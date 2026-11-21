//! Read the versioned Review board protocol from the Keryx CLI.
use crate::{bridge::AppState, child, locator, panels::project_dir, projects::ProjectWindows, settings};
use serde::Deserialize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use serde_json::Value;
use std::{ffi::OsStr, io::Write, path::PathBuf, process::{Command, Stdio}, time::Duration};
use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BadgeTarget {
    repository_id: String,
    viewer: String,
    revisions: String,
}

fn board_read_args(pr_state: Option<&str>, repo: Option<&str>, number: Option<u32>, repositories_only: bool,
    paged: bool, cursor: Option<&str>, badges: Option<BadgeTarget>) -> Result<Vec<String>, String> {
    if let Some(target) = badges {
        if paged || cursor.is_some() || repositories_only || pr_state.is_some() || number.is_some() || target.revisions.is_empty()
            || target.revisions.len() > 50000 || !target.revisions.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b',') {
            return Err("configuration: Invalid badge request".into());
        }
        let mut args = vec!["review".into(), "board".into(), "--json".into()];
        for (flag, value) in [("--repo", repo.unwrap_or_default()), ("--viewer", &target.viewer), ("--repository-id", &target.repository_id)] {
            if value.is_empty() || value.starts_with('-') || value.contains(char::is_whitespace) { return Err("configuration: Invalid badge identity".into()); }
            args.extend([flag.into(), value.into()]);
        }
        args.extend(["--badge-revisions".into(), target.revisions]);
        return Ok(args);
    }
    let mut args = board_args(pr_state, repo, number, repositories_only)?;
    if paged {
        if pr_state.is_none() { return Err("configuration: Select a board state to page".into()); }
        args.extend(["--page".into(), "--cards-only".into()]);
    }
    if let Some(value) = cursor {
        if !paged || value.is_empty() || value.len() > 4096 { return Err("configuration: Invalid board cursor".into()); }
        args.push(format!("--cursor={value}"));
    }
    Ok(args)
}

// Across webviews, keep slow reads from exhausting subprocesses and pipe threads.
static READERS: AtomicUsize = AtomicUsize::new(0);
const MAX_READERS: usize = 8;

struct ReadPermit<'a>(&'a AtomicUsize);
impl<'a> ReadPermit<'a> {
    fn acquire(count: &'a AtomicUsize) -> Result<Self, String> {
        let mut readers = count.load(Ordering::Relaxed);
        while readers < MAX_READERS {
            match count.compare_exchange_weak(readers, readers + 1, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => return Ok(Self(count)),
                Err(actual) => readers = actual,
            }
        }
        Err("unavailable: Too many Review reads are running. Retry shortly.".into())
    }
}
impl Drop for ReadPermit<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

fn run_reader(cmd: Command) -> Result<Value, String> {
    run_reader_with_input(cmd, Stdio::null(), false)
}

