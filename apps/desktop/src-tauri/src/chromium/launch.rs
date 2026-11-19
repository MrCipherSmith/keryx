//! Find a Chrome to run and start it for one project.
//!
//! Owner decision 1: the installed Chrome when present, always with a separate
//! per-project profile (Chrome 136+ refuses remote debugging on the default
//! profile anyway); otherwise Chrome for Testing, downloaded with consent into
//! the app's data directory (the download itself is not part of this module).
//!
//! The browser is driven over its debugging pipe (`--remote-debugging-pipe`,
//! fds 3 and 4), never a network port: no other local process can attach to it
//! and reach the project's signed-in sessions. Its profile is the project's own
//! (mode 0700) and keeps cookies with the real Keychain, so a sign-in survives a
//! restart and is not readable from the profile files alone.

use super::cdp::Cdp;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The file in a profile naming the app process that runs its browser.
pub const OWNER_FILE: &str = "keryx-owner-pid";

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

/// The command line for a project's browser.
pub fn args(profile: &Path, headless: bool) -> Vec<String> {
    let mut a = vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-pipe".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-networking".into(),
        "--disable-sync".into(),
        "--disable-component-update".into(),
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

#[cfg(unix)]
fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks whether the process exists.
    pid > 1 && unsafe { libc::kill(pid, 0) } == 0
}

/// Whether the app process named in the profile's owner file still runs (another app instance's
/// browser must not be taken over). A missing or unreadable file counts as gone.
#[cfg(unix)]
fn owner_alive(profile: &Path) -> bool {
    std::fs::read_to_string(profile.join(OWNER_FILE)).ok().and_then(|t| t.trim().parse::<i32>().ok()).is_some_and(alive)
}

