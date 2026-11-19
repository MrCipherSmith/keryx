//! Find a Chrome to run and start it for one project.
//!
//! Owner decision 1: the installed Chrome when present, always with a separate
//! per-project profile (Chrome 136+ refuses remote debugging on the default
//! profile anyway); otherwise Chrome for Testing, downloaded with consent into
//! the app's data directory (the download itself is not part of this module).
//!
//! Decision 5: the debugging port is a random free port on 127.0.0.1 (`0`),
//! read back from `DevToolsActivePort` in the profile, so that the app's own
//! CDP client, chrome-devtools-mcp and Playwright can all attach to it. The
//! port has no authentication; the profile is the project's own and the
//! process lives only as long as the window.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Where a Chrome binary may live, best first. `extra` are app-managed installs
/// (Chrome for Testing under the app's data directory).
pub fn candidates(home: Option<&Path>, extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for app in ["Google Chrome", "Google Chrome for Testing", "Chromium"] {
        let rel = format!("{app}.app/Contents/MacOS/{app}");
        out.push(Path::new("/Applications").join(&rel));
        if let Some(h) = home {
            out.push(h.join("Applications").join(&rel));
        }
    }
    out.extend(extra.iter().cloned());
    out
}

/// The first candidate that exists and is a file.
pub fn find_chrome(home: Option<&Path>, extra: &[PathBuf]) -> Option<PathBuf> {
    candidates(home, extra).into_iter().find(|p| p.is_file())
}

/// `DevToolsActivePort` holds the port on its first line and the browser
/// target's path (`/devtools/browser/<id>`) on the second.
pub fn parse_active_port(text: &str) -> Option<(u16, String)> {
    let mut lines = text.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim();
    if port == 0 || !path.starts_with("/devtools/browser/") {
        return None;
    }
    Some((port, path.to_string()))
}

/// The command line for a project's browser.
pub fn args(profile: &Path, headless: bool) -> Vec<String> {
    let mut a = vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-port=0".into(),
        "--remote-debugging-address=127.0.0.1".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-networking".into(),
        "--disable-sync".into(),
        "--disable-component-update".into(),
        "--password-store=basic".into(),
        "--use-mock-keychain".into(),
        "--window-size=1280,800".into(),
    ];
    if headless {
        a.push("--headless=new".into());
    }
    a.push("about:blank".into());
    a
}

/// The pid in a profile's `SingletonLock` link target (`<host>-<pid>`).
pub fn lock_pid(target: &str) -> Option<i32> {
    target.rsplit_once('-')?.1.parse().ok().filter(|p: &i32| *p > 1)
}

