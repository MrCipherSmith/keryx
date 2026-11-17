//! Tauri commands that connect a window to its own `keryx acp` process.
//!
//! The Rust core does not interpret ACP beyond framing and the `fs/*`
//! handler: every other line goes to the window verbatim as `acp://message`.

use crate::fs;
use crate::locator::{self, KeryxSource};
use crate::navigation;
use crate::process::{AcpProcess, ProcessEvent, SpawnConfig, GRACEFUL_STOP};
use crate::settings;
use crate::shellenv;
use crate::version;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};

/// Overall budget for stopping every window at app quit. It must outlast one
/// graceful stop, or the quit gives up before the process-group SIGKILL.
pub const QUIT_DEADLINE: Duration = Duration::from_millis(GRACEFUL_STOP.as_millis() as u64 + 2500);

/// A process installed for a window, with the start that installed it.
struct Installed {
    start: u64,
    proc: Arc<AcpProcess>,
}

/// Per window label, numbered in the order the commands were invoked.
#[derive(Default, Clone, Copy)]
struct Epochs {
    /// The newest `acp_start` issued.
    started: u64,
    /// Every start up to this one was cancelled by an `acp_stop`.
    stopped_through: u64,
}

#[derive(Default)]
struct Sessions {
    live: HashMap<String, Installed>,
    /// Labels of destroyed windows. Labels are never reused, so a start that
    /// finishes for one of these must not install its process.
    closed: HashSet<String>,
    epochs: HashMap<String, Epochs>,
}

#[derive(Default)]
pub struct AppState {
    sessions: Mutex<Sessions>,
    /// Processes being stopped (window closed, replaced, or started late).
    stopping: Arc<Mutex<Vec<Arc<AcpProcess>>>>,
    /// One lock per live window label, held by `start_session` across stop,
    /// launch and install; removed when the window is destroyed.
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
const START_CANCELLED: &str = "This keryx start was cancelled by a stop issued after it";
const START_SUPERSEDED: &str = "A newer keryx start for this window replaced this one";

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

    /// Number a new start for `label`. Called by `acp_start` before it leaves
    /// for a blocking worker, so starts and stops are ordered as the commands
    /// were invoked, not as the workers reach the start lock.
    pub fn begin_start(&self, label: &str) -> u64 {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.closed.contains(label) {
            return 0;
        }
        let e = sessions.epochs.entry(label.to_string()).or_default();
        e.started += 1;
        e.started
    }

    /// Cancel every start issued so far for `label` and return the newest one:
    /// the stop applies to those starts and never to a later one. Called by
    /// `acp_stop` before it leaves for a blocking worker.
    pub fn begin_stop(&self, label: &str) -> u64 {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.closed.contains(label) {
            return 0;
        }
        let e = sessions.epochs.entry(label.to_string()).or_default();
        e.stopped_through = e.started;
        e.started
    }

    /// Start session `start` (from `begin_start`) for `label`: stop the process
    /// an older start installed, run `launch`, and install what it returns.
    /// Serialised per window; blocking, so callers run it off the async
    /// runtime. A start cancelled by a later stop, or overtaken by a newer
    /// start, installs nothing.
    fn start_session<T>(
        &self,
        label: &str,
        start: u64,
        launch: impl FnOnce() -> Result<(Arc<AcpProcess>, T), String>,
    ) -> Result<T, String> {
        let start_lock = self.start_lock(label).ok_or(WINDOW_CLOSED)?;
        let _starting = start_lock.lock().unwrap();
        self.stop_older(label, start)?;
        let (proc, info) = launch()?;
        self.install(label, start, proc)?;
        Ok(info)
    }

