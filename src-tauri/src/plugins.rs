//! Host services every workspace plugin shares: an HTTP escape hatch, a
//! per-plugin JSON config file, and the install/uninstall side of user-authored
//! manifest plugins.
//!
//! Two kinds of plugin live side by side. Built-ins are compiled-in React
//! modules (`src/plugins/<id>/index.tsx`). User plugins are a `plugin.json`
//! manifest under the app data dir, rendered by a generic workspace — the
//! webview CSP (`script-src 'self'`, `frame-src 'none'`) rules out loading
//! third-party code at runtime, so the manifest is data, never script.
//!
//! ```text
//! <appData>/plugins/<id>/plugin.json   manifest, user-authored
//! <appData>/plugins/<id>/config.json   plugin state and tokens, mode 0600
//! ```

use std::fs;
use std::io::{BufRead, Read};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::linear::write_secret_file;

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_MAX: u64 = 8 * 1024 * 1024;
const ID_MAX: usize = 40;
const MANIFEST_MAX: u64 = 256 * 1024;
const MANIFEST: &str = "plugin.json";
const CONFIG: &str = "config.json";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub ms: u64,
}

#[tauri::command]
pub async fn plugin_fetch(request: PluginRequest) -> Result<PluginResponse, String> {
    tauri::async_runtime::spawn_blocking(move || send(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub fn plugin_config_get(app: AppHandle, id: String) -> Result<Value, String> {
    let path = config_path(&app, &id)?;
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command(async)]
pub fn plugin_config_set(app: AppHandle, id: String, config: Value) -> Result<(), String> {
    let path = config_path(&app, &id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string(&config).map_err(|error| error.to_string())?;
    // Plugin config is where an integration keeps its API token, so 0600 like linear-token.
    write_secret_file(&path, &raw)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub manifest: Value,
    /// Set when the manifest could not be read or parsed, so the UI can say why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command(async)]
pub fn plugins_list(app: AppHandle) -> Result<Vec<InstalledPlugin>, String> {
    let root = plugins_root(&app)?;
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut installed = Vec::new();
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().to_string();
        if validate_plugin_id(&id).is_err() || !entry.path().is_dir() {
            continue;
        }
        if let Some(plugin) = read_manifest(&entry.path().join(MANIFEST), id) {
            installed.push(plugin);
        }
    }
    installed.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(installed)
}

/// Writes a manifest, creating the plugin folder. Existing config is kept, so
/// this doubles as the update path.
#[tauri::command(async)]
pub fn plugin_install(app: AppHandle, manifest: Value) -> Result<String, String> {
    let id = manifest
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    validate_plugin_id(&id)?;
    let dir = plugins_root(&app)?.join(&id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let raw = serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?;
    if raw.len() as u64 > MANIFEST_MAX {
        return Err("Manifest is too large".into());
    }
    fs::write(dir.join(MANIFEST), raw).map_err(|error| error.to_string())?;
    Ok(id)
}

/// Drops the whole plugin folder — manifest, config and stored token.
#[tauri::command(async)]
pub fn plugin_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    validate_plugin_id(&id)?;
    let dir = plugins_root(&app)?.join(&id);
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Folder to drop a `<id>/plugin.json` into, shown in Settings.
#[tauri::command(async)]
pub fn plugins_dir(app: AppHandle) -> Result<String, String> {
    Ok(plugins_root(&app)?.to_string_lossy().to_string())
}

fn read_manifest(path: &std::path::Path, id: String) -> Option<InstalledPlugin> {
    let broken = |error: String| InstalledPlugin {
        id: id.clone(),
        manifest: Value::Null,
        error: Some(error),
    };
    match fs::metadata(path) {
        // A folder without a manifest is just config for a built-in plugin.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => return Some(broken(error.to_string())),
        Ok(meta) if meta.len() > MANIFEST_MAX => {
            return Some(broken("Manifest is too large".into()))
        }
        Ok(_) => {}
    }
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) => return Some(broken(error.to_string())),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(manifest) => Some(InstalledPlugin {
            id,
            manifest,
            error: None,
        }),
        Err(error) => Some(broken(error.to_string())),
    }
}

fn send(request: PluginRequest) -> Result<PluginResponse, String> {
    check_url(&request.url)?;
    let method = request.method.trim().to_uppercase();
    if method.is_empty() {
        return Err("Request needs an HTTP method".into());
    }
    let agent = ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build();
    let mut call = agent.request(&method, request.url.trim());
    for (name, value) in &request.headers {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        call = call.set(name, value.trim());
    }
    let started = Instant::now();
    let result = match request.body.as_deref() {
        Some(body) if !body.is_empty() => call.send_string(body),
        _ => call.call(),
    };
    // A 4xx/5xx is a result the plugin wants to render, not a host error.
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err(error.to_string()),
    };
    let status = response.status();
    let headers = response
        .headers_names()
        .into_iter()
        .filter_map(|name| {
            response
                .header(&name)
                .map(|value| (name.clone(), value.to_string()))
        })
        .collect();
    let mut buffer = Vec::new();
    response
        .into_reader()
        .take(BODY_MAX)
        .read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;
    Ok(PluginResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&buffer).to_string(),
        ms: started.elapsed().as_millis() as u64,
    })
}

