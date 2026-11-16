//! Spawns and supervises one `keryx acp` child.
//!
//! Independent of Tauri so the live smoke test can drive it directly. Threads:
//! one reads stdout through the line decoder, one drains stderr into a log file
//! (and a short in-memory tail), one polls for exit.

use crate::framing::{self, Frame, LineDecoder};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const STDERR_TAIL_BYTES: usize = 4096;
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const GRACEFUL_STOP: Duration = Duration::from_millis(1500);

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

pub struct AcpProcess {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    stopped: AtomicBool,
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
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");

        let proc = Arc::new(AcpProcess {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            stopped: AtomicBool::new(false),
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
                let status = loop {
                    let polled = proc.child.lock().unwrap().try_wait();
                    match polled {
                        Ok(Some(status)) => break Some(status),
                        Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                        Err(_) => break None,
                    }
                };
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
                on_event(
                    &proc,
                    ProcessEvent::Exit { code: status.and_then(|s| s.code()), stderr_tail },
                );
            });
        }

        Ok(proc)
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Write one framed message to the child's stdin.
    pub fn send_line(&self, message: &str) -> Result<(), String> {
        if self.is_stopped() {
            return Err("keryx is not running".into());
        }
        let bytes = framing::encode(message).map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or("keryx is not running")?;
        stdin.write_all(&bytes).and_then(|_| stdin.flush()).map_err(|e| format!("write to keryx failed: {e}"))
    }

    /// Stop the child: close stdin (keryx exits on EOF), wait briefly, then kill.
    /// Suppresses the exit event.
    pub fn kill(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        drop(self.stdin.lock().unwrap().take());
        let deadline = Instant::now() + GRACEFUL_STOP;
        loop {
            let done = matches!(self.child.lock().unwrap().try_wait(), Ok(Some(_)));
            if done {
                return;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}