fn run_reader_with_input(cmd: Command, input: Stdio, prompted: bool) -> Result<Value, String> {
    let out = child::run_bounded_with_stdin(cmd, input, Duration::from_secs(150), 32 * 1024 * 1024)
        .map_err(|e| format!("unavailable: Could not run the Review reader: {e:?}"))?;
    if !out.status.success() {
        // The CLI may have printed a confirmation prompt before failing.
        let reason = out.stderr.trim();
        let reason = if prompted { reason.lines().next_back().unwrap_or_default() } else { reason };
        return Err(if reason.is_empty() {
            format!("unavailable: Review reader exited with {}", out.status)
        } else {
            reason.to_owned()
        });
    }
    serde_json::from_str(&out.stdout).map_err(|_| "unavailable: The selected Keryx CLI did not return a valid Review response. Check the CLI version in Settings.".into())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn review_board(
    app: AppHandle,
    view: Webview,
    cwd: String,
    pr_state: Option<String>,
    repo: Option<String>,
    number: Option<u32>,
    repositories_only: Option<bool>,
    paged: Option<bool>,
    cursor: Option<String>,
    badge_target: Option<BadgeTarget>,
) -> Result<Value, String> {
    let args = board_read_args(pr_state.as_deref(), repo.as_deref(), number, repositories_only.unwrap_or(false), paged.unwrap_or(false), cursor.as_deref(), badge_target)?;
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
    invoke_review_at(app, args, read_only, move || review_project(registered.as_deref(), &cwd)).await
}

async fn invoke_review_at(
    app: AppHandle, args: Vec<String>, read_only: bool,
    root: impl FnOnce() -> Result<PathBuf, String> + Send + 'static,
) -> Result<Value, String> {
    invoke_review_at_with(app, read_only, root, move |mut cmd| {
        let desktop_action = args.first().map(String::as_str) == Some("review")
            && args.get(1).map(String::as_str) == Some("desk-run")
            && matches!(args.get(2).map(String::as_str), Some("start" | "continue" | "decide"));
        cmd.args(args);
        if desktop_action {
            cmd.env("KERYX_DESKTOP_REVIEW_ACTION", "1");
        }
        run_reader(cmd)
    }).await
}

async fn invoke_review_at_with(
    app: AppHandle, read_only: bool,
    root: impl FnOnce() -> Result<PathBuf, String> + Send + 'static,
    run: impl FnOnce(Command) -> Result<Value, String> + Send + 'static,
) -> Result<Value, String> {
    let permit = read_only.then(|| ReadPermit::acquire(&READERS)).transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let root = root()?;
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
        cmd.current_dir(root).env_clear().envs(env);
        run(cmd)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn github_accounts_args(action: &str, login: Option<&str>, skip: bool) -> Result<Vec<String>, String> {
    let mut args = vec!["review".into(), "accounts".into(), action.into(), "--json".into()];
    match (action, login, skip) {
        ("list" | "project", None, false) => {}
        ("bind", None, true) => args.push("--skip".into()),
        ("bind", Some(login), false)
            if login.len() <= 100
                && login.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
                && login.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') =>
        {
            args.extend(["--login".into(), login.into()]);
        }
        _ => return Err("configuration: Invalid GitHub account request.".into()),
    }
    Ok(args)
}

#[tauri::command]
pub async fn github_accounts(
    app: AppHandle, view: Webview, action: String, cwd: Option<String>, login: Option<String>, skip: Option<bool>,
) -> Result<Value, String> {
    let args = github_accounts_args(&action, login.as_deref(), skip.unwrap_or(false))?;
    if action == "list" && cwd.is_none() {
        let context = app.clone();
        return invoke_review_at(app, args, true, move || {
            context.path().home_dir().map_err(|_| "configuration: Could not locate the home directory.".into())
        }).await;
    }
    if action == "list" {
        return Err("configuration: List GitHub accounts without a project folder.".into());
    }
    let cwd = cwd.ok_or("configuration: Open a project to select its GitHub account.")?;
    invoke_review(app, view, cwd, args, action == "project").await
}

// Use a system-installed executable, a neutral cwd and a fixed URL. Both the
// logged-in gh account and clipboard live outside the invoking project.
static GITHUB_LOGIN: Mutex<()> = Mutex::new(());
const GITHUB_LOGIN_URL: &str = "https://github.com/login/device";
const GITHUB_LOGIN_ARGS: &[&str] =
    &["auth", "login", "--hostname", "github.com", "--web", "--clipboard", "--skip-ssh-key"];

#[tauri::command]
pub async fn github_login(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = GITHUB_LOGIN.try_lock()
            .map_err(|_| "A GitHub sign-in is already in progress.".to_string())?;
        let gh = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].iter()
            .filter_map(|entry| std::fs::canonicalize(entry).ok())
            .find(|path| path.is_file())
            .ok_or("Could not find GitHub CLI in a standard system location. Install gh or sign in from a terminal and refresh.")?;
        let home = app.path().home_dir().map_err(|_| "Could not locate the home directory.")?;
        let state = app.state::<AppState>();
        let env = state.environment();
        let mut cmd = Command::new(gh);
        cmd.current_dir(&home).args(GITHUB_LOGIN_ARGS).env_clear()
            .env("HOME", &home).env("PATH", "/usr/bin:/bin")
            .env("GH_PROMPT_DISABLED", "1").env("GH_NO_UPDATE_NOTIFIER", "1");
        for key in ["GH_CONFIG_DIR", "XDG_CONFIG_HOME", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"] {
            if let Some(value) = env.get(key) {
                cmd.env(key, value);
            }
        }
        app.opener().open_url(GITHUB_LOGIN_URL, None::<&str>)
            .map_err(|_| "Could not open GitHub in the browser.")?;
        match child::run_bounded(cmd, Duration::from_secs(300), 4096) {
            Ok(out) if out.status.success() => Ok(()),
            Err(child::RunError::Timeout) => Err("GitHub sign-in timed out. Add the account again.".into()),
            _ => Err("Could not sign in with GitHub CLI. Check gh or sign in from a terminal and refresh.".into()),
        }
    }).await.map_err(|_| "Could not start GitHub sign-in.".to_string())?
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
        options: Option<Value>,
    },
    Cancel { id: String },
    Continue { id: String, guidance: Option<String> },
    Answer { id: String, #[serde(rename = "questionId")] question_id: String, answer: String },
    Readiness { id: String },
    Decide { id: String, decision: String, reason: String, waive: Option<Vec<String>> },
}

