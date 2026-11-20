//! What the session panel shows about the project's git checkout: the branch,
//! how far it is ahead of or behind its upstream, and how many files changed.
//! One bounded `git status --porcelain=v2 --branch`; no repository means no info.

use crate::bridge::AppState;
use crate::child;
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tauri::State;

const GIT_TIMEOUT: Duration = Duration::from_secs(3);
/// A status listing far larger than this is cut; the counts it reports stay lower bounds.
const OUTPUT_CAP: usize = 1024 * 1024;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    /// Short commit id on a detached HEAD.
    pub commit: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Files with staged or unstaged changes, untracked ones included.
    pub changed: u32,
    /// The folder's name when it is a linked git worktree (not the main checkout).
    pub worktree: Option<String>,
}

/// Parses `git rev-parse --git-dir --git-common-dir --show-toplevel`: a linked worktree
/// is a checkout whose git dir differs from the common one; its name is the folder's.
pub fn parse_worktree(text: &str) -> Option<String> {
    let mut lines = text.lines();
    let (git_dir, common, top) = (lines.next()?, lines.next()?, lines.next()?);
    let canon = |p: &str| std::fs::canonicalize(Path::new(top).join(p)).unwrap_or_else(|_| Path::new(top).join(p));
    if canon(git_dir) == canon(common) {
        return None;
    }
    Path::new(top).file_name().map(|n| n.to_string_lossy().into_owned())
}

/// Parses `git status --porcelain=v2 --branch` output.
pub fn parse_status(text: &str) -> GitInfo {
    let mut info = GitInfo::default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            info.branch = (rest != "(detached)").then(|| rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.oid ") {
            if rest != "(initial)" {
                info.commit = Some(rest.chars().take(9).collect());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            info.upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    info.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    info.behind = n.parse().unwrap_or(0);
                }
            }
        } else if !line.starts_with('#') && !line.is_empty() {
            info.changed += 1;
        }
    }
    info
}

fn read(dir: &Path, path_env: Option<&str>) -> Option<GitInfo> {
    let mut cmd = Command::new("git");
    cmd.args(["status", "--porcelain=v2", "--branch"]).current_dir(dir);
    // The panel must never take the repository's index lock away from keryx or the user.
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let out = child::run_bounded(cmd, GIT_TIMEOUT, OUTPUT_CAP).ok()?;
    if !out.status.success() {
        return None;
    }
    let mut info = parse_status(&out.stdout);
    let mut rev = Command::new("git");
    rev.args(["rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"]).current_dir(dir);
    if let Some(p) = path_env {
        rev.env("PATH", p);
    }
    if let Ok(o) = child::run_bounded(rev, GIT_TIMEOUT, 16 * 1024) {
        if o.status.success() {
            info.worktree = parse_worktree(&o.stdout);
        }
    }
    Some(info)
}

