//! Issues runs a fixed CLI verb in the project registered to the calling webview.
use crate::{projects::ProjectWindows, review::invoke_review};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Webview};

fn issue_args(action: &str, login: &str, request: &Value) -> Result<(Vec<String>, bool), String> {
    let read = match action {
        "origin" | "viewer" | "list" | "detail" | "comments" | "project" | "workspace" => true,
        "move" | "open-session" | "prepare-flow" => false,
        _ => return Err("Unsupported Issues action.".into()),
    };
    if login.is_empty() || login.len() > 100 || login.starts_with('-')
        || !login.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
        return Err("Choose a connected GitHub account.".into());
    }
    let payload = request.to_string();
    if !request.is_object() || payload.len() > 32 * 1024 {
        return Err("Invalid Issues request.".into());
    }
    Ok((vec!["issues".into(), action.into(), "--login".into(), login.into(), "--request".into(), payload, "--json".into()], read))
}

#[tauri::command]
pub async fn issues_request(app: AppHandle, view: Webview, cwd: String, login: String, action: String, request: Value) -> Result<Value, String> {
    let (argv, read) = issue_args(&action, &login, &request)?;
    invoke_review(app, view, cwd, argv, read).await
}

/// Pass only the pending navigation to the destination project view. Work begins there, after
/// the regular account-scoped reader has verified the issue and the actual checkout again.
#[derive(Default)]
pub struct IssueTransfers(std::sync::Mutex<std::collections::HashMap<String, Value>>);

#[tauri::command]
pub fn issues_take_transfer(app: AppHandle, view: Webview) -> Option<Value> {
    let cwd = app.state::<ProjectWindows>().cwd_for(view.label())?;
    app.state::<IssueTransfers>().0.lock().ok()?.remove(&cwd)
}

#[tauri::command]
pub async fn issues_transfer(app: AppHandle, view: Webview, target: String, intent: Value) -> Result<(), String> {
    let projects = app.state::<ProjectWindows>();
    if projects.cwd_for(view.label()).is_none() || !std::path::Path::new(&target).is_absolute()
        || intent.to_string().len() > 16384 || !matches!(intent.get("action").and_then(Value::as_str), Some("open-session"|"prepare-flow"|"open-flow")) {
        return Err("Invalid issue navigation.".into());
    }
    {
        let transfers = app.state::<IssueTransfers>();
        let mut map = transfers.0.lock().map_err(|_| "Issue navigation unavailable")?;
        if map.contains_key(&target) {
            return Err("This checkout already has an issue waiting to open.".into());
        }
        map.insert(target.clone(), intent);
    }
    if let Err(error) = crate::projects::project_switch(app.clone(), view, projects, target.clone()).await {
        if let Ok(mut map) = app.state::<IssueTransfers>().0.lock() { map.remove(&target); }
        return Err(error);
    }
    let _ = app.emit("issues://transfer", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricted_argv_preserves_request_as_data() {
        let body = serde_json::json!({"search": "--help"});
        let (args, _) = issue_args("list", "test-user", &body).unwrap();
        assert_eq!(args[5], body.to_string());
        assert!(issue_args("flow", "user", &body).is_err());
        assert!(issue_args("list", "--help", &body).is_err());
        assert!(!issue_args("move", "user", &body).unwrap().1);
    }
}
