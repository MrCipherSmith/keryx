//! Projects kept live in the background, one host window per window on screen.
//!
//! A host window is a bare native window (no web view of its own). Every project it holds is a
//! child web view of it — a *project view*, labelled `project-N` — that fills the window and
//! follows its size. Each project view runs its own `keryx acp` (see `bridge`), keyed by the
//! view's label. Switching projects from the rail does not stop the one you leave: its view is
//! hidden and the target's view is shown in the same window (created on first use), so the
//! window's fullscreen Space, size, position and Stage Manager placement never change. Hidden
//! views keep their page, and so their keryx, running.
//!
//! The views report what their project is doing, and every view gets the whole picture
//! (`projects://state`) so the rail can show a dot on any project, on screen or in the background.

use crate::{bridge, browser, flows, panel_mcp, panels, pty};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::utils::config::WindowConfig;
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{AppHandle, CloseRequestApi, Emitter, Manager, PhysicalPosition, Rect, State, Webview, WebviewUrl, Window};

/// Background project views kept beyond this are closed, oldest idle first. A project with a
/// turn running or an answer waiting is never closed this way.
pub const MAX_BACKGROUND: usize = 6;

pub const STATE_EVENT: &str = "projects://state";

/// The first host window, declared in tauri.conf.json (`create: false`) and built at setup.
pub const MAIN_WINDOW: &str = "main";

const DEFAULT_TITLE: &str = "Keryx";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    /// Label of the host window holding this view.
    window: String,
    /// The project it shows; `None` on the welcome screen.
    cwd: Option<String>,
    /// "idle" | "busy" | "action", as the view reports it.
    activity: String,
    /// Order in which views were last brought to the front (higher is more recent).
    shown: u64,
    /// The host window's title while this view is in front.
    title: String,
}

#[derive(Default)]
struct Inner {
    /// Project view label → its entry.
    by_label: HashMap<String, Entry>,
    /// Host window label → the project view it shows. Every other view of that window is hidden.
    front: HashMap<String, String>,
    seq: u64,
}

#[derive(Default)]
pub struct ProjectWindows {
    inner: Mutex<Inner>,
    next_window: AtomicU64,
    next_view: AtomicU64,
}

/// One project as every view sees it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub cwd: String,
    pub activity: String,
    /// A view showing it is in front of its window.
    pub visible: bool,
}

fn normalize_activity(a: &str) -> &'static str {
    match a {
        "busy" => "busy",
        "action" => "action",
        _ => "idle",
    }
}

fn rank(a: &str) -> u8 {
    match a {
        "action" => 2,
        "busy" => 1,
        _ => 0,
    }
}

impl Inner {
    fn add(&mut self, label: &str, window: &str) {
        self.by_label.insert(
            label.to_string(),
            Entry { window: window.to_string(), cwd: None, activity: "idle".into(), shown: 0, title: DEFAULT_TITLE.into() },
        );
    }

    fn touch(&mut self, label: &str) {
        self.seq += 1;
        let seq = self.seq;
        if let Some(e) = self.by_label.get_mut(label) {
            e.shown = seq;
        }
    }

    /// The most recent view of project `cwd` other than `except`.
    fn label_of(&self, cwd: &str, except: &str) -> Option<String> {
        self.by_label
            .iter()
            .filter(|(l, e)| e.cwd.as_deref() == Some(cwd) && l.as_str() != except)
            .max_by_key(|(_, e)| e.shown)
            .map(|(l, _)| l.clone())
    }

    fn is_front(&self, label: &str) -> bool {
        self.by_label.get(label).is_some_and(|e| self.front.get(&e.window).map(String::as_str) == Some(label))
    }

    fn front_of(&self, window: &str) -> Option<String> {
        self.front.get(window).cloned()
    }

    /// Make `label` the view its window shows; returns the view it replaces.
    fn set_front(&mut self, label: &str) -> Option<String> {
        let window = self.by_label.get(label)?.window.clone();
        let previous = self.front.insert(window, label.to_string());
        self.touch(label);
        previous.filter(|p| p != label)
    }

