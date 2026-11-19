//! The Chromium engine behind the browser panel: one Chrome per project view
//! (keyed by the view's label, like the WebKit tabs in `browser`), its tabs as
//! CDP page targets, and what the panel needs to show and drive them.
//!
//! - Tab changes (URL, title, loading, popups, closes) go to the view as the same
//!   `panel://browser` events the WebKit engine sends, so the panel's chrome
//!   (tabs, address bar) works unchanged.
//! - The active tab is shown as a screencast: `Page.startScreencast` frames go
//!   to the view over a Tauri channel (`browser_frames`) and are drawn on a
//!   canvas; the user's mouse, wheel and keys come back as real CDP input
//!   (`browser_input`).
//! - The page's viewport is the panel body's size (`layout`), so pages lay out
//!   for the space they are shown in.
//!
//! Which engine a view uses is decided once, on its first browser call
//! (`kind`): the `browserEngine` setting, `auto` meaning Chromium when a
//! Chrome is installed and WebKit otherwise (owner decisions 1 and 3).

use super::launch::{find_chrome, profile_dir, Chromium};
use super::page::{Browser, Page};
use crate::browser::{self, BrowserEvent, BrowserTabInfo, Bounds};
use crate::panels::PanelRoots;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

pub const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EngineSetting {
    #[default]
    Auto,
    Chromium,
    Webkit,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Webkit,
    Chromium,
}

/// The engine a setting gives, given whether a Chrome was found.
pub fn resolve(setting: EngineSetting, chrome_found: bool) -> Kind {
    match setting {
        EngineSetting::Webkit => Kind::Webkit,
        EngineSetting::Chromium | EngineSetting::Auto if chrome_found => Kind::Chromium,
        _ => Kind::Webkit,
    }
}

/// A screencast frame for the panel's canvas.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub tab: u64,
    /// JPEG, base64.
    pub data: String,
    /// The page's size in CSS pixels the frame shows.
    pub width: f64,
    pub height: f64,
}

/// User input from the panel's canvas, in the page's CSS pixels.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum InputEvent {
    Mouse {
        /// `mousePressed`, `mouseReleased` or `mouseMoved`.
        #[serde(rename = "type")]
        ty: String,
        x: f64,
        y: f64,
        #[serde(default)]
        button: Option<String>,
        #[serde(default)]
        clicks: Option<i64>,
        #[serde(default)]
        modifiers: Option<i64>,
    },
    Wheel {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
        #[serde(default)]
        modifiers: Option<i64>,
    },
    Key {
        /// `keyDown` or `keyUp`.
        #[serde(rename = "type")]
        ty: String,
        key: String,
        code: String,
        #[serde(default)]
        text: Option<String>,
        #[serde(default, rename = "keyCode")]
        key_code: Option<i64>,
        #[serde(default)]
        modifiers: Option<i64>,
    },
    Text {
        text: String,
    },
}

const META: i64 = 4;

/// The CDP calls one input event becomes: (method, params).
pub fn input_calls(ev: &InputEvent) -> Vec<(&'static str, Value)> {
    match ev {
        InputEvent::Mouse { ty, x, y, button, clicks, modifiers } => {
            let button = if ty == "mouseMoved" && button.is_none() { "none".to_string() } else { button.clone().unwrap_or_else(|| "left".into()) };
            vec![(
                "Input.dispatchMouseEvent",
                json!({ "type": ty, "x": x, "y": y, "button": button, "clickCount": clicks.unwrap_or(if ty == "mouseMoved" { 0 } else { 1 }), "modifiers": modifiers.unwrap_or(0) }),
            )]
        }
        InputEvent::Wheel { x, y, dx, dy, modifiers } => vec![(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy, "modifiers": modifiers.unwrap_or(0) }),
        )],
        InputEvent::Key { ty, key, code, text, key_code, modifiers } => {
            let mods = modifiers.unwrap_or(0);
            let text = text.clone().filter(|t| !t.is_empty() && mods & META == 0);
            let kind = match (ty.as_str(), &text) {
                ("keyDown", Some(_)) => "keyDown",
                ("keyDown", None) => "rawKeyDown",
                _ => "keyUp",
            };
            let mut p = json!({ "type": kind, "key": key, "code": code, "modifiers": mods });
            if let Some(vk) = key_code {
                p["windowsVirtualKeyCode"] = json!(vk);
                p["nativeVirtualKeyCode"] = json!(vk);
            }
            if let (Some(t), "keyDown") = (&text, kind) {
                p["text"] = json!(t);
                p["unmodifiedText"] = json!(t);
            }
            // Headless Chrome does not turn Cmd+A/Z on macOS into editing commands by itself.
            if kind == "rawKeyDown" && mods & META != 0 {
                let command = match key.to_lowercase().as_str() {
                    "a" => Some("selectAll"),
                    "z" if mods & 8 != 0 => Some("redo"),
                    "z" => Some("undo"),
                    _ => None,
                };
                if let Some(c) = command {
                    p["commands"] = json!([c]);
                }
            }
            vec![("Input.dispatchKeyEvent", p)]
        }
        InputEvent::Text { text } => vec![("Input.insertText", json!({ "text": text }))],
    }
}

