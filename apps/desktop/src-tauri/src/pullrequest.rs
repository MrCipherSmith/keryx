//! The open GitHub pull request of the project's current branch, as the composer footer
//! shows it: number, link, CI rollup, review decision, unresolved review threads.
//! Everything goes through the `gh` CLI in the project folder under one hard deadline;
//! no PR, no `gh`, no auth, offline or slow all mean `null`, never an error.

use crate::bridge::AppState;
use crate::child;
use crate::locator;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::State;

const DEADLINE: Duration = Duration::from_secs(8);
const OUTPUT_CAP: usize = 1024 * 1024;

const THREADS_QUERY: &str = "query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){reviewThreads(first:100){nodes{isResolved}}}}}";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub url: String,
    pub is_draft: bool,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or empty.
    pub review_decision: String,
    /// `passed`, `failed`, `pending` or `none`.
    pub ci: String,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
    pub unresolved_threads: u32,
}

/// Parses `gh pr view --json number,url,state,isDraft,reviewDecision,statusCheckRollup`.
/// Only an open PR yields a summary.
pub fn parse_pr(json: &str) -> Option<PrInfo> {
    let v: Value = serde_json::from_str(json).ok()?;
    if v.get("state").and_then(Value::as_str) != Some("OPEN") {
        return None;
    }
    let mut info = PrInfo {
        number: v.get("number")?.as_u64()?,
        url: v.get("url")?.as_str()?.to_string(),
        is_draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        review_decision: v.get("reviewDecision").and_then(Value::as_str).unwrap_or("").to_string(),
        ..PrInfo::default()
    };
    for c in v.get("statusCheckRollup").and_then(Value::as_array).into_iter().flatten() {
        let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("");
        // A CheckRun has status + conclusion; a commit StatusContext only a state.
        let class = if c.get("status").is_some() {
            if s("status") != "COMPLETED" {
                'p'
            } else {
                match s("conclusion") {
                    "SUCCESS" | "NEUTRAL" | "SKIPPED" => 'o',
                    _ => 'f',
                }
            }
        } else {
            match s("state") {
                "SUCCESS" => 'o',
                "PENDING" | "EXPECTED" => 'p',
                _ => 'f',
            }
        };
        match class {
            'o' => info.checks_passed += 1,
            'f' => info.checks_failed += 1,
            _ => info.checks_pending += 1,
        }
    }
    info.ci = if info.checks_failed > 0 {
        "failed"
    } else if info.checks_pending > 0 {
        "pending"
    } else if info.checks_passed > 0 {
        "passed"
    } else {
        "none"
    }
    .to_string();
    Some(info)
}

/// `(owner, repo)` from a `https://github.com/owner/repo/pull/N` URL.
pub fn repo_of(url: &str) -> Option<(String, String)> {
    let rest = url.split("://").nth(1)?;
    let mut parts = rest.split('/');
    parts.next()?;
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?;
    Some((owner.to_string(), repo.to_string()))
}

/// Counts unresolved review threads in the GraphQL answer; a malformed one counts none.
pub fn parse_threads(json: &str) -> u32 {
    let Ok(v) = serde_json::from_str::<Value>(json) else { return 0 };
    v.pointer("/data/repository/pullRequest/reviewThreads/nodes")
        .and_then(Value::as_array)
        .map(|n| n.iter().filter(|t| t.get("isResolved").and_then(Value::as_bool) == Some(false)).count() as u32)
        .unwrap_or(0)
}

