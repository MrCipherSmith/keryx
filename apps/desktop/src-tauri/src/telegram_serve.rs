//! Desktop's owned `keryx serve` process. Never signals a process discovered by PID.
use serde::{Deserialize, Serialize};
use std::{fs::{self, OpenOptions}, io::Read, path::PathBuf, process::{Child, Command, Stdio}, sync::{Mutex, atomic::{AtomicU8, Ordering}}, thread, time::{Duration, Instant}};

const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
const POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServeStatus {
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ownership: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_sessions: Option<u64>,
}
impl ServeStatus {
    fn new(state: &str, reason: Option<String>) -> Self { Self { state: state.into(), ownership: None, reason, active_sessions: None } }
    fn running(ownership: &'static str, active_sessions: Option<u64>) -> Self { Self { state: "running".into(), ownership: Some(ownership), reason: None, active_sessions } }
    fn owned_if(mut self, held: bool) -> Self { if held { self.ownership = Some("desktop"); } self }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Probe { schema_version: u32, state: String, reason: Option<String>, pid: Option<u32>, active_sessions: Option<u64> }

#[derive(Default)]
pub struct TelegramServe { child: Mutex<Option<Child>>, operation_lock: Mutex<Option<OperationLock>>, phase: AtomicU8 }

struct Phase<'a>(&'a AtomicU8);
impl Drop for Phase<'_> { fn drop(&mut self) { self.0.store(0, Ordering::Release); } }

fn executable() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "Cannot locate the bundled Keryx executable.")?;
    crate::locator::bundled(exe.parent()).ok_or_else(|| "The bundled Keryx executable is unavailable.".into())
}

// A kernel lock is shared by Desktop launches and is released even if the app crashes.
#[cfg(unix)]
struct OperationLock(std::fs::File);
#[cfg(unix)]
impl OperationLock {
    fn acquire(until: Instant) -> Result<Self, String> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))).ok_or("Cannot locate the local configuration directory.")?;
        let dir = base.join("keryx");
        fs::create_dir_all(&dir).map_err(|_| "Cannot access the local configuration directory.")?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|_| "Cannot secure the local configuration directory.")?;
        let file = OpenOptions::new().read(true).write(true).create(true).mode(0o600).open(dir.join("desktop-serve.lock")).map_err(|_| "Cannot open the serve operation lock.")?;
        loop {
            if Instant::now() >= until { return Err("Another Desktop serve operation is still running.".into()); }
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 { return Ok(Self(file)); }
            if Instant::now() >= until { return Err("Another Desktop serve operation is still running.".into()); }
            thread::sleep(POLL);
        }
    }
}
#[cfg(unix)]
impl Drop for OperationLock { fn drop(&mut self) { use std::os::fd::AsRawFd; unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN); } } }
#[cfg(not(unix))]
struct OperationLock;
#[cfg(not(unix))]
impl OperationLock { fn acquire(_until: Instant) -> Result<Self, String> { Err("Desktop serve supervision is unavailable on this platform.".into()) } }

fn control(exe: &PathBuf, action: &str, complete: bool, until: Instant) -> Result<Probe, String> {
    let mut command = Command::new(exe);
    command.args(["serve", "desktop-control", action]);
    if complete { command.arg("--complete-setup"); }
    run_control(command, until)
}

fn run_control(mut command: Command, until: Instant) -> Result<Probe, String> {
    if Instant::now() >= until { return Err("The local serve control timed out.".into()); }
    let mut process = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "Could not run the local serve control.")?;
    let status = loop {
        match process.try_wait() {
            Ok(Some(status)) => break status,
            Err(_) => { let _ = process.kill(); let _ = process.wait(); return Err("Cannot confirm the local serve control exited.".into()); },
            Ok(None) => {}
        }
        if Instant::now() >= until { let _ = process.kill(); let _ = process.wait(); return Err("The local serve control timed out.".into()); }
        thread::sleep(POLL.min(until.saturating_duration_since(Instant::now())));
    };
    let stdout = process.stdout.take().ok_or("Could not read the local serve control response.")?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let fd = stdout.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 { return Err("Could not read the local serve control response.".into()); }
    }
    let mut output = Vec::new();
    stdout.take(4097).read_to_end(&mut output).map_err(|_| "Could not read the local serve control response.")?;
    if !status.success() || output.len() > 4096 { return Err("The local serve control failed.".into()); }
    let result: Probe = serde_json::from_slice(&output).map_err(|_| "The local serve control returned an invalid response.")?;
    if result.schema_version != 1 { return Err("The bundled serve control is incompatible.".into()); }
    Ok(result)
}

