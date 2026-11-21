//! The project files tab: a capped, ranked list of the project's files (for
//! the file picker and `@` mentions) and a bounded, confined read of one file.
//!
//! Both commands are thin wrappers over `list_files` / `read_file`, which take
//! the already-validated project root.

use crate::bridge::AppState;
use crate::child;
use crate::fs::{confine, GIT_TIMEOUT, MAX_FILE_BYTES};
use crate::panels::PanelRoots;
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::time::Instant;
use tauri::{State, Webview};

/// Most paths one listing returns; beyond this `truncated` is set.
const MAX_PATHS: usize = 20_000;
/// Most results a non-empty query returns.
const MAX_MATCHES: usize = 200;
/// Cap on `git ls-files` output; a cut listing is reported as truncated.
const LIST_OUTPUT_CAP: usize = 8 * 1024 * 1024;
/// A NUL byte within this many leading bytes marks a file as binary.
const BINARY_PROBE: usize = 8 * 1024;
/// Directories the fallback walk never enters.
const SKIPPED_DIRS: [&str; 3] = [".git", "node_modules", "target"];

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    pub files: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub text: Option<String>,
    pub binary: bool,
    pub size: u64,
}

fn git_files(root: &Path, path_env: Option<&str>) -> Option<(Vec<String>, bool)> {
    let mut cmd = Command::new("git");
    cmd.args(["ls-files", "-co", "--exclude-standard", "-z"]).current_dir(root);
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let out = child::run_bounded(cmd, GIT_TIMEOUT, LIST_OUTPUT_CAP).ok()?;
    if !out.status.success() {
        return None;
    }
    let cut = out.stdout.len() >= LIST_OUTPUT_CAP;
    let mut parts: Vec<&str> = out.stdout.split('\0').collect();
    // The last piece is empty after a final NUL, or a possibly cut path.
    let tail = parts.pop().unwrap_or("");
    if cut && !tail.is_empty() {
        // dropped: it may be a partial path
    } else if !tail.is_empty() {
        parts.push(tail);
    }
    // Keep regular files only, matching the fallback walk: index entries deleted
    // in the worktree, submodule gitlinks/dirs and symlinks (even to files) are
    // dropped, since the walk never lists them either.
    let files = parts
        .into_iter()
        .filter(|p| !p.is_empty())
        .filter(|p| std::fs::symlink_metadata(root.join(p)).map(|m| m.is_file()).unwrap_or(false))
        .map(str::to_string)
        .collect();
    Some((files, cut))
}

/// Bounded walk for a folder that is not a git checkout. Symlinks are never followed.
/// Stops at the entry cap or the wall-clock `deadline`, reporting either as truncated.
fn walk_files(root: &Path, deadline: Instant) -> (Vec<String>, bool) {
    let mut files = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        if Instant::now() >= deadline {
            return (files, true);
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = format!("{prefix}{name}");
            if kind.is_dir() {
                if !SKIPPED_DIRS.contains(&name.as_str()) {
                    stack.push((entry.path(), format!("{rel}/")));
                }
            } else if kind.is_file() {
                files.push(rel);
                if files.len() > MAX_PATHS {
                    return (files, true);
                }
            }
        }
    }
    (files, false)
}

fn is_subsequence(needle: &str, hay: &str) -> bool {
    let mut it = hay.chars();
    needle.chars().all(|c| it.any(|h| h == c))
}

/// Rank of `path` for `query` (both lowercase): lower is better, `None` is no match.
/// Substring beats subsequence; a basename hit beats a directory hit.
fn rank(path: &str, query: &str) -> Option<u8> {
    let base = path.rsplit('/').next().unwrap_or(path);
    if base.contains(query) {
        Some(0)
    } else if path.contains(query) {
        Some(1)
    } else if is_subsequence(query, base) {
        Some(2)
    } else if is_subsequence(query, path) {
        Some(3)
    } else {
        None
    }
}

/// Pure filter and rank. An empty query returns the sorted list; otherwise the
/// best `MAX_MATCHES` case-insensitive matches, best first (ties: shorter path, then alphabetical).
pub fn filter_paths(paths: &[String], query: Option<&str>) -> Vec<String> {
    let q = query.map(str::trim).unwrap_or("").to_lowercase();
    if q.is_empty() {
        let mut all = paths.to_vec();
        all.sort();
        return all;
    }
    let mut hits: Vec<(u8, &String)> = paths
        .iter()
        .filter_map(|p| rank(&p.to_lowercase(), &q).map(|r| (r, p)))
        .collect();
    hits.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.len().cmp(&b.1.len())).then(a.1.cmp(b.1)));
    hits.into_iter().take(MAX_MATCHES).map(|(_, p)| p.clone()).collect()
}

