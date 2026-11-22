//! Read-only Metaproject requests scoped to the calling project view.
use crate::review::invoke_review;
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Webview};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Catalog {},
    Detail { id: String },
    Search { query: String },
    Neighbors { id: String, depth: u8, direction: Direction, kinds: Vec<Kind> },
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Direction { Both, Incoming, Outgoing }
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind { Imports, Describes, Links, Contains, Defines, Calls }

fn metaproject_args(request: &Value) -> Result<Vec<String>, String> {
    let payload = request.to_string();
    if payload.len() > 16 * 1024 { return Err("configuration: Metaproject request is too large.".into()); }
    let parsed: Request = serde_json::from_value(request.clone())
        .map_err(|_| "configuration: Invalid Metaproject request.".to_string())?;
    let valid_text = |s: &str| !s.is_empty() && s.len() <= 4096;
    let valid = match parsed {
        Request::Catalog {} => true,
        Request::Detail { id } => valid_text(&id),
        Request::Search { query } => query.len() <= 4096,
        Request::Neighbors { id, depth, direction, kinds } => {
            let _ = direction;
            valid_text(&id) && (1..=2).contains(&depth) && kinds.len() <= 6
        }
    };
    if !valid { return Err("configuration: Invalid Metaproject request.".into()); }
    Ok(vec!["metaproject-explorer".into(), "--request".into(), payload])
}

#[tauri::command]
pub async fn metaproject_request(app: AppHandle, view: Webview, cwd: String, request: Value) -> Result<Value, String> {
    invoke_review(app, view, cwd, metaproject_args(&request)?, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn metaproject_accepts_only_closed_read_requests() {
        let body = json!({"action":"detail", "id":"--help"});
        assert_eq!(metaproject_args(&body).unwrap(), vec!["metaproject-explorer", "--request", &body.to_string()]);
        assert!(metaproject_args(&json!({"action":"rebuild"})).is_err());
        assert!(metaproject_args(&json!({"action":"catalog", "cwd":"/tmp"})).is_err());
        assert!(metaproject_args(&json!({"action":"neighbors", "id":"x", "depth":3, "direction":"both", "kinds":[]})).is_err());
        assert!(metaproject_args(&json!({"action":"neighbors", "id":"x", "depth":1, "direction":"both", "kinds":["write"]})).is_err());
    }
}