    /// Why start `start` must not go on, if it must not.
    fn refusal(sessions: &Sessions, label: &str, start: u64) -> Option<&'static str> {
        if sessions.closed.contains(label) {
            return Some(WINDOW_CLOSED);
        }
        if sessions.epochs.get(label).is_some_and(|e| start <= e.stopped_through) {
            return Some(START_CANCELLED);
        }
        if sessions.epochs.get(label).is_some_and(|e| e.started > start) {
            return Some(START_SUPERSEDED);
        }
        None
    }

    /// Before launching start `start`: refuse it if it no longer applies, else
    /// stop the process an older start installed.
    fn stop_older(&self, label: &str, start: u64) -> Result<(), String> {
        let old = {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(why) = Self::refusal(&sessions, label, start) {
                return Err(why.into());
            }
            sessions.live.remove(label)
        };
        if let Some(old) = old {
            self.stop_tracked(old.proc);
        }
        Ok(())
    }

    /// Register `proc` as start `start` of `label` and stop whatever it
    /// replaces, so a second start can never leave the first process running
    /// unowned. A start that no longer applies (window destroyed, cancelled by a
    /// later stop, overtaken by a newer start) gets nothing installed: its
    /// process is stopped.
    fn install(&self, label: &str, start: u64, proc: Arc<AcpProcess>) -> Result<(), String> {
        let previous = {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(why) = Self::refusal(&sessions, label, start) {
                drop(sessions);
                self.stop_tracked(proc);
                return Err(why.into());
            }
            sessions.live.insert(label.to_string(), Installed { start, proc })
        };
        if let Some(old) = previous {
            self.stop_tracked(old.proc);
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

    /// `acp_stop`, with `through` from `begin_stop`: stop the process a start
    /// up to `through` installed, and wait until it is gone. A start still in
    /// flight that the stop cancelled stops its own process when it finishes
    /// (`install` refuses it), so the stop need not wait for it; a later start's
    /// process is never touched.
    pub fn stop_session(&self, label: &str, through: u64) {
        let proc = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.live.get(label) {
                Some(i) if i.start <= through => sessions.live.remove(label).map(|i| i.proc),
                _ => None,
            }
        };
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
            sessions.epochs.remove(label);
            self.start_locks.lock().unwrap().remove(label);
            sessions.live.remove(label).map(|i| i.proc)
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
        self.sessions.lock().unwrap().live.get(label).map(|i| i.proc.clone())
    }

    /// App quit: stop everything in parallel within one overall deadline.
    pub fn stop_all(&self) {
        let mut all: Vec<_> = self.sessions.lock().unwrap().live.drain().map(|(_, i)| i.proc).collect();
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

/// Workers answering `fs/read_text_file` for one keryx process.
const FS_WORKERS: usize = 2;

/// Answers `fs/read_text_file` off the stdout reader thread (a slow disk must
/// not stall the stream of agent messages) on a fixed pool of workers. Excess
/// requests wait in the channel as small parsed requests, so a keryx that
/// stops reading its stdin holds at most `FS_WORKERS` built replies outside
/// the stdin queue: the per-window bound is the queue budget plus
/// `FS_WORKERS` x the 16 MiB frame. The workers end once the process's reader
/// threads, which own the sender, are gone.
struct FsPool {
    jobs: mpsc::Sender<(Arc<AcpProcess>, fs::FsRequest)>,
}

impl FsPool {
    fn new(root: PathBuf) -> Self {
        let (jobs, queue) = mpsc::channel::<(Arc<AcpProcess>, fs::FsRequest)>();
        let queue = Arc::new(Mutex::new(queue));
        for _ in 0..FS_WORKERS {
            let (queue, root) = (queue.clone(), root.clone());
            std::thread::spawn(move || loop {
                let next = queue.lock().unwrap().recv();
                let Ok((proc, request)) = next else { return };
                answer_fs(&proc, &root, &request);
            });
        }
        Self { jobs }
    }

    fn submit(&self, proc: &Arc<AcpProcess>, request: fs::FsRequest) {
        let _ = self.jobs.send((proc.clone(), request));
    }
}

/// Answer one request. keryx waits for this reply with no timeout, so it goes
/// through `send_response`, which waits for queue room instead of dropping it.
fn answer_fs(proc: &Arc<AcpProcess>, root: &Path, request: &fs::FsRequest) {
    if proc.is_stopped() {
        return;
    }
    let reply = fs::answer(root, request);
    if proc.send_response(reply).is_err() && !proc.is_stopped() {
        // Only a reply that cannot be framed gets here (`fs::answer` already
        // turns those into errors, so this is a last resort): never leave
        // keryx waiting, send an error for this id.
        let err = fs::RpcError { code: fs::INTERNAL_ERROR, message: "reply could not be sent".into() };
        let _ = proc.send_response(fs::error_response(&request.id, &err).to_string());
    }
}

#[tauri::command]
pub async fn acp_start(
    app: AppHandle,
    window: Window,
    cwd: String,
    no_profile: Option<bool>,
) -> Result<StartInfo, String> {
    let label = window.label().to_string();
    // Numbered before the first await: see `begin_start`.
    let start = app.state::<AppState>().begin_start(&label);
    // Stopping the previous process (grace), the login-env capture, git and
    // the spawn all block: keep them off the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.start_session(&label, start, || launch(&app, &label, &cwd, no_profile.unwrap_or(false)))
    })
    .await
    .map_err(|e| format!("keryx start failed: {e}"))?
}