pub fn list_files(root: &Path, path_env: Option<&str>, query: Option<&str>) -> ProjectFiles {
    let (mut files, cut) = git_files(root, path_env)
        .unwrap_or_else(|| walk_files(root, Instant::now() + GIT_TIMEOUT));
    let mut truncated = cut;
    files.sort();
    if files.len() > MAX_PATHS {
        files.truncate(MAX_PATHS);
        truncated = true;
    }
    ProjectFiles { files: filter_paths(&files, query), truncated }
}

pub fn read_file(root: &Path, path: &str) -> Result<FileContent, String> {
    let resolved = confine(root, path).map_err(|e| e.message)?;
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("Could not read {path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} is a folder"));
    }
    if !meta.is_file() {
        return Err(format!("{path} is not a regular file"));
    }
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return Err(format!("{path} is too large to open ({size} bytes; the limit is {MAX_FILE_BYTES})"));
    }
    let file = std::fs::File::open(&resolved).map_err(|e| format!("Could not read {path}: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read {path}: {e}"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("{path} is too large to open (the limit is {MAX_FILE_BYTES} bytes)"));
    }
    let binary = bytes.iter().take(BINARY_PROBE).any(|b| *b == 0);
    let text = (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned());
    Ok(FileContent { path: path.to_string(), text, binary, size })
}

