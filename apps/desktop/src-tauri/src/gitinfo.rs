//! What the session panel shows about the project's git checkout: the branch,
//! how far it is ahead of or behind its upstream, and how many files changed.
//! One bounded `git status --porcelain=v2 --branch`; no repository means no info.

use crate::bridge::AppState;
use crate::child;
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tauri::{State, Webview};
use crate::panels::PanelRoots;

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
pub async fn git_info(state: State<'_, AppState>, roots: State<'_, PanelRoots>, view: Webview, cwd: String) -> Result<Option<GitInfo>, String> {
    let root = roots.require_project(view.label(), &cwd)?;
    let path = state.environment().get("PATH").cloned();
    tauri::async_runtime::spawn_blocking(move || read(&root, path.as_deref()))
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
        if crate::slots::try_take(&REPOSITORY_LOOKUPS, MAX_REPOSITORY_LOOKUPS) {
            Some(Self)
        } else {
            None
        }
    }
}

impl Drop for LookupSlot {
    fn drop(&mut self) {
        REPOSITORY_LOOKUPS.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[tauri::command]
pub async fn git_repository(state: State<'_, AppState>, roots: State<'_, PanelRoots>, view: Webview, cwd: String) -> Result<Option<String>, String> {
    let root = roots.require_project(view.label(), &cwd)?;
    let path = state.environment().get("PATH").cloned();
    // Saturated: answer "unknown" rather than queue more Git children.
    let Some(slot) = LookupSlot::take() else { return Err("busy: too many repository lookups; try again".into()) };
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        let mut cmd = Command::new("git");
        cmd.args(["config", "--local", "--get", "remote.origin.url"]).current_dir(root);
        if let Some(p) = path {
            cmd.env("PATH", p);
        }
        let out = child::run_bounded(cmd, GIT_TIMEOUT, 16 * 1024).ok()?;
        out.status.success().then(|| github_repository_from_origin(&out.stdout)).flatten()
    })
    .await
    .map_err(|e| e.to_string())
}

// ---- Changes tab: changed files and one file's diff -------------------------------------------

/// Entries beyond this are dropped and `truncated` is set.
const MAX_CHANGES: usize = 2000;
/// A diff larger than this is reported as `tooLarge` instead of being sent.
const DIFF_CAP: usize = 1024 * 1024;
/// Room for `MAX_CHANGES` long paths in the porcelain listing.
const STATUS_CAP: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// `M`, `A`, `D`, `R` or `?` (untracked).
    pub status: String,
    /// The old path of a rename.
    pub orig_path: Option<String>,
    /// The index holds a change for this file.
    pub staged: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChanges {
    pub files: Vec<ChangedFile>,
    pub truncated: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub binary: bool,
    pub too_large: bool,
    /// Unified diff; `None` for a binary or too-large file.
    pub text: Option<String>,
}

fn status_letter(x: char, y: char) -> &'static str {
    match if x != '.' { x } else { y } {
        'A' | 'C' => "A",
        'D' => "D",
        'R' => "R",
        _ => "M",
    }
}

/// Parses `git status --porcelain=v2 -z --untracked-files=all` (entries are NUL-separated; a
/// rename entry is followed by one more field holding the old path).
pub fn parse_changes(text: &str) -> GitChanges {
    let mut out = GitChanges::default();
    let mut fields = text.split('\0');
    while let Some(rec) = fields.next() {
        let mut file = match rec.as_bytes().first() {
            Some(b'1') => changed(rec, 9),
            Some(b'2') => changed(rec, 10),
            Some(b'u') => changed(rec, 11).map(|mut f| {
                f.status = "M".into();
                f.staged = false;
                f
            }),
            Some(b'?') => rec.strip_prefix("? ").map(|path| ChangedFile {
                path: path.to_string(),
                status: "?".into(),
                orig_path: None,
                staged: false,
            }),
            _ => None,
        };
        // The old path of a rename or copy is the next field whether or not the entry is kept.
        if rec.starts_with('2') {
            let orig = fields.next().filter(|o| !o.is_empty());
            if let Some(f) = file.as_mut() {
                f.orig_path = orig.map(str::to_string);
            }
        }
        let Some(file) = file else { continue };
        if out.files.len() >= MAX_CHANGES {
            out.truncated = true;
            break;
        }
        out.files.push(file);
    }
    out
}