/// Locate and spawn keryx for one window; the caller installs the process.
fn launch(app: &AppHandle, label: &str, cwd: &str, no_profile: bool) -> Result<(Arc<AcpProcess>, StartInfo), String> {
    let root = Path::new(cwd)
        .canonicalize()
        .map_err(|e| format!("The project folder is not available ({cwd}): {e}"))?;
    if !root.is_dir() {
        return Err(format!("Not a folder: {cwd}"));
    }

    let env = app.state::<AppState>().environment().clone();
    // Reads are confined to the git toplevel, which is what keryx binds its session to.
    let fs_root = fs::project_root(&root, env.get("PATH").map(String::as_str));
    let settings = settings::load_settings(app);
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
    let fs_pool = FsPool::new(fs_root);
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
                        fs_pool.submit(proc, request);
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

/// Queue a message for the window's keryx.
///
/// Deliberately a sync command: Tauri runs sync commands on the main thread
/// one after another, in the order the web view invoked them, so messages
/// reach the stdin queue in send order. An async command runs on a pool of
/// workers, and two sends issued back to back could be queued swapped. Sync is
/// safe here because `send_line` never waits: it only pushes onto the queue
/// under a short lock and fails at once when the queue is full.
#[tauri::command]
pub fn acp_send(window: Window, state: State<'_, AppState>, message: String) -> Result<(), String> {
    let proc = state.session(window.label()).ok_or("keryx is not running in this window")?;
    proc.send_line(&message)
}

#[tauri::command]
pub async fn acp_stop(app: AppHandle, window: Window) -> Result<(), String> {
    let label = window.label().to_string();
    // Bound to the starts issued before it, before the first await: see
    // `begin_stop`.
    let through = app.state::<AppState>().begin_stop(&label);
    // The stop waits out the grace period: keep it off the async runtime.
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().stop_session(&label, through))
        .await
        .map_err(|e| format!("keryx stop failed: {e}"))
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
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Keryx")
        .inner_size(1180.0, 780.0)
        .min_inner_size(720.0, 480.0);
    navigation::guard(builder, navigation::dev_url(&app)).build().map_err(|e| e.to_string())?;
    Ok(())
}

