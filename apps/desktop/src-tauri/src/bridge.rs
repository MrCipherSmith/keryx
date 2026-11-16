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
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Overall budget for stopping every window at app quit.
pub const QUIT_DEADLINE: Duration = Duration::from_secs(7);

#[derive(Default)]
pub struct AppState {
    sessions: Mutex<HashMap<String, Arc<AcpProcess>>>,
    /// Processes being stopped on a background thread (window closed).
    stopping: Arc<Mutex<Vec<Arc<AcpProcess>>>>,
    /// One lock per window label, held across spawn + insert in `acp_start`.
    start_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pending_cwd: Mutex<HashMap<String, String>>,
    login_env: OnceLock<HashMap<String, String>>,
    window_counter: AtomicU64,
}

/// Stop every process in parallel; wait for all of them, but no longer than `deadline`.
fn kill_all(procs: Vec<Arc<AcpProcess>>, deadline: Duration) {
    let total = procs.len();
    let (tx, rx) = mpsc::channel();
    for p in procs {
        let tx = tx.clone();
        std::thread::spawn(move || {
            p.kill();
            let _ = tx.send(());
        });
    }
    let end = Instant::now() + deadline;
    for _ in 0..total {
        let left = end.saturating_duration_since(Instant::now());
        if rx.recv_timeout(left).is_err() {
            break;
        }
    }
}

impl AppState {
    /// The login-shell environment, captured once (blocks the first caller).
    pub fn environment(&self) -> &HashMap<String, String> {
        self.login_env.get_or_init(shellenv::resolve_environment)
    }

    /// The per-window lock that serialises `acp_start` for one label.
    fn start_lock(&self, label: &str) -> Arc<Mutex<()>> {
        self.start_locks.lock().unwrap().entry(label.to_string()).or_default().clone()
    }

    /// Register `proc` for `label` and stop whatever it replaces, so a second
    /// start can never leave the first process running unowned.
    fn install(&self, label: &str, proc: Arc<AcpProcess>) {
        let previous = self.sessions.lock().unwrap().insert(label.to_string(), proc);
        if let Some(old) = previous {
            old.kill();
        }
    }

    /// Stop the window's process and wait until it is gone.
    pub fn stop_window(&self, label: &str) {
        let proc = self.sessions.lock().unwrap().remove(label);
        if let Some(p) = proc {
            p.kill();
        }
    }

    /// Stop the window's process on a background thread (called from the event
    /// loop, which must not wait out the grace period).
    pub fn stop_window_in_background(&self, label: &str) {
        let Some(proc) = self.sessions.lock().unwrap().remove(label) else { return };
        self.stopping.lock().unwrap().push(proc.clone());
        let stopping = self.stopping.clone();
        std::thread::spawn(move || {
            proc.kill();
            stopping.lock().unwrap().retain(|p| !Arc::ptr_eq(p, &proc));
        });
    }

    /// App quit: stop everything in parallel within one overall deadline.
    pub fn stop_all(&self) {
        let mut all: Vec<_> = self.sessions.lock().unwrap().drain().map(|(_, p)| p).collect();
        all.extend(self.stopping.lock().unwrap().iter().cloned());
        kill_all(all, QUIT_DEADLINE);
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

/// Answer an `fs/read_text_file` request off the stdout reader thread: a slow
/// disk must not stall the stream of agent messages.
fn answer_fs_in_background(proc: &Arc<AcpProcess>, root: PathBuf, request: fs::FsRequest) {
    let proc = proc.clone();
    std::thread::spawn(move || {
        let reply = fs::answer(&root, &request);
        if proc.send_line(&reply).is_err() && !proc.is_stopped() {
            // Never leave keryx waiting: fall back to an error for this id.
            let err = fs::RpcError { code: fs::INTERNAL_ERROR, message: "reply could not be sent".into() };
            let _ = proc.send_line(&fs::error_response(&request.id, &err).to_string());
        }
    });
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
    // Held from here to the insert (this function has no await points), so two
    // starts for one window run one after the other and the second replaces
    // and stops the first.
    let start_lock = state.start_lock(&label);
    let _starting = start_lock.lock().unwrap();
    state.stop_window(&label);

    let root = Path::new(&cwd)
        .canonicalize()
        .map_err(|e| format!("The project folder is not available ({cwd}): {e}"))?;
    if !root.is_dir() {
        return Err(format!("Not a folder: {cwd}"));
    }

    let env = state.environment().clone();
    // Reads are confined to the git toplevel, which is what keryx binds its session to.
    let fs_root = fs::project_root(&root, env.get("PATH").map(String::as_str));
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
                    if let Some(request) = fs::parse_request(&line) {
                        answer_fs_in_background(proc, fs_root.clone(), request);
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

    state.install(&label, proc);
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn sleeper() -> Arc<AcpProcess> {
        AcpProcess::spawn(
            SpawnConfig {
                program: "/bin/sleep".into(),
                args: vec!["300".into()],
                cwd: std::env::temp_dir(),
                env: HashMap::new(),
                log_path: None,
            },
            |_, _| {},
        )
        .unwrap()
    }

    fn alive(p: &Arc<AcpProcess>) -> bool {
        !p.is_stopped()
    }

    #[test]
    fn installing_a_second_process_stops_the_first() {
        let state = AppState::default();
        let first = sleeper();
        let second = sleeper();
        state.install("w", first.clone());
        assert!(alive(&first));
        state.install("w", second.clone());
        assert!(first.is_stopped(), "the replaced process must be killed, not orphaned");
        assert!(alive(&second));
        state.stop_window("w");
        assert!(second.is_stopped());
    }

    #[test]
    fn one_start_lock_per_window_label() {
        let state = AppState::default();
        assert!(Arc::ptr_eq(&state.start_lock("a"), &state.start_lock("a")));
        assert!(!Arc::ptr_eq(&state.start_lock("a"), &state.start_lock("b")));
    }

    #[test]
    fn stop_all_stops_every_process_in_parallel_and_includes_background_stops() {
        let state = AppState::default();
        let (a, b, c) = (sleeper(), sleeper(), sleeper());
        state.install("a", a.clone());
        state.install("b", b.clone());
        state.install("c", c.clone());
        state.stop_window_in_background("c");
        state.stop_all();
        assert!(a.is_stopped() && b.is_stopped() && c.is_stopped());
    }

    #[test]
    fn answers_fs_requests_and_ignores_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "hello\nworld\n").unwrap();
        let req = json!({
            "jsonrpc": "2.0", "id": 5, "method": "fs/read_text_file",
            "params": { "sessionId": "s", "path": "f.txt", "line": 2 }
        })
        .to_string();
        let reply: Value = serde_json::from_str(&fs::answer(dir.path(), &fs::parse_request(&req).unwrap())).unwrap();
        assert_eq!(reply["id"], 5);
        assert_eq!(reply["result"]["content"], "world\n");

        let outside = json!({
            "jsonrpc": "2.0", "id": 6, "method": "fs/read_text_file",
            "params": { "path": "/etc/hosts" }
        })
        .to_string();
        let reply: Value = serde_json::from_str(&fs::answer(dir.path(), &fs::parse_request(&outside).unwrap())).unwrap();
        assert_eq!(reply["id"], 6);
        assert!(reply["error"]["message"].as_str().unwrap().contains("outside"));

        let other = json!({"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{}}).to_string();
        assert!(fs::parse_request(&other).is_none());
        let notification = json!({"jsonrpc":"2.0","method":"fs/read_text_file","params":{"path":"f.txt"}}).to_string();
        assert!(fs::parse_request(&notification).is_none());
        assert!(fs::parse_request("not json").is_none());
    }
}