struct Tab {
    id: u64,
    page: Arc<Page>,
    url: String,
    title: String,
    loading: bool,
}

#[derive(Default)]
struct ViewState {
    tabs: Vec<Tab>,
    active: Option<u64>,
    /// CSS size and device scale of the panel body.
    viewport: Option<(f64, f64, f64)>,
    visible: bool,
    frames: Option<Channel<Frame>>,
    /// The session the screencast runs on.
    casting: Option<String>,
}

pub struct View {
    label: String,
    browser: Browser,
    process: Mutex<Option<Chromium>>,
    state: Mutex<ViewState>,
    /// Tab → the isolated world a picker runs in, for cancelling it.
    pickers: Mutex<HashMap<u64, i64>>,
}

#[derive(Default)]
pub struct Engines {
    kinds: Mutex<HashMap<String, Kind>>,
    views: Mutex<HashMap<String, Arc<View>>>,
    /// Serialises the launch of a view's browser.
    launching: Mutex<()>,
}

fn tab_info(t: &Tab, active: Option<u64>) -> BrowserTabInfo {
    BrowserTabInfo { id: t.id, url: t.url.clone(), title: t.title.clone(), loading: t.loading, active: active == Some(t.id) }
}

fn app_chrome_dirs(app: &AppHandle) -> Vec<PathBuf> {
    // Chrome for Testing, once the app downloads it, lives here.
    app.path()
        .app_data_dir()
        .map(|d| vec![d.join("chromium/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")])
        .unwrap_or_default()
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// The engine of project view `label` (decided on first use, then fixed for the view).
pub fn kind(app: &AppHandle, label: &str) -> Kind {
    let engines = app.state::<Engines>();
    let mut kinds = engines.kinds.lock().unwrap();
    *kinds.entry(label.to_string()).or_insert_with(|| {
        let setting = crate::settings::load_settings(app).browser_engine;
        resolve(setting, find_chrome(home().as_deref(), &app_chrome_dirs(app)).is_some())
    })
}

pub fn is_chromium(app: &AppHandle, label: &str) -> bool {
    kind(app, label) == Kind::Chromium
}

/// The view's browser, started on first use.
fn view(app: &AppHandle, label: &str) -> Result<Arc<View>, String> {
    let engines = app.state::<Engines>();
    if let Some(v) = engines.views.lock().unwrap().get(label) {
        return Ok(v.clone());
    }
    let _launch = engines.launching.lock().unwrap();
    if let Some(v) = engines.views.lock().unwrap().get(label) {
        return Ok(v.clone());
    }
    let root = app.state::<PanelRoots>().get(label).ok_or("This project has no folder registered for the browser")?;
    let chrome = find_chrome(home().as_deref(), &app_chrome_dirs(app)).ok_or("No Chrome is installed")?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let process = Chromium::launch(&chrome, &profile_dir(&data, &root), true, LAUNCH_TIMEOUT)?;
    let browser = Browser::connect(&process.ws_url)?;
    let cdp = browser.cdp.clone();
    // The startup tab is not one of ours.
    if let Ok(t) = cdp.call(None, "Target.getTargets", json!({})) {
        for info in t.get("targetInfos").and_then(|x| x.as_array()).into_iter().flatten() {
            if info.get("type").and_then(|x| x.as_str()) == Some("page") {
                let _ = cdp.call(None, "Target.closeTarget", json!({ "targetId": info.get("targetId") }));
            }
        }
    }
    let events = cdp.subscribe();
    cdp.call(None, "Target.setDiscoverTargets", json!({ "discover": true }))?;
    let _ = cdp.call(None, "Browser.setDownloadBehavior", json!({ "behavior": "deny" }));
    let v = Arc::new(View { label: label.to_string(), browser, process: Mutex::new(Some(process)), state: Mutex::default(), pickers: Mutex::default() });
    engines.views.lock().unwrap().insert(label.to_string(), v.clone());
    let app2 = app.clone();
    let weak = Arc::downgrade(&v);
    std::thread::Builder::new()
        .name("chromium-view-events".into())
        .spawn(move || {
            while let Ok(ev) = events.recv() {
                let Some(v) = weak.upgrade() else { break };
                on_event(&app2, &v, &ev.method, ev.session.as_deref(), &ev.params);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(v)
}

fn emit_tab(app: &AppHandle, v: &View, id: u64) {
    let info = {
        let s = v.state.lock().unwrap();
        s.tabs.iter().find(|t| t.id == id).map(|t| tab_info(t, s.active))
    };
    if let Some(tab) = info {
        browser::emit_event(app, &v.label, BrowserEvent::Tab { tab });
    }
}

fn on_event(app: &AppHandle, v: &Arc<View>, method: &str, session: Option<&str>, p: &Value) {
    let target_of = |p: &Value| p.get("targetInfo").and_then(|t| t.get("targetId")).and_then(|t| t.as_str()).map(String::from);
    match method {
        "Target.targetInfoChanged" => {
            let Some(target) = target_of(p) else { return };
            let info = p.get("targetInfo").cloned().unwrap_or(Value::Null);
            let id = {
                let mut s = v.state.lock().unwrap();
                s.tabs.iter_mut().find(|t| t.page.target_id == target).map(|t| {
                    t.url = info.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();
                    t.title = info.get("title").and_then(|u| u.as_str()).unwrap_or("").to_string();
                    t.id
                })
            };
            if let Some(id) = id {
                emit_tab(app, v, id);
            }
        }
        "Target.targetCreated" => {
            // A popup or `target=_blank` from one of our tabs becomes a tab of its own.
            let info = p.get("targetInfo").cloned().unwrap_or(Value::Null);
            let opener = info.get("openerId").and_then(|o| o.as_str()).unwrap_or("");
            let ours = !opener.is_empty() && v.state.lock().unwrap().tabs.iter().any(|t| t.page.target_id == opener);
            if ours && info.get("type").and_then(|t| t.as_str()) == Some("page") {
                if let Some(target) = target_of(p) {
                    let (app, v) = (app.clone(), v.clone());
                    std::thread::spawn(move || {
                        if let Ok(page) = Page::attach(v.browser.cdp.clone(), target) {
                            let _ = adopt(&app, &v, page, true);
                        }
                    });
                }
            }
        }
        "Target.targetDestroyed" => {
            let Some(target) = p.get("targetId").and_then(|t| t.as_str()) else { return };
            let gone = {
                let mut s = v.state.lock().unwrap();
                let pos = s.tabs.iter().position(|t| t.page.target_id == target);
                pos.map(|i| {
                    let t = s.tabs.remove(i);
                    if s.active == Some(t.id) {
                        s.active = s.tabs.last().map(|t| t.id);
                    }
                    t.id
                })
            };
            if let Some(id) = gone {
                browser::emit_event(app, &v.label, BrowserEvent::Closed { id });
                refresh_screencast(v);
            }
        }
        "Page.frameStartedLoading" | "Page.frameStoppedLoading" => {
            let loading = method == "Page.frameStartedLoading";
            let frame = p.get("frameId").and_then(|f| f.as_str()).unwrap_or("");
            let id = {
                let mut s = v.state.lock().unwrap();
                s.tabs.iter_mut().find(|t| Some(t.page.session.as_str()) == session && t.page.target_id == frame).map(|t| {
                    t.loading = loading;
                    t.id
                })
            };
            if let Some(id) = id {
                emit_tab(app, v, id);
            }
        }
        "Page.screencastFrame" => {
            let ack = p.get("sessionId").cloned().unwrap_or(Value::Null);
            let Some(session) = session else { return };
            let _ = v.browser.cdp.call_within(Some(session), "Page.screencastFrameAck", json!({ "sessionId": ack }), Duration::from_secs(5));
            let s = v.state.lock().unwrap();
            if s.casting.as_deref() != Some(session) {
                return;
            }
            let (Some(ch), Some(tab)) = (&s.frames, s.tabs.iter().find(|t| t.page.session == session)) else { return };
            let meta = p.get("metadata").cloned().unwrap_or(Value::Null);
            let _ = ch.send(Frame {
                tab: tab.id,
                data: p.get("data").and_then(|d| d.as_str()).unwrap_or("").to_string(),
                width: meta.get("deviceWidth").and_then(|w| w.as_f64()).unwrap_or(0.0),
                height: meta.get("deviceHeight").and_then(|h| h.as_f64()).unwrap_or(0.0),
            });
        }
        _ => {}
    }
}

/// Size the page's viewport to the panel body.
fn apply_viewport(page: &Page, viewport: Option<(f64, f64, f64)>) {
    if let Some((w, h, scale)) = viewport {
        let _ = page.call(
            "Emulation.setDeviceMetricsOverride",
            json!({ "width": w.round() as i64, "height": h.round() as i64, "deviceScaleFactor": scale, "mobile": false }),
        );
    }
}

/// Run the screencast on the active tab while the panel shows it and has a canvas attached.
fn refresh_screencast(v: &View) {
    let (want, current, viewport) = {
        let s = v.state.lock().unwrap();
        let want = if s.visible && s.frames.is_some() { s.active.and_then(|a| s.tabs.iter().find(|t| t.id == a)).map(|t| t.page.clone()) } else { None };
        (want, s.casting.clone(), s.viewport)
    };
    let want_session = want.as_ref().map(|p| p.session.clone());
    if want_session == current {
        return;
    }
    if let Some(old) = &current {
        let _ = v.browser.cdp.call_within(Some(old), "Page.stopScreencast", json!({}), Duration::from_secs(5));
    }
    v.state.lock().unwrap().casting = want_session.clone();
    if let Some(page) = want {
        let (w, h, scale) = viewport.unwrap_or((1280.0, 800.0, 2.0));
        let _ = page.call(
            "Page.startScreencast",
            json!({ "format": "jpeg", "quality": 80, "maxWidth": (w * scale).round() as i64, "maxHeight": (h * scale).round() as i64, "everyNthFrame": 1 }),
        );
    }
}

/// Add an attached page as the view's new active tab.
fn adopt(app: &AppHandle, v: &Arc<View>, page: Arc<Page>, reveal: bool) -> Result<BrowserTabInfo, String> {
    let id = browser::next_tab_id(app);
    let viewport = v.state.lock().unwrap().viewport;
    apply_viewport(&page, viewport);
    let (url, title) = page.url_and_title();
    {
        let mut s = v.state.lock().unwrap();
        s.tabs.push(Tab { id, page, url, title, loading: false });
        s.active = Some(id);
    }
    refresh_screencast(v);
    emit_tab(app, v, id);
    if reveal {
        browser::emit_event(app, &v.label, BrowserEvent::Show { id });
    }
    let s = v.state.lock().unwrap();
    Ok(s.tabs.iter().find(|t| t.id == id).map(|t| tab_info(t, s.active)).expect("tab just added"))
}

/// The CDP connection of the view's browser (started if needed), for browser-wide calls.
pub fn browser_cdp(app: &AppHandle, label: &str) -> Result<Arc<super::cdp::Cdp>, String> {
    Ok(view(app, label)?.browser.cdp.clone())
}

/// Open a tab on `url` (already normalised and allowed).
pub fn open_tab(app: &AppHandle, label: &str, url: &str) -> Result<BrowserTabInfo, String> {
    let v = view(app, label)?;
    let page = v.browser.open_page()?;
    let info = adopt(app, &v, page.clone(), false)?;
    page.navigate(url)?;
    let (u, t) = page.url_and_title();
    {
        let mut s = v.state.lock().unwrap();
        if let Some(tab) = s.tabs.iter_mut().find(|x| x.id == info.id) {
            tab.url = u;
            tab.title = t;
        }
    }
    emit_tab(app, &v, info.id);
    Ok(list(app, label).into_iter().find(|x| x.id == info.id).unwrap_or(info))
}

/// The page of tab `id` (or the active tab).
pub fn page(app: &AppHandle, label: &str, id: Option<u64>) -> Result<(u64, Arc<Page>), String> {
    let v = view(app, label)?;
    let s = v.state.lock().unwrap();
    let id = id.or(s.active).ok_or("No browser tab is open; call browser_navigate first")?;
    s.tabs.iter().find(|t| t.id == id).map(|t| (t.id, t.page.clone())).ok_or_else(|| format!("No browser tab {id} in this project"))
}

pub fn list(app: &AppHandle, label: &str) -> Vec<BrowserTabInfo> {
    let Some(v) = app.state::<Engines>().views.lock().unwrap().get(label).cloned() else { return Vec::new() };
    let s = v.state.lock().unwrap();
    s.tabs.iter().map(|t| tab_info(t, s.active)).collect()
}

pub fn select(app: &AppHandle, label: &str, id: u64) -> Result<(), String> {
    let v = view(app, label)?;
    {
        let mut s = v.state.lock().unwrap();
        if !s.tabs.iter().any(|t| t.id == id) {
            return Err(format!("No browser tab {id} in this project"));
        }
        s.active = Some(id);
    }
    refresh_screencast(&v);
    Ok(())
}

/// Show the panel on tab `id` (the agent acted on it).
pub fn reveal(app: &AppHandle, label: &str, id: u64) {
    if select(app, label, id).is_ok() {
        browser::emit_event(app, label, BrowserEvent::Show { id });
    }
}

pub fn close_tab(app: &AppHandle, label: &str, id: u64) -> Result<(), String> {
    let (_, page) = page(app, label, Some(id))?;
    // `Target.targetDestroyed` removes it and tells the view.
    page.close();
    Ok(())
}

pub fn go(app: &AppHandle, label: &str, id: u64, action: &str) -> Result<(), String> {
    let (_, page) = page(app, label, Some(id))?;
    match action {
        "back" => page.history(-1),
        "forward" => page.history(1),
        "reload" => page.reload(),
        other => Err(format!("Unknown browser action {other}")),
    }
}

/// Where the panel body is: its size becomes the pages' viewport. `None` hides.
pub fn layout(app: &AppHandle, label: &str, bounds: Option<Bounds>, visible: bool, scale: f64) {
    let Some(v) = app.state::<Engines>().views.lock().unwrap().get(label).cloned() else { return };
    let (pages, changed) = {
        let mut s = v.state.lock().unwrap();
        s.visible = visible && bounds.is_some();
        let next = bounds.filter(|b| b.width >= 1.0 && b.height >= 1.0).map(|b| (b.width, b.height, scale.clamp(1.0, 3.0)));
        let changed = next.is_some() && next != s.viewport;
        if next.is_some() {
            s.viewport = next;
        }
        (s.tabs.iter().map(|t| t.page.clone()).collect::<Vec<_>>(), changed)
    };
    if changed {
        let viewport = v.state.lock().unwrap().viewport;
        for p in &pages {
            apply_viewport(p, viewport);
        }
        // Restart the screencast at the new size.
        let current = v.state.lock().unwrap().casting.take();
        if let Some(old) = current {
            let _ = v.browser.cdp.call_within(Some(&old), "Page.stopScreencast", json!({}), Duration::from_secs(5));
        }
    }
    refresh_screencast(&v);
}

/// The view's canvas wants frames on `channel` (replacing any earlier one).
pub fn attach_frames(app: &AppHandle, label: &str, channel: Channel<Frame>) -> Result<(), String> {
    let v = view(app, label)?;
    {
        let mut s = v.state.lock().unwrap();
        s.frames = Some(channel);
        s.casting = None;
    }
    refresh_screencast(&v);
    Ok(())
}

pub fn input(app: &AppHandle, label: &str, id: u64, ev: &InputEvent) -> Result<(), String> {
    let (_, page) = page(app, label, Some(id))?;
    for (method, params) in input_calls(ev) {
        page.call(method, params)?;
    }
    Ok(())
}

/// Wrap a script written as an async function body (`pick.js`) as an expression.
pub fn as_expression(body: &str) -> String {
    format!("(async () => {{\n{body}\n}})()")
}

/// Let the user pick an element on tab `id` with the panel's picker script, run in an isolated
/// world; a picked element gets a PNG of its visible part under `screenshot`.
pub fn pick(app: &AppHandle, label: &str, id: u64, script: &str, timeout: Duration) -> Result<Value, String> {
    let (_, page) = page(app, label, Some(id))?;
    let context = page.isolated_world("keryx-picker")?;
    let v = view(app, label)?;
    v.pickers.lock().unwrap().insert(id, context);
    let answer = page.evaluate_in(context, &as_expression(script), timeout);
    v.pickers.lock().unwrap().remove(&id);
    let text = answer?;
    let mut value: Value = serde_json::from_str(text.as_str().unwrap_or("")).map_err(|_| "The page returned no result".to_string())?;
    if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    if value.get("cancelled").is_some() {
        return Ok(value);
    }
    let clip = match (value.get("rect"), value.get("viewport")) {
        (Some(r), Some(vp)) => browser::visible_rect(r, vp),
        _ => None,
    };
    if let Some((x, y, w, h)) = clip {
        std::thread::sleep(Duration::from_millis(60));
        if let Ok(path) = page
            .screenshot(&super::page::Shot::Clip(x, y, w, h), "png")
            .and_then(|png| browser::save_png(&format!("pick-{id}"), &png))
        {
            value["screenshot"] = Value::String(path.to_string_lossy().into_owned());
        }
    }
    Ok(value)
}

/// Stop a running picker on tab `id`; its `pick` answers `{cancelled: true}`.
pub fn pick_cancel(app: &AppHandle, label: &str, id: u64, cancel_body: &str) -> Result<(), String> {
    let (_, page) = page(app, label, Some(id))?;
    let context = view(app, label)?.pickers.lock().unwrap().get(&id).copied();
    if let Some(context) = context {
        page.evaluate_in(context, &format!("(() => {{ {cancel_body} }})()"), Duration::from_secs(5))?;
    }
    Ok(())
}

/// Stop the view's browser (the project view is closing).
pub fn close_view(app: &AppHandle, label: &str) {
    let engines = app.state::<Engines>();
    engines.kinds.lock().unwrap().remove(label);
    let v = engines.views.lock().unwrap().remove(label);
    if let Some(v) = v {
        if let Some(mut p) = v.process.lock().unwrap().take() {
            std::thread::spawn(move || p.stop());
        }
    }
}

/// Stop every browser (the app is quitting).
pub fn close_all(app: &AppHandle) {
    let labels: Vec<String> = app.state::<Engines>().views.lock().unwrap().keys().cloned().collect();
    for l in labels {
        close_view(app, &l);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_uses_chromium_only_when_chrome_is_there() {
        assert_eq!(resolve(EngineSetting::Auto, true), Kind::Chromium);
        assert_eq!(resolve(EngineSetting::Auto, false), Kind::Webkit);
        assert_eq!(resolve(EngineSetting::Chromium, false), Kind::Webkit);
        assert_eq!(resolve(EngineSetting::Webkit, true), Kind::Webkit);
    }

    #[test]
    fn canvas_input_becomes_cdp_input() {
        let click: InputEvent = serde_json::from_value(json!({ "kind": "mouse", "type": "mousePressed", "x": 10.0, "y": 20.0 })).unwrap();
        assert_eq!(
            input_calls(&click),
            vec![("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": 10.0, "y": 20.0, "button": "left", "clickCount": 1, "modifiers": 0 }))]
        );
        let mv: InputEvent = serde_json::from_value(json!({ "kind": "mouse", "type": "mouseMoved", "x": 1.0, "y": 2.0 })).unwrap();
        assert_eq!(input_calls(&mv)[0].1["button"], "none");

        let a: InputEvent = serde_json::from_value(json!({ "kind": "key", "type": "keyDown", "key": "a", "code": "KeyA", "text": "a", "keyCode": 65 })).unwrap();
        let p = &input_calls(&a)[0].1;
        assert_eq!((p["type"].as_str(), p["text"].as_str(), p["windowsVirtualKeyCode"].as_i64()), (Some("keyDown"), Some("a"), Some(65)));

        let enter: InputEvent = serde_json::from_value(json!({ "kind": "key", "type": "keyDown", "key": "Enter", "code": "Enter", "text": "\r", "keyCode": 13 })).unwrap();
        assert_eq!(input_calls(&enter)[0].1["text"], "\r");

        let arrow: InputEvent = serde_json::from_value(json!({ "kind": "key", "type": "keyDown", "key": "ArrowLeft", "code": "ArrowLeft", "keyCode": 37 })).unwrap();
        assert_eq!(input_calls(&arrow)[0].1["type"], "rawKeyDown");

        let select_all: InputEvent = serde_json::from_value(json!({ "kind": "key", "type": "keyDown", "key": "a", "code": "KeyA", "text": "a", "modifiers": 4 })).unwrap();
        let p = &input_calls(&select_all)[0].1;
        assert_eq!(p["type"], "rawKeyDown");
        assert_eq!(p["commands"], json!(["selectAll"]));
        assert!(p.get("text").is_none());

        let wheel: InputEvent = serde_json::from_value(json!({ "kind": "wheel", "x": 5.0, "y": 6.0, "dx": 0.0, "dy": 120.0 })).unwrap();
        assert_eq!(input_calls(&wheel)[0].1["type"], "mouseWheel");

        let paste: InputEvent = serde_json::from_value(json!({ "kind": "text", "text": "hello" })).unwrap();
        assert_eq!(input_calls(&paste), vec![("Input.insertText", json!({ "text": "hello" }))]);
    }
}