/// A browser left running on `profile` by an earlier app run that did not stop it (killed, crashed)
/// holds the profile's lock, so a new one would exit at once. Stop it only when it is ours and
/// orphaned: its command line names this exact profile and the app that started it is gone.
#[cfg(unix)]
pub fn reclaim_profile(profile: &Path) -> bool {
    let Ok(target) = std::fs::read_link(profile.join("SingletonLock")) else { return false };
    let Some(pid) = lock_pid(&target.to_string_lossy()) else { return false };
    let Some(cmd) = command_of(pid) else { return false };
    if !cmd.contains(&format!("--user-data-dir={}", profile.display())) || owner_alive(profile) {
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
    pub profile: PathBuf,
}

/// Create the profile folder for this user only.
fn private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the browser profile {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        if let Some(parent) = dir.parent() {
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    Ok(())
}

/// Two pipes for the debugging channel: (the child's fd 3 end, our write end), (our read end, the
/// child's fd 4 end). All four are close-on-exec; the child gets its two ends as 3 and 4.
#[cfg(unix)]
fn debug_pipes() -> Result<([i32; 2], [i32; 2]), String> {
    let mut to_browser = [0i32; 2];
    let mut from_browser = [0i32; 2];
    // SAFETY: plain pipe/fcntl calls on fresh descriptors.
    unsafe {
        if libc::pipe(to_browser.as_mut_ptr()) != 0 || libc::pipe(from_browser.as_mut_ptr()) != 0 {
            return Err(format!("Could not open the browser pipe: {}", std::io::Error::last_os_error()));
        }
        for fd in to_browser.iter().chain(from_browser.iter()) {
            libc::fcntl(*fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    Ok((to_browser, from_browser))
}

impl Chromium {
    /// Start `binary` on `profile` and connect to it over its debugging pipe (waiting up to `timeout`).
    #[cfg(unix)]
    pub fn launch(binary: &Path, profile: &Path, headless: bool, timeout: Duration) -> Result<(Chromium, Arc<Cdp>), String> {
        use std::os::fd::FromRawFd;
        use std::os::unix::process::CommandExt;
        private_dir(profile)?;
        // An earlier run's orphaned browser may still hold the profile.
        reclaim_profile(profile);
        let (to_browser, from_browser) = debug_pipes()?;
        let (child_in, child_out) = (to_browser[0], from_browser[1]);
        let mut cmd = Command::new(binary);
        cmd.args(args(profile, headless)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // Its own process group, so stopping it stops the helper processes too.
        cmd.process_group(0);
        // SAFETY: only async-signal-safe calls (fcntl, dup2, close) between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                // Move both ends above 3/4 first, so placing one cannot overwrite the other.
                let a = libc::fcntl(child_in, libc::F_DUPFD, 10);
                let b = libc::fcntl(child_out, libc::F_DUPFD, 10);
                if a < 0 || b < 0 || libc::dup2(a, 3) < 0 || libc::dup2(b, 4) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::close(a);
                libc::close(b);
                Ok(())
            });
        }
        let spawned = cmd.spawn();
        // SAFETY: the child's ends are ours to close once it has them (or failed to start).
        unsafe {
            libc::close(child_in);
            libc::close(child_out);
        }
        let child = match spawned {
            Ok(c) => c,
            Err(e) => {
                // SAFETY: our ends were never wrapped.
                unsafe {
                    libc::close(to_browser[1]);
                    libc::close(from_browser[0]);
                }
                return Err(format!("Could not start {}: {e}", binary.display()));
            }
        };
        let _ = std::fs::write(profile.join(OWNER_FILE), std::process::id().to_string());
        // SAFETY: each fd is open, owned by nobody else, and wrapped exactly once.
        let (writer, reader) = unsafe { (std::fs::File::from_raw_fd(to_browser[1]), std::fs::File::from_raw_fd(from_browser[0])) };
        let mut browser = Chromium { child, profile: profile.to_path_buf() };
        let cdp = Cdp::over(reader, writer);
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(Some(status)) = browser.child.try_wait() {
                return Err(format!("The browser exited at once ({status}). Another Chrome may already use the profile {}.", profile.display()));
            }
            if cdp.call_within(None, "Browser.getVersion", json!({}), Duration::from_secs(2)).is_ok() {
                return Ok((browser, cdp));
            }
            if Instant::now() >= deadline {
                browser.stop();
                return Err("The browser did not answer on its debugging pipe in time".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(not(unix))]
    pub fn launch(_: &Path, _: &Path, _: bool, _: Duration) -> Result<(Chromium, Arc<Cdp>), String> {
        Err("The Chromium engine needs macOS".into())
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
    fn installed_chrome_comes_before_app_managed_installs() {
        let extra = vec![PathBuf::from("/data/chromium/131/Google Chrome for Testing")];
        let c = candidates(Some(Path::new("/Users/me")), &extra);
        assert_eq!(c[0], PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
        assert_eq!(c[1], PathBuf::from("/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
        assert_eq!(c.last(), extra.last());
    }

    #[test]
    fn the_browser_gets_a_private_profile_a_pipe_and_the_real_keychain() {
        let a = args(Path::new("/p"), true);
        assert!(a.contains(&"--user-data-dir=/p".to_string()));
        assert!(a.contains(&"--remote-debugging-pipe".to_string()));
        assert!(!a.iter().any(|x| x.starts_with("--remote-debugging-port") || x.starts_with("--remote-debugging-address")));
        assert!(!a.iter().any(|x| x == "--use-mock-keychain" || x.starts_with("--password-store")));
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

    #[cfg(unix)]
    #[test]
    fn a_browser_whose_app_still_runs_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        // The owner is this test process, which runs: nothing is reclaimed whatever holds the lock.
        std::fs::write(dir.path().join(OWNER_FILE), std::process::id().to_string()).unwrap();
        assert!(owner_alive(dir.path()));
        std::fs::write(dir.path().join(OWNER_FILE), "999999").unwrap();
        assert!(!owner_alive(dir.path()));
    }

    #[cfg(unix)]
    #[test]
    fn profiles_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("chromium-profiles/abc");
        private_dir(&p).unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn profiles_differ_per_project() {
        let d = Path::new("/data");
        assert_ne!(profile_dir(d, Path::new("/a")), profile_dir(d, Path::new("/b")));
        assert!(profile_dir(d, Path::new("/a")).starts_with("/data/chromium-profiles"));
    }
}
