//! Answers `fs/read_text_file` from keryx without involving the web view.
//!
//! Reads are confined to the session cwd: both the root and the requested
//! path are canonicalised (symlinks resolved) and the result must stay inside
//! the root. Anything else is a JSON-RPC error.

use crate::framing;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
/// ACP's "resource not found" code.
pub const RESOURCE_NOT_FOUND: i64 = -32002;

/// Largest file this handler will read. Well below the 16 MiB line limit: the
/// reply is JSON, and escaping can inflate the text several-fold, so the encoded
/// reply is checked again before it is sent.
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

pub fn error_response(id: &Value, err: &RpcError) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": err.code, "message": err.message } })
}

pub fn result_response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn uint_param(params: &Value, key: &str) -> Result<Option<u64>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .map(Some)
            .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("`{key}` must be a non-negative integer"))),
    }
}

fn outside(requested: &str) -> RpcError {
    RpcError::new(INVALID_PARAMS, format!("path is outside the project folder: {requested}"))
}

/// Resolve `.` and `..` without touching the file system.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve `requested` inside `root`; the result must exist and must not escape.
///
/// Every path that is not inside the root gets the same error, whether or not
/// it exists, so the handler is not an existence oracle for the rest of the
/// disk. "Not found" is only reported for paths that lexically stay inside.
pub fn confine(root: &Path, requested: &str) -> Result<PathBuf, RpcError> {
    let root = root
        .canonicalize()
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("session folder is unavailable: {e}")))?;
    let candidate = {
        let p = Path::new(requested);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            root.join(p)
        }
    };
    match candidate.canonicalize() {
        Ok(resolved) if resolved.starts_with(&root) => Ok(resolved),
        Ok(_) => Err(outside(requested)),
        Err(_) if lexical_normalize(&candidate).starts_with(&root) => {
            Err(RpcError::new(RESOURCE_NOT_FOUND, format!("file not found: {requested}")))
        }
        Err(_) => Err(outside(requested)),
    }
}

/// How long `git rev-parse` may take before the folder itself is used.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(3);

/// The folder reads are confined to: the git toplevel of `dir` when it is in a
/// repository (keryx binds its session there), else `dir` itself.
///
/// This check is defence-in-depth for the one request keryx routes through the
/// client. It is not the agent's security boundary: keryx's own tools read the
/// disk directly and never pass through here.
pub fn project_root(dir: &Path, path_env: Option<&str>) -> PathBuf {
    git_toplevel(dir, path_env, "git", GIT_TIMEOUT).unwrap_or_else(|| dir.to_path_buf())
}

/// `git rev-parse --show-toplevel` in `dir`, bounded by `timeout` (a hung git,
/// say on a stalled network volume, must not hang the start). `None` when it
/// fails, times out, or names a folder that does not contain `dir`.
fn git_toplevel(dir: &Path, path_env: Option<&str>, git: &str, timeout: Duration) -> Option<PathBuf> {
    let mut cmd = Command::new(git);
    cmd.args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let ok = stdout.read_to_string(&mut out).is_ok();
        let _ = tx.send(ok.then_some(out));
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let out = rx.recv_timeout(Duration::from_millis(500)).ok().flatten()?;
    if !status.success() {
        return None;
    }
    let top = PathBuf::from(out.trim_end_matches(['\n', '\r'])).canonicalize().ok()?;
    dir.canonicalize().is_ok_and(|d| d.starts_with(&top)).then_some(top)
}

/// Apply ACP's 1-based `line` and `limit` to `text`.
pub fn slice_lines(text: &str, line: Option<u64>, limit: Option<u64>) -> String {
    if line.is_none() && limit.is_none() {
        return text.to_string();
    }
    let skip = line.unwrap_or(1).saturating_sub(1) as usize;
    let take = limit.map(|l| l as usize).unwrap_or(usize::MAX);
    text.split_inclusive('\n').skip(skip).take(take).collect()
}

pub fn read_text_file(root: &Path, params: &Value) -> Result<Value, RpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "`path` must be a non-empty string"))?;
    let line = uint_param(params, "line")?;
    let limit = uint_param(params, "limit")?;
    if line == Some(0) {
        return Err(RpcError::new(INVALID_PARAMS, "`line` is 1-based"));
    }
    let resolved = confine(root, path)?;
    let file = open_regular(&resolved)
        .map_err(|e| RpcError::new(RESOURCE_NOT_FOUND, format!("cannot read {path}: {e}")))?;
    // Checked on the opened handle, so the file cannot be swapped after the check.
    let meta = file
        .metadata()
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("cannot read {path}: {e}")))?;
    if !meta.is_file() {
        return Err(RpcError::new(INVALID_PARAMS, format!("not a file: {path}")));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(RpcError::new(INVALID_PARAMS, format!("file is larger than 8 MiB: {path}")));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("cannot read {path}: {e}")))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(RpcError::new(INVALID_PARAMS, format!("file is larger than 8 MiB: {path}")));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(json!({ "content": slice_lines(&text, line, limit) }))
}

