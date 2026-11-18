//! Projects kept live in the background.
//!
//! Each project runs in its own window with its own `keryx acp` (see `bridge`). Switching projects
//! from the rail does not stop the one you leave: its window is hidden and the target project's
//! window takes its place at the same position and size (created hidden on first use). The
//! windows report what their project is doing, and every window gets the whole picture
//! (`projects://state`) so the rail can show a dot on any project, open or in the background.

use crate::bridge;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, Window};

/// Background project windows kept beyond this are closed, oldest idle first. A project with a
/// turn running or an answer waiting is never closed this way.
pub const MAX_BACKGROUND: usize = 6;

pub const STATE_EVENT: &str = "projects://state";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    cwd: String,
    /// "idle" | "busy" | "action", as the window reports it.
    activity: String,
    /// Order in which windows were last shown (higher is more recent).
    shown: u64,
}

#[derive(Default)]
struct Inner {
    by_label: HashMap<String, Entry>,
    seq: u64,
}

#[derive(Default)]
pub struct ProjectWindows {
    inner: Mutex<Inner>,
}

/// One project as every window sees it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub cwd: String,
    pub activity: String,
    /// The window holding it is on screen.
    pub visible: bool,
}

fn normalize_activity(a: &str) -> &'static str {
    match a {
        "busy" => "busy",
        "action" => "action",
        _ => "idle",
    }
}

impl Inner {
    fn touch(&mut self, label: &str) {
        self.seq += 1;
        let seq = self.seq;
        if let Some(e) = self.by_label.get_mut(label) {
            e.shown = seq;
        }
    }

    fn label_of(&self, cwd: &str, except: &str) -> Option<String> {
        self.by_label
            .iter()
            .filter(|(l, e)| e.cwd == cwd && l.as_str() != except)
            .max_by_key(|(_, e)| e.shown)
            .map(|(l, _)| l.clone())
    }

    /// Hidden labels to close so at most `max` stay in the background; only idle ones, oldest first.
    fn over_cap(&self, hidden: &[String], max: usize) -> Vec<String> {
        if hidden.len() <= max {
            return Vec::new();
        }
        let mut idle: Vec<(&String, u64)> = hidden
            .iter()
            .filter_map(|l| self.by_label.get(l).filter(|e| e.activity == "idle").map(|e| (l, e.shown)))
            .collect();
        idle.sort_by_key(|(_, shown)| *shown);
        idle.into_iter().take(hidden.len() - max).map(|(l, _)| l.clone()).collect()
    }
}

impl ProjectWindows {
    pub fn forget(&self, label: &str) {
        self.inner.lock().unwrap().by_label.remove(label);
    }

    fn snapshot(&self, app: &AppHandle) -> Vec<ProjectState> {
        let inner = self.inner.lock().unwrap();
        let mut out: Vec<ProjectState> = Vec::new();
        for (label, e) in &inner.by_label {
            let visible = app.get_webview_window(label).and_then(|w| w.is_visible().ok()).unwrap_or(false);
            match out.iter_mut().find(|p| p.cwd == e.cwd) {
                // The same project in two windows: the more urgent state and either one visible.
                Some(p) => {
                    p.visible |= visible;
                    if rank(&e.activity) > rank(&p.activity) {
                        p.activity = e.activity.clone();
                    }
                }
                None => out.push(ProjectState { cwd: e.cwd.clone(), activity: e.activity.clone(), visible }),
            }
        }
        out.sort_by(|a, b| a.cwd.cmp(&b.cwd));
        out
    }

    pub fn broadcast(&self, app: &AppHandle) {
        let _ = app.emit(STATE_EVENT, self.snapshot(app));
    }
}

fn rank(a: &str) -> u8 {
    match a {
        "action" => 2,
        "busy" => 1,
        _ => 0,
    }
}

/// The project this window shows (`None` once it shows none, e.g. back on the welcome screen).
#[tauri::command]
pub fn project_register(app: AppHandle, window: Window, state: State<'_, ProjectWindows>, cwd: Option<String>) {
    {
        let mut inner = state.inner.lock().unwrap();
        match cwd {
            Some(cwd) if !cwd.is_empty() => {
                inner.by_label.insert(window.label().to_string(), Entry { cwd, activity: "idle".into(), shown: 0 });
                inner.touch(window.label());
            }
            _ => {
                inner.by_label.remove(window.label());
            }
        }
    }
    state.broadcast(&app);
}

/// What this window's project is doing: "idle", "busy" or "action" (a dialog waits for an answer).
#[tauri::command]
pub fn project_activity(app: AppHandle, window: Window, state: State<'_, ProjectWindows>, activity: String) {
    {
        let mut inner = state.inner.lock().unwrap();
        let Some(e) = inner.by_label.get_mut(window.label()) else { return };
        let next = normalize_activity(&activity);
        if e.activity == next {
            return;
        }
        e.activity = next.to_string();
    }
    state.broadcast(&app);
}

/// Every live project, for a window that just opened.
#[tauri::command]
pub fn projects_state(app: AppHandle, state: State<'_, ProjectWindows>) -> Vec<ProjectState> {
    state.snapshot(&app)
}

