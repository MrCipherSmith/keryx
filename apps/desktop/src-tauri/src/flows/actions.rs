//! The mutation allowlist. `FlowAction` is the only thing the web view can ask
//! for; an unknown `type` does not deserialize, and every argument is validated
//! before a process is resolved or spawned. argv is built here as separate
//! entries, never as a shell string.

use super::package::is_flow_dir_name;
use crate::child::{self, RunError};
use crate::locator;
use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

pub const ACTION_TIMEOUT: Duration = Duration::from_secs(60);
pub const OUTPUT_CAP: usize = 1024 * 1024;
const MAX_TEXT_CHARS: usize = 4000;

const KINDS: [&str; 6] = ["context", "implement", "test", "verify", "review", "docs"];
/// `keryx flow task attempt` accepts exactly these outcomes.
const OUTCOMES: [&str; 3] = ["started", "failed", "blocked"];

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FlowAction {
    Start,
    Block { reason: String },
    Unblock,
    TaskAdd { title: String, kind: String },
    TaskAttempt {
        task_id: String,
        outcome: String,
        #[serde(default)]
        detail: Option<String>,
    },
    TaskDone { task_id: String },
    Freeze,
    Next,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// The mutation gate for a package name. A flow is addressed by its directory
/// name (ids are shared across packages), and a name keryx lists is one it
/// resolves by exact match. As an argv entry the name is safe because it is
/// one path component that starts with three digits (never `-`, so never read
/// as an option), and argv is never handed to a shell.
pub fn validate_flow_dir(package: &str) -> Result<(), String> {
    if is_flow_dir_name(package) {
        Ok(())
    } else {
        Err(format!("Invalid flow directory: {package:?}"))
    }
}

fn validate_task_id(id: &str) -> Result<(), String> {
    let digits = id.strip_prefix('T').unwrap_or("");
    if !digits.is_empty() && digits.len() <= 6 && digits.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err(format!("Invalid task id: {id:?}"))
    }
}

/// Free text becomes one argv entry. A leading `-` would be read by the keryx
/// option parser as a flag, so it is refused rather than escaped.
fn validate_text<'a>(what: &str, text: &'a str) -> Result<&'a str, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err(format!("{what} must not be empty"));
    }
    if t.starts_with('-') {
        return Err(format!("{what} must not start with '-'"));
    }
    if t.contains('\0') || t.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("{what} is invalid or longer than {MAX_TEXT_CHARS} characters"));
    }
    Ok(t)
}

fn one_of<'a>(what: &str, value: &'a str, allowed: &[&str]) -> Result<&'a str, String> {
    if allowed.contains(&value) {
        Ok(value)
    } else {
        Err(format!("Invalid {what}: {value:?}"))
    }
}

/// Validate and turn an action on the flow package `package` into the `keryx`
/// argv (without the program).
pub fn build_argv(package: &str, action: &FlowAction) -> Result<Vec<String>, String> {
    validate_flow_dir(package)?;
    let dir = package;
    let mut argv: Vec<String> = vec!["flow".into()];
    let mut push = |items: &[&str]| argv.extend(items.iter().map(|s| s.to_string()));
    match action {
        FlowAction::Start => push(&["start", dir]),
        FlowAction::Unblock => push(&["unblock", dir]),
        FlowAction::Freeze => push(&["freeze", dir]),
        FlowAction::Next => push(&["next", dir, "--json"]),
        FlowAction::Block { reason } => push(&["block", dir, "--reason", validate_text("reason", reason)?]),
        FlowAction::TaskAdd { title, kind } => push(&[
            "task",
            "add",
            dir,
            "--title",
            validate_text("title", title)?,
            "--kind",
            one_of("kind", kind, &KINDS)?,
        ]),
        FlowAction::TaskAttempt { task_id, outcome, detail } => {
            validate_task_id(task_id)?;
            push(&["task", "attempt", dir, task_id, "--outcome", one_of("outcome", outcome, &OUTCOMES)?]);
            if let Some(d) = detail.as_deref().filter(|d| !d.trim().is_empty()) {
                push(&["--detail", validate_text("detail", d)?]);
            }
        }
        FlowAction::TaskDone { task_id } => {
            validate_task_id(task_id)?;
            push(&["task", "done", dir, task_id]);
        }
    }
    Ok(argv)
}