    /// Every view not in front of its window, in label order.
    fn hidden(&self) -> Vec<String> {
        let mut out: Vec<String> = self.by_label.keys().filter(|l| !self.is_front(l)).cloned().collect();
        out.sort();
        out
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

    /// The most recently shown hidden view of `window`, to take the place of `closing`.
    fn successor(&self, window: &str, closing: &str) -> Option<String> {
        self.by_label
            .iter()
            .filter(|(l, e)| e.window == window && l.as_str() != closing && !self.is_front(l))
            .max_by_key(|(_, e)| e.shown)
            .map(|(l, _)| l.clone())
    }

    fn remove(&mut self, label: &str) -> Option<Entry> {
        let e = self.by_label.remove(label)?;
        if self.front.get(&e.window).map(String::as_str) == Some(label) {
            self.front.remove(&e.window);
        }
        Some(e)
    }

    /// Forget a destroyed window and every view it held; returns those views.
    fn remove_window(&mut self, window: &str) -> Vec<String> {
        let mut labels: Vec<String> = self.by_label.iter().filter(|(_, e)| e.window == window).map(|(l, _)| l.clone()).collect();
        labels.sort();
        for l in &labels {
            self.by_label.remove(l);
        }
        self.front.remove(window);
        labels
    }

    /// `label` now belongs to `window` (it was reparented while hidden).
    fn move_to(&mut self, label: &str, window: &str) {
        let Some(old) = self.by_label.get(label).map(|e| e.window.clone()) else { return };
        if self.front.get(&old).map(String::as_str) == Some(label) {
            self.front.remove(&old);
        }
        if let Some(e) = self.by_label.get_mut(label) {
            e.window = window.to_string();
        }
    }

    fn snapshot(&self) -> Vec<ProjectState> {
        let mut out: Vec<ProjectState> = Vec::new();
        for (label, e) in &self.by_label {
            let Some(cwd) = &e.cwd else { continue };
            let visible = self.is_front(label);
            match out.iter_mut().find(|p| &p.cwd == cwd) {
                // The same project in two views: the more urgent state and either one visible.
                Some(p) => {
                    p.visible |= visible;
                    if rank(&e.activity) > rank(&p.activity) {
                        p.activity = e.activity.clone();
                    }
                }
                None => out.push(ProjectState { cwd: cwd.clone(), activity: e.activity.clone(), visible }),
            }
        }
        out.sort_by(|a, b| a.cwd.cmp(&b.cwd));
        out
    }
}

impl ProjectWindows {
    fn snapshot(&self) -> Vec<ProjectState> {
        self.inner.lock().unwrap().snapshot()
    }

    pub fn broadcast(&self, app: &AppHandle) {
        let _ = app.emit(STATE_EVENT, self.snapshot());
    }

    /// Whether `label` is the view its window shows.
    pub fn is_front(&self, label: &str) -> bool {
        self.inner.lock().unwrap().is_front(label)
    }

    /// The view `window` shows.
    pub fn front_of(&self, window: &str) -> Option<String> {
        self.inner.lock().unwrap().front_of(window)
    }
}

// ---- host windows and project views ----

/// The host window settings declared for `main` in tauri.conf.json, relabelled.
fn host_config(app: &AppHandle, label: &str) -> Result<WindowConfig, String> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
        .ok_or("tauri.conf.json declares no `main` window")?;
    config.label = label.to_string();
    Ok(config)
}

fn build_host_window(app: &AppHandle, label: &str) -> Result<Window, String> {
    let config = host_config(app, label)?;
    WindowBuilder::from_config(app, &config).and_then(|b| b.build()).map_err(|e| e.to_string())
}

/// Add a project view for `cwd` (`None`: the welcome screen) to `window`, filling it and following
/// its size. It is registered, not yet in front: see `bring_to_front`.
pub fn add_view(app: &AppHandle, window: &Window, cwd: Option<String>) -> Result<Webview, String> {
    let state = app.state::<ProjectWindows>();
    let n = state.next_view.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("project-{n}");
    if let Some(cwd) = cwd {
        app.state::<bridge::AppState>().set_pending_cwd(&label, cwd);
    }
    // Registered first: the page may call in before `add_child` returns.
    state.inner.lock().unwrap().add(&label, window.label());
    let builder = navigation_guarded(app, &label).auto_resize();
    let size = window.inner_size().map_err(|e| e.to_string())?;
    match window.add_child(builder, PhysicalPosition::new(0, 0), size) {
        Ok(view) => Ok(view),
        Err(e) => {
            state.inner.lock().unwrap().remove(&label);
            app.state::<bridge::AppState>().view_closed(&label);
            Err(format!("Could not open the project view: {e}"))
        }
    }
}