/// Put `target` where `from` is and show it in its place; `from` is hidden, its keryx keeps running.
fn take_place(from: &Window, target: &WebviewWindow) -> Result<(), String> {
    if let (Ok(pos), Ok(size)) = (from.outer_position(), from.inner_size()) {
        let _ = target.set_size(size);
        let _ = target.set_position(pos);
    }
    if from.is_maximized().unwrap_or(false) {
        let _ = target.maximize();
    }
    target.show().map_err(|e| e.to_string())?;
    target.set_focus().map_err(|e| e.to_string())?;
    from.hide().map_err(|e| e.to_string())
}

/// Switch this window's place to project `cwd`: the window already running it, or a new one.
#[tauri::command]
pub async fn project_switch(
    app: AppHandle,
    window: Window,
    state: State<'_, ProjectWindows>,
    bridge_state: State<'_, bridge::AppState>,
    cwd: String,
) -> Result<(), String> {
    let existing = state.inner.lock().unwrap().label_of(&cwd, window.label());
    let target = match existing.and_then(|l| app.get_webview_window(&l)) {
        // Opened in a window of its own and on screen: just bring that window forward.
        Some(w) if w.is_visible().unwrap_or(false) => {
            w.set_focus().map_err(|e| e.to_string())?;
            state.inner.lock().unwrap().touch(w.label());
            return Ok(());
        }
        Some(w) => w,
        None => bridge::create_project_window(&app, &bridge_state, cwd, false)?,
    };
    take_place(&window, &target)?;
    {
        let mut inner = state.inner.lock().unwrap();
        inner.touch(target.label());
    }
    close_over_cap(&app, &state);
    state.broadcast(&app);
    Ok(())
}

/// The most recently shown hidden project window, to take the place of a window being closed.
pub fn successor(app: &AppHandle, state: &ProjectWindows, closing: &str) -> Option<WebviewWindow> {
    let inner = state.inner.lock().unwrap();
    inner
        .by_label
        .iter()
        .filter(|(l, _)| l.as_str() != closing)
        .filter_map(|(l, e)| app.get_webview_window(l).filter(|w| !w.is_visible().unwrap_or(true)).map(|w| (w, e.shown)))
        .max_by_key(|(_, shown)| *shown)
        .map(|(w, _)| w)
}

/// A visible project window is closing: the most recent background project takes its place, so
/// projects still running never end up with no window on screen.
pub fn on_close_requested(app: &AppHandle, window: &Window) {
    let state = app.state::<ProjectWindows>();
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    if let Some(next) = successor(app, &state, window.label()) {
        let _ = take_place(window, &next);
        state.inner.lock().unwrap().touch(next.label());
    }
}

fn close_over_cap(app: &AppHandle, state: &ProjectWindows) {
    let hidden: Vec<String> = {
        let inner = state.inner.lock().unwrap();
        inner
            .by_label
            .keys()
            .filter(|l| app.get_webview_window(l).map(|w| !w.is_visible().unwrap_or(true)).unwrap_or(false))
            .cloned()
            .collect()
    };
    let doomed = state.inner.lock().unwrap().over_cap(&hidden, MAX_BACKGROUND);
    for label in doomed {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner(entries: &[(&str, &str, &str, u64)]) -> Inner {
        let mut i = Inner::default();
        for (label, cwd, activity, shown) in entries {
            i.by_label.insert((*label).into(), Entry { cwd: (*cwd).into(), activity: (*activity).into(), shown: *shown });
        }
        i.seq = 100;
        i
    }

    #[test]
    fn finds_the_most_recent_window_of_a_project_but_not_the_caller() {
        let i = inner(&[("a", "/p", "idle", 1), ("b", "/p", "idle", 5), ("c", "/q", "idle", 9)]);
        assert_eq!(i.label_of("/p", "x").as_deref(), Some("b"));
        assert_eq!(i.label_of("/p", "b").as_deref(), Some("a"));
        assert_eq!(i.label_of("/none", "x"), None);
    }

    #[test]
    fn touching_moves_a_window_to_most_recent() {
        let mut i = inner(&[("a", "/p", "idle", 1), ("b", "/q", "idle", 5)]);
        i.touch("a");
        assert!(i.by_label["a"].shown > i.by_label["b"].shown);
    }

    #[test]
    fn over_cap_closes_only_idle_background_projects_oldest_first() {
        let i = inner(&[("a", "/a", "idle", 1), ("b", "/b", "busy", 2), ("c", "/c", "idle", 3), ("d", "/d", "action", 4), ("e", "/e", "idle", 5)]);
        let hidden: Vec<String> = ["a", "b", "c", "d", "e"].iter().map(|s| s.to_string()).collect();
        assert_eq!(i.over_cap(&hidden, 3), vec!["a".to_string(), "c".to_string()]);
        assert!(i.over_cap(&hidden, 5).is_empty());
        // Busy and waiting projects are never closed, even over the cap.
        assert_eq!(i.over_cap(&hidden, 0), vec!["a".to_string(), "c".to_string(), "e".to_string()]);
    }

    #[test]
    fn unknown_activity_counts_as_idle() {
        assert_eq!(normalize_activity("busy"), "busy");
        assert_eq!(normalize_activity("action"), "action");
        assert_eq!(normalize_activity("weird"), "idle");
        assert!(rank("action") > rank("busy") && rank("busy") > rank("idle"));
    }
}