/// Run `program args...` in `cwd`: stdin null, cleared env, output capped,
/// killed after `timeout`.
pub fn run_command(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    timeout: Duration,
) -> Result<ActionResult, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(cwd).env_clear().envs(env);
    match child::run_bounded(cmd, timeout, OUTPUT_CAP) {
        Ok(out) => Ok(ActionResult {
            ok: out.status.success(),
            exit_code: out.status.code(),
            stdout: out.stdout,
            stderr: out.stderr,
        }),
        Err(RunError::Spawn(e)) => Err(format!("Could not start {}: {e}", program.display())),
        Err(RunError::Wait(e)) => Err(format!("Could not wait for keryx: {e}")),
        Err(RunError::Timeout) => Err(format!("keryx did not finish within {} s and was stopped", timeout.as_secs())),
    }
}

/// Resolve keryx like the ACP process does (same settings, same login-shell
/// PATH) and run the already validated argv.
pub fn run_action(
    cwd: &str,
    argv: Vec<String>,
    env: HashMap<String, String>,
    settings: &Settings,
) -> Result<ActionResult, String> {
    let root = Path::new(cwd)
        .canonicalize()
        .map_err(|e| format!("The project folder is not available ({cwd}): {e}"))?;
    if !root.is_dir() {
        return Err(format!("Not a folder: {cwd}"));
    }
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let located = locator::locate(
        settings.keryx_source,
        settings.custom_path.as_deref(),
        exe_dir.as_deref(),
        env.get("PATH").map(std::ffi::OsString::from).as_deref(),
    )?;
    run_command(&located.path, &argv, &root, &env, ACTION_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn act(v: serde_json::Value) -> FlowAction {
        serde_json::from_value(v).unwrap()
    }

    /// A real package name, as keryx creates it.
    const DIR: &str = "012-2026-01-01-write-docs";

    #[test]
    fn every_allowlisted_action_builds_the_documented_argv() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(build_argv(DIR, &act(json!({"type":"start"}))).unwrap(), s(&["flow", "start", DIR]));
        assert_eq!(
            build_argv(DIR, &act(json!({"type":"block","reason":"waiting on review"}))).unwrap(),
            s(&["flow", "block", DIR, "--reason", "waiting on review"])
        );
        assert_eq!(build_argv(DIR, &act(json!({"type":"unblock"}))).unwrap(), s(&["flow", "unblock", DIR]));
        assert_eq!(
            build_argv(DIR, &act(json!({"type":"taskAdd","title":"Write docs; rm -rf /","kind":"docs"}))).unwrap(),
            s(&["flow", "task", "add", DIR, "--title", "Write docs; rm -rf /", "--kind", "docs"])
        );
        assert_eq!(
            build_argv(DIR, &act(json!({"type":"taskAttempt","taskId":"T3","outcome":"failed","detail":"red"}))).unwrap(),
            s(&["flow", "task", "attempt", DIR, "T3", "--outcome", "failed", "--detail", "red"])
        );
        assert_eq!(
            build_argv(DIR, &act(json!({"type":"taskAttempt","taskId":"T3","outcome":"started"}))).unwrap(),
            s(&["flow", "task", "attempt", DIR, "T3", "--outcome", "started"])
        );
        assert_eq!(
            build_argv(DIR, &act(json!({"type":"taskDone","taskId":"T3"}))).unwrap(),
            s(&["flow", "task", "done", DIR, "T3"])
        );
        assert_eq!(build_argv(DIR, &act(json!({"type":"freeze"}))).unwrap(), s(&["flow", "freeze", DIR]));
        assert_eq!(build_argv(DIR, &act(json!({"type":"next"}))).unwrap(), s(&["flow", "next", DIR, "--json"]));
    }

    #[test]
    fn package_names_keryx_lists_are_accepted() {
        for dir in [
            "001-x",
            "487-2026-11-10-shell-product-review-p1",
            "999-",
            "103-2026-01-04-duplicate-id",
            // keryx lists any `^\d{3}-` directory and resolves it by exact match.
            "012-Write-Docs",
            "012-a.b",
            "012-a_b",
            "012-a b",
            "012-x ",
        ] {
            assert!(is_flow_dir_name(dir), "{dir}");
            assert!(build_argv(dir, &act(json!({"type":"start"}))).is_ok(), "{dir}");
        }
    }

    #[test]
    fn names_keryx_does_not_list_are_refused() {
        let start = act(json!({"type":"start"}));
        for dir in [
            // A bare id passed the old digits-and-letters rule; keryx reads it as a
            // fuzzy reference (by id, then by slug), so it must not reach argv.
            "12",
            "012",
            "101",
            // Names keryx's listFlowDirs (^\d{3}-) does not list.
            "1234-2026-01-01-x",
            "12-x",
            "shell-images",
            "notes",
        ] {
            assert!(!is_flow_dir_name(dir), "{dir:?}");
            assert!(build_argv(dir, &start).is_err(), "{dir:?}");
        }
    }

    #[test]
    fn actions_outside_the_allowlist_do_not_deserialize() {
        for bad in [
            json!({"type":"complete"}),
            json!({"type":"confirm"}),
            json!({"type":"recover"}),
            json!({"type":"acUpdate"}),
            json!({"type":"shell","command":"ls"}),
            json!({"reason":"no type"}),
        ] {
            assert!(serde_json::from_value::<FlowAction>(bad.clone()).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn invalid_arguments_are_refused_before_any_process() {
        let start = act(json!({"type":"start"}));
        let too_long = format!("001-{}", "a".repeat(crate::flows::package::MAX_DIR_LEN));
        for dir in ["", "../1", "1; ls", "-1", "-12-x", "..", ".", "012-a/b", "012-x\n", "012-a\0b", "012-\u{7f}", "012-\tx", "١٢٣-x", &too_long] {
            assert!(build_argv(dir, &start).is_err(), "dir {dir:?}");
        }
        let bad = [
            json!({"type":"block","reason":""}),
            json!({"type":"block","reason":"--force"}),
            json!({"type":"block","reason":"a\u{0}b"}),
            json!({"type":"taskAdd","title":"x","kind":"deploy"}),
            json!({"type":"taskAdd","title":"","kind":"docs"}),
            json!({"type":"taskAttempt","taskId":"3","outcome":"failed"}),
            json!({"type":"taskAttempt","taskId":"T3","outcome":"exploded"}),
            json!({"type":"taskAttempt","taskId":"T3","outcome":"paused"}),
            json!({"type":"taskAttempt","taskId":"T3","outcome":"completed"}),
            json!({"type":"taskAttempt","taskId":"T3; ls","outcome":"failed"}),
            json!({"type":"taskAttempt","taskId":"T3","outcome":"failed","detail":"--x"}),
            json!({"type":"taskDone","taskId":"../T1"}),
            json!({"type":"taskDone","taskId":"T"}),
        ];
        for v in bad {
            assert!(build_argv(DIR, &act(v.clone())).is_err(), "{v}");
        }
    }

    #[test]
    fn run_action_refuses_before_spawning_when_the_project_is_missing() {
        let r = run_action("/definitely/not/here", vec!["flow".into()], HashMap::new(), &Settings::default());
        assert!(r.unwrap_err().contains("not available"));
    }

    fn env_with_path() -> HashMap<String, String> {
        HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())])
    }

    #[test]
    fn run_command_passes_argv_verbatim_and_caps_nothing_small() {
        let args: Vec<String> = ["a b", "$HOME", "; ls", "--x"].iter().map(|s| s.to_string()).collect();
        let r = run_command(Path::new("/bin/echo"), &args, Path::new("/"), &env_with_path(), Duration::from_secs(5)).unwrap();
        assert!(r.ok);
        assert_eq!(r.exit_code, Some(0));
        assert_eq!(r.stdout, "a b $HOME ; ls --x\n");
    }

    #[test]
    fn run_command_reports_failure_and_times_out() {
        let fail = run_command(Path::new("/bin/sh"), &["-c".into(), "echo oops >&2; exit 3".into()], Path::new("/"), &env_with_path(), Duration::from_secs(5)).unwrap();
        assert!(!fail.ok);
        assert_eq!(fail.exit_code, Some(3));
        assert_eq!(fail.stderr, "oops\n");

        let slow = run_command(Path::new("/bin/sleep"), &["5".into()], Path::new("/"), &env_with_path(), Duration::from_millis(200));
        assert!(slow.unwrap_err().contains("did not finish"));
    }

    #[test]
    fn output_is_capped() {
        let r = run_command(
            Path::new("/bin/sh"),
            &["-c".into(), "head -c 3000000 /dev/zero | tr '\\0' x".into()],
            Path::new("/"),
            &env_with_path(),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(r.stdout.len(), OUTPUT_CAP);
    }
}
