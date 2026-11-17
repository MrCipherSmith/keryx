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
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Overall budget for stopping every window at app quit.
pub const QUIT_DEADLINE: Duration = Duration::from_secs(7);

#[derive(Default)]
struct Sessions {
    live: HashMap<String, Arc<AcpProcess>>,
    /// Labels of destroyed windows. Labels are never reused, so a start that
    /// finishes for one of these must not install its process.
    closed: HashSet<String>,
}

#[derive(Default)]
pub struct AppState {
    sessions: Mutex<Sessions>,
    /// Processes being stopped (window closed, replaced, or started late).
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

const WINDOW_CLOSED: &str = "This window was closed while keryx was starting";

impl AppState {
    /// The login-shell environment, captured once (blocks the first caller).
    pub fn environment(&self) -> &HashMap<String, String> {
        self.login_env.get_or_init(shellenv::resolve_environment)
    }

    /// The per-window lock that serialises `acp_start` for one label; `None`
    /// once the window is destroyed.
    fn start_lock(&self, label: &str) -> Option<Arc<Mutex<()>>> {
        // Lock order: sessions, then start_locks (as in `window_destroyed`).
        let sessions = self.sessions.lock().unwrap();
        if sessions.closed.contains(label) {
            return None;
        }
        Some(self.start_locks.lock().unwrap().entry(label.to_string()).or_default().clone())
    }

    /// Start a session for `label`: stop the current one, run `launch`, and
    /// install the process it returns. Serialised per window; blocking, so
    /// callers run it off the async runtime.
    fn start_session<T>(
        &self,
        label: &str,
        launch: impl FnOnce() -> Result<(Arc<AcpProcess>, T), String>,
    ) -> Result<T, String> {
        let start_lock = self.start_lock(label).ok_or(WINDOW_CLOSED)?;
        let _starting = start_lock.lock().unwrap();
        self.stop_window(label);
        let (proc, info) = launch()?;
        self.install(label, proc)?;
        Ok(info)
    }

    /// Register `proc` for `label` and stop whatever it replaces, so a second
    /// start can never leave the first process running unowned. A window that
    /// was destroyed meanwhile gets nothing installed: its process is stopped.
    fn install(&self, label: &str, proc: Arc<AcpProcess>) -> Result<(), String> {
        let previous = {
            let mut sessions = self.sessions.lock().unwrap();
            if sessions.closed.contains(label) {
                drop(sessions);
                self.stop_tracked(proc);
                return Err(WINDOW_CLOSED.into());
            }
            sessions.live.insert(label.to_string(), proc)
        };
        if let Some(old) = previous {
            self.stop_tracked(old);
        }
        Ok(())
    }

    /// Stop `proc` on this thread, listed in `stopping` meanwhile so a quit
    /// that lands during the grace still waits for it.
    fn stop_tracked(&self, proc: Arc<AcpProcess>) {
        self.stopping.lock().unwrap().push(proc.clone());
        proc.kill();
        self.stopping.lock().unwrap().retain(|p| !Arc::ptr_eq(p, &proc));
    }

    /// Stop the window's process and wait until it is gone.
    pub fn stop_window(&self, label: &str) {
        let proc = self.sessions.lock().unwrap().live.remove(label);
        if let Some(p) = proc {
            self.stop_tracked(p);
        }
    }

    /// The window was destroyed: mark its label closed (so an in-flight start
    /// stops what it spawns), drop its start lock, and stop its process on a
    /// background thread (called from the event loop, which must not wait out
    /// the grace period).
    pub fn window_destroyed(&self, label: &str) {
        let proc = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.closed.insert(label.to_string());
            self.start_locks.lock().unwrap().remove(label);
            sessions.live.remove(label)
        };
        self.pending_cwd.lock().unwrap().remove(label);
        let Some(proc) = proc else { return };
        self.stopping.lock().unwrap().push(proc.clone());
        let stopping = self.stopping.clone();
        std::thread::spawn(move || {
            proc.kill();
            stopping.lock().unwrap().retain(|p| !Arc::ptr_eq(p, &proc));
        });
    }

    fn session(&self, label: &str) -> Option<Arc<AcpProcess>> {
        self.sessions.lock().unwrap().live.get(label).cloned()
    }

    /// App quit: stop everything in parallel within one overall deadline.
    pub fn stop_all(&self) {
        let mut all: Vec<_> = self.sessions.lock().unwrap().live.drain().map(|(_, p)| p).collect();
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
    cwd: String,
    no_profile: Option<bool>,
) -> Result<StartInfo, String> {
    let label = window.label().to_string();
    // Stopping the previous process (grace), the login-env capture, git and
    // the spawn all block: keep them off the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.start_session(&label, || launch(&app, &state, &label, &cwd, no_profile.unwrap_or(false)))
    })
    .await
    .map_err(|e| format!("keryx start failed: {e}"))?
}