/// An ordinary (`1`), rename/copy (`2`) or unmerged (`u`) entry: `fields` space-separated
/// columns, the last one the path.
fn changed(rec: &str, fields: usize) -> Option<ChangedFile> {
    let mut parts = rec.splitn(fields, ' ');
    parts.next()?;
    let mut xy = parts.next()?.chars();
    let (x, y) = (xy.next()?, xy.next()?);
    let path = parts.last().filter(|p| !p.is_empty())?;
    Some(ChangedFile { path: path.to_string(), status: status_letter(x, y).into(), orig_path: None, staged: x != '.' })
}

/// What the last `git_changes` listed per project root: the repository top level the paths are
/// relative to, and the files. `git_file_diff` serves only these paths.
type Listed = (std::path::PathBuf, Vec<ChangedFile>);
static LISTED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Listed>>> =
    std::sync::OnceLock::new();

fn listed() -> std::sync::MutexGuard<'static, std::collections::HashMap<std::path::PathBuf, Listed>> {
    LISTED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn git_command(args: &[&str], dir: &Path, path_env: Option<&str>) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(dir).env("GIT_OPTIONAL_LOCKS", "0");
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    cmd
}

fn run_git(args: &[&str], dir: &Path, path_env: Option<&str>, cap: usize) -> Result<child::Output, String> {
    child::run_bounded(git_command(args, dir, path_env), GIT_TIMEOUT, cap).map_err(|e| match e {
        child::RunError::Timeout => "git timed out".to_string(),
        child::RunError::Spawn(_) => "git is not available".to_string(),
        child::RunError::Wait(e) => e.to_string(),
    })
}

fn changes(root: &Path, path_env: Option<&str>) -> Result<(std::path::PathBuf, GitChanges), String> {
    let top = run_git(&["rev-parse", "--show-toplevel"], root, path_env, 16 * 1024)?;
    if !top.status.success() {
        return Err("not a git repository".into());
    }
    let top = std::path::PathBuf::from(top.stdout.trim_end_matches(['\n', '\r']));
    let out = run_git(&["status", "--porcelain=v2", "-z", "--untracked-files=all"], &top, path_env, STATUS_CAP)?;
    if !out.status.success() {
        return Err("git status failed".into());
    }
    Ok((top, parse_changes(&out.stdout)))
}

/// A path git reported, safe to hand back to git: relative and made of plain names only.
fn lexically_safe(path: &str) -> bool {
    use std::path::Component;
    !path.is_empty()
        && !path.contains('\0')
        && Path::new(path).components().all(|c| matches!(c, Component::Normal(_)))
}

fn is_binary(text: &str) -> bool {
    text.lines().any(|l| (l.starts_with("Binary files ") && l.ends_with(" differ")) || l == "GIT binary patch")
}

fn file_diff(top: &Path, file: &ChangedFile, path_env: Option<&str>) -> Result<FileDiff, String> {
    let mut diff = FileDiff { path: file.path.clone(), status: file.status.clone(), ..Default::default() };
    let literal = |p: &str| format!(":(top,literal){p}");
    let out = if file.status == "?" {
        // Not known to git yet: diff against nothing. Exit 1 means "differs", not failure.
        let o = run_git(&["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", &file.path], top, path_env, DIFF_CAP + 1)?;
        if o.status.code().map_or(true, |c| c > 1) {
            return Err("git diff failed".into());
        }
        o
    } else {
        let mut specs = vec![literal(&file.path)];
        specs.extend(file.orig_path.iter().map(|p| literal(p)));
        let mut args = vec!["diff", "HEAD", "-M", "--no-color", "--no-ext-diff", "--"];
        args.extend(specs.iter().map(String::as_str));
        let mut o = run_git(&args, top, path_env, DIFF_CAP + 1)?;
        if !o.status.success() {
            // No commit yet: compare against the index instead.
            args[1] = "--cached";
            o = run_git(&args, top, path_env, DIFF_CAP + 1)?;
        }
        if !o.status.success() {
            return Err("git diff failed".into());
        }
        o
    };
    if out.stdout.len() > DIFF_CAP {
        diff.too_large = true;
    } else if is_binary(&out.stdout) {
        diff.binary = true;
    } else {
        diff.text = Some(out.stdout);
    }
    Ok(diff)
}