// ponytail: scheme guard only — an HTTP-client plugin needs arbitrary hosts by
// design. Add a per-plugin host allowlist if plugins ever load at runtime.
fn check_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(())
    } else {
        Err("Plugin requests must use http:// or https://".into())
    }
}

pub(crate) fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("plugins"))
}

fn config_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(id)?;
    Ok(plugins_root(app)?.join(id).join(CONFIG))
}

pub(crate) fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > ID_MAX {
        return Err("Invalid plugin id".into());
    }
    if id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        Ok(())
    } else {
        Err("Invalid plugin id".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_schemes_are_allowed() {
        assert!(check_url("https://api.example.com/v1").is_ok());
        assert!(check_url(" HTTP://localhost:8080/ping ").is_ok());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("ipc://localhost/notes_list").is_err());
        assert!(check_url("").is_err());
    }

    #[test]
    fn plugin_ids_cannot_escape_the_plugins_dir() {
        assert!(validate_plugin_id("jira").is_ok());
        assert!(validate_plugin_id("http-client-2").is_ok());
        assert!(validate_plugin_id("../linear-token").is_err());
        assert!(validate_plugin_id("Jira").is_err());
        assert!(validate_plugin_id("a/b").is_err());
        assert!(validate_plugin_id("").is_err());
    }

    #[test]
    fn truncation_respects_utf8_boundaries() {
        let mut line = "é".repeat(10); // 2 bytes per char
        truncate_line(&mut line, 15); // would split char 8
        assert_eq!(line, "é".repeat(7));
        let mut short = String::from("ok");
        truncate_line(&mut short, LINE_MAX);
        assert_eq!(short, "ok");
        truncate_line(&mut short, 0);
        assert_eq!(short, "");
    }

    #[cfg(unix)]
    #[test]
    fn plugin_commands_get_only_the_documented_environment() {
        let canary = "ENVCANARY_8F3D_NOT_FORWARDED";
        std::env::set_var(canary, "1");
        let root = std::env::temp_dir().join("monocode-plugin-envtest");
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let extra = vec![
            ("MONOCODE_SETTING_X".to_string(), "v".to_string()),
            (canary.to_string(), "1".to_string()),
        ];
        let output = plugin_command(&root, &state, "envtest", "/usr/bin/env", &[], &extra)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(text.contains("MONOCODE_ENV=1"), "{text}");
        assert!(text.contains("MONOCODE_PLUGIN_ID=envtest"), "{text}");
        assert!(text.contains("MONOCODE_SETTING_X=v"), "{text}");
        assert!(!text.contains(canary), "{text}");
        assert!(text.contains("PATH="), "{text}");
    }
}

// ---------------------------------------------------------------------------
// Process plugins: a manifest may declare argv commands in any language. The
// host spawns them in the plugin folder, hands identity + context + settings in
// the environment, and reads one JSON object per stdout line as a UI push.
// Modelled on luvus modules, which proved the shape.
// ---------------------------------------------------------------------------

const LINE_EVENT: &str = "plugin_line";
const EXIT_EVENT: &str = "plugin_exit";
const LINE_MAX: usize = 8 * 1024;

/// Environment variables a plugin command inherits besides `MONOCODE_*` —
/// just enough to find tools, reach the user's home and write temp files.
/// Everything else the app itself was started with (tokens included) is
/// deliberately not forwarded.
#[cfg(windows)]
const BASE_ENV: &[&str] = &[
    "PATH",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
];
#[cfg(not(windows))]
const BASE_ENV: &[&str] = &["PATH", "HOME", "TMPDIR"];

#[derive(Default)]
pub struct PluginProcs {
    /// Live pids per plugin id, so disabling or uninstalling can stop them.
    pids: std::sync::Mutex<std::collections::HashMap<String, Vec<u32>>>,
}

impl PluginProcs {
    pub fn new() -> Self {
        Self::default()
    }

    fn add(&self, id: &str, pid: u32) {
        if let Ok(mut pids) = self.pids.lock() {
            pids.entry(id.to_string()).or_default().push(pid);
        }
    }

    fn remove(&self, id: &str, pid: u32) {
        if let Ok(mut pids) = self.pids.lock() {
            if let Some(list) = pids.get_mut(id) {
                list.retain(|it| *it != pid);
                if list.is_empty() {
                    pids.remove(id);
                }
            }
        }
    }

