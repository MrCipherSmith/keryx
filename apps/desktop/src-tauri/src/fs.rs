//! Answers `fs/read_text_file` from keryx without involving the web view.
//!
//! Reads are confined to the session cwd: both the root and the requested
//! path are canonicalised (symlinks resolved) and the result must stay inside
//! the root. Anything else is a JSON-RPC error.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
/// ACP's "resource not found" code.
pub const RESOURCE_NOT_FOUND: i64 = -32002;

/// Largest file this handler will return.
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

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

/// Resolve `requested` inside `root`; both must exist and the result must not escape.
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
    let resolved = candidate
        .canonicalize()
        .map_err(|_| RpcError::new(RESOURCE_NOT_FOUND, format!("file not found: {requested}")))?;
    if !resolved.starts_with(&root) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("path is outside the project folder: {requested}"),
        ));
    }
    Ok(resolved)
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
    let meta = std::fs::metadata(&resolved)
        .map_err(|e| RpcError::new(RESOURCE_NOT_FOUND, format!("cannot read {path}: {e}")))?;
    if !meta.is_file() {
        return Err(RpcError::new(INVALID_PARAMS, format!("not a file: {path}")));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(RpcError::new(INVALID_PARAMS, format!("file is larger than 16 MiB: {path}")));
    }
    let bytes = std::fs::read(&resolved)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("cannot read {path}: {e}")))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(json!({ "content": slice_lines(&text, line, limit) }))
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
    fn rejects_dot_dot_traversal() {
        let (root, outside) = setup();
        let rel = format!("../{}/secret.txt", outside.path().file_name().unwrap().to_str().unwrap());
        // The sibling temp dirs share a parent, so this resolves to a real file outside.
        let err = read_text_file(&root.path().join("sub"), &req(&rel));
        assert!(err.is_err());
        let err = read_text_file(root.path(), &req("sub/../../etc/hosts")).unwrap_err();
        assert!(err.code == INVALID_PARAMS || err.code == RESOURCE_NOT_FOUND);
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
