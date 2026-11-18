//! The update banner's backend (decision D-10).
//!
//! The release lookup lives in one place, the keryx CLI: `app_update_check`
//! runs `<resolved keryx> app status --json` and compares the newest
//! `desktop-v*` release and keryx's `minDesktopVersion` with this app's own
//! version. `app_update_run` starts `keryx app update --dir <folder>
//! --wait-pid <this pid> --relaunch` detached, then quits the app so the CLI
//! can swap the bundle and open the new one.
//!
//! A keryx without `app status` (older than D-10) makes the check return
//! `None`, and the app shows no banner. So does a dev build that does not run
//! from a `Keryx.app` bundle: there is nothing for the CLI to replace.

use crate::bridge::AppState;
use crate::child::{self, RunError};
use crate::locator;
use crate::settings;
use crate::version;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const STATUS_TIMEOUT: Duration = Duration::from_secs(30);
const STATUS_CAP: usize = 64 * 1024;
pub const BUNDLE_NAME: &str = "Keryx.app";

/// The part of `keryx app status --json` the banner reads.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub latest: Option<CliRelease>,
    pub keryx_version: String,
    pub min_desktop_version: String,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliRelease {
    pub version: String,
    pub url: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// This app's version.
    pub current: String,
    /// The newest release, when GitHub answered.
    pub latest: Option<String>,
    pub release_url: Option<String>,
    /// A newer release exists.
    pub available: bool,
    /// The keryx this app runs needs a newer app than this one.
    pub required: bool,
    pub keryx_version: String,
    pub min_desktop_version: String,
}

/// Parse the CLI's output; `None` for anything that is not a status object.
pub fn parse_status(stdout: &str) -> Option<CliStatus> {
    serde_json::from_str(stdout.trim()).ok()
}

fn older(a: &str, b: &str) -> bool {
    match (version::parse(a), version::parse(b)) {
        (Some(x), Some(y)) => version::compare(&x, &y) == Ordering::Less,
        _ => false,
    }
}

pub fn decide(current: &str, status: &CliStatus) -> UpdateCheck {
    let latest = status.latest.as_ref().map(|r| r.version.clone());
    UpdateCheck {
        current: current.to_string(),
        available: latest.as_deref().is_some_and(|l| older(current, l)),
        latest,
        release_url: status.latest.as_ref().and_then(|r| r.url.clone()),
        required: older(current, &status.min_desktop_version),
        keryx_version: status.keryx_version.clone(),
        min_desktop_version: status.min_desktop_version.clone(),
    }
}

/// The folder holding the running `Keryx.app`, from the main executable's
/// path (`<folder>/Keryx.app/Contents/MacOS/<exe>`); `None` outside a bundle.
pub fn install_dir(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.file_name()? == BUNDLE_NAME;
    is_bundle.then(|| bundle.parent().map(Path::to_path_buf)).flatten()
}

pub fn status_args(dir: &Path) -> Vec<String> {
    vec!["app".into(), "status".into(), "--json".into(), "--dir".into(), dir.display().to_string()]
}

pub fn update_args(dir: &Path, pid: u32) -> Vec<String> {
    vec![
        "app".into(),
        "update".into(),
        "--dir".into(),
        dir.display().to_string(),
        "--wait-pid".into(),
        pid.to_string(),
        "--relaunch".into(),
    ]
}

fn locate_keryx(app: &AppHandle, env: &HashMap<String, String>) -> Result<PathBuf, String> {
    let s = settings::load_settings(app);
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    locator::locate(
        s.keryx_source,
        s.custom_path.as_deref(),
        exe_dir.as_deref(),
        env.get("PATH").map(std::ffi::OsString::from).as_deref(),
    )
    .map(|l| l.path)
}

fn running_install_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|exe| install_dir(&exe))
}

pub fn run_status(keryx: &Path, dir: &Path, env: &HashMap<String, String>) -> Option<CliStatus> {
    let mut cmd = Command::new(keryx);
    cmd.args(status_args(dir)).env_clear().envs(env);
    match child::run_bounded(cmd, STATUS_TIMEOUT, STATUS_CAP) {
        Ok(out) if out.status.success() => parse_status(&out.stdout),
        Ok(_) | Err(RunError::Spawn(_) | RunError::Wait(_) | RunError::Timeout) => None,
    }
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> Result<Option<UpdateCheck>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = running_install_dir() else { return Ok(None) };
        let env = app.state::<AppState>().environment().clone();
        let keryx = locate_keryx(&app, &env)?;
        let current = app.package_info().version.to_string();
        Ok(run_status(&keryx, &dir, &env).map(|s| decide(&current, &s)))
    })
    .await
    .map_err(|e| format!("update check failed: {e}"))?
}

