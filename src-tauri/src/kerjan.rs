use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_BASE_URL: &str = "https://kerjan.omni-x.dev";
const MCP_PATH: &str = "/api/v1/mcp";
// Kerjan is reached through its MCP server, which exposes every write the
// agent token allows. The inbox only needs these, so nothing else gets through.
const ALLOWED_TOOLS: [&str; 9] = [
    "whoami",
    "list_members",
    "list_sprints",
    "list_tickets",
    "get_ticket",
    "add_comment",
    "move_task",
    "set_assignee",
    "update_ticket",
];
// Workspace-wide tools need an explicit `workspace` argument once the token
// belongs to more than one Workspace; the X-Workspace-ID header is not enough.
const WORKSPACE_TOOLS: [&str; 2] = ["list_sprints", "list_tickets"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KerjanStatus {
    pub connected: bool,
    pub base_url: String,
    pub workspace_id: String,
    pub member_id: i64,
    pub member_name: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct KerjanConfig {
    base_url: String,
    token: String,
    workspace_id: String,
    #[serde(default)]
    member_id: i64,
    #[serde(default)]
    member_name: String,
}

#[tauri::command(async)]
pub fn kerjan_status(app: AppHandle) -> Result<KerjanStatus, String> {
    Ok(status_for(read_config(&app)?.as_ref()))
}

#[tauri::command]
pub async fn kerjan_set_config(
    app: AppHandle,
    base_url: String,
    token: String,
    workspace_id: String,
) -> Result<KerjanStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token.trim().to_string();
        if token.is_empty() {
            delete_config(&app)?;
            return Ok(status_for(None));
        }
        let workspace_id = workspace_id.trim().to_string();
        if workspace_id.is_empty() || !workspace_id.chars().all(|c| c.is_ascii_digit()) {
            return Err("Enter the numeric Kerjan workspace ID".into());
        }
        let mut config = KerjanConfig {
            base_url: normalize_base_url(&base_url)?,
            token,
            workspace_id,
            member_id: 0,
            member_name: String::new(),
        };
        let me = call_tool(&config, "whoami", json!({}))?;
        config.member_id = me.get("id").and_then(Value::as_i64).unwrap_or_default();
        if config.member_id == 0 {
            return Err("Kerjan did not return the current member".into());
        }
        config.member_name = me
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        write_config(&app, &config)?;
        Ok(status_for(Some(&config)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn kerjan_call(app: AppHandle, tool: String, arguments: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tool = tool.trim();
        if !ALLOWED_TOOLS.contains(&tool) {
            return Err(format!("Kerjan tool {tool} is not available"));
        }
        if !arguments.is_object() {
            return Err("Kerjan arguments must be an object".into());
        }
        let Some(config) = read_config(&app)? else {
            return Err("Connect Kerjan in Settings".into());
        };
        call_tool(&config, tool, arguments)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn status_for(config: Option<&KerjanConfig>) -> KerjanStatus {
    match config {
        Some(config) => KerjanStatus {
            connected: true,
            base_url: config.base_url.clone(),
            workspace_id: config.workspace_id.clone(),
            member_id: config.member_id,
            member_name: config.member_name.clone(),
        },
        None => KerjanStatus {
            connected: false,
            base_url: String::new(),
            workspace_id: String::new(),
            member_id: 0,
            member_name: String::new(),
        },
    }
}

fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() {
        DEFAULT_BASE_URL
    } else {
        trimmed.strip_suffix(MCP_PATH).unwrap_or(trimmed)
    };
    let base = base.trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err("Kerjan URL must start with https://".into());
    }
    Ok(base.to_string())
}

fn call_tool(config: &KerjanConfig, tool: &str, arguments: Value) -> Result<Value, String> {
    let arguments = with_workspace(tool, arguments, &config.workspace_id);
    let agent = ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build();
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": tool, "arguments": arguments },
    });
    let result = agent
        .post(&format!("{}{MCP_PATH}", config.base_url))
        .set("Authorization", &format!("Bearer {}", config.token))
        .set("X-Workspace-ID", &config.workspace_id)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send_string(&payload.to_string());
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(401, _)) => return Err("Kerjan token is invalid".into()),
        Err(ureq::Error::Status(403, _)) => {
            return Err("Kerjan refused the token. Use an agent token (kjt_…)".into());
        }
        Err(ureq::Error::Status(status, _)) => {
            return Err(format!("Kerjan request failed ({status})"));
        }
        Err(_) => return Err("Could not reach Kerjan".into()),
    };
    let body = response
        .into_string()
        .map_err(|_| "Kerjan returned an unreadable response".to_string())?;
    parse_tool_result(&body)
}