    fn take(&self, id: &str) -> Vec<u32> {
        self.pids
            .lock()
            .ok()
            .and_then(|mut pids| pids.remove(id))
            .unwrap_or_default()
    }

    fn take_all(&self) -> Vec<u32> {
        self.pids
            .lock()
            .ok()
            .map(|mut pids| pids.drain().flat_map(|(_, list)| list).collect())
            .unwrap_or_default()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginLine {
    plugin_id: String,
    /// What ran, e.g. `startup` or `action:playpause`, for the log.
    label: String,
    line: String,
    stderr: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginExit {
    plugin_id: String,
    label: String,
    code: Option<i32>,
}

/// Spawns an argv command for a plugin. Fire-and-forget: stdout lines arrive as
/// `plugin_line` events, the exit code as `plugin_exit`. A long-lived watcher and
/// a one-shot action are the same code path — only how long it runs differs.
#[tauri::command(async)]
pub fn plugin_run(
    app: AppHandle,
    procs: State<'_, PluginProcs>,
    id: String,
    label: String,
    argv: Vec<String>,
    env: Vec<(String, String)>,
) -> Result<u32, String> {
    validate_plugin_id(&id)?;
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| "Command is empty".to_string())?;
    if program.trim().is_empty() {
        return Err("Command is empty".into());
    }
    let root = plugins_root(&app)?.join(&id);
    if !root.is_dir() {
        return Err(format!("Plugin {id} is not installed"));
    }
    let state = root.join("state");
    let _ = fs::create_dir_all(&state);

    let mut command = plugin_command(&root, &state, &id, program, args, &env);

    let mut child = command.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => format!("{program}: not found"),
        _ => error.to_string(),
    })?;
    let pid = child.id();
    procs.add(&id, pid);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    for (pipe, is_stderr) in [
        (stdout.map(Pipe::Out), false),
        (stderr.map(Pipe::Err), true),
    ] {
        let Some(pipe) = pipe else { continue };
        let app = app.clone();
        let plugin_id = id.clone();
        let label = label.clone();
        std::thread::spawn(move || {
            let reader: Box<dyn std::io::BufRead> = match pipe {
                Pipe::Out(out) => Box::new(std::io::BufReader::new(out)),
                Pipe::Err(err) => Box::new(std::io::BufReader::new(err)),
            };
            for line in reader.lines() {
                let Ok(mut line) = line else { break };
                truncate_line(&mut line, LINE_MAX);
                let _ = app.emit(
                    LINE_EVENT,
                    PluginLine {
                        plugin_id: plugin_id.clone(),
                        label: label.clone(),
                        line,
                        stderr: is_stderr,
                    },
                );
            }
        });
    }

    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        if let Some(procs) = app.try_state::<PluginProcs>() {
            procs.remove(&id, pid);
        }
        let _ = app.emit(
            EXIT_EVENT,
            PluginExit {
                plugin_id: id,
                label,
                code,
            },
        );
    });

    Ok(pid)
}

/// Cuts a line to `max` bytes without panicking on a multi-byte character
/// straddling the boundary (`String::truncate` would).
fn truncate_line(line: &mut String, max: usize) {
    let mut cut = max.min(line.len());
    while cut > 0 && !line.is_char_boundary(cut) {
        cut -= 1;
    }
    line.truncate(cut);
}

enum Pipe {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}
/// Builds the command for a plugin process: fixed working dir and stdio, and
/// an environment reduced to `BASE_ENV` plus the `MONOCODE_*` contract. The
/// fixed `MONOCODE_*` values are applied last so caller-supplied ones cannot
/// override the host's.
fn plugin_command(
    root: &std::path::Path,
    state: &std::path::Path,
    id: &str,
    program: &str,
    args: &[String],
    extra: &[(String, String)],
) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env_clear();
    for (key, value) in extra {
        if key.starts_with("MONOCODE_") {
            command.env(key, value);
        }
    }
    for key in BASE_ENV {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    command
        .env("MONOCODE_ENV", "1")
        .env("MONOCODE_PLUGIN_ID", id)
        .env("MONOCODE_PLUGIN_ROOT", root.display().to_string())
        .env("MONOCODE_PLUGIN_STATE_DIR", state.display().to_string())
        .env(
            "MONOCODE_PLUGIN_CONFIG",
            root.join(CONFIG).display().to_string(),
        );
    command
}

/// Stops every process a plugin started. Called on disable and uninstall.
#[tauri::command(async)]
pub fn plugin_stop(procs: State<'_, PluginProcs>, id: String) -> Result<(), String> {
    validate_plugin_id(&id)?;
    crate::harness::terminate_all(&procs.take(&id));
    Ok(())
}

#[tauri::command(async)]
pub fn plugin_stop_all(procs: State<'_, PluginProcs>) -> Result<(), String> {
    crate::harness::terminate_all(&procs.take_all());
    Ok(())
}