/// The git state of `cwd`, or `null` outside a repository (or when git is slow or missing).
#[tauri::command]
pub async fn git_info(state: State<'_, AppState>, cwd: String) -> Result<Option<GitInfo>, String> {
    let path = state.environment().get("PATH").cloned();
    tauri::async_runtime::spawn_blocking(move || read(Path::new(&cwd), path.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

fn github_repository_from_origin(origin: &str) -> Option<String> {
    let raw = origin.trim();
    let repo = ["https://github.com/", "git@github.com:", "ssh://git@github.com/"]
        .iter().find_map(|prefix| {
            raw.get(..prefix.len())?.eq_ignore_ascii_case(prefix).then(|| &raw[prefix.len()..])
        })?;
    let repo = repo.strip_suffix('/').unwrap_or(repo);
    let suffix_start = repo.len().saturating_sub(".git".len());
    let repo = match repo.get(suffix_start..) {
        Some(suffix) if suffix.eq_ignore_ascii_case(".git") => &repo[..suffix_start],
        _ => repo,
    };
    let (owner, name) = repo.split_once('/')?;
    if !owner.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        || !owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || name.is_empty() || matches!(name, "." | "..")
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    {
        return None;
    }
    Some(repo.to_string())
}

const MAX_REPOSITORY_LOOKUPS: usize = 4;
static REPOSITORY_LOOKUPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Holds one of the few repository-lookup slots; the slot is returned on drop.
struct LookupSlot;

impl LookupSlot {
    fn take() -> Option<Self> {
        use std::sync::atomic::Ordering;
        REPOSITORY_LOOKUPS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < MAX_REPOSITORY_LOOKUPS).then_some(n + 1))
            .ok()
            .map(|_| Self)
    }
}

impl Drop for LookupSlot {
    fn drop(&mut self) {
        REPOSITORY_LOOKUPS.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[tauri::command]
pub async fn git_repository(state: State<'_, AppState>, cwd: String) -> Result<Option<String>, String> {
    let path = state.environment().get("PATH").cloned();
    // Saturated: answer "unknown" rather than queue more Git children.
    let Some(slot) = LookupSlot::take() else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        let mut cmd = Command::new("git");
        cmd.args(["config", "--get", "remote.origin.url"]).current_dir(cwd);
        if let Some(p) = path {
            cmd.env("PATH", p);
        }
        let out = child::run_bounded(cmd, GIT_TIMEOUT, 16 * 1024).ok()?;
        out.status.success().then(|| github_repository_from_origin(&out.stdout)).flatten()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_origin_uses_only_the_github_repository_path() {
        assert_eq!(github_repository_from_origin(" HTTPS://GitHub.COM/Example/Project.GiT/ ").as_deref(), Some("Example/Project"));
        assert_eq!(github_repository_from_origin("git@github.com:org/repo.git").as_deref(), Some("org/repo"));
        assert!(github_repository_from_origin("https://github.com.evil.test/org/repo").is_none());
        assert!(github_repository_from_origin("https://github.com/org/..").is_none());
    }

    #[test]
    fn branch_upstream_counts_and_changes() {
        let text = "# branch.oid 0123456789abcdef\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.ts\n? new.txt\n";
        assert_eq!(
            parse_status(text),
            GitInfo {
                branch: Some("feat/x".into()),
                commit: Some("012345678".into()),
                upstream: Some("origin/feat/x".into()),
                ahead: 2,
                behind: 1,
                changed: 2,
                worktree: None,
            }
        );
    }

    #[test]
    fn detached_head_and_a_new_repository() {
        let detached = parse_status("# branch.oid abcdef0123\n# branch.head (detached)\n");
        assert_eq!(detached.branch, None);
        assert_eq!(detached.commit.as_deref(), Some("abcdef012"));
        let fresh = parse_status("# branch.oid (initial)\n# branch.head main\n");
        assert_eq!((fresh.branch.as_deref(), fresh.commit), (Some("main"), None));
    }

    #[test]
    fn a_linked_worktree_is_told_from_the_main_checkout() {
        let main = "/nonexistent/repo/.git\n/nonexistent/repo/.git\n/nonexistent/repo\n";
        assert_eq!(parse_worktree(main), None);
        let linked = "/nonexistent/repo/.git/worktrees/feat\n/nonexistent/repo/.git\n/nonexistent/wt/feat\n";
        assert_eq!(parse_worktree(linked).as_deref(), Some("feat"));
        assert_eq!(parse_worktree(""), None);
    }

    #[test]
    fn a_real_checkout_reports_its_branch() {
        let dir = std::env::temp_dir().join(format!("keryx-gitinfo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| Command::new("git").args(args).current_dir(&dir).output().unwrap();
        git(&["init", "-q", "-b", "trunk"]);
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        let info = read(&dir, None).expect("a git checkout");
        assert_eq!(info.branch.as_deref(), Some("trunk"));
        assert_eq!(info.changed, 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
