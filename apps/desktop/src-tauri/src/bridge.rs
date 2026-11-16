//! Tauri commands that connect a window to its own `keryx acp` process.
//!
//! The Rust core does not interpret ACP beyond framing and the `fs/*`
//! handler: every other line goes to the window verbatim as `acp://message`.

use crate::fs;
use crate::locator::{self, KeryxSource};
use crate::process::{AcpProcess, ProcessEvent, SpawnConfig};
use crate::settings::Settings;
use crate::shellenv;
use crate::version;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Default)]
pub struct AppState {
    sessions: Mutex<HashMap<String, Arc<AcpProcess>>>,
    pending_cwd: Mutex<HashMap<String, String>>,
    login_env: OnceLock<HashMap<String, String>>,
    window_counter: AtomicU64,
}

impl AppState {
    /// The login-shell environment, captured once (blocks the first caller).
    pub fn environment(&self) -> &HashMap<String, String> {
        self.login_env.get_or_init(shellenv::resolve_environment)
    }

    pub fn stop_window(&self, label: &str) {
        let proc = self.sessions.lock().unwrap().remove(label);
        if let Some(p) = proc {
            p.kill();
        }
    }

    pub fn stop_all(&self) {
        let all: Vec<_> = self.sessions.lock().unwrap().drain().map(|(_, p)| p).collect();
        for p in all {
            p.kill();
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    keryx_path: String,
    source: KeryxSource,
    note: Option<String>,
    log_path: String,
    min_keryx_version: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    code: Option<i32>,
    stderr_tail: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|d| d.join("settings.json")).map_err(|e| e.to_string())
}

pub fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app).map(|p| Settings::load(&p)).unwrap_or_default()
}

/// If `line` is an `fs/read_text_file` request, the response line to send back.
pub fn intercept_fs(root: &Path, line: &str) -> Option<String> {
    let msg: Value = serde_json::from_str(line).ok()?;
    if msg.get("method").and_then(Value::as_str) != Some("fs/read_text_file") {
        return None;
    }
    let id = msg.get("id")?; // a notification has no id and is not ours to answer
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let response = match fs::read_text_file(root, &params) {
        Ok(result) => fs::result_response(id, result),
        Err(err) => fs::error_response(id, &err),
    };
    Some(response.to_string())
}

#[tauri::command]
pub async fn acp_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    cwd: String,
    no_profile: Option<bool>,
) -> Result<StartInfo, String> {
    let label = window.label().to_string();
    state.stop_window(&label);

    let root = Path::new(&cwd)
        .canonicalize()
        .map_err(|e| format!("The project folder is not available ({cwd}): {e}"))?;
    if !root.is_dir() {
        return Err(format!("Not a folder: {cwd}"));
    }

    let env = state.environment().clone();
    let settings = load_settings(&app);
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let located = locator::locate(
        settings.keryx_source,
        settings.custom_path.as_deref(),
        exe_dir.as_deref(),
        env.get("PATH").map(std::ffi::OsString::from).as_deref(),
    )?;

    let mut args = vec!["acp".to_string()];
    if !no_profile.unwrap_or(false) {
        args.push("--profile".into());
        args.push("shell".into());
    }
    let log_path = app
        .path()
        .app_log_dir()
        .map(|d| d.join(format!("keryx-acp-{label}.log")))
        .map_err(|e| e.to_string())?;

    let emit_app = app.clone();
    let emit_label = label.clone();
    let fs_root = root.clone();
    let proc = AcpProcess::spawn(
        SpawnConfig {
            program: located.path.clone(),
            args,
            cwd: root,
            env,
            log_path: Some(log_path.clone()),
        },
        move |proc, event| {
            if proc.is_stopped() {
                return;
            }
            match event {
                ProcessEvent::Line(line) => {
                    if let Some(reply) = intercept_fs(&fs_root, &line) {
                        let _ = proc.send_line(&reply);
                    } else {
                        let _ = emit_app.emit_to(emit_label.as_str(), "acp://message", line);
                    }
                }
                ProcessEvent::Oversized => {
                    let _ = emit_app.emit_to(
                        emit_label.as_str(),
                        "acp://error",
                        "keryx sent a message larger than 16 MiB; it was dropped",
                    );
                }
                ProcessEvent::Exit { code, stderr_tail } => {
                    let _ = emit_app.emit_to(
                        emit_label.as_str(),
                        "acp://exit",
                        ExitPayload { code, stderr_tail },
                    );
                }
            }
        },
    )
    .map_err(|e| format!("Could not start keryx at {}: {e}", located.path.display()))?;

    state.sessions.lock().unwrap().insert(label, proc);
    Ok(StartInfo {
        keryx_path: located.path.display().to_string(),
        source: located.source,
        note: located.note,
        log_path: log_path.display().to_string(),
        min_keryx_version: version::MIN_KERYX_VERSION,
    })
}

