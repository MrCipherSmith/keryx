//! Spawns and supervises one `keryx acp` child.
//!
//! Independent of Tauri so the live smoke test can drive it directly. Threads:
//! one reads stdout through the line decoder, one drains stderr into a log file
//! (and a short in-memory tail), one owns stdin and writes queued lines, one
//! polls for exit.
//!
//! Two invariants keep a stop safe:
//! - No lock the stop path takes is ever held across a pipe write: lines go to
//!   the writer thread through a bounded queue, so a keryx that stops reading
//!   stdin can stall that thread but never a stop or a caller of `send_line`.
//! - The child is reaped only under the `child` mutex, and only after its
//!   process group was swept. Every raw signal is sent under that mutex after
//!   checking the child is not yet reaped, so a signal never reaches a pid or
//!   process group the kernel may have handed to another process.

use crate::framing::{self, Frame, LineDecoder};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const STDERR_TAIL_BYTES: usize = 4096;
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// Lines waiting for the stdin writer. A keryx that reads its input keeps this
/// near empty; a full queue means keryx stopped reading, and `send_line` fails
/// instead of blocking.
const STDIN_QUEUE_LINES: usize = 32;
const EXIT_POLL: Duration = Duration::from_millis(40);
/// How long keryx gets after stdin closes and SIGTERM lands. Its own shutdown
/// drains background shell tasks (2 s) and MCP servers (up to 4.5 s), so this
/// stays above that sum; only then is the whole process group killed.
pub const GRACEFUL_STOP: Duration = Duration::from_millis(6500);

pub struct SpawnConfig {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub log_path: Option<PathBuf>,
}

#[derive(Debug)]
pub enum ProcessEvent {
    /// One complete stdout line.
    Line(String),
    /// A stdout line exceeded the 16 MiB guard and was dropped.
    Oversized,
    /// The child exited on its own (not via `kill`).
    Exit { code: Option<i32>, stderr_tail: String },
}

struct ChildSlot {
    child: Child,
    /// Set once the child was waited for; its pid may be reused from then on.
    reaped: bool,
    status: Option<ExitStatus>,
}

pub struct AcpProcess {
    child: Mutex<ChildSlot>,
    /// The queue to the stdin writer thread. `None` once stopped; dropping the
    /// sender closes stdin after the queued lines are written.
    stdin: Mutex<Option<SyncSender<Vec<u8>>>>,
    stopped: AtomicBool,
    /// Every raw signal sent, for tests: `(target, signal)`.
    #[cfg(test)]
    signals: Mutex<Vec<(i32, i32)>>,
}

/// Owns the child's stdin: writes queued lines until the queue closes (stop)
/// or a write fails (keryx gone). Blocking here blocks nobody else.
fn run_stdin_writer(mut stdin: ChildStdin, lines: mpsc::Receiver<Vec<u8>>) {
    for bytes in lines {
        if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
            return;
        }
    }
}

fn open_log(path: &PathBuf) -> Option<std::fs::File> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).map(|m| m.len() > LOG_ROTATE_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
}

