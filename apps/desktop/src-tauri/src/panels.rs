//! Tauri commands of the side panel's terminal tabs (D-13).
//!
//! Every command acts on the calling project view's own tabs only (keyed by
//! the view's label, not its host window's): a tab id from
//! another view is refused by `PtyManager::get`.

use crate::bridge::AppState;
use crate::pty::{OpenSpec, Owner, PtyEvent, PtyManager, TabInfo};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, Webview};

/// Canonical project roots assigned by the host when creating project views.
#[derive(Default)]
pub struct PanelRoots(Mutex<HashMap<String, PathBuf>>);

impl PanelRoots {
    pub fn set(&self, window: &str, root: PathBuf) {
        self.0.lock().unwrap().insert(window.to_string(), root);
    }

    pub fn get(&self, window: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().get(window).cloned()
    }

    pub fn require_project(&self, window: &str, cwd: &str) -> Result<PathBuf, String> {
        let root = self.get(window).ok_or("Open a project first")?;
        if project_dir(cwd)? != root {
            return Err("The requested folder does not belong to this project view".into());
        }
        Ok(root)
    }

    pub fn remove(&self, window: &str) {
        self.0.lock().unwrap().remove(window);
    }
}

pub fn project_dir(cwd: &str) -> Result<PathBuf, String> {
    let p = Path::new(cwd);
    if !p.is_absolute() || !p.is_dir() {
        return Err(format!("{cwd} is not a folder"));
    }
    p.canonicalize().map_err(|e| format!("Could not resolve project folder {cwd}: {e}"))
}

fn sink(channel: Channel<PtyEvent>) -> crate::pty::Sink {
    Box::new(move |e| {
        let _ = channel.send(e);
    })
}

/// Open a tab for `owner` in `root`; the view attaches afterwards and gets the
/// output so far replayed. Agent tabs are announced to the window.
pub fn open_tab(app: &AppHandle, window: &str, root: &Path, owner: Owner, cols: u16, rows: u16) -> Result<TabInfo, String> {
    let env = app.state::<AppState>().environment().clone();
    let env = if env.is_empty() { std::env::vars().collect() } else { env };
    let pty = app.state::<PtyManager>().open(OpenSpec { window, owner, cwd: root, env: &env, cols, rows, program: None, title: None, on_exit: None })?;
    let info = pty.info();
    if owner == Owner::Agent {
        let _ = app.emit_to(window, "panel://terminal", &info);
    }
    Ok(info)
}

#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    view: Webview,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<TabInfo, String> {
    let root = project_dir(&cwd)?;
    let label = view.label().to_string();
    // The first call waits for the login-shell environment capture.
    tauri::async_runtime::spawn_blocking(move || open_tab(&app, &label, &root, Owner::User, cols, rows))
    .await
    .map_err(|e| e.to_string())?
}

/// Exit of a tab opened by `pty_open_run`, announced to its window.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub id: u64,
    pub code: Option<u32>,
}

/// Open a tab whose process is `argv` itself (`/delegate`'s vendor CLI, D-14), in `root`, with the
/// login-shell environment. The window gets `panel://pty-exit` when it ends, whether or not the tab is
/// on screen. A program that cannot start is an error and no tab exists.
pub fn open_run_tab(app: &AppHandle, window: &str, root: &Path, argv: &[String], title: &str, cols: u16, rows: u16) -> Result<TabInfo, String> {
    let Some((program, rest)) = argv.split_first() else { return Err("Nothing to run".into()) };
    let env = app.state::<AppState>().environment().clone();
    let env = if env.is_empty() { std::env::vars().collect() } else { env };
    let rest: Vec<&str> = rest.iter().map(String::as_str).collect();
    let (hook_app, hook_window) = (app.clone(), window.to_string());
    let pty = app.state::<PtyManager>().open(OpenSpec {
        window,
        owner: Owner::User,
        cwd: root,
        env: &env,
        cols,
        rows,
        program: Some((program.as_str(), &rest)),
        title: Some(title),
        on_exit: Some(Box::new(move |id, code| {
            let _ = hook_app.emit_to(hook_window.as_str(), "panel://pty-exit", &PtyExit { id, code });
        })),
    })?;
    Ok(pty.info())
}

#[tauri::command]
pub async fn pty_open_run(
    app: AppHandle,
    view: Webview,
    cwd: String,
    argv: Vec<String>,
    title: String,
    cols: u16,
    rows: u16,
) -> Result<TabInfo, String> {
    let root = project_dir(&cwd)?;
    let label = view.label().to_string();
    tauri::async_runtime::spawn_blocking(move || open_run_tab(&app, &label, &root, &argv, &title, cols, rows))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn pty_attach(view: Webview, ptys: State<'_, PtyManager>, id: u64, on_event: Channel<PtyEvent>) -> Result<TabInfo, String> {
    let pty = ptys.get(view.label(), id)?;
    pty.attach(sink(on_event));
    Ok(pty.info())
}

#[tauri::command]
pub fn pty_write(view: Webview, ptys: State<'_, PtyManager>, id: u64, data: String) -> Result<(), String> {
    ptys.get(view.label(), id)?.write(data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(view: Webview, ptys: State<'_, PtyManager>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    ptys.get(view.label(), id)?.resize(cols, rows)
}

#[tauri::command]
pub async fn pty_close(app: AppHandle, view: Webview, id: u64) -> Result<(), String> {
    let label = view.label().to_string();
    tauri::async_runtime::spawn_blocking(move || app.state::<PtyManager>().close(&label, id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_list(view: Webview, ptys: State<'_, PtyManager>) -> Vec<TabInfo> {
    ptys.list(view.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_view_accepts_only_its_registered_root() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let roots = PanelRoots::default();
        let root = project_dir(a.path().to_str().unwrap()).unwrap();
        let alias = a.path().join(".");
        assert!(roots.require_project("view", alias.to_str().unwrap()).is_err());
        roots.set("view", root.clone());
        assert_eq!(roots.require_project("view", alias.to_str().unwrap()).unwrap(), root);
        assert!(roots.require_project("view", b.path().to_str().unwrap()).is_err());
        assert!(roots.require_project("other", alias.to_str().unwrap()).is_err());
    }
}