/// Open without following a final symlink and without blocking on a FIFO that
/// replaced the file after `confine` ran.
fn open_regular(path: &Path) -> std::io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    opts.open(path)
}

/// A parsed `fs/read_text_file` request.
#[derive(Debug)]
pub struct FsRequest {
    pub id: Value,
    pub params: Value,
}

/// `Some` when `line` is an `fs/read_text_file` request that needs an answer.
pub fn parse_request(line: &str) -> Option<FsRequest> {
    let msg: Value = serde_json::from_str(line).ok()?;
    if msg.get("method").and_then(Value::as_str) != Some("fs/read_text_file") {
        return None;
    }
    let id = msg.get("id")?.clone(); // a notification has no id and is not ours to answer
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    Some(FsRequest { id, params })
}

/// The reply line for `req`. Always a sendable line: when the success reply
/// would not fit the frame limit (or cannot be framed) it becomes an error
/// response, so keryx never waits for an answer that was dropped.
pub fn answer(root: &Path, req: &FsRequest) -> String {
    let response = match read_text_file(root, &req.params) {
        Ok(result) => result_response(&req.id, result),
        Err(err) => error_response(&req.id, &err),
    };
    let line = response.to_string();
    match framing::encode(&line) {
        Ok(_) => line,
        Err(e) => error_response(
            &req.id,
            &RpcError::new(INTERNAL_ERROR, format!("reply could not be sent: {e}")),
        )
        .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup() -> (tempfile::TempDir, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        fs::create_dir(root.path().join("sub")).unwrap();
        fs::write(root.path().join("sub/b.txt"), "bee").unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        (root, outside)
    }

    fn req(path: &str) -> Value {
        json!({ "sessionId": "s", "path": path })
    }

    #[test]
    fn reads_a_file_inside_the_root() {
        let (root, _o) = setup();
        let p = root.path().join("a.txt");
        let out = read_text_file(root.path(), &req(p.to_str().unwrap())).unwrap();
        assert_eq!(out["content"], "one\ntwo\nthree\nfour\n");
    }

    #[test]
    fn relative_paths_resolve_against_the_root() {
        let (root, _o) = setup();
        let out = read_text_file(root.path(), &req("sub/b.txt")).unwrap();
        assert_eq!(out["content"], "bee");
    }

    #[test]
    fn honours_line_and_limit() {
        let (root, _o) = setup();
        let p = root.path().join("a.txt");
        let path = p.to_str().unwrap();
        let out = read_text_file(root.path(), &json!({"path": path, "line": 2, "limit": 2})).unwrap();
        assert_eq!(out["content"], "two\nthree\n");
        let out = read_text_file(root.path(), &json!({"path": path, "line": 4})).unwrap();
        assert_eq!(out["content"], "four\n");
        let out = read_text_file(root.path(), &json!({"path": path, "limit": 1})).unwrap();
        assert_eq!(out["content"], "one\n");
        let out = read_text_file(root.path(), &json!({"path": path, "line": 99})).unwrap();
        assert_eq!(out["content"], "");
        assert!(read_text_file(root.path(), &json!({"path": path, "line": 0})).is_err());
    }

    #[test]
    fn rejects_absolute_paths_outside_the_root() {
        let (root, outside) = setup();
        let p = outside.path().join("secret.txt");
        let err = read_text_file(root.path(), &req(p.to_str().unwrap())).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        assert!(err.message.contains("outside"));
    }

    #[test]
    fn rejects_dot_dot_traversal_to_a_real_file_outside() {
        let (root, outside) = setup();
        // a.txt exists one level above `sub`, so the path resolves to a real file.
        let err = read_text_file(&root.path().join("sub"), &req("../a.txt")).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        assert!(err.message.contains("outside"));
        // A sibling temp dir reached through the shared parent.
        let rel = format!("../../{}/secret.txt", outside.path().file_name().unwrap().to_str().unwrap());
        let err = read_text_file(&root.path().join("sub"), &req(&rel));
        assert_eq!(err.unwrap_err().code, INVALID_PARAMS);
    }

    #[test]
    fn outside_paths_give_one_error_whether_or_not_they_exist() {
        let (root, outside) = setup();
        let real = read_text_file(root.path(), &req(outside.path().join("secret.txt").to_str().unwrap())).unwrap_err();
        let missing = read_text_file(root.path(), &req(outside.path().join("nope.txt").to_str().unwrap())).unwrap_err();
        let missing_dir = read_text_file(root.path(), &req("/definitely/not/here/x.txt")).unwrap_err();
        let dotdot_missing = read_text_file(root.path(), &req("../no-such-sibling/x")).unwrap_err();
        assert_eq!(real.code, INVALID_PARAMS);
        assert_eq!(missing.code, INVALID_PARAMS);
        assert_eq!(missing_dir.code, INVALID_PARAMS);
        assert_eq!(dotdot_missing.code, INVALID_PARAMS);
        // Inside the root a missing file is still "not found".
        assert_eq!(read_text_file(root.path(), &req("sub/nope.txt")).unwrap_err().code, RESOURCE_NOT_FOUND);
    }

    #[test]
    fn files_over_the_cap_are_refused_and_the_cap_leaves_room_in_the_frame() {
        let (root, _o) = setup();
        let big = root.path().join("big.txt");
        fs::write(&big, vec![b'a'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let err = read_text_file(root.path(), &req("big.txt")).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        assert!(MAX_FILE_BYTES * 2 <= framing::MAX_LINE_BYTES as u64);
    }

    #[test]
    fn a_reply_that_cannot_be_framed_becomes_an_error_response() {
        let (root, _o) = setup();
        // Control characters escape to six bytes each, so a file under the cap
        // still encodes past the 16 MiB line limit.
        let nasty = vec![0x01u8; (MAX_FILE_BYTES - 1) as usize];
        fs::write(root.path().join("ctl.txt"), nasty).unwrap();
        let request = parse_request(
            &json!({"jsonrpc":"2.0","id":42,"method":"fs/read_text_file","params":{"path":"ctl.txt"}}).to_string(),
        )
        .unwrap();
        let line = answer(root.path(), &request);
        assert!(framing::encode(&line).is_ok(), "the answer must always be sendable");
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["id"], 42);
        assert_eq!(reply["error"]["code"], INTERNAL_ERROR);
        assert!(reply.get("result").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_without_blocking() {
        let (root, _o) = setup();
        let fifo = root.path().join("pipe");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let err = read_text_file(root.path(), &req("pipe")).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn project_root_is_the_git_toplevel_or_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("a/b");
        fs::create_dir_all(&sub).unwrap();
        let plain = project_root(&sub, None);
        assert_eq!(plain, sub, "not a repository: fall back to the folder");
        let init = std::process::Command::new("git").args(["init", "-q"]).current_dir(dir.path()).status();
        if init.map(|s| s.success()).unwrap_or(false) {
            let top = project_root(&sub, None);
            assert_eq!(top, dir.path().canonicalize().unwrap());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_git_falls_back_to_the_folder_at_the_timeout() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let git = dir.path().join("hung-git");
        fs::write(&git, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
        fs::set_permissions(&git, fs::Permissions::from_mode(0o755)).unwrap();
        let start = Instant::now();
        let got = git_toplevel(dir.path(), None, git.to_str().unwrap(), Duration::from_millis(300));
        assert!(got.is_none());
        assert!(start.elapsed() < Duration::from_secs(3), "the hung git was not stopped: {:?}", start.elapsed());
        assert_eq!(project_root(dir.path(), Some("/nonexistent")), dir.path(), "no git: the folder itself");
    }

    #[test]
    fn rejects_a_symlink_that_escapes_the_root() {
        let (root, outside) = setup();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.path().join("link.txt")).unwrap();
            let err = read_text_file(root.path(), &req("link.txt")).unwrap_err();
            assert_eq!(err.code, INVALID_PARAMS);
        }
        let _ = outside;
    }

    #[test]
    fn a_sibling_directory_sharing_the_root_prefix_is_outside() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("proj");
        let sibling = parent.path().join("proj-evil");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        fs::write(sibling.join("x.txt"), "x").unwrap();
        let err = read_text_file(&root, &req(sibling.join("x.txt").to_str().unwrap())).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn missing_file_and_bad_params_are_errors() {
        let (root, _o) = setup();
        assert_eq!(read_text_file(root.path(), &req("nope.txt")).unwrap_err().code, RESOURCE_NOT_FOUND);
        assert_eq!(read_text_file(root.path(), &json!({})).unwrap_err().code, INVALID_PARAMS);
        assert_eq!(
            read_text_file(root.path(), &json!({"path": "a.txt", "limit": "x"})).unwrap_err().code,
            INVALID_PARAMS
        );
        assert_eq!(read_text_file(root.path(), &req("sub")).unwrap_err().code, INVALID_PARAMS);
    }

    #[test]
    fn response_envelopes_have_the_jsonrpc_shape() {
        let ok = result_response(&json!(7), json!({"content": "x"}));
        assert_eq!(ok["id"], 7);
        assert_eq!(ok["jsonrpc"], "2.0");
        let err = error_response(&json!("a"), &RpcError::new(-32602, "bad"));
        assert_eq!(err["error"]["code"], -32602);
    }
}