fn navigation_guarded(app: &AppHandle, label: &str) -> WebviewBuilder<tauri::Wry> {
    crate::navigation::guard(WebviewBuilder::new(label, WebviewUrl::App("index.html".into())), crate::navigation::dev_url(app))
}

/// Build the `main` host window with a welcome view (app setup).
pub fn create_main_window(app: &AppHandle) -> Result<(), String> {
    let window = build_host_window(app, MAIN_WINDOW)?;
    let view = add_view(app, &window, None)?;
    bring_to_front(app, &window, &view);
    Ok(())
}

/// A new host window showing `cwd`.
pub fn open_in_new_window(app: &AppHandle, cwd: String) -> Result<(), String> {
    let n = app.state::<ProjectWindows>().next_window.fetch_add(1, Ordering::SeqCst) + 1;
    let window = build_host_window(app, &format!("window-{n}"))?;
    let view = match add_view(app, &window, Some(cwd)) {
        Ok(v) => v,
        Err(e) => {
            let _ = window.close();
            return Err(e);
        }
    };
    bring_to_front(app, &window, &view);
    broadcast(app);
    Ok(())
}

fn broadcast(app: &AppHandle) {
    app.state::<ProjectWindows>().broadcast(app);
}

/// Show `target` in `window` and hide the view it replaces (its keryx keeps running), with the
/// browser tabs of each following its project; the window's title becomes the target's.
fn bring_to_front(app: &AppHandle, window: &Window, target: &Webview) {
    let state = app.state::<ProjectWindows>();
    let (previous, title) = {
        let mut inner = state.inner.lock().unwrap();
        let previous = inner.set_front(target.label());
        let title = inner.by_label.get(target.label()).map(|e| e.title.clone()).unwrap_or_else(|| DEFAULT_TITLE.into());
        (previous, title)
    };
    // Show first, then hide: the window never shows an empty frame.
    let _ = target.show();
    if let Some(prev) = &previous {
        if let Some(view) = app.get_webview(prev) {
            let _ = view.hide();
        }
        browser::apply_layout(app, prev);
    }
    browser::apply_layout(app, target.label());
    let _ = target.set_focus();
    let _ = window.set_title(&title);
}

/// Move hidden view `view` (and its browser tabs) into `window`, filling it.
fn move_view(app: &AppHandle, view: &Webview, window: &Window) -> Result<(), String> {
    view.reparent(window).map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    // Recomputes the auto-resize ratios against the new window.
    view.set_bounds(Rect { position: PhysicalPosition::new(0, 0).into(), size: size.into() }).map_err(|e| e.to_string())?;
    app.state::<ProjectWindows>().inner.lock().unwrap().move_to(view.label(), window.label());
    // After the project view, so the tabs stay above it.
    browser::reparent_tabs(app, view.label(), window);
    Ok(())
}

/// Drop everything a project view owned. `close_tabs`: also close its browser tab views (false
/// when its window is destroyed and took them along).
fn release(app: &AppHandle, label: &str, close_tabs: bool) {
    // Never wait out the stop grace period here.
    app.state::<bridge::AppState>().view_closed(label);
    // Unsent chat attachments of a closed view go with it; sent ones stay until the app exits.
    crate::images::release_view(app, label);
    app.state::<flows::watch::FlowWatchers>().stop_window(label);
    app.state::<pty::PtyManager>().close_window(label);
    app.state::<panels::PanelRoots>().remove(label);
    // The view's Chrome is a separate process: it stops whether or not the window took the tab views along.
    crate::chromium::engine::close_view(app, label);
    if close_tabs {
        browser::close_window(app, label);
    } else {
        app.state::<browser::Browsers>().forget_window(label);
    }
    app.state::<panel_mcp::PanelMcp>().forget_window(label);
}