/// The folder a freshly created project window should open (taken once).
#[tauri::command]
pub fn window_initial_cwd(window: Window, state: State<'_, AppState>) -> Option<String> {
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
        state.install("w", state.begin_start("w"), first.clone()).unwrap();
        assert!(alive(&first));
        state.install("w", state.begin_start("w"), second.clone()).unwrap();
        assert!(first.is_stopped(), "the replaced process must be killed, not orphaned");
        assert!(alive(&second));
        state.stop_session("w", state.begin_stop("w"));
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
        let result = state.start_session("w", state.begin_start("w"), || {
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
        let result = state.start_session("w", state.begin_start("w"), || {
            launched = true;
            Ok((sleeper(), ()))
        });
        assert!(result.is_err());
        assert!(!launched, "nothing is spawned for a closed window");
        assert!(!state.start_locks.lock().unwrap().contains_key("w"));
        assert!(!state.sessions.lock().unwrap().epochs.contains_key("w"));
    }

    /// Runs a start on a thread whose launch signals `launching`, waits for
    /// `release`, then spawns a sleeper (recorded in the returned slot).
    #[allow(clippy::type_complexity)]
    fn slow_start(
        state: &Arc<AppState>,
        start: u64,
        launching: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    ) -> (std::thread::JoinHandle<Result<(), String>>, Arc<Mutex<Option<Arc<AcpProcess>>>>) {
        let slot: Arc<Mutex<Option<Arc<AcpProcess>>>> = Arc::default();
        let (starter, out) = (state.clone(), slot.clone());
        let handle = std::thread::spawn(move || {
            starter.start_session("w", start, || {
                launching.send(()).unwrap();
                release.recv().unwrap();
                let p = sleeper();
                *out.lock().unwrap() = Some(p.clone());
                Ok((p, ()))
            })
        });
        (handle, slot)
    }

    #[test]
    fn a_stop_during_a_start_cancels_it_and_its_process_is_stopped() {
        let state = Arc::new(AppState::default());
        let (launching_tx, launching_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (start, spawned) = slow_start(&state, state.begin_start("w"), launching_tx, release_rx);
        launching_rx.recv().unwrap();
        // keryx is still being located and spawned when the stop arrives.
        state.stop_session("w", state.begin_stop("w"));
        release_tx.send(()).unwrap();
        assert_eq!(start.join().unwrap().unwrap_err(), START_CANCELLED);
        let late = spawned.lock().unwrap().clone().expect("the start spawned a process");
        assert!(late.is_stopped(), "the stop must reach the process the start was launching");
        assert!(state.session("w").is_none());
    }

    /// REG-R3-001: a project switch issues stop (old view) then start (new
    /// view) while an earlier start still holds the start lock. Whichever
    /// worker reaches the lock first, the stop must not kill the new process.
    #[test]
    fn a_stop_queued_behind_a_start_never_kills_a_later_start() {
        let state = Arc::new(AppState::default());
        // Start #1 (view A) is in flight and holds the start lock.
        let (launching_tx, launching_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (first, first_proc) = slow_start(&state, state.begin_start("w"), launching_tx, release_rx);
        launching_rx.recv().unwrap();

        // View A unmounts (stop), view B mounts (start #2): numbered in that order.
        let through = state.begin_stop("w");
        let second_start = state.begin_start("w");
        // Start #2 wins the lock over the stop: the stop's worker runs last.
        let (second_launching_tx, second_launching_rx) = mpsc::channel();
        let (second_release_tx, second_release_rx) = mpsc::channel();
        let (second, second_proc) = slow_start(&state, second_start, second_launching_tx, second_release_rx);
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap().unwrap_err(), START_CANCELLED);
        assert!(first_proc.lock().unwrap().clone().unwrap().is_stopped(), "view A's keryx is stopped");
        second_launching_rx.recv().unwrap();
        second_release_tx.send(()).unwrap();
        second.join().unwrap().unwrap();
        state.stop_session("w", through);

        let new = second_proc.lock().unwrap().clone().unwrap();
        assert!(alive(&new), "the stop meant for view A must not kill view B's keryx");
        assert!(state.session("w").is_some_and(|p| Arc::ptr_eq(&p, &new)));
        state.stop_session("w", state.begin_stop("w"));
        assert!(new.is_stopped());
    }

    #[test]
    fn an_older_start_that_reaches_the_lock_late_does_not_replace_a_newer_one() {
        let state = AppState::default();
        let older = state.begin_start("w");
        let newer = state.begin_start("w");
        let current = sleeper();
        state.start_session("w", newer, || Ok((current.clone(), ()))).unwrap();
        let mut launched = false;
        let late = state.start_session("w", older, || {
            launched = true;
            Ok((sleeper(), ()))
        });
        assert_eq!(late.unwrap_err(), START_SUPERSEDED);
        assert!(!launched);
        assert!(alive(&current));
        state.stop_session("w", state.begin_stop("w"));
    }

    #[test]
    fn an_older_start_is_refused_even_when_the_newer_one_has_not_installed_yet() {
        let state = AppState::default();
        let older = state.begin_start("w");
        let _newer = state.begin_start("w");
        let mut launched = false;
        let late = state.start_session("w", older, || {
            launched = true;
            Ok((sleeper(), ()))
        });
        assert_eq!(late.unwrap_err(), START_SUPERSEDED);
        assert!(!launched);
    }

    #[test]
    fn the_quit_deadline_outlasts_a_graceful_stop() {
        assert!(QUIT_DEADLINE > GRACEFUL_STOP, "quit must reach the process-group SIGKILL");
    }

    #[test]
    fn a_stop_for_a_destroyed_window_is_a_no_op() {
        let state = AppState::default();
        state.window_destroyed("w");
        state.stop_session("w", state.begin_stop("w"));
        assert!(state.start_lock("w").is_none(), "a stop must not resurrect the start lock");
        assert!(!state.sessions.lock().unwrap().epochs.contains_key("w"));
    }

    #[test]
    fn stop_all_stops_every_process_in_parallel_and_includes_background_stops() {
        let state = AppState::default();
        let (a, b, c) = (sleeper(), sleeper(), sleeper());
        state.install("a", state.begin_start("a"), a.clone()).unwrap();
        state.install("b", state.begin_start("b"), b.clone()).unwrap();
        state.install("c", state.begin_start("c"), c.clone()).unwrap();
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