impl TelegramServe {
    fn status_locked(child: &mut Option<Child>, exe: &PathBuf, until: Instant) -> ServeStatus {
        if let Some(process) = child.as_mut() {
            match process.try_wait() {
                Ok(Some(_)) => *child = None,
                Err(_) => return ServeStatus::new("failed", Some("Cannot confirm the managed process has exited.".into())).owned_if(true),
                Ok(None) => {}
            }
        }
        let status = match control(exe, "status", false, until) {
            Ok(probe) if probe.state == "running" && child.as_ref().is_some_and(|c| Some(c.id()) != probe.pid) => ServeStatus::new("failed", Some("A different process answered while the managed process is still running.".into())),
            Ok(probe) if probe.state == "running" => ServeStatus::running(if child.is_some() { "desktop" } else { "external" }, probe.active_sessions),
            Ok(probe) if child.is_some() => ServeStatus::new("failed", Some(probe.reason.unwrap_or_else(|| "The managed process has not proved readiness. Stop it before retrying.".into()))),
            Ok(probe) => ServeStatus::new(&probe.state, probe.reason),
            Err(reason) => ServeStatus::new("failed", Some(reason)),
        };
        status.owned_if(child.is_some())
    }
    fn status(&self) -> ServeStatus {
        match self.phase.load(Ordering::Acquire) {
            1 => return ServeStatus::new("starting", None),
            2 => return ServeStatus::new("stopping", None),
            _ => {}
        }
        let Ok(mut child) = self.child.lock() else { return ServeStatus::new("failed", Some("The serve supervisor is unavailable.".into())); };
        let status = match executable() { Ok(exe) => Self::status_locked(&mut child, &exe, Instant::now() + START_TIMEOUT), Err(reason) => ServeStatus::new("blocked", Some(reason)).owned_if(child.is_some()) };
        if child.is_none() { if let Ok(mut lock) = self.operation_lock.lock() { *lock = None; } }
        status
    }
    fn start_locked(child: &mut Option<Child>, exe: &PathBuf, complete: bool, until: Instant) -> ServeStatus {
        let initial = Self::status_locked(child, exe, until);
        if initial.state == "running" || initial.state == "blocked" || initial.state == "failed" || child.is_some() { return initial; }
        let setup = match control(exe, "bootstrap", complete, until) { Ok(value) => value, Err(reason) => return ServeStatus::new("failed", Some(reason)) };
        if setup.state != "ready" { return ServeStatus::new(&setup.state, setup.reason); }
        if Instant::now() >= until { return ServeStatus::new("failed", Some("Serve startup timed out before launch; retry.".into())); }
        match Command::new(exe).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
            Ok(process) => *child = Some(process),
            Err(_) => return ServeStatus::new("failed", Some("Could not start the bundled serve process.".into())),
        }
        loop {
            let status = Self::status_locked(child, exe, until);
            if status.state == "running" || child.is_none() { return status; }
            if Instant::now() >= until { return ServeStatus::new("failed", Some("Serve did not prove readiness in time. Stop the managed process before retrying.".into())).owned_if(child.is_some()); }
            thread::sleep(POLL.min(until.saturating_duration_since(Instant::now())));
        }
    }
    fn stop_locked(child: &mut Option<Child>) -> ServeStatus {
        let Some(process) = child.as_mut() else { return ServeStatus::new("stopped", None); };
        match process.try_wait() { Ok(Some(_)) => { *child = None; return ServeStatus::new("stopped", None); }, Err(_) => return ServeStatus::new("failed", Some("Cannot confirm the managed process has exited.".into())).owned_if(true), Ok(None) => {} }
        #[cfg(unix)]
        if unsafe { libc::kill(process.id() as libc::pid_t, libc::SIGTERM) } != 0 { return ServeStatus::new("failed", Some("Could not stop the managed process.".into())).owned_if(true); }
        #[cfg(not(unix))]
        return ServeStatus::new("failed", Some("Stopping the managed process is unavailable on this platform.".into())).owned_if(true);
        let until = Instant::now() + STOP_TIMEOUT;
        loop {
            match process.try_wait() {
                Ok(Some(_)) => { *child = None; return ServeStatus::new("stopped", None); },
                Err(_) => return ServeStatus::new("failed", Some("Cannot confirm the managed process has exited.".into())).owned_if(true),
                Ok(None) => {}
            }
            if Instant::now() >= until { return ServeStatus::new("failed", Some("Serve has not exited; retry stopping it.".into())).owned_if(true); }
            thread::sleep(POLL);
        }
    }
    fn operate(&self, action: &str, complete: bool) -> ServeStatus {
        let until = Instant::now() + START_TIMEOUT;
        let mut child = match self.child.try_lock() {
            Ok(child) => child,
            Err(std::sync::TryLockError::WouldBlock) => return ServeStatus::new(if self.phase.load(Ordering::Acquire) == 2 { "stopping" } else { "starting" }, None),
            Err(std::sync::TryLockError::Poisoned(_)) => return ServeStatus::new("failed", Some("The serve supervisor is unavailable.".into())),
        };
        self.phase.store(if action == "start" { 1 } else { 2 }, Ordering::Release);
        let _phase = Phase(&self.phase);
        let Ok(mut held) = self.operation_lock.lock() else { return ServeStatus::new("failed", Some("The serve supervisor is unavailable.".into())).owned_if(child.is_some()); };
        if action == "stop" && child.is_some() {
            let stopped = Self::stop_locked(&mut child);
            if child.is_none() { *held = None; }
            return stopped;
        }
        let exe = match executable() { Ok(exe) => exe, Err(reason) => return ServeStatus::new("blocked", Some(reason)).owned_if(child.is_some()) };
        if child.is_none() {
            let status = Self::status_locked(&mut child, &exe, until);
            if status.state == "running" { return if action == "start" { status } else { ServeStatus::new("blocked", Some("This serve is owned outside Desktop; stop it from its owning process.".into())) }; }
            *held = None;
        }
        if held.is_none() {
            *held = match OperationLock::acquire(until) { Ok(lock) => Some(lock), Err(reason) => return ServeStatus::new("blocked", Some(reason)).owned_if(child.is_some()) };
        }
        if action != "start" {
            let status = Self::status_locked(&mut child, &exe, until);
            if child.is_none() && status.state == "running" { return ServeStatus::new("blocked", Some("This serve is owned outside Desktop; stop it from its owning process.".into())); }
            let stopped = Self::stop_locked(&mut child);
            if action == "stop" || stopped.state != "stopped" { if child.is_none() { *held = None; } return stopped; }
            self.phase.store(1, Ordering::Release);
        }
        let result = Self::start_locked(&mut child, &exe, complete, until);
        if child.is_none() { *held = None; }
        result
    }
    pub fn shutdown(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = Self::stop_locked(&mut child);
            if let Some(process) = child.as_mut() {
                // A managed child must not outlive the application and its lock.
                let _ = process.kill();
                let _ = process.wait();
                *child = None;
            }
            if let Ok(mut lock) = self.operation_lock.lock() { *lock = None; }
        }
    }
}