/// Close one project view and stop its keryx; its window stays.
fn close_view(app: &AppHandle, label: &str) {
    app.state::<ProjectWindows>().inner.lock().unwrap().remove(label);
    release(app, label, true);
    if let Some(view) = app.get_webview(label) {
        let _ = view.close();
    }
}

fn close_over_cap(app: &AppHandle, state: &ProjectWindows) {
    let doomed = {
        let inner = state.inner.lock().unwrap();
        inner.over_cap(&inner.hidden(), MAX_BACKGROUND)
    };
    for label in doomed {
        close_view(app, &label);
    }
}

/// A host window is closing. While it holds another project, the window stays: only the project
/// in front closes (its keryx stops) and the most recent other project of the window takes its
/// place, so a project still running never closes with a window. The last one closes the window.
pub fn on_close_requested(app: &AppHandle, window: &Window, api: &CloseRequestApi) {
    let state = app.state::<ProjectWindows>();
    let (closing, next) = {
        let inner = state.inner.lock().unwrap();
        let closing = inner.front_of(window.label());
        let next = closing.as_deref().and_then(|c| inner.successor(window.label(), c));
        (closing, next)
    };
    let (Some(closing), Some(next)) = (closing, next) else { return };
    let Some(next) = app.get_webview(&next) else { return };
    api.prevent_close();
    bring_to_front(app, window, &next);
    // Off the event loop: closing views and stopping processes goes through it.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        close_view(&app, &closing);
        broadcast(&app);
    });
}

/// A host window is gone, and every project view in it.
pub fn on_window_destroyed(app: &AppHandle, window: &str) {
    let labels = app.state::<ProjectWindows>().inner.lock().unwrap().remove_window(window);
    for label in labels {
        release(app, &label, false);
    }
    broadcast(app);
}

// ---- commands ----

/// The project this view shows (`None` once it shows none, e.g. back on the welcome screen).
#[tauri::command]
pub fn project_register(app: AppHandle, webview: Webview, state: State<'_, ProjectWindows>, cwd: Option<String>) {
    {
        let mut inner = state.inner.lock().unwrap();
        let cwd = cwd.filter(|c| !c.is_empty());
        let Some(e) = inner.by_label.get_mut(webview.label()) else { return };
        let opened = cwd.is_some();
        e.cwd = cwd;
        e.activity = "idle".into();
        if opened {
            inner.touch(webview.label());
        }
    }
    state.broadcast(&app);
}

/// What this view's project is doing: "idle", "busy" or "action" (a dialog waits for an answer).
#[tauri::command]
pub fn project_activity(app: AppHandle, webview: Webview, state: State<'_, ProjectWindows>, activity: String) {
    {
        let mut inner = state.inner.lock().unwrap();
        let Some(e) = inner.by_label.get_mut(webview.label()) else { return };
        let next = normalize_activity(&activity);
        if e.activity == next {
            return;
        }
        e.activity = next.to_string();
    }
    state.broadcast(&app);
}

