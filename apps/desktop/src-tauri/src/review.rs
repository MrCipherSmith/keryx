//! Read the versioned Review board protocol from the Keryx CLI.
use crate::{bridge::AppState, child, locator, panels::project_dir, projects::ProjectWindows, settings};
use serde::Deserialize;
use std::sync::atomic::{AtomicUsize, Ordering};
use serde_json::Value;
use std::{ffi::OsStr, path::PathBuf, process::Command, time::Duration};
use tauri::{AppHandle, Manager, Webview};

fn board_args(
    pr_state: Option<&str>,
    repo: Option<&str>,
    number: Option<u32>,
    repositories_only: bool,
) -> Result<Vec<String>, String> {
    let mut args = vec!["review".into(), "board".into(), "--json".into()];
    if repositories_only {
        if pr_state.is_some() || repo.is_some() || number.is_some() {
            return Err("configuration: Repository discovery cannot be combined with a PR query".into());
        }
        args.push("--repositories".into());
        return Ok(args);
    }
    if let Some(repo) = repo {
        if repo.is_empty() || repo.starts_with('-') || repo.contains(char::is_whitespace) {
            return Err("configuration: Invalid repository".into());
        }
        args.extend(["--repo".into(), repo.into()]);
    }
    match (pr_state, number) {
        (Some(state @ ("open" | "closed" | "merged" | "all")), None) => {
            args.extend(["--state".into(), state.into()]);
        }
        (None, Some(n)) if n > 0 && repo.is_some() => args.extend(["--number".into(), n.to_string()]),
        _ => return Err("configuration: Select a PR state or a repository and PR number".into()),
    }
    Ok(args)
}

// Across webviews, keep slow reads from exhausting subprocesses and pipe threads.
static READERS: AtomicUsize = AtomicUsize::new(0);
const MAX_READERS: usize = 8;

struct ReadPermit<'a>(&'a AtomicUsize);
impl<'a> ReadPermit<'a> {
    fn acquire(count: &'a AtomicUsize) -> Result<Self, String> {
        count.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| (n < MAX_READERS).then_some(n + 1))
            .map(|_| Self(count))
            .map_err(|_| "unavailable: Too many Review reads are running. Retry shortly.".into())
    }
}
impl Drop for ReadPermit<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

fn run_reader(cmd: Command) -> Result<Value, String> {
    let out = child::run_bounded(cmd, Duration::from_secs(150), 32 * 1024 * 1024)
        .map_err(|e| format!("unavailable: Could not run the Review reader: {e:?}"))?;
    if !out.status.success() {
        let reason = out.stderr.trim();
        return Err(if reason.is_empty() {
            format!("unavailable: Review reader exited with {}", out.status)
        } else {
            reason.to_owned()
        });
    }
    serde_json::from_str(&out.stdout).map_err(|_| "unavailable: The selected Keryx CLI did not return a valid Review response. Check the CLI version in Settings.".into())
}

#[tauri::command]
pub async fn review_board(
    app: AppHandle,
    view: Webview,
    cwd: String,
    pr_state: Option<String>,
    repo: Option<String>,
    number: Option<u32>,
    repositories_only: Option<bool>,
) -> Result<Value, String> {
    let args = board_args(pr_state.as_deref(), repo.as_deref(), number, repositories_only.unwrap_or(false))?;
    invoke_review(app, view, cwd, args, true).await
}

fn review_project(registered: Option<&str>, requested: &str) -> Result<PathBuf, String> {
    match registered {
        Some(cwd) if cwd == requested => project_dir(cwd),
        _ => Err("configuration: Open this project in the current view to use Review.".into()),
    }
}

