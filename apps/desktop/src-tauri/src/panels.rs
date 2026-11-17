//! Tauri commands of the side panel's terminal tabs (D-13).
//!
//! Every command acts on the calling window's own tabs only: a tab id from
//! another window is refused by `PtyManager::get`.

use crate::bridge::AppState;
use crate::pty::{OpenSpec, Owner, PtyEvent, PtyManager, TabInfo};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, Window};

/// The project root each window's panel runs in, set by `panel_register`.
#[derive(Default)]
pub struct PanelRoots(Mutex<HashMap<String, PathBuf>>);

impl PanelRoots {
    pub fn set(&self, window: &str, root: PathBuf) {
        self.0.lock().unwrap().insert(window.to_string(), root);
    }

    pub fn get(&self, window: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().get(window).cloned()
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
    Ok(p.to_path_buf())
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
    let pty = app.state::<PtyManager>().open(OpenSpec { window, owner, cwd: root, env: &env, cols, rows, program: None })?;
    let info = pty.info();
    if owner == Owner::Agent {
        let _ = app.emit_to(window, "panel://terminal", &info);
    }
    Ok(info)
}

#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    window: Window,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<TabInfo, String> {
    let root = project_dir(&cwd)?;
    let label = window.label().to_string();
    // The first call waits for the login-shell environment capture.
    tauri::async_runtime::spawn_blocking(move || open_tab(&app, &label, &root, Owner::User, cols, rows))
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn pty_attach(window: Window, ptys: State<'_, PtyManager>, id: u64, on_event: Channel<PtyEvent>) -> Result<TabInfo, String> {
    let pty = ptys.get(window.label(), id)?;
    pty.attach(sink(on_event));
    Ok(pty.info())
}

#[tauri::command]
pub fn pty_write(window: Window, ptys: State<'_, PtyManager>, id: u64, data: String) -> Result<(), String> {
    ptys.get(window.label(), id)?.write(data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(window: Window, ptys: State<'_, PtyManager>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    ptys.get(window.label(), id)?.resize(cols, rows)
}

#[tauri::command]
pub async fn pty_close(app: AppHandle, window: Window, id: u64) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || app.state::<PtyManager>().close(&label, id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_list(window: Window, ptys: State<'_, PtyManager>) -> Vec<TabInfo> {
    ptys.list(window.label())
}