fn with_workspace(tool: &str, mut arguments: Value, workspace_id: &str) -> Value {
    if WORKSPACE_TOOLS.contains(&tool) {
        if let Some(map) = arguments.as_object_mut() {
            map.entry("workspace")
                .or_insert_with(|| Value::String(workspace_id.to_string()));
        }
    }
    arguments
}

fn parse_tool_result(body: &str) -> Result<Value, String> {
    let envelope: Value = serde_json::from_str(rpc_payload(body))
        .map_err(|_| "Kerjan returned invalid JSON".to_string())?;
    if let Some(message) = envelope.pointer("/error/message").and_then(Value::as_str) {
        return Err(message.trim().to_string());
    }
    let result = envelope
        .get("result")
        .ok_or_else(|| "Kerjan returned no result".to_string())?;
    let text = result
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(if text.is_empty() {
            "Kerjan rejected the request".into()
        } else {
            text.to_string()
        });
    }
    if let Some(structured) = result.get("structuredContent") {
        return Ok(structured.clone());
    }
    if text.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string())))
}

/// Streamable HTTP servers may answer with an SSE stream instead of a JSON body.
fn rpc_payload(body: &str) -> &str {
    let trimmed = body.trim();
    if trimmed.starts_with('{') {
        return trimmed;
    }
    trimmed
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .rfind(|line| line.starts_with('{'))
        .unwrap_or(trimmed)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("kerjan-config.json"))
}

fn read_config(app: &AppHandle) -> Result<Option<KerjanConfig>, String> {
    match fs::read_to_string(config_path(app)?) {
        Ok(raw) => {
            let config: KerjanConfig = serde_json::from_str(&raw)
                .map_err(|_| "Kerjan settings are invalid".to_string())?;
            if config.token.trim().is_empty() || config.workspace_id.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(config))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_config(app: &AppHandle, config: &KerjanConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let value = serde_json::to_string(config).map_err(|error| error.to_string())?;
    write_secret_file(&path, &value)
}

fn delete_config(app: &AppHandle) -> Result<(), String> {
    match fs::remove_file(config_path(app)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_secret_file(path: &Path, value: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| error.to_string())?;
        file.write_all(value.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, value).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_workspace_to_workspace_tools_only() {
        let args = with_workspace("list_tickets", json!({ "status": "todo" }), "7");
        assert_eq!(args, json!({ "status": "todo", "workspace": "7" }));
        let kept = with_workspace("list_sprints", json!({ "workspace": "PRD" }), "7");
        assert_eq!(kept, json!({ "workspace": "PRD" }));
        assert_eq!(with_workspace("whoami", json!({}), "7"), json!({}));
    }

    #[test]
    fn normalizes_base_url() {
        assert_eq!(normalize_base_url("").unwrap(), DEFAULT_BASE_URL);
        assert_eq!(
            normalize_base_url("https://kerjan.omni-x.dev/api/v1/mcp/").unwrap(),
            "https://kerjan.omni-x.dev"
        );
        assert_eq!(
            normalize_base_url("http://localhost:5200/").unwrap(),
            "http://localhost:5200"
        );
        assert!(normalize_base_url("kerjan.omni-x.dev").is_err());
    }

    #[test]
    fn parses_json_text_content() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"id\":27,\"name\":\"Ridho\"}"}]}}"#;
        assert_eq!(
            parse_tool_result(body).unwrap(),
            json!({ "id": 27, "name": "Ridho" })
        );
    }

    #[test]
    fn surfaces_tool_errors() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ticket not found"}],"isError":true}}"#;
        assert_eq!(parse_tool_result(body).unwrap_err(), "ticket not found");
        let rpc = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"unknown tool"}}"#;
        assert_eq!(parse_tool_result(rpc).unwrap_err(), "unknown tool");
    }

    #[test]
    fn reads_sse_payload() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"[]\"}]}}\n\n";
        assert_eq!(parse_tool_result(body).unwrap(), json!([]));
    }

    #[test]
    fn keeps_plain_text_results() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}"#;
        assert_eq!(parse_tool_result(body).unwrap(), json!("ok"));
    }
}