impl AcpProcess {
    /// Spawn the child and start its reader threads. `on_event` is called from
    /// those threads; it receives the process so it can answer requests inline.
    pub fn spawn<F>(cfg: SpawnConfig, on_event: F) -> std::io::Result<Arc<AcpProcess>>
    where
        F: Fn(&Arc<AcpProcess>, ProcessEvent) + Send + Sync + 'static,
    {
        let mut cmd = Command::new(&cfg.program);
        cmd.args(&cfg.args)
            .current_dir(&cfg.cwd)
            .env_clear()
            .envs(&cfg.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Own process group: the group id equals the child's pid, so a stop can
        // signal keryx and every shell task / MCP server it started.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().expect("stdin piped");
        let mut stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");

        let (stdin_tx, stdin_rx) = mpsc::sync_channel(STDIN_QUEUE_LINES);
        std::thread::spawn(move || run_stdin_writer(stdin, stdin_rx));

        let proc = Arc::new(AcpProcess {
            child: Mutex::new(ChildSlot { child, reaped: false, status: None }),
            stdin: Mutex::new(Some(stdin_tx)),
            stopped: AtomicBool::new(false),
            #[cfg(test)]
            signals: Mutex::new(Vec::new()),
        });
        let on_event = Arc::new(on_event);
        let tail: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let stdout_done = Arc::new(AtomicBool::new(false));

        // stdout -> decoder -> events
        {
            let proc = proc.clone();
            let on_event = on_event.clone();
            let done = stdout_done.clone();
            std::thread::spawn(move || {
                let mut decoder = LineDecoder::default();
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match stdout.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            for frame in decoder.push(&buf[..n]) {
                                match frame {
                                    Frame::Line(l) => on_event(&proc, ProcessEvent::Line(l)),
                                    Frame::Oversized => on_event(&proc, ProcessEvent::Oversized),
                                }
                            }
                        }
                    }
                }
                for frame in decoder.finish() {
                    if let Frame::Line(l) = frame {
                        on_event(&proc, ProcessEvent::Line(l));
                    }
                }
                done.store(true, Ordering::SeqCst);
            });
        }

        // stderr -> log file + tail
        {
            let tail = tail.clone();
            let log_path = cfg.log_path.clone();
            std::thread::spawn(move || {
                let mut log = log_path.as_ref().and_then(open_log);
                let mut buf = vec![0u8; 8 * 1024];
                while let Ok(n) = stderr.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if let Some(f) = log.as_mut() {
                        let _ = f.write_all(&buf[..n]);
                    }
                    let mut t = tail.lock().unwrap();
                    t.extend_from_slice(&buf[..n]);
                    if t.len() > STDERR_TAIL_BYTES {
                        let cut = t.len() - STDERR_TAIL_BYTES;
                        t.drain(..cut);
                    }
                }
            });
        }

        // exit watcher
        {
            let proc = proc.clone();
            let tail = tail.clone();
            std::thread::spawn(move || {
                while !proc.has_exited() {
                    std::thread::sleep(EXIT_POLL);
                }
                // Sweep what keryx left in its group, then reap (no-op when a
                // concurrent stop already did both).
                let status = proc.sweep_and_reap();
                // Let the stdout reader drain what the child wrote before exiting.
                let deadline = Instant::now() + Duration::from_secs(2);
                while !stdout_done.load(Ordering::SeqCst) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                std::thread::sleep(Duration::from_millis(20));
                if proc.stopped.load(Ordering::SeqCst) {
                    return;
                }
                let stderr_tail = String::from_utf8_lossy(&tail.lock().unwrap()).into_owned();
                on_event(&proc, ProcessEvent::Exit { code: status.and_then(|s| s.code()), stderr_tail });
            });
        }

        Ok(proc)
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Queue one framed message for the child's stdin. Never blocks on the
    /// pipe: fails when keryx is stopped, gone, or no longer reading its input.
    pub fn send_line(&self, message: &str) -> Result<(), String> {
        if self.is_stopped() {
            return Err("keryx is not running".into());
        }
        let bytes = framing::encode(message).map_err(|e| e.to_string())?;
        let guard = self.stdin.lock().unwrap();
        let queue = guard.as_ref().ok_or("keryx is not running")?;
        queue.try_send(bytes).map_err(|e| match e {
            TrySendError::Full(_) => "keryx is not reading its input; the message was not sent".to_string(),
            TrySendError::Disconnected(_) => "keryx is not running".to_string(),
        })
    }

    /// Stop the child with the default grace period. See [`kill_with_grace`].
    pub fn kill(&self) {
        self.kill_with_grace(GRACEFUL_STOP);
    }

    /// Stop the child: close stdin (keryx exits on EOF), send SIGTERM (the only
    /// signal that aborts an in-flight turn), wait up to `grace` for keryx to
    /// finish its own drain, then SIGKILL the whole process group. The group is
    /// also swept after a clean exit so no background task outlives the window.
    /// A child that already exited and was reaped gets no signal at all.
    /// Suppresses the exit event.
    pub fn kill_with_grace(&self, grace: Duration) {
        self.stopped.store(true, Ordering::SeqCst);
        // Dropping the sender never waits on the writer thread, even one stuck
        // in a write to a keryx that stopped reading.
        drop(self.stdin.lock().unwrap().take());
        {
            let slot = self.child.lock().unwrap();
            if slot.reaped {
                return;
            }
            #[cfg(unix)]
            self.signal(slot.child.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + grace;
        while !self.has_exited() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        self.sweep_and_reap();
    }

    /// Whether the child has exited, without reaping it: an exited but
    /// unreaped child keeps its pid and process group id reserved.
    #[cfg(unix)]
    fn has_exited(&self) -> bool {
        let pid = {
            let slot = self.child.lock().unwrap();
            if slot.reaped {
                return true;
            }
            slot.child.id()
        };
        // SAFETY: zeroed siginfo_t is a valid out-parameter for waitid.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: plain syscall; WNOWAIT leaves the child waitable.
        let rc = unsafe {
            libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT)
        };
        // rc -1 (ECHILD) means it was reaped meanwhile; with WNOHANG an
        // unchanged child leaves the zeroed siginfo untouched.
        rc != 0 || info.si_signo == libc::SIGCHLD
    }

    #[cfg(not(unix))]
    fn has_exited(&self) -> bool {
        let mut slot = self.child.lock().unwrap();
        slot.reaped || matches!(slot.child.try_wait(), Ok(Some(_)))
    }

    /// SIGKILL the process group, then reap the child, all under the child
    /// mutex: the leader is not reaped yet, so the group id is still ours.
    /// Idempotent; returns the exit status once reaped.
    fn sweep_and_reap(&self) -> Option<ExitStatus> {
        let mut slot = self.child.lock().unwrap();
        if !slot.reaped {
            #[cfg(unix)]
            self.signal(-(slot.child.id() as i32), libc::SIGKILL);
            #[cfg(not(unix))]
            let _ = slot.child.kill();
            slot.status = slot.child.wait().ok();
            slot.reaped = true;
        }
        slot.status
    }

    /// `kill(2)`; a negative pid signals the process group. Errors (ESRCH)
    /// mean the target is already gone. Callers hold the child mutex and have
    /// checked the child is not reaped.
    #[cfg(unix)]
    fn signal(&self, target: i32, sig: i32) {
        #[cfg(test)]
        self.signals.lock().unwrap().push((target, sig));
        // SAFETY: plain syscall with integer arguments.
        unsafe {
            libc::kill(target, sig);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn pid_alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn wait_for_file(path: &std::path::Path) -> String {
        for _ in 0..200 {
            if let Ok(s) = std::fs::read_to_string(path) {
                if s.ends_with('\n') {
                    return s;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("{} never appeared", path.display());
    }

    fn spawn_script(dir: &std::path::Path, body: &str) -> (Arc<AcpProcess>, i32) {
        let script = dir.join("fake-keryx.sh");
        std::fs::write(&script, body).unwrap();
        let pidfile = dir.join("grandchild.pid");
        let proc = AcpProcess::spawn(
            SpawnConfig {
                program: "/bin/sh".into(),
                args: vec![script.display().to_string(), pidfile.display().to_string()],
                cwd: dir.to_path_buf(),
                env: HashMap::from([("PATH".to_string(), "/bin:/usr/bin".to_string())]),
                log_path: None,
            },
            |_, _| {},
        )
        .unwrap();
        let grandchild: i32 = wait_for_file(&pidfile).trim().parse().unwrap();
        (proc, grandchild)
    }

    fn assert_gone(pid: i32) {
        for _ in 0..80 {
            if !pid_alive(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("process {pid} survived the stop");
    }

    #[test]
    fn a_child_that_ignores_term_and_its_grandchild_are_killed_after_the_grace() {
        let dir = tempfile::tempdir().unwrap();
        let (proc, grandchild) = spawn_script(
            dir.path(),
            "trap '' TERM\nsleep 300 &\necho $! > \"$1\"\nwhile true; do sleep 1; done\n",
        );
        assert!(pid_alive(grandchild));
        let started = Instant::now();
        proc.kill_with_grace(Duration::from_millis(300));
        assert!(started.elapsed() >= Duration::from_millis(300), "SIGKILL must wait for the grace");
        assert!(proc.is_stopped());
        assert_gone(grandchild);
    }

    #[test]
    fn a_child_that_exits_on_term_leaves_no_orphaned_grandchild() {
        let dir = tempfile::tempdir().unwrap();
        // Exits on TERM but leaves its background task running.
        let (proc, grandchild) = spawn_script(
            dir.path(),
            "trap 'exit 0' TERM\nsleep 300 &\necho $! > \"$1\"\nwhile true; do sleep 1; done\n",
        );
        let started = Instant::now();
        proc.kill_with_grace(Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(4), "a cooperative child stops quickly");
        assert_gone(grandchild);
    }

    /// Runs `f` on a thread and fails (instead of hanging the suite) when it
    /// does not return within `limit`.
    fn within<T: Send + 'static>(limit: Duration, what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(limit).unwrap_or_else(|_| panic!("{what} did not return within {limit:?}"))
    }

    #[test]
    fn a_stop_is_not_blocked_by_a_write_to_a_child_that_stopped_reading_stdin() {
        let dir = tempfile::tempdir().unwrap();
        // Never reads stdin and ignores TERM: only the group SIGKILL ends it.
        let (proc, grandchild) = spawn_script(
            dir.path(),
            "trap '' TERM\nsleep 300 &\necho $! > \"$1\"\nwhile true; do sleep 1; done\n",
        );
        // Far larger than a pipe buffer, so a direct write would block.
        let big = "x".repeat(4 * 1024 * 1024);
        let sender = proc.clone();
        within(Duration::from_secs(2), "send_line", move || sender.send_line(&big)).unwrap();
        let second = "y".repeat(1024);
        let sender = proc.clone();
        within(Duration::from_secs(2), "a second send_line", move || sender.send_line(&second)).unwrap();
        std::thread::sleep(Duration::from_millis(200));

        let stopper = proc.clone();
        let started = Instant::now();
        within(Duration::from_secs(5), "kill_with_grace", move || {
            stopper.kill_with_grace(Duration::from_millis(300))
        });
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_gone(grandchild);
        assert!(proc.send_line("{}").is_err(), "a stopped process takes no more input");
    }

    #[test]
    fn a_full_stdin_queue_fails_the_send_instead_of_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let (proc, _) = spawn_script(dir.path(), "sleep 300 &\necho $! > \"$1\"\nwhile true; do sleep 1; done\n");
        let big = "x".repeat(1024 * 1024);
        let sender = proc.clone();
        let results = within(Duration::from_secs(5), "queued sends", move || {
            (0..STDIN_QUEUE_LINES + 4).map(|_| sender.send_line(&big)).collect::<Vec<_>>()
        });
        assert!(results.iter().any(|r| r.is_err()), "an unread stdin must surface as an error");
        proc.kill_with_grace(Duration::from_millis(100));
    }

    #[test]
    fn a_stop_after_the_child_exited_on_its_own_sends_no_signal() {
        let dir = tempfile::tempdir().unwrap();
        let (exit_tx, exit_rx) = mpsc::channel();
        let exit_tx = Mutex::new(exit_tx);
        let proc = AcpProcess::spawn(
            SpawnConfig {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), "exit 3".into()],
                cwd: dir.path().to_path_buf(),
                env: HashMap::new(),
                log_path: None,
            },
            move |_, event| {
                if let ProcessEvent::Exit { code, .. } = event {
                    let _ = exit_tx.lock().unwrap().send(code);
                }
            },
        )
        .unwrap();
        let code = exit_rx.recv_timeout(Duration::from_secs(5)).expect("the exit event");
        assert_eq!(code, Some(3));
        let swept_on_exit = proc.signals.lock().unwrap().clone();

        proc.kill_with_grace(Duration::from_millis(300));
        assert!(proc.is_stopped());
        assert_eq!(
            *proc.signals.lock().unwrap(),
            swept_on_exit,
            "a reaped child's pid may belong to another process: no signal after the reap"
        );
        // The group was swept once, before the reap, and never signalled by pid.
        assert!(swept_on_exit.iter().all(|&(target, sig)| target < 0 && sig == libc::SIGKILL));
    }

    #[test]
    fn a_child_that_exits_on_its_own_leaves_no_orphaned_grandchild() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-keryx.sh");
        std::fs::write(&script, "sleep 300 &\necho $! > \"$1\"\nsleep 0.5\nexit 0\n").unwrap();
        let pidfile = dir.path().join("grandchild.pid");
        let proc = AcpProcess::spawn(
            SpawnConfig {
                program: "/bin/sh".into(),
                args: vec![script.display().to_string(), pidfile.display().to_string()],
                cwd: dir.path().to_path_buf(),
                env: HashMap::from([("PATH".to_string(), "/bin:/usr/bin".to_string())]),
                log_path: None,
            },
            |_, _| {},
        )
        .unwrap();
        let grandchild: i32 = wait_for_file(&pidfile).trim().parse().unwrap();
        assert!(pid_alive(grandchild));
        assert_gone(grandchild);
        drop(proc);
    }
}