fn gh(gh_bin: &Path, dir: &Path, path_env: Option<&str>, args: &[&str], deadline: Instant) -> Option<String> {
    let left = deadline.checked_duration_since(Instant::now())?;
    let mut cmd = Command::new(gh_bin);
    cmd.args(args)
        .current_dir(dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1");
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let out = child::run_bounded(cmd, left, OUTPUT_CAP).ok()?;
    out.status.success().then_some(out.stdout)
}

fn read(dir: &Path, path_env: Option<&str>) -> Option<PrInfo> {
    let deadline = Instant::now() + DEADLINE;
    let bin = locator::which("gh", path_env.map(std::ffi::OsStr::new))?;
    let text = gh(&bin, dir, path_env, &["pr", "view", "--json", "number,url,state,isDraft,reviewDecision,statusCheckRollup"], deadline)?;
    let mut info = parse_pr(&text)?;
    if let Some((owner, repo)) = repo_of(&info.url) {
        let q = format!("query={THREADS_QUERY}");
        let (o, n, num) = (format!("o={owner}"), format!("n={repo}"), format!("num={}", info.number));
        if let Some(t) = gh(&bin, dir, path_env, &["api", "graphql", "-f", &q, "-f", &o, "-f", &n, "-F", &num], deadline) {
            info.unresolved_threads = parse_threads(&t);
        }
    }
    Some(info)
}

/// The open PR of `cwd`'s branch, or `null` when there is none or it cannot be read.
#[tauri::command]
pub async fn pr_info(state: State<'_, AppState>, cwd: String) -> Result<Option<PrInfo>, String> {
    let path = state.environment().get("PATH").cloned();
    Ok(tauri::async_runtime::spawn_blocking(move || read(Path::new(&cwd), path.as_deref()))
        .await
        .unwrap_or(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(checks: &str, extra: &str) -> String {
        format!(r#"{{"number":12,"url":"https://github.com/o/r/pull/12","state":"OPEN","isDraft":false,"reviewDecision":"{extra}","statusCheckRollup":[{checks}]}}"#)
    }
    const OK: &str = r#"{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}"#;
    const BAD: &str = r#"{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}"#;
    const RUN: &str = r#"{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""}"#;
    const CTX: &str = r#"{"__typename":"StatusContext","state":"SUCCESS"}"#;

    #[test]
    fn all_checks_passed() {
        let i = parse_pr(&pr(&format!("{OK},{CTX}"), "APPROVED")).unwrap();
        assert_eq!((i.number, i.ci.as_str(), i.checks_passed), (12, "passed", 2));
        assert_eq!(i.review_decision, "APPROVED");
    }

    #[test]
    fn a_failed_check_wins_over_a_running_one() {
        let i = parse_pr(&pr(&format!("{OK},{BAD},{RUN}"), "")).unwrap();
        assert_eq!((i.ci.as_str(), i.checks_failed, i.checks_passed, i.checks_pending), ("failed", 1, 1, 1));
    }

    #[test]
    fn running_checks_are_pending() {
        let i = parse_pr(&pr(&format!("{OK},{RUN}"), "")).unwrap();
        assert_eq!((i.ci.as_str(), i.checks_pending), ("pending", 1));
    }

    #[test]
    fn no_checks_and_changes_requested() {
        let i = parse_pr(&pr("", "CHANGES_REQUESTED")).unwrap();
        assert_eq!((i.ci.as_str(), i.review_decision.as_str()), ("none", "CHANGES_REQUESTED"));
    }

    #[test]
    fn closed_or_garbage_is_no_pr() {
        assert_eq!(parse_pr(&pr("", "").replace("OPEN", "MERGED")), None);
        assert_eq!(parse_pr("no pull requests found"), None);
        assert_eq!(parse_pr(""), None);
    }

    #[test]
    fn unresolved_threads_are_counted() {
        let t = r#"{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false},{"isResolved":true},{"isResolved":false}]}}}}}"#;
        assert_eq!(parse_threads(t), 2);
        assert_eq!(parse_threads("{}"), 0);
        assert_eq!(parse_threads("nope"), 0);
    }

    #[test]
    fn the_repo_comes_from_the_pr_url() {
        assert_eq!(repo_of("https://github.com/o/r/pull/12"), Some(("o".into(), "r".into())));
        assert_eq!(repo_of("garbage"), None);
    }
}