#[tauri::command]
pub async fn telegram_serve_status(state: tauri::State<'_, std::sync::Arc<TelegramServe>>) -> Result<ServeStatus, String> {
    let state = state.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || state.status()).await.unwrap_or_else(|_| ServeStatus::new("failed", Some("The serve supervisor failed.".into()))))
}
#[tauri::command]
pub async fn telegram_serve_start(state: tauri::State<'_, std::sync::Arc<TelegramServe>>, complete_setup: Option<bool>) -> Result<ServeStatus, String> {
    let state = state.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || state.operate("start", complete_setup.unwrap_or(false))).await.unwrap_or_else(|_| ServeStatus::new("failed", Some("The serve supervisor failed.".into()))))
}
#[tauri::command]
pub async fn telegram_serve_stop(state: tauri::State<'_, std::sync::Arc<TelegramServe>>) -> Result<ServeStatus, String> {
    let state = state.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || state.operate("stop", false)).await.unwrap_or_else(|_| ServeStatus::new("failed", Some("The serve supervisor failed.".into()))))
}
#[tauri::command]
pub async fn telegram_serve_restart(state: tauri::State<'_, std::sync::Arc<TelegramServe>>) -> Result<ServeStatus, String> {
    let state = state.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || state.operate("restart", false)).await.unwrap_or_else(|_| ServeStatus::new("failed", Some("The serve supervisor failed.".into()))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_session_count_is_exposed_in_running_status() {
        let probe: Probe = serde_json::from_str(r#"{"schemaVersion":1,"state":"running","activeSessions":2}"#).unwrap();
        let status = ServeStatus::running("desktop", probe.active_sessions);
        assert_eq!(serde_json::to_value(status).unwrap()["activeSessions"], 2);
    }

    #[test]
    #[ignore]
    fn owned_child_fixture() { loop { thread::sleep(Duration::from_secs(1)); } }

    #[test]
    fn stop_reaps_only_the_held_child_and_is_idempotent() {
        let process = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "telegram_serve::tests::owned_child_fixture", "--ignored"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut child = Some(process);
        assert_eq!(TelegramServe::stop_locked(&mut child).state, "stopped");
        assert!(child.is_none());
        assert_eq!(TelegramServe::stop_locked(&mut child).state, "stopped");
    }

    #[test]
    fn failed_readiness_keeps_owned_child_stoppable() {
        let process = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "telegram_serve::tests::owned_child_fixture", "--ignored"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut child = Some(process);
        let result = TelegramServe::status_locked(&mut child, &std::env::current_exe().unwrap(), Instant::now() + Duration::from_secs(1));
        assert_eq!(result.state, "failed");
        assert_eq!(result.ownership, Some("desktop"));
        assert_eq!(TelegramServe::stop_locked(&mut child).state, "stopped");
    }

    #[test]
    fn a_stalled_probe_obeys_the_shared_deadline() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "telegram_serve::tests::owned_child_fixture", "--ignored"]);
        let started = Instant::now();
        let result = run_control(command, started + Duration::from_millis(150));
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
