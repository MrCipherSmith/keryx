//! The user's login-shell environment.
//!
//! A GUI app started from Finder inherits a minimal environment (no Homebrew
//! on PATH, none of the provider API keys exported from shell rc files). We run
//! the user's shell once at startup (`$SHELL -ilc 'env -0'`, bounded by a
//! timeout) and hand the result to the keryx child.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MARKER: &str = "__KERYX_ENV_BEGIN__";
/// Printed after `env -0`: its presence proves the capture is complete, so the
/// capture never depends on stdout reaching EOF (a background job started by an
/// rc file can keep the pipe open long after the shell exits).
const END_MARKER: &str = "__KERYX_ENV_END__";
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const CAPTURE_POLL: Duration = Duration::from_millis(20);
/// After the shell exited, how long its last output may take to reach us.
const EXIT_DRAIN: Duration = Duration::from_millis(200);

/// Parse the `env -0` output between `MARKER` and `END_MARKER` (anything
/// before is rc-file noise). Empty when either marker is missing: a capture
/// without its end marker is incomplete and must not be used.
pub fn parse_env0(output: &[u8]) -> HashMap<String, String> {
    let text = String::from_utf8_lossy(output);
    let Some(start) = text.find(MARKER).map(|i| i + MARKER.len()) else { return HashMap::new() };
    let Some(end) = text[start..].rfind(END_MARKER).map(|i| start + i) else { return HashMap::new() };
    let mut map = HashMap::new();
    for entry in text[start..end].split('\0') {
        let Some((k, v)) = entry.split_once('=') else { continue };
        let k = k.trim_start_matches('\n');
        if k.is_empty() || k.contains(char::is_whitespace) {
            continue;
        }
        map.insert(k.to_string(), v.to_string());
    }
    map
}

fn has_end_marker(buf: &[u8]) -> bool {
    buf.windows(END_MARKER.len()).any(|w| w == END_MARKER.as_bytes())
}

/// Run the login shell; `None` on failure, on timeout, or when the output never
/// carried the end marker.
///
/// The capture ends at the end marker or at the shell's exit, whichever comes
/// first, never at stdout EOF: the output collected so far is kept. A reader
/// thread left behind on a pipe that a background job still holds ends when
/// that job does.
pub fn capture_login_env(shell: &str, timeout: Duration) -> Option<HashMap<String, String>> {
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARKER}'; env -0; printf '{END_MARKER}'")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let collected: Arc<Mutex<Vec<u8>>> = Arc::default();
    {
        let collected = collected.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = stdout.read(&mut buf) {
                if n == 0 {
                    break;
                }
                collected.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
    }
    let deadline = Instant::now() + timeout;
    let mut exited_at: Option<Instant> = None;
    loop {
        if has_end_marker(&collected.lock().unwrap()) {
            break;
        }
        let now = Instant::now();
        if exited_at.is_none() && matches!(child.try_wait(), Ok(Some(_))) {
            exited_at = Some(now);
        }
        let drained = exited_at.is_some_and(|at| now.duration_since(at) >= EXIT_DRAIN);
        if drained || now >= deadline {
            break;
        }
        std::thread::sleep(CAPTURE_POLL);
    }
    // Reap the shell; one still running (timeout, or an exit trap that hangs)
    // is killed first.
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill();
    }
    let _ = child.wait();
    let map = parse_env0(&collected.lock().unwrap());
    map.contains_key("PATH").then_some(map)
}

/// `PATH` without empty or relative entries. A relative entry (or an empty one,
/// which means the current directory) resolves against the folder a child runs
/// in, so an opened repository could supply its own `git` or `keryx`.
pub fn absolute_path_entries(path: &str) -> String {
    path.split(':').filter(|entry| entry.starts_with('/')).collect::<Vec<_>>().join(":")
}

/// Current environment overlaid with the login-shell one (when available).
/// `PATH` keeps only absolute entries; every child the app starts gets it.
pub fn resolve_environment() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if let Some(login) = capture_login_env(&shell, CAPTURE_TIMEOUT) {
        env.extend(login);
    }
    if let Some(path) = env.get_mut("PATH") {
        *path = absolute_path_entries(path);
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entries_after_the_marker_and_ignores_noise() {
        let raw = format!("rc noise\n{MARKER}PATH=/a:/b\0HOME=/h\0MULTI=line1\nline2\0{END_MARKER}");
        let map = parse_env0(raw.as_bytes());
        assert_eq!(map["PATH"], "/a:/b");
        assert_eq!(map["HOME"], "/h");
        assert_eq!(map["MULTI"], "line1\nline2");
        assert!(!map.keys().any(|k| k.contains("noise")));
    }

    #[test]
    fn output_without_the_marker_yields_nothing() {
        assert!(parse_env0(b"PATH=/a\0").is_empty());
        // Cut off before the end marker: incomplete, never used.
        assert!(parse_env0(format!("{MARKER}PATH=/a\0HO").as_bytes()).is_empty());
    }

    #[test]
    fn values_may_contain_equals_signs() {
        let raw = format!("{MARKER}TOKEN=a=b=c\0{END_MARKER}");
        assert_eq!(parse_env0(raw.as_bytes())["TOKEN"], "a=b=c");
    }

    #[test]
    fn a_missing_shell_returns_none() {
        assert!(capture_login_env("/definitely/not/a/shell", Duration::from_secs(1)).is_none());
    }

    #[test]
    fn relative_and_empty_path_entries_are_dropped() {
        assert_eq!(absolute_path_entries("/opt/homebrew/bin:bin:./node_modules/.bin::/usr/bin:"), "/opt/homebrew/bin:/usr/bin");
        assert_eq!(absolute_path_entries("."), "");
    }

    #[cfg(unix)]
    fn fake_shell(dir: &std::path::Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let shell = dir.join("fake-shell");
        std::fs::write(&shell, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        shell.display().to_string()
    }

    #[cfg(unix)]
    #[test]
    fn a_background_job_holding_stdout_does_not_discard_the_capture() {
        let dir = tempfile::tempdir().unwrap();
        // Like an rc file that starts an agent: the job inherits stdout and
        // outlives the shell, so stdout never reaches EOF in time.
        let shell = fake_shell(
            dir.path(),
            &format!("/bin/sleep 5 &\nprintf '{MARKER}'\nprintf 'PATH=/x/bin\\0'\nprintf '{END_MARKER}'\n"),
        );
        let start = std::time::Instant::now();
        let got = capture_login_env(&shell, Duration::from_secs(3)).expect("the complete capture is kept");
        assert_eq!(got["PATH"], "/x/bin");
        assert!(start.elapsed() < Duration::from_secs(2), "the capture must not wait for EOF: {:?}", start.elapsed());
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_exits_without_the_end_marker_yields_none_promptly() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), &format!("printf '{MARKER}PATH=/x\\0'\nexit 1\n"));
        let start = std::time::Instant::now();
        assert!(capture_login_env(&shell, Duration::from_secs(3)).is_none());
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_hangs_is_abandoned_at_the_timeout() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("hanging-shell");
        // Ignores its arguments and really sleeps, so only the timeout ends it.
        std::fs::write(&shell, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let start = std::time::Instant::now();
        let got = capture_login_env(shell.to_str().unwrap(), Duration::from_millis(300));
        let took = start.elapsed();
        assert!(got.is_none());
        assert!(took >= Duration::from_millis(300), "returned before the timeout: {took:?}");
        assert!(took < Duration::from_secs(4), "the hung shell was not killed: {took:?}");
    }
}