/// Diffs `path` of the project at `root` if the last listing for it contained that path.
fn diff_listed(root: &Path, path: &str, path_env: Option<&str>) -> Result<FileDiff, String> {
    if !lexically_safe(path) {
        return Err("path is not a repository-relative path".into());
    }
    let (top, file) = {
        let map = listed();
        let (top, files) = map.get(root).ok_or("list the changes first")?;
        let file = files
            .iter()
            .find(|f| f.path == path || f.orig_path.as_deref() == Some(path))
            .ok_or("path is not among the changed files")?;
        (top.clone(), file.clone())
    };
    file_diff(&top, &file, path_env)
}

/// The files with staged, unstaged or untracked changes in the project's checkout.
#[tauri::command]
pub async fn git_changes(state: State<'_, AppState>, roots: State<'_, PanelRoots>, view: Webview, cwd: String) -> Result<GitChanges, String> {
    let root = roots.require_project(view.label(), &cwd)?;
    let path = state.environment().get("PATH").cloned();
    tauri::async_runtime::spawn_blocking(move || {
        let (top, result) = changes(&root, path.as_deref())?;
        listed().insert(root, (top, result.files.clone()));
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The unified diff of one file from the last `git_changes` listing, against HEAD.
#[tauri::command]
pub async fn git_file_diff(state: State<'_, AppState>, roots: State<'_, PanelRoots>, view: Webview, cwd: String, path: String) -> Result<FileDiff, String> {
    let root = roots.require_project(view.label(), &cwd)?;
    let env = state.environment().get("PATH").cloned();
    tauri::async_runtime::spawn_blocking(move || diff_listed(&root, &path, env.as_deref()))
        .await
        .map_err(|e| e.to_string())?
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

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("keryx-gitchanges-{}-{name}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@localhost.invalid", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .env("GIT_TEMPLATE_DIR", "")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn porcelain_entries_become_changed_files() {
        let text = "1 .M N... 100644 100644 100644 a b src/a.ts\x001 A. N... 000000 100644 100644 a b new file.ts\x001 D. N... 100644 000000 000000 a b gone.ts\x002 R. N... 100644 100644 100644 a b R100 to.ts\0from.ts\0u UU N... 1 2 3 4 a b c merge.ts\0? loose.txt\0! ignored.log\0";
        let got = parse_changes(text);
        let view: Vec<_> = got.files.iter().map(|f| (f.path.as_str(), f.status.as_str(), f.orig_path.as_deref(), f.staged)).collect();
        assert_eq!(
            view,
            vec![
                ("src/a.ts", "M", None, false),
                ("new file.ts", "A", None, true),
                ("gone.ts", "D", None, true),
                ("to.ts", "R", Some("from.ts"), true),
                ("merge.ts", "M", None, false),
                ("loose.txt", "?", None, false),
            ]
        );
        assert!(!got.truncated);
    }

    #[test]
    fn the_listing_is_capped_at_two_thousand() {
        let text: String = (0..MAX_CHANGES + 5).map(|i| format!("? f{i}\0")).collect();
        let got = parse_changes(&text);
        assert_eq!(got.files.len(), MAX_CHANGES);
        assert!(got.truncated);
        let exact: String = (0..MAX_CHANGES).map(|i| format!("? f{i}\0")).collect();
        assert!(!parse_changes(&exact).truncated);
    }

    #[test]
    fn only_plain_relative_paths_are_safe() {
        assert!(lexically_safe("a/b.txt") && lexically_safe("-weird name"));
        assert!(!lexically_safe("../x") && !lexically_safe("a/../x") && !lexically_safe("/etc/passwd") && !lexically_safe("") && !lexically_safe("./a"));
    }

    #[test]
    fn binary_diffs_are_recognised() {
        assert!(is_binary("diff --git a/x b/x\nBinary files a/x and b/x differ\n"));
        assert!(!is_binary("+Binary files are mentioned here\n"));
    }

    #[test]
    fn a_real_checkout_lists_every_status_and_diffs_them() {
        let dir = fixture("statuses");
        git_in(&dir, &["init", "-q", "-b", "trunk"]);
        std::fs::write(dir.join("mod.txt"), "one\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "old content\n").unwrap();
        std::fs::write(dir.join("from.txt"), "rename me\nline two\nline three\nline four\n").unwrap();
        git_in(&dir, &["add", "."]);
        git_in(&dir, &["commit", "-q", "-m", "base"]);
        std::fs::write(dir.join("mod.txt"), "one\ntwo\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        git_in(&dir, &["mv", "from.txt", "to.txt"]);
        std::fs::write(dir.join("added.txt"), "fresh\n").unwrap();
        git_in(&dir, &["add", "added.txt"]);
        std::fs::write(dir.join("loose.txt"), "untracked\n").unwrap();
        std::fs::write(dir.join("bin.dat"), [0u8, 1, 2, 0, 255]).unwrap();

        let root = std::fs::canonicalize(&dir).unwrap();
        let (top, got) = changes(&root, None).unwrap();
        listed().insert(root.clone(), (top, got.files.clone()));
        let status = |p: &str| got.files.iter().find(|f| f.path == p).map(|f| (f.status.as_str(), f.staged));
        assert_eq!(status("mod.txt"), Some(("M", false)));
        assert_eq!(status("added.txt"), Some(("A", true)));
        assert_eq!(status("gone.txt"), Some(("D", false)));
        assert_eq!(status("to.txt"), Some(("R", true)));
        assert_eq!(status("loose.txt"), Some(("?", false)));
        assert_eq!(status("bin.dat"), Some(("?", false)));
        assert_eq!(got.files.iter().find(|f| f.path == "to.txt").unwrap().orig_path.as_deref(), Some("from.txt"));

        let text = |p: &str| diff_listed(&root, p, None).unwrap();
        assert!(text("mod.txt").text.unwrap().contains("+two"));
        assert!(text("added.txt").text.unwrap().contains("+fresh"));
        assert!(text("gone.txt").text.unwrap().contains("-old content"));
        let renamed = text("to.txt").text.unwrap();
        assert!(renamed.contains("rename from from.txt") && renamed.contains("rename to to.txt"), "{renamed}");
        assert!(text("from.txt").text.is_some());
        assert!(text("loose.txt").text.unwrap().contains("+untracked"));
        let bin = text("bin.dat");
        assert!(bin.binary && bin.text.is_none());

        for bad in ["../x", "/etc/passwd", "not-changed.txt", "mod.txt/../mod.txt"] {
            assert!(diff_listed(&root, bad, None).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_subfolder_root_diffs_from_the_repository_top() {
        let dir = fixture("subdir");
        git_in(&dir, &["init", "-q", "-b", "trunk"]);
        std::fs::create_dir_all(dir.join("pkg")).unwrap();
        std::fs::write(dir.join("pkg/a.txt"), "a\n").unwrap();
        git_in(&dir, &["add", "."]);
        git_in(&dir, &["commit", "-q", "-m", "base"]);
        std::fs::write(dir.join("pkg/a.txt"), "a\nb\n").unwrap();
        std::fs::write(dir.join("pkg/new.txt"), "n\n").unwrap();
        let root = std::fs::canonicalize(dir.join("pkg")).unwrap();
        let (top, got) = changes(&root, None).unwrap();
        listed().insert(root.clone(), (top, got.files));
        assert!(diff_listed(&root, "pkg/a.txt", None).unwrap().text.unwrap().contains("+b"));
        assert!(diff_listed(&root, "pkg/new.txt", None).unwrap().text.unwrap().contains("+n"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_repository_without_commits_still_diffs() {
        let dir = fixture("unborn");
        git_in(&dir, &["init", "-q", "-b", "trunk"]);
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        git_in(&dir, &["add", "a.txt"]);
        let root = std::fs::canonicalize(&dir).unwrap();
        let (top, got) = changes(&root, None).unwrap();
        listed().insert(root.clone(), (top, got.files));
        assert!(diff_listed(&root, "a.txt", None).unwrap().text.unwrap().contains("+staged"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_thousand_and_one_untracked_files_are_truncated() {
        let dir = fixture("many");
        git_in(&dir, &["init", "-q", "-b", "trunk"]);
        for i in 0..=MAX_CHANGES {
            std::fs::write(dir.join(format!("f{i}.txt")), "x").unwrap();
        }
        let (_, got) = changes(&std::fs::canonicalize(&dir).unwrap(), None).unwrap();
        assert_eq!(got.files.len(), MAX_CHANGES);
        assert!(got.truncated);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_huge_diff_is_reported_too_large() {
        let dir = fixture("huge");
        git_in(&dir, &["init", "-q", "-b", "trunk"]);
        std::fs::write(dir.join("big.txt"), "line of text\n".repeat(100_000)).unwrap();
        let root = std::fs::canonicalize(&dir).unwrap();
        let (top, got) = changes(&root, None).unwrap();
        listed().insert(root.clone(), (top, got.files));
        let d = diff_listed(&root, "big.txt", None).unwrap();
        assert!(d.too_large && d.text.is_none() && !d.binary);
        std::fs::remove_dir_all(&dir).ok();
    }
}
