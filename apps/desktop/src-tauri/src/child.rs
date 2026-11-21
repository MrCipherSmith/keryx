//! Run a short-lived program to completion: stdin closed, stdout and stderr
//! drained and capped, killed and reaped when it outlives a deadline.
//!
//! The one bounded runner the core uses for one-shot children (`keryx flow`
//! actions, `git rev-parse`). Errors are neutral; callers word them for their
//! own context.

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(20);
/// After the child exits, how long its last output may take to be read.
const OUTPUT_DRAIN: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub struct Output {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug)]
pub enum RunError {
    /// The program could not be started.
    Spawn(std::io::Error),
    /// Waiting for the program failed; it was killed and reaped.
    Wait(std::io::Error),
    /// It did not finish within the timeout; it was killed and reaped.
    Timeout,
}

/// Drain `r` on a helper thread, keeping at most `cap` bytes. Reads past the
/// cap so the child never blocks on a full pipe.
pub fn read_capped(mut r: impl Read + Send + 'static, cap: usize) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = cap.saturating_sub(kept.len());
                    kept.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&kept).into_owned());
    });
    rx
}

/// Run `cmd` (its stdio is set here) and wait at most `timeout`. Each output
/// stream keeps at most `cap` bytes.
pub fn run_bounded(cmd: Command, timeout: Duration, cap: usize) -> Result<Output, RunError> {
    run_bounded_with_stdin(cmd, Stdio::null(), timeout, cap)
}

/// Use a separate Unix process group for commands that spawn work of their own.
pub fn run_bounded_tree(mut cmd: Command, timeout: Duration, cap: usize) -> Result<Output, RunError> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    run_bounded_inner(cmd, Stdio::null(), timeout, cap, true)
}

pub fn run_bounded_with_stdin(cmd: Command, stdin: Stdio, timeout: Duration, cap: usize) -> Result<Output, RunError> {
    run_bounded_inner(cmd, stdin, timeout, cap, false)
}

fn run_bounded_inner(mut cmd: Command, stdin: Stdio, timeout: Duration, cap: usize, tree: bool) -> Result<Output, RunError> {
    let mut child = cmd
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(RunError::Spawn)?;
    let out = read_capped(child.stdout.take().expect("stdout piped"), cap);
    let err = read_capped(child.stderr.take().expect("stderr piped"), cap);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL),
            other => {
                // Only signal the group while the child has not been reaped.
                #[cfg(unix)]
                if tree && matches!(&other, Ok(None)) {
                    unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
                }
                #[cfg(not(unix))]
                let _ = tree;
                let _ = child.kill();
                let _ = child.wait();
                return Err(match other {
                    Err(e) => RunError::Wait(e),
                    _ => RunError::Timeout,
                });
            }
        }
    };
    Ok(Output {
        status,
        stdout: out.recv_timeout(OUTPUT_DRAIN).unwrap_or_default(),
        stderr: err.recv_timeout(OUTPUT_DRAIN).unwrap_or_default(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn captures_both_streams_and_the_status() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "echo out; echo err >&2; exit 4"]);
        let o = run_bounded(cmd, Duration::from_secs(5), 1024).unwrap();
        assert_eq!(o.status.code(), Some(4));
        assert_eq!((o.stdout.as_str(), o.stderr.as_str()), ("out\n", "err\n"));
    }

    #[test]
    fn a_slow_child_is_killed_at_the_timeout() {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30");
        let started = Instant::now();
        assert!(matches!(run_bounded(cmd, Duration::from_millis(200), 1024), Err(RunError::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_missing_program_is_a_spawn_error() {
        let cmd = Command::new("/definitely/not/a/program");
        assert!(matches!(run_bounded(cmd, Duration::from_secs(1), 1024), Err(RunError::Spawn(_))));
    }

    #[test]
    fn output_is_capped() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "head -c 100000 /dev/zero | tr '\\0' x"]);
        let o = run_bounded(cmd, Duration::from_secs(5), 1000).unwrap();
        assert_eq!(o.stdout.len(), 1000);
    }
}
