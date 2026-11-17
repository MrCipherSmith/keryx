//! The mutation allowlist. `FlowAction` is the only thing the web view can ask
//! for; an unknown `type` does not deserialize, and every argument is validated
//! before a process is resolved or spawned. argv is built here as separate
//! entries, never as a shell string.

use crate::locator;
use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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

/// A flow is addressed by its directory name: ids are shared across packages.
/// One path component of `[A-Za-z0-9._-]`, starting with a letter or digit (so
/// no `..`, no separator, no leading `-` that keryx would read as an option).
pub fn validate_flow_dir(dir: &str) -> Result<(), String> {
    let ok = dir.len() <= 200
        && dir.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && dir.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid flow directory: {dir:?}"))
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

/// Validate and turn an action into the `keryx` argv (without the program).
pub fn build_argv(id: &str, action: &FlowAction) -> Result<Vec<String>, String> {
    // `id` here is the flow directory name (see `validate_flow_dir`).
    validate_flow_dir(id)?;
    let mut argv: Vec<String> = vec!["flow".into()];
    let mut push = |items: &[&str]| argv.extend(items.iter().map(|s| s.to_string()));
    match action {
        FlowAction::Start => push(&["start", id]),
        FlowAction::Unblock => push(&["unblock", id]),
        FlowAction::Freeze => push(&["freeze", id]),
        FlowAction::Next => push(&["next", id, "--json"]),
        FlowAction::Block { reason } => push(&["block", id, "--reason", validate_text("reason", reason)?]),
        FlowAction::TaskAdd { title, kind } => push(&[
            "task",
            "add",
            id,
            "--title",
            validate_text("title", title)?,
            "--kind",
            one_of("kind", kind, &KINDS)?,
        ]),
        FlowAction::TaskAttempt { task_id, outcome, detail } => {
            validate_task_id(task_id)?;
            push(&["task", "attempt", id, task_id, "--outcome", one_of("outcome", outcome, &OUTCOMES)?]);
            if let Some(d) = detail.as_deref().filter(|d| !d.trim().is_empty()) {
                push(&["--detail", validate_text("detail", d)?]);
            }
        }
        FlowAction::TaskDone { task_id } => {
            validate_task_id(task_id)?;
            push(&["task", "done", id, task_id]);
        }
    }
    Ok(argv)
}

fn read_capped(mut r: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                // Keep draining past the cap so the child never blocks on a full pipe.
                Ok(n) => {
                    let room = OUTPUT_CAP.saturating_sub(kept.len());
                    kept.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&kept).into_owned());
    });
    rx
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
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", program.display()))?;
    let out = read_capped(child.stdout.take().expect("stdout piped"));
    let err = read_capped(child.stderr.take().expect("stderr piped"));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("keryx did not finish within {} s and was stopped", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("Could not wait for keryx: {e}")),
        }
    };
    Ok(ActionResult {
        ok: status.success(),
        exit_code: status.code(),
        stdout: out.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
        stderr: err.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
    })
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

    #[test]
    fn every_allowlisted_action_builds_the_documented_argv() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(build_argv("12", &act(json!({"type":"start"}))).unwrap(), s(&["flow", "start", "12"]));
        assert_eq!(
            build_argv("12", &act(json!({"type":"block","reason":"waiting on review"}))).unwrap(),
            s(&["flow", "block", "12", "--reason", "waiting on review"])
        );
        assert_eq!(build_argv("12", &act(json!({"type":"unblock"}))).unwrap(), s(&["flow", "unblock", "12"]));
        assert_eq!(
            build_argv("12", &act(json!({"type":"taskAdd","title":"Write docs; rm -rf /","kind":"docs"}))).unwrap(),
            s(&["flow", "task", "add", "12", "--title", "Write docs; rm -rf /", "--kind", "docs"])
        );
        assert_eq!(
            build_argv("12", &act(json!({"type":"taskAttempt","taskId":"T3","outcome":"failed","detail":"red"}))).unwrap(),
            s(&["flow", "task", "attempt", "12", "T3", "--outcome", "failed", "--detail", "red"])
        );
        assert_eq!(
            build_argv("12", &act(json!({"type":"taskAttempt","taskId":"T3","outcome":"started"}))).unwrap(),
            s(&["flow", "task", "attempt", "12", "T3", "--outcome", "started"])
        );
        assert_eq!(
            build_argv("12", &act(json!({"type":"taskDone","taskId":"T3"}))).unwrap(),
            s(&["flow", "task", "done", "12", "T3"])
        );
        assert_eq!(build_argv("12", &act(json!({"type":"freeze"}))).unwrap(), s(&["flow", "freeze", "12"]));
        assert_eq!(build_argv("12", &act(json!({"type":"next"}))).unwrap(), s(&["flow", "next", "12", "--json"]));
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
        for id in ["", "../1", "1; ls", "12 ", "-1", "-12-x", "..", ".", "a/b", "12\n", "١٢-x", &"1".repeat(201)] {
            assert!(build_argv(id, &start).is_err(), "id {id:?}");
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
            assert!(build_argv("1", &act(v.clone())).is_err(), "{v}");
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