/// The command line of process `pid`, if it is running.
#[cfg(unix)]
fn command_of(pid: i32) -> Option<String> {
    let out = Command::new("/bin/ps").args(["-o", "command=", "-p", &pid.to_string()]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

/// A browser left running on `profile` by an earlier app run that did not stop it (killed, crashed)
/// holds the profile's lock, so a new one would exit at once. Stop it when it is ours: a process
/// whose command line names this exact profile (these profiles are the app's own).
#[cfg(unix)]
pub fn reclaim_profile(profile: &Path) -> bool {
    let Ok(target) = std::fs::read_link(profile.join("SingletonLock")) else { return false };
    let Some(pid) = lock_pid(&target.to_string_lossy()) else { return false };
    let Some(cmd) = command_of(pid) else { return false };
    if !cmd.contains(&format!("--user-data-dir={}", profile.display())) {
        return false;
    }
    // SAFETY: plain signal calls on a process that runs on this profile.
    unsafe { libc::kill(pid, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        // SAFETY: signal 0 only checks whether the process exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // SAFETY: as above.
    unsafe { libc::kill(pid, libc::SIGKILL) };
    std::thread::sleep(Duration::from_millis(200));
    true
}

#[cfg(not(unix))]
pub fn reclaim_profile(_: &Path) -> bool {
    false
}

/// A running browser. Dropping it stops the browser and its helpers.
pub struct Chromium {
    child: Child,
    pub port: u16,
    /// `ws://127.0.0.1:<port>/devtools/browser/<id>`
    pub ws_url: String,
    pub profile: PathBuf,
}

impl Chromium {
    /// Start `binary` on `profile` and wait (up to `timeout`) for its debugging port.
    pub fn launch(binary: &Path, profile: &Path, headless: bool, timeout: Duration) -> Result<Chromium, String> {
        std::fs::create_dir_all(profile).map_err(|e| format!("Could not create the browser profile {}: {e}", profile.display()))?;
        let port_file = profile.join("DevToolsActivePort");
        // An earlier run's browser may still hold the profile; a file it left would point at its port.
        reclaim_profile(profile);
        let _ = std::fs::remove_file(&port_file);
        let mut cmd = Command::new(binary);
        cmd.args(args(profile, headless)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so stopping it stops the helper processes too.
            cmd.process_group(0);
        }
        let child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", binary.display()))?;
        let mut browser = Chromium { child, port: 0, ws_url: String::new(), profile: profile.to_path_buf() };
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(Some(status)) = browser.child.try_wait() {
                return Err(format!(
                    "The browser exited at once ({status}). Another Chrome may already use the profile {}.",
                    profile.display()
                ));
            }
            if let Some((port, path)) = std::fs::read_to_string(&port_file).ok().as_deref().and_then(parse_active_port) {
                browser.port = port;
                browser.ws_url = format!("ws://127.0.0.1:{port}{path}");
                return Ok(browser);
            }
            if Instant::now() >= deadline {
                return Err("The browser did not open its debugging port in time".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// `http://127.0.0.1:<port>`, for tools that attach with a browser URL.
    pub fn http_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Stop the browser: SIGTERM to its process group, SIGKILL after a grace period.
    pub fn stop(&mut self) {
        if let Ok(Some(_)) = self.child.try_wait() {
            return;
        }
        #[cfg(unix)]
        // SAFETY: plain signal calls on the group this process leads.
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        #[cfg(unix)]
        // SAFETY: as above.
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Chromium {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A project's browser profile directory under the app's data directory.
pub fn profile_dir(data_dir: &Path, project: &Path) -> PathBuf {
    let id = crate::browser::store_id(project);
    let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
    data_dir.join("chromium-profiles").join(hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_active_port_file_gives_port_and_browser_path() {
        assert_eq!(
            parse_active_port("53211\n/devtools/browser/0b1c-2d\n"),
            Some((53211, "/devtools/browser/0b1c-2d".to_string()))
        );
        assert_eq!(parse_active_port("0\n/devtools/browser/x"), None);
        assert_eq!(parse_active_port("53211\n/json/version"), None);
        assert_eq!(parse_active_port("53211"), None);
        assert_eq!(parse_active_port(""), None);
    }

    #[test]
    fn installed_chrome_comes_before_app_managed_installs() {
        let extra = vec![PathBuf::from("/data/chromium/131/Google Chrome for Testing")];
        let c = candidates(Some(Path::new("/Users/me")), &extra);
        assert_eq!(c[0], PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
        assert_eq!(c[1], PathBuf::from("/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
        assert_eq!(c.last(), extra.last());
    }

    #[test]
    fn the_browser_gets_a_private_profile_and_a_local_random_port() {
        let a = args(Path::new("/p"), true);
        assert!(a.contains(&"--user-data-dir=/p".to_string()));
        assert!(a.contains(&"--remote-debugging-port=0".to_string()));
        assert!(a.contains(&"--remote-debugging-address=127.0.0.1".to_string()));
        assert!(a.contains(&"--headless=new".to_string()));
        assert!(!args(Path::new("/p"), false).contains(&"--headless=new".to_string()));
    }

    #[test]
    fn the_lock_names_the_holding_process() {
        assert_eq!(lock_pid("Goodeas-MacBook-Pro.local-27924"), Some(27924));
        assert_eq!(lock_pid("host-1"), None);
        assert_eq!(lock_pid("nohyphen"), None);
        assert_eq!(lock_pid("host-abc"), None);
    }

    #[test]
    fn a_profile_without_a_lock_or_with_a_stranger_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!reclaim_profile(dir.path()));
        // A lock pointing at this test process: its command line does not name the profile.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(format!("host-{}", std::process::id()), dir.path().join("SingletonLock")).unwrap();
            assert!(!reclaim_profile(dir.path()));
        }
    }

    #[test]
    fn profiles_differ_per_project() {
        let d = Path::new("/data");
        assert_ne!(profile_dir(d, Path::new("/a")), profile_dir(d, Path::new("/b")));
        assert!(profile_dir(d, Path::new("/a")).starts_with("/data/chromium-profiles"));
    }
}
