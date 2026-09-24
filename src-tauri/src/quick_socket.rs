//! Linux stand-in for the macOS quick composer panel. The panel itself lives
//! outside MonoCode (a Quickshell layer-shell surface, since Wayland gives an
//! app no global shortcut or non-activating panel); it hands its prompt over
//! this socket, and the workspace starts the session through the same
//! `launchQuickSession` the macOS panel uses.
//!
//! One JSON object per connection, one JSON reply line:
//!   {"prompt":"...","cwd":"/project","harness":"claude","model":"...","reveal":false}
//!   -> {"ok":true} | {"ok":false,"error":"..."}
//!   {"op":"catalog"}
//!   -> {"ok":true,"catalog":{projects, project, harnesses, choice}}
//! Everything but the prompt is optional; the workspace fills in its defaults.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, WebviewWindow};

/// Workspace windows listen for this; the payload is the raw request object.
const EVENT: &str = "external_quick_launch";
const MAX_BYTES: u64 = 256 * 1024;

/// The project and model lists live in the workspace webview, so it pushes a
/// snapshot here (on blur, when the user reaches for the panel) and the panel
/// reads it back without a round trip through the webview.
static CATALOG: Mutex<Option<Value>> = Mutex::new(None);

#[tauri::command]
pub fn quick_socket_catalog(catalog: String) -> Result<(), String> {
    let catalog = serde_json::from_str(&catalog).map_err(|err| err.to_string())?;
    *CATALOG.lock().map_err(|err| err.to_string())? = Some(catalog);
    Ok(())
}

fn socket_path() -> Option<PathBuf> {
    // XDG_RUNTIME_DIR is 0700 and per user, so only this user can connect.
    std::env::var_os("XDG_RUNTIME_DIR").map(|dir| PathBuf::from(dir).join("monocode-quick.sock"))
}

pub fn init(app: &AppHandle) {
    let Some(path) = socket_path() else {
        return;
    };
    // A socket that answers belongs to another running MonoCode (the installed
    // app beside a dev build, say); leave it to that one.
    if UnixStream::connect(&path).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("monocode: quick socket: {err}");
            return;
        }
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            serve(&app, stream);
        }
    });
}

fn serve(app: &AppHandle, stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut line = String::new();
    let result = BufReader::new((&stream).take(MAX_BYTES))
        .read_line(&mut line)
        .map_err(|err| err.to_string())
        .and_then(|_| {
            serde_json::from_str::<Value>(line.trim())
                .map_err(|_| "Expected one JSON object.".to_string())
        })
        .and_then(|request| match request.get("op").and_then(Value::as_str) {
            Some("catalog") => catalog(),
            _ => deliver(app, request).map(|()| json!({ "ok": true })),
        });
    let reply = result.unwrap_or_else(|error| json!({ "ok": false, "error": error }));
    let _ = writeln!(&stream, "{reply}");
}

fn catalog() -> Result<Value, String> {
    let catalog = CATALOG.lock().map_err(|err| err.to_string())?.clone();
    let catalog = catalog.ok_or("MonoCode is still starting.")?;
    Ok(json!({ "ok": true, "catalog": catalog }))
}

fn deliver(app: &AppHandle, request: Value) -> Result<(), String> {
    if !request
        .get("prompt")
        .and_then(Value::as_str)
        .is_some_and(|prompt| !prompt.trim().is_empty())
    {
        return Err("Write a prompt first.".into());
    }
    let window = target(app).ok_or("No MonoCode window is open.")?;
    if request.get("reveal").and_then(Value::as_bool) == Some(true) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    window.emit(EVENT, request).map_err(|err| err.to_string())
}

/// The window the user last looked at, else the first one, like the macOS
/// panel's launch target.
fn target(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = crate::window::workspace_windows(app);
    windows
        .iter()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| {
            windows
                .iter()
                .find(|window| window.is_visible().unwrap_or(false))
        })
        .or(windows.first())
        .cloned()
}
