//! The user's login-shell environment.
//!
//! A GUI app started from Finder inherits a minimal environment (no Homebrew
//! on PATH, none of the provider API keys exported from shell rc files). We run
//! the user's shell once at startup (`$SHELL -ilc 'env -0'`, bounded by a
//! timeout) and hand the result to the keryx child.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const MARKER: &str = "__KERYX_ENV_BEGIN__";
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// Parse `env -0` output that follows `MARKER` (anything before it is rc-file noise).
pub fn parse_env0(output: &[u8]) -> HashMap<String, String> {
    let text = String::from_utf8_lossy(output);
    let body = match text.find(MARKER) {
        Some(i) => &text[i + MARKER.len()..],
        None => return HashMap::new(),
    };
    let mut map = HashMap::new();
    for entry in body.split('\0') {
        let Some((k, v)) = entry.split_once('=') else { continue };
        let k = k.trim_start_matches('\n');
        if k.is_empty() || k.contains(char::is_whitespace) {
            continue;
        }
        map.insert(k.to_string(), v.to_string());
    }
    map
}

/// Run the login shell; `None` on failure or timeout.
pub fn capture_login_env(shell: &str, timeout: Duration) -> Option<HashMap<String, String>> {
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARKER}'; env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(timeout) {
        Ok(buf) => {
            let _ = child.wait();
            let map = parse_env0(&buf);
            if map.contains_key("PATH") {
                Some(map)
            } else {
                None
            }
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// Current environment overlaid with the login-shell one (when available).
pub fn resolve_environment() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if let Some(login) = capture_login_env(&shell, CAPTURE_TIMEOUT) {
        env.extend(login);
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entries_after_the_marker_and_ignores_noise() {
        let raw = format!("rc noise\n{MARKER}PATH=/a:/b\0HOME=/h\0MULTI=line1\nline2\0");
        let map = parse_env0(raw.as_bytes());
        assert_eq!(map["PATH"], "/a:/b");
        assert_eq!(map["HOME"], "/h");
        assert_eq!(map["MULTI"], "line1\nline2");
        assert!(!map.keys().any(|k| k.contains("noise")));
    }

    #[test]
    fn output_without_the_marker_yields_nothing() {
        assert!(parse_env0(b"PATH=/a\0").is_empty());
    }

    #[test]
    fn values_may_contain_equals_signs() {
        let raw = format!("{MARKER}TOKEN=a=b=c\0");
        assert_eq!(parse_env0(raw.as_bytes())["TOKEN"], "a=b=c");
    }

    #[test]
    fn a_missing_shell_returns_none() {
        assert!(capture_login_env("/definitely/not/a/shell", Duration::from_secs(1)).is_none());
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
