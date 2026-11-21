//! Read-only project checks shared by all Desktop webviews.
use crate::{locator::KeryxSource, panels::project_dir, projects::ProjectWindows, settings, setup};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, Webview};

const UPDATED: &str = "project-diagnostics://updated";
const FRESH_FOR: Duration = Duration::from_secs(90);
const PROJECT_LIMIT: usize = 16;
const CHECK_TIMEOUT: Duration = Duration::from_secs(8);
const SCAN_BUDGET: Duration = Duration::from_secs(45);

#[derive(Default)]
pub struct Diagnostics {
    // Serialize native scans across windows. The snapshot is independently readable.
    scan: Mutex<()>,
    cache: Mutex<HashMap<PathBuf, Cached>>,
}

struct Cached {
    scan: ProjectCheck,
    started: Instant,
    observed: Instant,
    source: (KeryxSource, Option<String>),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCheck {
    cwd: String,
    root: String,
    checked_at: u64,
    status: &'static str,
    report: Option<Value>,
    error: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanKind {
    Startup,
    Refresh,
    AfterApply,
}

fn snapshot(state: &Diagnostics) -> Vec<ProjectCheck> {
    let mut checks: Vec<_> = state.cache.lock().unwrap().values().map(|entry| entry.scan.clone()).collect();
    checks.sort_by(|a, b| a.cwd.cmp(&b.cwd));
    checks
}

fn inspect(app: &AppHandle, cwd: String, root: Option<&Path>, timeout: Duration) -> ProjectCheck {
    let (status, report, error) = match root {
        None => ("unavailable", None, Some("The project folder is unavailable.".to_owned())),
        Some(root) => {
            let (operation, args) = setup::SetupAction::Inspect.args().expect("Inspect has fixed arguments");
            match setup::run_setup(app, root, operation, args, timeout) {
                Ok(response) if response.result.get("state").and_then(Value::as_str).is_some() =>
                    ("checked", Some(response.result), None),
                Ok(_) => ("error", None, Some("Keryx could not inspect this project.".to_owned())),
                Err(error) if error.starts_with("cli-configuration: ") =>
                    ("cli-configuration", None, Some(error.trim_start_matches("cli-configuration: ").to_owned())),
                Err(error) => ("error", None, Some(error)),
            }
        }
    };
    let root = root.map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| cwd.clone());
    let checked_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    ProjectCheck { cwd, root, checked_at, status, report, error }
}

#[tauri::command]
pub async fn project_diagnostics(app: AppHandle, view: Webview, kind: ScanKind) -> Result<(), String> {
    let current = app.state::<ProjectWindows>().cwd_for(view.label());
    let requested = Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Diagnostics>();
        let _gate = state.scan.lock().unwrap();
        let prefs = settings::load_settings(&app);
        let source = (prefs.keryx_source, prefs.custom_path);
        let mut paths: Vec<_> = current.into_iter().collect();
        if !matches!(kind, ScanKind::AfterApply) {
            paths.extend(prefs.recent_projects);
            paths.extend(app.state::<ProjectWindows>().snapshot().into_iter().map(|project| project.cwd));
        }

        let mut seen = HashSet::new();
        let mut projects = Vec::new();
        for cwd in paths {
            if projects.len() == PROJECT_LIMIT { break; }
            let root = project_dir(&cwd).ok();
            let key = root.clone().unwrap_or_else(|| PathBuf::from(&cwd));
            if seen.insert(key.clone()) { projects.push((cwd, key, root)); }
        }
        if !matches!(kind, ScanKind::AfterApply) {
            state.cache.lock().unwrap().retain(|key, _| seen.contains(key));
        }
        let deadline = Instant::now() + SCAN_BUDGET;
        let mut complete = true;
        for (cwd, key, root) in projects {
            let cached = state.cache.lock().unwrap().get(&key).is_some_and(|entry| {
                entry.source == source && match kind {
                    ScanKind::Startup => entry.observed.elapsed() < FRESH_FOR,
                    ScanKind::Refresh => entry.observed >= requested,
                    ScanKind::AfterApply => entry.started >= requested,
                }
            });
            if cached { continue; }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                complete = false;
                break;
            }
            let started = Instant::now();
            let scan = inspect(&app, cwd, root.as_deref(), remaining.min(CHECK_TIMEOUT));
            state.cache.lock().unwrap().insert(key, Cached { scan, started, observed: Instant::now(), source: source.clone() });
            let _ = app.emit(UPDATED, snapshot(&state));
        }
        let _ = app.emit(UPDATED, snapshot(&state));
        if complete { Ok(()) } else { Err("Some projects could not be checked in time. Refresh to try again.".to_owned()) }
    })
    .await
    .map_err(|_| "Project diagnostics could not finish.".to_owned())?
}
