//! Serves a plugin's free-form UI over the `pluginui://` scheme.
//!
//! A manifest may declare `"ui": "index.html"`. The host renders that entry in
//! a sandboxed iframe; this handler answers its requests from
//! `<appData>/plugins/<id>/ui/<path>` — and only from there: `config.json`
//! (which holds tokens) sits one level above `ui/` and is unreachable.
//! Relative paths inside the UI resolve against `pluginui://<id>/...` and
//! keep working, so multi-file UIs need no special handling.
//!
//! Trust model, same as a browser extension install: the code in the frame is
//! code the user chose to install. The sandbox attribute on the iframe keeps
//! it out of the app's DOM; every host action goes through the postMessage
//! bridge in `UiWorkspace`, which binds requests and config to that plugin id.

use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::http;

/// The URL scheme: `pluginui://<plugin-id>/<relative path under ui/>`.
pub const SCHEME: &str = "pluginui";

const HTML: &str = "text/html; charset=utf-8";

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => HTML,
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Percent-decoded path components, or `None` when anything smells like an
/// escape attempt (`..`, empty segments, backslashes, NULs, absolute remnant).
fn safe_components(raw_path: &str) -> Option<Vec<String>> {
    let decoded = percent_decode_str(raw_path).decode_utf8().ok()?;
    let mut out = Vec::new();
    for component in decoded.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".."
            || component.contains('\\')
            || component.contains('\0')
            || component.contains(':')
        {
            return None;
        }
        out.push(component.to_string());
    }
    Some(out)
}
/// Resolves `/<id>/<relative path>` against `plugins_root`, rejecting
/// anything that would leave that plugin's `ui/` folder. The id travels in
/// the path (not the URL host) so macOS and Windows use one URL shape.
/// `Ok(None)` maps to a 404.
fn safe_resolve(root: &Path, raw_path: &str) -> Result<Option<PathBuf>, String> {
    let components = safe_components(raw_path).ok_or_else(|| "Invalid path".to_string())?;
    let (id, rel) = match components.split_first() {
        Some((id, rel)) if !rel.is_empty() => (id, rel),
        _ => return Ok(None),
    };
    crate::plugins::validate_plugin_id(id)?;
    let mut full = root.join(id).join("ui");
    for component in rel {
        full.push(component);
    }
    // Belt and braces: component filtering above already rules out escapes.
    if !full.starts_with(root.join(id).join("ui")) {
        return Err("Path escapes the plugin ui folder".into());
    }
    Ok(Some(full))
}

fn response(status: u16, mime: &str, body: Vec<u8>) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-store")
        .body(body)
        .expect("static response parts")
}

/// The whole handler minus the Tauri plumbing: pure over a filesystem root.
/// The URI path is `/<plugin id>/<relative path under ui/>`.
pub fn serve(root: &Path, method: &str, raw_path: &str) -> http::Response<Vec<u8>> {
    if method != "GET" && method != "HEAD" {
        return response(405, "text/plain", b"method not allowed".to_vec());
    }
    let path = match safe_resolve(root, raw_path) {
        Ok(Some(path)) => path,
        Ok(None) => return response(404, "text/plain", b"not found".to_vec()),
        Err(error) => return response(400, "text/plain", error.into_bytes()),
    };
    match std::fs::read(&path) {
        Ok(body) => {
            let mime = mime_for(&path.display().to_string());
            let mut response = response(200, mime, body);
            if method == "HEAD" {
                *response.body_mut() = Vec::new();
            }
            response
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            response(404, "text/plain", b"not found".to_vec())
        }
        Err(error) => response(500, "text/plain", error.to_string().into_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("monocode-ui-{}-{name}", std::process::id()));
        std::fs::create_dir_all(dir.join("board/ui/assets")).unwrap();
        std::fs::write(dir.join("board/ui/index.html"), "<html></html>").unwrap();
        std::fs::write(dir.join("board/ui/assets/app.js"), "console.log(1)").unwrap();
        std::fs::write(dir.join("board/config.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn serves_files_with_mime_types() {
        let root = write_fixture("mime");
        let html = serve(&root, "GET", "/board/index.html");
        assert_eq!(html.status(), 200);
        assert_eq!(html.headers()["Content-Type"], HTML);
        assert_eq!(html.body(), b"<html></html>");
        let js = serve(&root, "GET", "/board/assets/app.js");
        assert_eq!(
            js.headers()["Content-Type"],
            "text/javascript; charset=utf-8"
        );
        let head = serve(&root, "HEAD", "/board/index.html");
        assert_eq!(head.status(), 200);
        assert!(head.body().is_empty());
    }

    #[test]
    fn rejects_escapes_and_unknown_ids() {
        let root = write_fixture("escape");
        for path in [
            "/board/../config.json",
            "/board/%2e%2e/config.json",
            "/board/..%2fconfig.json",
            "/board/a/../config.json",
            "/board/..\\config.json",
            "/../board/config.json",
            "/board",
            "/board/",
        ] {
            let status = serve(&root, "GET", path).status();
            assert!(status == 400 || status == 404, "{path}: {status}");
        }
        assert_eq!(serve(&root, "POST", "/board/index.html").status(), 405);
        assert_eq!(serve(&root, "GET", "/nope/index.html").status(), 404);
        assert_eq!(serve(&root, "GET", "/board/missing.html").status(), 404);
        // config.json is outside ui/ and must never be served.
        assert_eq!(serve(&root, "GET", "/board/config.json").status(), 404);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn percent_decodes_paths() {
        let root = write_fixture("percent");
        std::fs::write(root.join("board/ui/my file.html"), "x").unwrap();
        let response = serve(&root, "GET", "/board/my%20file.html");
        assert_eq!(response.status(), 200);
        std::fs::remove_dir_all(&root).ok();
    }
}
