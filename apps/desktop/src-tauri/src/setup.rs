//! The project setup protocol runs independently of ACP and terminal sessions.
use crate::{bridge::AppState, child, locator, panels::project_dir, projects::ProjectWindows, settings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{ffi::OsStr, path::Path, process::Command, time::Duration};
use tauri::{AppHandle, Manager, Webview};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SetupAction {
    Inspect,
    Plan { request: Value },
    Apply { request: Value, #[serde(rename = "planId")] plan_id: String },
}

impl SetupAction {
    fn args(self) -> Result<(&'static str, Vec<String>), String> {
        let (operation, request, plan_id) = match self {
            Self::Inspect => ("inspect", None, None),
            Self::Plan { request } => ("plan", Some(request), None),
            Self::Apply { request, plan_id } => ("apply", Some(request), Some(plan_id)),
        };
        let mut args = vec!["setup".into(), operation.into(), "--json".into()];
        if let Some(request) = request {
            if !request.is_object() || request.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
                return Err("Invalid project setup request.".into());
            }
            let serialized = request.to_string();
            if serialized.len() > 16 * 1024 {
                return Err("Project setup request is too large.".into());
            }
            args.extend(["--request".into(), serialized]);
        }
        if let Some(id) = plan_id {
            if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                return Err("Open a new preview before applying this project setup.".into());
            }
            args.extend(["--plan-id".into(), id]);
        }
        Ok((operation, args))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResponse {
    cli_source: &'static str,
    pub(crate) result: Value,
}

#[tauri::command]
pub async fn project_setup(
    app: AppHandle,
    view: Webview,
    cwd: String,
    action: SetupAction,
) -> Result<SetupResponse, String> {
    let label = view.label().to_owned();
    if app.state::<ProjectWindows>().cwd_for(&label).as_deref() != Some(cwd.as_str()) {
        return Err("Open this folder in the current project view before configuring it.".into());
    }
    let (operation, args) = action.args()?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = project_dir(&cwd).map_err(|_| "The selected project folder is unavailable.".to_owned())?;
        // Recheck after resolving the folder so a queued call cannot retarget a switched view.
        if app.state::<ProjectWindows>().cwd_for(&label).as_deref() != Some(cwd.as_str()) {
            return Err("The selected project changed.".into());
        }
        run_setup(&app, &root, operation, args, Duration::from_secs(if operation == "apply" { 3600 } else { 30 }))
    })
    .await
    .map_err(|_| "Could not finish the project setup request.".to_owned())?
}


pub(crate) fn run_inspection(app: &AppHandle, root: &Path, timeout: Duration) -> Result<SetupResponse, String> {
    run_setup(app, root, "inspect", vec!["setup".into(), "inspect".into(), "--json".into(), "--background".into()], timeout)
}

fn run_setup(
    app: &AppHandle, root: &Path, operation: &str, args: Vec<String>, timeout: Duration,
) -> Result<SetupResponse, String> {
    let state = app.state::<AppState>();
    let env = state.environment();
    let prefs = settings::load_settings(app);
    let exe = std::env::current_exe().map_err(|_| "Could not locate Keryx Desktop.".to_owned())?;
    let cli = locator::locate_for_app(
        prefs.keryx_source, prefs.custom_path.as_deref(), exe.parent(),
        env.get("PATH").map(OsStr::new), true,
    ).map_err(|error| format!("cli-configuration: {error}"))?;
    let mut cmd = Command::new(cli.path);
    cmd.current_dir(root).env_clear().envs(env)
        .env("KERYX_NONINTERACTIVE", "1").args(args);
    // Repository discovery must come from the selected folder even if Desktop was launched from a Git hook.
    for name in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"] {
        cmd.env_remove(name);
    }
    cmd.env_remove("GIT_CONFIG_PARAMETERS").env_remove("GIT_CONFIG_COUNT");
    if operation != "apply" {
        // A background git status must neither refresh the index nor call a repository fsmonitor.
        cmd.env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "core.fsmonitor")
            .env("GIT_CONFIG_VALUE_0", "false");
    }
    let out = child::run_bounded_tree(cmd, timeout, 16 * 1024 * 1024).map_err(|error| match error {
        child::RunError::Timeout if operation == "apply" =>
            "Setup timed out and may have made changes. Inspect the project before retrying.".to_owned(),
        child::RunError::Timeout => "The project check timed out. Try again.".to_owned(),
        _ => "Could not run the selected Keryx CLI.".to_owned(),
    })?;
    let result: Value = serde_json::from_str(&out.stdout).map_err(|_| {
        if operation == "apply" {
            "Keryx did not return a setup result. Inspect the project before retrying."
        } else {
            "cli-configuration: The selected Keryx CLI did not return setup JSON. Check its version or CLI source in Settings."
        }
    })?;
    if result.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || result.get("operation").and_then(Value::as_str) != Some(operation) {
        return Err("cli-configuration: The selected Keryx CLI returned an unsupported setup response.".into());
    }
    // Refusals and partial results are valid structured responses even on nonzero exits.
    let status = result.get("status").and_then(Value::as_str);
    if !out.status.success() && !matches!(status, Some("error" | "partial")) {
        return Err("The selected Keryx CLI exited before reporting the setup result.".into());
    }
    let cli_source = match cli.source {
        locator::KeryxSource::Auto => "automatic",
        locator::KeryxSource::Path => "path",
        locator::KeryxSource::Bundled => "bundled",
        locator::KeryxSource::Custom => "custom",
    };
    Ok(SetupResponse { cli_source, result })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_setup_schema_and_plan_id() {
        assert!(SetupAction::Plan { request: json!({"schemaVersion": 2}) }.args().is_err());
        let request = json!({"schemaVersion": 1});
        assert!(SetupAction::Apply {
            request: request.clone(),
            plan_id: "g".repeat(64),
        }.args().is_err());
        let id = "a".repeat(64);
        let (_, args) = SetupAction::Apply {
            request,
            plan_id: id.clone(),
        }.args().unwrap();
        assert_eq!(&args[args.len() - 2..], &["--plan-id".to_owned(), id]);
    }
}