/// The project's files, optionally filtered by `query`.
#[tauri::command]
pub async fn project_files(
    state: State<'_, AppState>,
    roots: State<'_, PanelRoots>,
    view: Webview,
    cwd: String,
    query: Option<String>,
) -> Result<ProjectFiles, String> {
    let root = roots.require_project(view.label(), &cwd)?;
    let path = state.environment().get("PATH").cloned();
    tauri::async_runtime::spawn_blocking(move || list_files(&root, path.as_deref(), query.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// One project file's text, refused when it is outside the project, a folder, or too large.
#[tauri::command]
pub async fn project_file_read(
    roots: State<'_, PanelRoots>,
    view: Webview,
    cwd: String,
    path: String,
) -> Result<FileContent, String> {
    let root = roots.require_project(view.label(), &cwd)?;
    tauri::async_runtime::spawn_blocking(move || read_file(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn git(root: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(["-c", "core.hooksPath=/dev/null"])
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn canon_dir() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        (dir, root)
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn git_listing_excludes_ignored_and_includes_untracked() {
        let (_d, root) = canon_dir();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "t@t.invalid"]);
        git(&root, &["config", "user.name", "t"]);
        write(&root, ".gitignore", "ignored.log\n");
        write(&root, "src/tracked.rs", "a");
        write(&root, "ignored.log", "x");
        git(&root, &["add", "src/tracked.rs"]);
        write(&root, "notes/untracked.md", "u");
        let out = list_files(&root, None, None);
        assert!(!out.truncated);
        assert!(out.files.contains(&"src/tracked.rs".to_string()));
        assert!(out.files.contains(&"notes/untracked.md".to_string()));
        assert!(!out.files.contains(&"ignored.log".to_string()));
    }

    #[test]
    fn non_git_folder_is_walked_skipping_heavy_and_symlinked_dirs() {
        let (_d, root) = canon_dir();
        write(&root, "a/b.txt", "1");
        write(&root, "top.txt", "2");
        write(&root, "node_modules/x/i.js", "3");
        write(&root, "target/debug/t", "4");
        write(&root, ".git/config", "5");
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            write(outside.path(), "secret.txt", "s");
            std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
            let out = list_files(&root, None, None);
            assert!(!out.files.iter().any(|f| f.starts_with("link")));
        }
        let out = list_files(&root, None, None);
        assert_eq!(out.files, strings(&["a/b.txt", "top.txt"]));
    }

    #[test]
    fn walk_caps_at_the_path_limit() {
        let (_d, root) = canon_dir();
        for i in 0..(MAX_PATHS + 5) {
            fs::write(root.join(format!("f{i}")), "").unwrap();
        }
        let out = list_files(&root, None, None);
        assert!(out.truncated);
        assert_eq!(out.files.len(), MAX_PATHS);
    }

    #[test]
    fn query_ranks_basename_substring_first_then_dir_then_subsequence() {
        let paths = strings(&["docs/readme/intro.md", "src/read.rs", "lib/r_e_a_d.txt", "other/x.rs"]);
        let out = filter_paths(&paths, Some("READ"));
        assert_eq!(out, strings(&["src/read.rs", "docs/readme/intro.md", "lib/r_e_a_d.txt"]));
    }

    #[test]
    fn subsequence_match_works_and_non_matches_drop() {
        let paths = strings(&["src/file_tree.rs", "src/other.rs"]);
        assert_eq!(filter_paths(&paths, Some("ftr")), strings(&["src/file_tree.rs"]));
        assert!(filter_paths(&paths, Some("zzz")).is_empty());
    }

    #[test]
    fn empty_query_returns_sorted_list_and_matches_cap_at_200() {
        let paths: Vec<String> = (0..500).map(|i| format!("d/file{i:03}.rs")).collect();
        let all = filter_paths(&paths, None);
        assert_eq!(all.len(), 500);
        assert!(all.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(filter_paths(&paths, Some("")).len(), 500);
        assert_eq!(filter_paths(&paths, Some("file")).len(), MAX_MATCHES);
    }

    #[test]
    fn read_returns_text_and_binary_flag() {
        let (_d, root) = canon_dir();
        write(&root, "a.txt", "héllo");
        fs::write(root.join("b.bin"), [1u8, 0, 2]).unwrap();
        let t = read_file(&root, "a.txt").unwrap();
        assert_eq!(t.text.as_deref(), Some("héllo"));
        assert!(!t.binary);
        assert_eq!(t.size, "héllo".len() as u64);
        let b = read_file(&root, "b.bin").unwrap();
        assert!(b.binary);
        assert_eq!(b.text, None);
    }

    #[test]
    fn read_refuses_escapes_folders_and_big_files() {
        let (_d, root) = canon_dir();
        let (_o, outside) = canon_dir();
        write(&root, "dir/x.txt", "x");
        write(&outside, "secret.txt", "s");
        assert!(read_file(&root, "../x").is_err());
        let abs = outside.join("secret.txt");
        assert!(read_file(&root, abs.to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&abs, root.join("link.txt")).unwrap();
            assert!(read_file(&root, "link.txt").is_err());
        }
        assert!(read_file(&root, "dir").unwrap_err().contains("is a folder"));
        let big = fs::File::create(root.join("big.dat")).unwrap();
        big.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(read_file(&root, "big.dat").unwrap_err().contains("too large"));
    }

    #[test]
    fn git_listing_drops_deleted_symlinked_and_submodule_entries() {
        let (_d, root) = canon_dir();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "t@t.invalid"]);
        git(&root, &["config", "user.name", "t"]);
        write(&root, "keep.txt", "k");
        write(&root, "gone.txt", "g");
        write(&root, "sub/inner.txt", "i");
        git(&root, &["add", "."]);
        fs::remove_file(root.join("gone.txt")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("keep.txt", root.join("ln.txt")).unwrap();
        // A gitlink entry (submodule) staged without a checkout.
        git(
            &root,
            &["update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,mod"],
        );
        fs::create_dir_all(root.join("mod")).unwrap();
        let out = list_files(&root, None, None);
        assert!(out.files.contains(&"keep.txt".to_string()));
        assert!(out.files.contains(&"sub/inner.txt".to_string()));
        assert!(!out.files.contains(&"gone.txt".to_string()));
        assert!(!out.files.contains(&"ln.txt".to_string()));
        assert!(!out.files.contains(&"mod".to_string()));
    }

    #[test]
    fn walk_stops_at_an_elapsed_deadline_and_reports_truncated() {
        let (_d, root) = canon_dir();
        write(&root, "a.txt", "1");
        let (files, truncated) = walk_files(&root, Instant::now());
        assert!(truncated);
        assert!(files.is_empty());
        let (files, truncated) = walk_files(&root, Instant::now() + GIT_TIMEOUT);
        assert!(!truncated);
        assert_eq!(files, strings(&["a.txt"]));
    }

    #[cfg(unix)]
    #[test]
    fn read_refuses_a_fifo_without_hanging() {
        let (_d, root) = canon_dir();
        let status = Command::new("mkfifo").arg(root.join("pipe")).status().unwrap();
        assert!(status.success());
        let err = read_file(&root, "pipe").unwrap_err();
        assert!(err.contains("not a regular file"), "{err}");
    }

    #[test]
    fn require_project_rejects_a_foreign_cwd() {
        let (_d, root) = canon_dir();
        let (_o, other) = canon_dir();
        let roots = PanelRoots::default();
        roots.set("w", root.clone());
        assert_eq!(roots.require_project("w", root.to_str().unwrap()).unwrap(), root);
        assert!(roots.require_project("w", other.to_str().unwrap()).is_err());
        assert!(roots.require_project("nope", root.to_str().unwrap()).is_err());
    }
}