/// Locate and spawn keryx for one window; the caller installs the process.
fn launch(
    app: &AppHandle,
    state: &AppState,
    label: &str,
    cwd: &str,
    no_profile: bool,
) -> Result<(Arc<AcpProcess>, StartInfo), String> {
    let root = Path::new(cwd)
        .canonicalize()
        .map_err(|e| format!("The project folder is not available ({cwd}): {e}"))?;
    if !root.is_dir() {
        return Err(format!("Not a folder: {cwd}"));
    }

    let env = state.environment().clone();
    // Reads are confined to the git toplevel, which is what keryx binds its session to.
    let fs_root = fs::project_root(&root, env.get("PATH").map(String::as_str));
    let settings = load_settings(app);
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let located = locator::locate(
        settings.keryx_source,
        settings.custom_path.as_deref(),
        exe_dir.as_deref(),
        env.get("PATH").map(std::ffi::OsString::from).as_deref(),
    )?;

    let mut args = vec!["acp".to_string()];
    if !no_profile {
        args.push("--profile".into());
        args.push("shell".into());
    }
    let log_path = app
        .path()
        .app_log_dir()
        .map(|d| d.join(format!("keryx-acp-{label}.log")))
        .map_err(|e| e.to_string())?;

    let emit_app = app.clone();
    let emit_label = label.to_string();
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

    let info = StartInfo {
        keryx_path: located.path.display().to_string(),
        source: located.source,
        note: located.note,
        log_path: log_path.display().to_string(),
        min_keryx_version: version::MIN_KERYX_VERSION,
    };
    Ok((proc, info))
}

/// Queue a message for the window's keryx. Async so it never runs on the main
/// thread; `send_line` itself never waits on the pipe.
#[tauri::command]
pub async fn acp_send(window: WebviewWindow, state: State<'_, AppState>, message: String) -> Result<(), String> {
    let proc = state.session(window.label()).ok_or("keryx is not running in this window")?;
    proc.send_line(&message)
}

#[tauri::command]
pub async fn acp_stop(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    // The stop waits out the grace period: keep it off the async runtime.
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().stop_window(&label))
        .await
        .map_err(|e| format!("keryx stop failed: {e}"))
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
        state.install("w", first.clone()).unwrap();
        assert!(alive(&first));
        state.install("w", second.clone()).unwrap();
        assert!(first.is_stopped(), "the replaced process must be killed, not orphaned");
        assert!(alive(&second));
        state.stop_window("w");
        assert!(second.is_stopped());
    }

    #[test]
    fn one_start_lock_per_window_label() {
        let state = AppState::default();
        let a = state.start_lock("a").unwrap();
        assert!(Arc::ptr_eq(&a, &state.start_lock("a").unwrap()));
        assert!(!Arc::ptr_eq(&a, &state.start_lock("b").unwrap()));
    }

    #[test]
    fn a_window_destroyed_during_start_gets_its_late_process_stopped() {
        let state = AppState::default();
        let mut spawned = None;
        let result = state.start_session("w", || {
            // The window closes while keryx is being located and spawned.
            state.window_destroyed("w");
            let p = sleeper();
            spawned = Some(p.clone());
            Ok((p, ()))
        });
        assert!(result.is_err(), "a start for a destroyed window must report failure");
        let late = spawned.unwrap();
        assert!(late.is_stopped(), "the late process must be killed, not left running unowned");
        assert!(state.session("w").is_none());
        assert!(state.stopping.lock().unwrap().is_empty());
    }

    #[test]
    fn a_destroyed_window_drops_its_start_lock_and_refuses_new_starts() {
        let state = AppState::default();
        state.start_lock("w").unwrap();
        state.window_destroyed("w");
        assert!(!state.start_locks.lock().unwrap().contains_key("w"));
        assert!(state.start_lock("w").is_none());
        let mut launched = false;
        let result = state.start_session("w", || {
            launched = true;
            Ok((sleeper(), ()))
        });
        assert!(result.is_err());
        assert!(!launched, "nothing is spawned for a closed window");
        assert!(!state.start_locks.lock().unwrap().contains_key("w"));
    }

    #[test]
    fn stop_all_stops_every_process_in_parallel_and_includes_background_stops() {
        let state = AppState::default();
        let (a, b, c) = (sleeper(), sleeper(), sleeper());
        state.install("a", a.clone()).unwrap();
        state.install("b", b.clone()).unwrap();
        state.install("c", c.clone()).unwrap();
        state.window_destroyed("c");
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