/// The window title this view wants; applied while it is in front, and again whenever it comes back.
#[tauri::command]
pub fn project_title(webview: Webview, state: State<'_, ProjectWindows>, title: String) -> Result<(), String> {
    let front = {
        let mut inner = state.inner.lock().unwrap();
        let Some(e) = inner.by_label.get_mut(webview.label()) else { return Ok(()) };
        e.title = title.clone();
        inner.is_front(webview.label())
    };
    if front {
        webview.window().set_title(&title).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every live project, for a view that just opened.
#[tauri::command]
pub fn projects_state(state: State<'_, ProjectWindows>) -> Vec<ProjectState> {
    state.snapshot()
}

/// Show project `cwd` in this view's window in its place: the view already running it, or a new
/// one. A project in front of another window is brought forward there instead.
#[tauri::command]
pub async fn project_switch(app: AppHandle, webview: Webview, state: State<'_, ProjectWindows>, cwd: String) -> Result<(), String> {
    let window = webview.window();
    let existing = {
        let inner = state.inner.lock().unwrap();
        inner
            .label_of(&cwd, webview.label())
            .and_then(|l| inner.by_label.get(&l).map(|e| (l.clone(), inner.is_front(&l), e.window.clone())))
    };
    let existing = existing.and_then(|(l, front, win)| app.get_webview(&l).map(|v| (v, front, win)));
    let target = match existing {
        // On screen in a window of its own: bring that window forward.
        Some((view, true, win)) => {
            if let Some(w) = app.get_window(&win) {
                let _ = w.unminimize();
                w.set_focus().map_err(|e| e.to_string())?;
            }
            let _ = view.set_focus();
            state.inner.lock().unwrap().touch(view.label());
            return Ok(());
        }
        Some((view, false, win)) if win == window.label() => view,
        // In the background of another window: it moves here.
        Some((view, false, _)) => {
            move_view(&app, &view, &window)?;
            view
        }
        None => add_view(&app, &window, Some(cwd))?,
    };
    bring_to_front(&app, &window, &target);
    close_over_cap(&app, &state);
    state.broadcast(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (label, window, cwd ("" = none), activity, shown)
    fn inner(entries: &[(&str, &str, &str, &str, u64)], front: &[(&str, &str)]) -> Inner {
        let mut i = Inner::default();
        for (label, window, cwd, activity, shown) in entries {
            i.by_label.insert(
                (*label).into(),
                Entry {
                    window: (*window).into(),
                    cwd: (!cwd.is_empty()).then(|| (*cwd).to_string()),
                    activity: (*activity).into(),
                    shown: *shown,
                    title: DEFAULT_TITLE.into(),
                },
            );
        }
        for (window, label) in front {
            i.front.insert((*window).into(), (*label).into());
        }
        i.seq = 100;
        i
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_the_most_recent_view_of_a_project_but_not_the_caller() {
        let i = inner(
            &[("a", "w", "/p", "idle", 1), ("b", "w", "/p", "idle", 5), ("c", "w", "/q", "idle", 9), ("d", "w", "", "idle", 20)],
            &[],
        );
        assert_eq!(i.label_of("/p", "x").as_deref(), Some("b"));
        assert_eq!(i.label_of("/p", "b").as_deref(), Some("a"));
        assert_eq!(i.label_of("/none", "x"), None);
        assert_eq!(i.label_of("", "x"), None, "the welcome screen is no project");
    }

    #[test]
    fn touching_moves_a_view_to_most_recent() {
        let mut i = inner(&[("a", "w", "/p", "idle", 1), ("b", "w", "/q", "idle", 5)], &[]);
        i.touch("a");
        assert!(i.by_label["a"].shown > i.by_label["b"].shown);
    }

    #[test]
    fn one_view_in_front_per_window() {
        let mut i = inner(&[("a", "w1", "/a", "idle", 1), ("b", "w1", "/b", "idle", 2), ("c", "w2", "/c", "idle", 3)], &[]);
        assert_eq!(i.set_front("a"), None);
        assert_eq!(i.set_front("c"), None, "another window has its own front");
        assert_eq!(i.set_front("b").as_deref(), Some("a"));
        assert_eq!(i.set_front("b"), None, "bringing the front view forward replaces nothing");
        assert!(i.is_front("b") && i.is_front("c") && !i.is_front("a"));
        assert_eq!(i.hidden(), strings(&["a"]));
        assert!(i.by_label["b"].shown > i.by_label["c"].shown);
        assert_eq!(i.set_front("missing"), None);
    }

    #[test]
    fn over_cap_closes_only_idle_background_projects_oldest_first() {
        let i = inner(
            &[("a", "w", "/a", "idle", 1), ("b", "w", "/b", "busy", 2), ("c", "w", "/c", "idle", 3), ("d", "w", "/d", "action", 4), ("e", "w", "/e", "idle", 5)],
            &[],
        );
        let hidden = strings(&["a", "b", "c", "d", "e"]);
        assert_eq!(i.over_cap(&hidden, 3), strings(&["a", "c"]));
        assert!(i.over_cap(&hidden, 5).is_empty());
        // Busy and waiting projects are never closed, even over the cap.
        assert_eq!(i.over_cap(&hidden, 0), strings(&["a", "c", "e"]));
    }

    #[test]
    fn the_cap_counts_hidden_views_of_every_window() {
        let i = inner(
            &[("a", "w1", "/a", "idle", 1), ("b", "w1", "/b", "idle", 2), ("c", "w2", "/c", "idle", 3), ("d", "w2", "/d", "idle", 4)],
            &[("w1", "b"), ("w2", "d")],
        );
        let hidden = i.hidden();
        assert_eq!(hidden, strings(&["a", "c"]));
        assert_eq!(i.over_cap(&hidden, 1), strings(&["a"]));
    }

    #[test]
    fn the_successor_is_the_most_recent_hidden_view_of_the_same_window() {
        let i = inner(
            &[("a", "w1", "/a", "busy", 1), ("b", "w1", "/b", "idle", 3), ("c", "w1", "/c", "idle", 9), ("d", "w2", "/d", "idle", 10), ("e", "w2", "/e", "idle", 11)],
            &[("w1", "c"), ("w2", "e")],
        );
        assert_eq!(i.successor("w1", "c").as_deref(), Some("b"));
        assert_eq!(i.successor("w2", "e").as_deref(), Some("d"), "never a view of another window");
        let alone = inner(&[("a", "w1", "/a", "idle", 1), ("b", "w2", "/b", "idle", 2)], &[("w1", "a"), ("w2", "b")]);
        assert_eq!(alone.successor("w1", "a"), None, "the last view closes the window");
    }

    #[test]
    fn removing_the_front_view_leaves_its_window_without_one() {
        let mut i = inner(&[("a", "w1", "/a", "idle", 1), ("b", "w1", "/b", "idle", 2)], &[("w1", "b")]);
        assert!(i.remove("b").is_some());
        assert_eq!(i.front_of("w1"), None);
        assert!(i.remove("b").is_none());
        assert!(i.remove("a").is_some());
        assert!(i.by_label.is_empty());
    }

    #[test]
    fn a_destroyed_window_takes_all_its_views_along() {
        let mut i = inner(
            &[("a", "w1", "/a", "idle", 1), ("b", "w1", "", "idle", 2), ("c", "w2", "/c", "idle", 3)],
            &[("w1", "b"), ("w2", "c")],
        );
        assert_eq!(i.remove_window("w1"), strings(&["a", "b"]));
        assert_eq!(i.by_label.keys().cloned().collect::<Vec<_>>(), strings(&["c"]));
        assert_eq!(i.front_of("w1"), None);
        assert_eq!(i.front_of("w2").as_deref(), Some("c"));
    }

    #[test]
    fn a_moved_view_belongs_to_its_new_window() {
        let mut i = inner(&[("a", "w1", "/a", "idle", 1), ("b", "w1", "/b", "idle", 2), ("c", "w2", "/c", "idle", 3)], &[("w1", "b"), ("w2", "c")]);
        i.move_to("a", "w2");
        assert_eq!(i.by_label["a"].window, "w2");
        assert_eq!(i.set_front("a").as_deref(), Some("c"));
        assert_eq!(i.front_of("w1").as_deref(), Some("b"), "the old window keeps its own front");
    }

    #[test]
    fn the_snapshot_lists_projects_once_and_marks_those_in_front() {
        let i = inner(
            &[("a", "w1", "/p", "busy", 1), ("b", "w2", "/p", "idle", 2), ("c", "w1", "/q", "action", 3), ("d", "w3", "", "idle", 4)],
            &[("w1", "a"), ("w2", "b"), ("w3", "d")],
        );
        assert_eq!(
            i.snapshot(),
            vec![
                ProjectState { cwd: "/p".into(), activity: "busy".into(), visible: true },
                ProjectState { cwd: "/q".into(), activity: "action".into(), visible: false },
            ]
        );
    }

    #[test]
    fn unknown_activity_counts_as_idle() {
        assert_eq!(normalize_activity("busy"), "busy");
        assert_eq!(normalize_activity("action"), "action");
        assert_eq!(normalize_activity("weird"), "idle");
        assert!(rank("action") > rank("busy") && rank("busy") > rank("idle"));
    }
}