#[tauri::command]
pub async fn app_update_run(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dir = running_install_dir().ok_or("This app does not run from a Keryx.app bundle; nothing to update.")?;
        let env = handle.state::<AppState>().environment().clone();
        let keryx = locate_keryx(&handle, &env)?;
        let log_dir = handle.path().app_log_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(log_dir.join("app-update.log")).map_err(|e| e.to_string())?;
        let log_err = log.try_clone().map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&keryx);
        cmd.args(update_args(&dir, std::process::id()))
            .env_clear()
            .envs(&env)
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(log_err);
        // Its own process group: quitting the app must not take the updater with it.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd.spawn().map_err(|e| format!("Could not start `keryx app update`: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("update failed: {e}"))??;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(latest: Option<&str>, min: &str) -> CliStatus {
        CliStatus {
            latest: latest.map(|v| CliRelease { version: v.into(), url: Some(format!("https://example.test/{v}")) }),
            keryx_version: "0.5.0".into(),
            min_desktop_version: min.into(),
        }
    }

    #[test]
    fn parses_the_cli_status_and_ignores_extra_fields() {
        let raw = r#"{"appPath":"/Applications/Keryx.app","installedVersion":"0.1.0",
            "latest":{"version":"0.2.0","tag":"desktop-v0.2.0","url":"https://x/y","prerelease":false},
            "updateAvailable":true,"keryxVersion":"0.4.36","minDesktopVersion":"0.1.0","appTooOld":false,"error":null}"#;
        let s = parse_status(raw).unwrap();
        assert_eq!(s.latest.unwrap().version, "0.2.0");
        assert_eq!(s.min_desktop_version, "0.1.0");
        let offline = parse_status(r#"{"latest":null,"keryxVersion":"0.4.36","minDesktopVersion":"0.1.0"}"#).unwrap();
        assert!(offline.latest.is_none());
        assert!(parse_status("Unknown command: app").is_none());
        assert!(parse_status("").is_none());
    }

    #[test]
    fn decides_available_and_required() {
        let newer = decide("0.1.0", &status(Some("0.2.0"), "0.1.0"));
        assert!(newer.available && !newer.required);
        assert_eq!(newer.release_url.as_deref(), Some("https://example.test/0.2.0"));
        let same = decide("0.2.0", &status(Some("0.2.0"), "0.1.0"));
        assert!(!same.available && !same.required);
        let required = decide("0.1.0", &status(Some("0.3.0"), "0.2.0"));
        assert!(required.available && required.required);
        let offline = decide("0.1.0", &status(None, "0.2.0"));
        assert!(!offline.available && offline.required && offline.latest.is_none());
        // A pre-release of the same version is older than the release.
        assert!(decide("0.2.0-rc.1", &status(Some("0.2.0"), "0.1.0")).available);
    }

    #[test]
    fn install_dir_only_inside_a_keryx_bundle() {
        assert_eq!(
            install_dir(Path::new("/Applications/Keryx.app/Contents/MacOS/keryx-desktop")),
            Some(PathBuf::from("/Applications"))
        );
        assert_eq!(
            install_dir(Path::new("/Users/me/Apps/Keryx.app/Contents/MacOS/keryx-desktop")),
            Some(PathBuf::from("/Users/me/Apps"))
        );
        assert_eq!(install_dir(Path::new("/repo/apps/desktop/src-tauri/target/debug/keryx-desktop")), None);
        assert_eq!(install_dir(Path::new("/Applications/Other.app/Contents/MacOS/x")), None);
    }

    #[test]
    fn argv_is_built_as_separate_entries() {
        let dir = Path::new("/Users/me/My Apps");
        assert_eq!(status_args(dir), ["app", "status", "--json", "--dir", "/Users/me/My Apps"]);
        assert_eq!(
            update_args(dir, 42),
            ["app", "update", "--dir", "/Users/me/My Apps", "--wait-pid", "42", "--relaunch"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_status_reads_a_fake_keryx() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("keryx");
        std::fs::write(
            &fake,
            "#!/bin/sh\n[ \"$1 $2 $3 $4\" = \"app status --json --dir\" ] || exit 2\necho '{\"latest\":{\"version\":\"9.0.0\"},\"keryxVersion\":\"1.0.0\",\"minDesktopVersion\":\"0.1.0\"}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env: HashMap<String, String> = [("PATH".to_string(), "/usr/bin:/bin".to_string())].into();
        let s = run_status(&fake, dir.path(), &env).unwrap();
        assert_eq!(s.latest.unwrap().version, "9.0.0");

        let old = dir.path().join("old-keryx");
        std::fs::write(&old, "#!/bin/sh\necho 'Unknown command: app' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(run_status(&old, dir.path(), &env).is_none());
    }
}