#[tauri::command]
pub fn acp_send(window: WebviewWindow, state: State<'_, AppState>, message: String) -> Result<(), String> {
    let proc = state
        .sessions
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or("keryx is not running in this window")?;
    proc.send_line(&message)
}

#[tauri::command]
pub async fn acp_stop(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    state.stop_window(window.label());
    Ok(())
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Settings {
    load_settings(&app)
}

#[tauri::command]
pub fn settings_set(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    // Recents are owned by `settings_add_recent`; a stale form must not clobber them.
    let mut next = settings;
    next.recent_projects = Settings::load(&path).recent_projects;
    next.save(&path).map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
pub fn settings_add_recent(app: AppHandle, project: String) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    let mut s = Settings::load(&path);
    s.add_recent(&project);
    s.save(&path).map_err(|e| e.to_string())?;
    Ok(s)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionCheck {
    ok: bool,
    found: String,
    required: &'static str,
}

#[tauri::command]
pub fn version_check(found: String) -> VersionCheck {
    VersionCheck { ok: version::is_compatible(&found), found, required: version::MIN_KERYX_VERSION }
}

/// Open a project in a new window (one keryx process per window).
#[tauri::command]
pub async fn window_open_project(app: AppHandle, state: State<'_, AppState>, cwd: String) -> Result<(), String> {
    let n = state.window_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("project-{n}");
    state.pending_cwd.lock().unwrap().insert(label.clone(), cwd);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Keryx")
        .inner_size(1180.0, 780.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The folder a freshly created project window should open (taken once).
#[tauri::command]
pub fn window_initial_cwd(window: WebviewWindow, state: State<'_, AppState>) -> Option<String> {
    state.pending_cwd.lock().unwrap().remove(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_fs_requests_and_ignores_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "hello\nworld\n").unwrap();
        let req = json!({
            "jsonrpc": "2.0", "id": 5, "method": "fs/read_text_file",
            "params": { "sessionId": "s", "path": "f.txt", "line": 2 }
        })
        .to_string();
        let reply: Value = serde_json::from_str(&intercept_fs(dir.path(), &req).unwrap()).unwrap();
        assert_eq!(reply["id"], 5);
        assert_eq!(reply["result"]["content"], "world\n");

        let outside = json!({
            "jsonrpc": "2.0", "id": 6, "method": "fs/read_text_file",
            "params": { "path": "/etc/hosts" }
        })
        .to_string();
        let reply: Value = serde_json::from_str(&intercept_fs(dir.path(), &outside).unwrap()).unwrap();
        assert_eq!(reply["id"], 6);
        assert!(reply["error"]["message"].as_str().unwrap().contains("outside"));

        let other = json!({"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{}}).to_string();
        assert!(intercept_fs(dir.path(), &other).is_none());
        let notification = json!({"jsonrpc":"2.0","method":"fs/read_text_file","params":{"path":"f.txt"}}).to_string();
        assert!(intercept_fs(dir.path(), &notification).is_none());
        assert!(intercept_fs(dir.path(), "not json").is_none());
    }
}