async fn invoke_review(app: AppHandle, view: Webview, cwd: String, args: Vec<String>, read_only: bool) -> Result<Value, String> {
    let registered = app.state::<ProjectWindows>().cwd_for(view.label());
    let permit = read_only.then(|| ReadPermit::acquire(&READERS)).transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let root = review_project(registered.as_deref(), &cwd)?;
        let state = app.state::<AppState>();
        let env = state.environment();
        let prefs = settings::load_settings(&app);
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // In Automatic mode the app and its bundled reader share the same wire format.
        let reader = locator::locate_for_app(
            prefs.keryx_source,
            prefs.custom_path.as_deref(),
            exe.parent(),
            env.get("PATH").map(OsStr::new),
            true,
        )?;
        let mut cmd = Command::new(reader.path);
        cmd.current_dir(root).args(args).env_clear().envs(env);
        run_reader(cmd)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTarget {
    repo: String,
    repository_id: String,
    viewer: String,
    number: u32,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum RunAction {
    Status { id: Option<String>, #[serde(rename = "activityId")] activity_id: Option<String> },
    Start {
        #[serde(rename = "baseSha")]
        base_sha: String,
        #[serde(rename = "headSha")]
        head_sha: String,
    },
    Cancel { id: String },
}

fn run_args(target: RunTarget, action: RunAction) -> Result<Vec<String>, String> {
    if target.number == 0 {
        return Err("configuration: Invalid pull request number".into());
    }
    let (operation, extra) = match action {
        RunAction::Status { id: Some(_), activity_id: Some(_) } => return Err("Choose one Review attempt scope.".into()),
        RunAction::Status { id, activity_id } => ("status", id.into_iter().map(|id| ("--id", id))
            .chain(activity_id.into_iter().map(|id| ("--activity-id", id))).collect()),
        RunAction::Start { base_sha, head_sha } => ("start", vec![("--base", base_sha), ("--head", head_sha)]),
        RunAction::Cancel { id } => ("cancel", vec![("--id", id)]),
    };
    let mut args = vec!["review".into(), "desk-run".into(), operation.into(), "--json".into()];
    let fields = [
        ("--repo", target.repo),
        ("--repository-id", target.repository_id),
        ("--viewer", target.viewer),
        ("--number", target.number.to_string()),
    ];
    for (flag, value) in fields.into_iter().chain(extra) {
        if value.is_empty() || value.starts_with('-') || value.contains(char::is_whitespace) {
            return Err(format!("configuration: Invalid Review request field {flag}"));
        }
        args.extend([flag.into(), value]);
    }
    Ok(args)
}

#[tauri::command]
pub async fn review_run(
    app: AppHandle,
    view: Webview,
    cwd: String,
    target: RunTarget,
    action: RunAction,
) -> Result<Value, String> {
    let read_only = matches!(action, RunAction::Status { .. });
    invoke_review(app, view, cwd, run_args(target, action)?, read_only).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherTarget {
    repo: String,
    repository_id: String,
    viewer: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum WatcherAction {
    Status,
    Enable { #[serde(rename = "intervalMinutes")] interval_minutes: u16 },
    Pause,
    Resume,
}

impl WatcherTarget {
    fn args(self) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        for (flag, value) in [("--repo", self.repo), ("--repository-id", self.repository_id), ("--viewer", self.viewer)] {
            if value.is_empty() || value.starts_with('-') || value.contains(char::is_whitespace) {
                return Err("Invalid watcher identity.".into());
            }
            args.extend([flag.into(), value]);
        }
        Ok(args)
    }
}

fn rule_args(target: WatcherTarget, action: Value) -> Result<Vec<String>, String> {
    if !matches!(action["kind"].as_str(), Some("status" | "save" | "delete" | "mode")) {
        return Err("Unknown review rule operation.".into());
    }
    let request = action.to_string();
    if request.len() > 8192 {
        return Err("Review rule request is too large.".into());
    }
    let mut args = vec!["review".into(), "rules".into(), "--json".into()];
    args.extend(target.args()?);
    args.extend(["--request".into(), request]);
    Ok(args)
}

#[tauri::command]
pub async fn review_rules(
    app: AppHandle,
    view: Webview,
    cwd: String,
    target: WatcherTarget,
    action: Value,
) -> Result<Value, String> {
    let read_only = action["kind"] == "status";
    invoke_review(app, view, cwd, rule_args(target, action)?, read_only).await
}

fn watcher_args(target: Option<WatcherTarget>, action: WatcherAction) -> Result<Vec<String>, String> {
    let (op, interval) = match action {
        WatcherAction::Status => ("status", None),
        WatcherAction::Enable { interval_minutes: n @ 1..=1440 } => ("enable", Some(n)),
        WatcherAction::Enable { .. } => return Err("Choose a watcher interval from 1 to 1440 minutes.".into()),
        WatcherAction::Pause => ("pause", None),
        WatcherAction::Resume => ("resume", None),
    };
    let mut args = vec!["review".into(), "watch".into(), op.into(), "--json".into()];
    if let Some(key) = target {
        args.extend(key.args()?);
    } else if op != "status" && op != "pause" {
        return Err("Select a repository for the watcher.".into());
    }
    if let Some(minutes) = interval {
        args.extend(["--interval-minutes".into(), minutes.to_string()]);
    }
    Ok(args)
}

#[tauri::command]
pub async fn review_watcher(
    app: AppHandle,
    view: Webview,
    cwd: String,
    target: Option<WatcherTarget>,
    action: WatcherAction,
) -> Result<Value, String> {
    let read_only = matches!(action, WatcherAction::Status);
    invoke_review(app, view, cwd, watcher_args(target, action)?, read_only).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_commands_resolve_only_the_registered_project() {
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let cwd = project.path().to_str().unwrap();
        assert_eq!(review_project(Some(cwd), cwd).unwrap(), project.path());
        assert!(review_project(Some(cwd), other.path().to_str().unwrap()).is_err());
        assert!(review_project(None, cwd).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reader_decodes_json_and_preserves_access_failures() {
        let mut success = Command::new("/bin/echo");
        success.arg(r#"{"version":1,"cards":[]}"#);
        assert_eq!(run_reader(success).unwrap()["version"], 1);

        let mut denied = Command::new("/bin/sh");
        denied.args(["-c", "echo 'access: repository unavailable' >&2; exit 1"]);
        assert_eq!(run_reader(denied).unwrap_err(), "access: repository unavailable");
    }

    #[test]
    fn rule_settings_only_forward_scoped_data() {
        let key = || WatcherTarget { repo: "org/repo".into(), repository_id: "R".into(), viewer: "me".into() };
        assert!(rule_args(key(), serde_json::json!({"kind":"worker"})).is_err());
        for rule in [serde_json::json!({}), serde_json::json!({"budgetTokens": null}), serde_json::json!({"budgetTokens": 500000})] {
            let request = serde_json::json!({"kind": "save", "rule": rule});
            let args = rule_args(key(), request.clone()).unwrap();
            assert_eq!(serde_json::from_str::<Value>(args.last().unwrap()).unwrap(), request);
        }
        let args = rule_args(key(), serde_json::json!({"kind":"mode", "number":1, "choice":{"mode":"manual"}})).unwrap();
        assert_eq!(&args[..5], ["review","rules","--json","--repo","org/repo"]);
        assert_eq!(args[9], "--request");
        assert_eq!(serde_json::from_str::<Value>(&args[10]).unwrap()["choice"]["mode"], "manual");
    }

    #[test]
    fn watcher_controls_use_only_scoped_cli_operations() {
        assert!(serde_json::from_str::<WatcherAction>(r#"{"kind":"tick"}"#).is_err());
        assert!(watcher_args(None, WatcherAction::Resume).is_err());
        assert_eq!(watcher_args(None, WatcherAction::Pause).unwrap(), ["review", "watch", "pause", "--json"]);
        let key = || Some(WatcherTarget { repo: "org/repo".into(), repository_id: "R".into(), viewer: "me".into() });
        let enabled = watcher_args(key(), WatcherAction::Enable { interval_minutes: 10 }).unwrap();
        assert_eq!(&enabled[4..], ["--repo","org/repo","--repository-id","R","--viewer","me","--interval-minutes","10"]);
        assert!(watcher_args(key(), WatcherAction::Enable { interval_minutes: 0 }).is_err());
    }

    #[test]
    fn manual_review_exposes_only_typed_operations() {
        let target = || RunTarget {
            repo: "org/r".into(), repository_id: "R_42".into(), viewer: "me".into(), number: 4,
        };
        let start = RunAction::Start { base_sha: "b".repeat(40), head_sha: "c".repeat(40) };
        let args = run_args(target(), start).unwrap();
        assert_eq!(&args[..5], ["review", "desk-run", "start", "--json", "--repo"]);
        assert_eq!(&args[12..], ["--base", &"b".repeat(40), "--head", &"c".repeat(40)]);
        assert!(serde_json::from_str::<RunAction>(r#"{"kind":"worker"}"#).is_err());
        assert!(run_args(target(), RunAction::Cancel { id: "--worker".into() }).is_err());
        let mut invalid = target();
        invalid.number = 0;
        assert!(run_args(invalid, RunAction::Status { id: None, activity_id: None }).is_err());
    }

    #[test]
    fn reader_capacity_is_released_after_completion() {
        let count = AtomicUsize::new(0);
        let mut acquired: Vec<_> = (0..MAX_READERS).map(|_| ReadPermit::acquire(&count).unwrap()).collect();
        assert!(ReadPermit::acquire(&count).is_err());
        acquired.pop();
        assert!(ReadPermit::acquire(&count).is_ok());
    }

    #[test]
    fn review_requests_have_a_fixed_read_only_command() {
        assert_eq!(board_args(Some("all"), None, None, false).unwrap(), ["review", "board", "--json", "--state", "all"]);
        assert_eq!(board_args(None, Some("team/r"), Some(4), false).unwrap(), ["review", "board", "--json", "--repo", "team/r", "--number", "4"]);
        assert_eq!(board_args(None, None, None, true).unwrap(), ["review", "board", "--json", "--repositories"]);
        assert!(board_args(Some("open"), None, None, true).is_err());
        assert!(board_args(None, None, Some(4), false).is_err());
        assert!(board_args(Some("open"), Some("--other"), None, false).is_err());
        assert!(board_args(Some("open"), Some("team/r"), Some(1), false).is_err());
    }
}