fn run_args(target: RunTarget, action: RunAction) -> Result<Vec<String>, String> {
    if target.number == 0 {
        return Err("configuration: Invalid pull request number".into());
    }
    let mut payload_arg = None;
    let mut waiver_arg = None;
    let (operation, extra) = match action {
        RunAction::Status { id: Some(_), activity_id: Some(_) } => return Err("Choose one Review attempt scope.".into()),
        RunAction::Status { id, activity_id } => ("status", id.into_iter().map(|id| ("--id", id))
            .chain(activity_id.into_iter().map(|id| ("--activity-id", id))).collect()),
        RunAction::Start { base_sha, head_sha, options } => {
            if let Some(options) = options {
                let json = options.to_string();
                if !options.is_object() || json.len() > 8192 {
                    return Err("configuration: Invalid review settings.".into());
                }
                payload_arg = Some(format!("--options={json}"));
            }
            ("start", vec![("--base", base_sha), ("--head", head_sha)])
        },
        RunAction::Continue { id, guidance } => {
            if let Some(text) = guidance {
                if text.encode_utf16().count() > 2000 || text.contains('\0') {
                    return Err("configuration: Review guidance is too long.".into());
                }
                payload_arg = Some(format!("--guidance={text}"));
            }
            ("continue", vec![("--id", id)])
        },
        RunAction::Cancel { id } => ("cancel", vec![("--id", id)]),
        RunAction::Readiness { id } => ("readiness", vec![("--id", id)]),
        RunAction::Decide { id, decision, reason, waive } => {
            if !matches!(decision.as_str(), "complete" | "close" | "archive" | "restore" | "delete")
                || reason.trim().is_empty() || reason.encode_utf16().count() > 2000 || reason.contains('\0') {
                return Err("configuration: Invalid review decision or reason.".into());
            }
            if let Some(items) = waive {
                if decision != "complete" || items.len() > 12 || items.is_empty() || items.iter().any(|item|
                    item.is_empty() || item.len() > 40 || !item.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')) {
                    return Err("configuration: Invalid review check selection.".into());
                }
                waiver_arg = Some(format!("--waive={}", items.join(",")));
            }
            payload_arg = Some(format!("--reason={reason}"));
            ("decide", vec![("--id", id), ("--decision", decision)])
        },
        RunAction::Answer { id, question_id, answer } => {
            if answer.trim().is_empty() || answer.encode_utf16().count() > 2000 || answer.contains('\0') {
                return Err("configuration: Invalid review answer.".into());
            }
            payload_arg = Some(format!("--answer={answer}"));
            ("answer", vec![("--id", id), ("--question-id", question_id)])
        }
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
    args.extend(payload_arg);
    args.extend(waiver_arg);
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
    let read_only = matches!(action, RunAction::Status { .. } | RunAction::Readiness { .. });
    invoke_review(app, view, cwd, run_args(target, action)?, read_only).await
}

const PUBLICATION_REQUEST_LIMIT: usize = 1024 * 1024;

fn publication_args(target: &RunTarget) -> Result<Vec<String>, String> {
    if target.number == 0 || target.number > i32::MAX as u32 {
        return Err("configuration: Invalid pull request number.".into());
    }
    let fields = [
        ("--repo", &target.repo),
        ("--repository-id", &target.repository_id),
        ("--viewer", &target.viewer),
    ];
    let mut args = vec!["review".into(), "desk-publish".into(), "--json".into()];
    for (flag, value) in fields {
        if value.is_empty()
            || value.len() > 256
            || value.starts_with('-')
            || value.contains(char::is_whitespace)
            || value.chars().any(char::is_control)
        {
            return Err("configuration: Invalid Review publication target.".into());
        }
        args.extend([flag.into(), value.clone()]);
    }
    args.extend(["--number".into(), target.number.to_string()]);
    Ok(args)
}

fn publication_request_file(request: &str) -> Result<tempfile::NamedTempFile, String> {
    if request.len() > PUBLICATION_REQUEST_LIMIT {
        return Err("configuration: Review publication request is too large.".into());
    }
    // NamedTempFile creates an owner-only file on Unix and removes it on every return path.
    let temp_error = |_| "unavailable: Could not stage the local Review publication request.".to_string();
    let mut file = tempfile::NamedTempFile::new().map_err(temp_error)?;
    file.write_all(request.as_bytes()).map_err(temp_error)?;
    Ok(file)
}

#[cfg(unix)]
fn publication_terminal() -> std::io::Result<(std::fs::File, Stdio)> {
    use std::fs::File;
    use std::os::fd::FromRawFd;
    use std::ptr::null_mut;

    let (mut master, mut slave) = (-1, -1);
    // SAFETY: openpty initializes both file descriptors when it returns success.
    if unsafe { libc::openpty(&mut master, &mut slave, null_mut(), null_mut(), null_mut()) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: descriptors are fresh and the File handles take exclusive ownership.
    let (mut input, tty) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
    for fd in [master, slave] {
        // SAFETY: both descriptors are open and owned here; no unrelated child needs them.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    input.write_all(b"publish
")?;
    // Keep the PTY master open while the child reads; JSON stdout and stderr stay separate.
    Ok((input, tty.into()))
}

#[cfg(unix)]
fn run_approved_publication(cmd: Command) -> Result<Value, String> {
    let (_terminal, stdin) = publication_terminal()
        .map_err(|_| "unavailable: Could not open a private terminal for Review publication.".to_string())?;
    run_reader_with_input(cmd, stdin, true)
}

#[cfg(not(unix))]
fn run_approved_publication(_cmd: Command) -> Result<Value, String> {
    Err("unavailable: Publish this review from the CLI in your terminal.".into())
}

#[tauri::command]
pub async fn review_publish(
    app: AppHandle,
    view: Webview,
    cwd: String,
    target: RunTarget,
    request: Value,
) -> Result<Value, String> {
    let (read_only, submit) = match request["kind"].as_str() {
        Some("preview") => (true, false),
        Some("save" | "skip") => (false, false),
        Some("submit") => (false, true),
        _ => return Err("configuration: Unknown Review publication operation.".into()),
    };
    let args = publication_args(&target)?;
    let request = request.to_string();
    if request.len() > PUBLICATION_REQUEST_LIMIT {
        return Err("configuration: Review publication request is too large.".into());
    }
    let registered = app.state::<ProjectWindows>().cwd_for(view.label());
    let window = view.window();
    let view_label = view.label().to_string();
    let app_for_confirmation = app.clone();
    let project = cwd.clone();
    invoke_review_at_with(app, read_only, move || review_project(registered.as_deref(), &cwd), move |mut cmd| {
        if submit {
            let confirmed = app_for_confirmation.dialog()
                .message(format!("Publish the review for {} #{} on GitHub as @{}?", target.repo, target.number, target.viewer))
                .title("Publish review to GitHub")
                .parent(&window)
                .buttons(MessageDialogButtons::OkCancelCustom("Publish review".into(), "Cancel".into()))
                .blocking_show();
            if !confirmed {
                return Err("permission: Publication cancelled. No review was sent.".into());
            }
            let current = app_for_confirmation.state::<ProjectWindows>().cwd_for(&view_label);
            review_project(current.as_deref(), &project)?;
        }
        let request_file = publication_request_file(&request)?;
        cmd.args(args).arg("--request-file").arg(request_file.path());
        if submit { run_approved_publication(cmd) } else { run_reader(cmd) }
    }).await
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
    if !matches!(action["kind"].as_str(), Some("status" | "save" | "delete" | "mode" | "subscription")) {
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
    fn github_account_commands_only_accept_scoped_argv() {
        assert_eq!(github_accounts_args("list", None, false).unwrap(),
            ["review", "accounts", "list", "--json"]);
        assert_eq!(github_accounts_args("project", None, false).unwrap(),
            ["review", "accounts", "project", "--json"]);
        assert_eq!(github_accounts_args("bind", Some("work-user"), false).unwrap(),
            ["review", "accounts", "bind", "--json", "--login", "work-user"]);
        assert_eq!(github_accounts_args("bind", None, true).unwrap(),
            ["review", "accounts", "bind", "--json", "--skip"]);
        for login in ["", "--force", "two words", "user\nname"] {
            assert!(github_accounts_args("bind", Some(login), false).is_err());
        }
        assert!(github_accounts_args("bind", Some("user"), true).is_err());
        assert!(github_accounts_args("list", Some("user"), false).is_err());
        assert!(github_accounts_args("login", None, false).is_err());
    }

    #[test]
    fn review_commands_resolve_only_the_registered_project() {
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let cwd = project.path().to_str().unwrap();
        // A temporary directory may be reached through an alias on macOS.
        let canonical = project.path().canonicalize().unwrap();
        assert_eq!(review_project(Some(cwd), cwd).unwrap(), canonical);
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
    fn badge_batches_and_page_cursors_are_read_only_board_queries() {
        let r = format!("1:{}:{}", "a".repeat(40), "b".repeat(40));
        let target = BadgeTarget { repository_id: "R".into(), viewer: "me".into(), revisions: r.clone() };
        assert_eq!(board_read_args(None, Some("org/repo"), None, false, false, None, Some(target)).unwrap(),
            ["review","board","--json","--repo","org/repo","--viewer","me","--repository-id","R","--badge-revisions",&r]);
        assert_eq!(board_read_args(Some("open"),None,None,false,true,Some("-abc"),None).unwrap(),
            ["review","board","--json","--state","open","--page","--cards-only","--cursor=-abc"]);
        assert!(board_read_args(None,Some("org/repo"),Some(1),false,true,None,None).is_err());
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
        let start = RunAction::Start { base_sha: "b".repeat(40), head_sha: "c".repeat(40), options: None };
        let args = run_args(target(), start).unwrap();
        assert_eq!(&args[..5], ["review", "desk-run", "start", "--json", "--repo"]);
        assert_eq!(&args[12..], ["--base", &"b".repeat(40), "--head", &"c".repeat(40)]);
        let configured = RunAction::Start {
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            options: Some(serde_json::json!({ "mode": "auto", "adaptive": true })),
        };
        let args = run_args(target(), configured).unwrap();
        let payload = args.last().unwrap().strip_prefix("--options=").unwrap();
        let decoded: Value = serde_json::from_str(payload).unwrap();
        assert_eq!(decoded["mode"], "auto");
        assert!(serde_json::from_str::<RunAction>(r#"{"kind":"worker"}"#).is_err());
        assert!(run_args(target(), RunAction::Cancel { id: "--worker".into() }).is_err());
        let answer = RunAction::Answer { id: "run".into(), question_id: "q".into(), answer: "--continue with this".into() };
        assert_eq!(&run_args(target(), answer).unwrap()[12..], ["--id", "run", "--question-id", "q", "--answer=--continue with this"]);
        let mut invalid = target();
        invalid.number = 0;
        assert!(run_args(invalid, RunAction::Status { id: None, activity_id: None }).is_err());
    }

    #[test]
    fn publication_scopes_the_target_and_stages_a_bounded_request_file() {
        let mut target = RunTarget {
            repo: "org/r".into(), repository_id: "R_42".into(), viewer: "me".into(), number: 4,
        };
        assert_eq!(publication_args(&target).unwrap(), [
            "review", "desk-publish", "--json", "--repo", "org/r", "--repository-id", "R_42",
            "--viewer", "me", "--number", "4",
        ]);
        let request = serde_json::json!({"kind": "preview", "id": "a".repeat(48 * 1024)}).to_string();
        let file = publication_request_file(&request).unwrap();
        let path = file.path().to_owned();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), request);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
        drop(file);
        assert!(!path.exists());
        assert!(publication_request_file(&"x".repeat(PUBLICATION_REQUEST_LIMIT + 1)).is_err());
        target.repo = "--config".into();
        assert!(publication_args(&target).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn private_publication_terminal_leaves_json_stdout_separate() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "test -t 0 && read -r answer && test \"$answer\" = publish && printf '%s' '{\"version\":1}'"]);
        assert_eq!(run_approved_publication(cmd).unwrap()["version"], 1);
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
