//! Browser tabs of the side panel (D-13): each tab is a child WKWebView of the
//! host window, owned by one project view (see `projects`) and laid over the
//! panel's body by that view's page (`browser_layout`). Tabs are keyed by the
//! project view's label; they show only while their project view is the one in
//! front of its window, and sit above it (added after it).
//!
//! Pages are untrusted. They load only over `http`/`https`, open no windows,
//! download nothing, and reach no app command: Tauri refuses every custom
//! command to a remote origin unless a capability names it, and ours name none.
//! The dev server's origin is the one `http` origin Tauri treats as the app's
//! own, so a debug build refuses it here.
//!
//! Storage is per project on macOS 14+ (`data_store_identifier`); below that
//! the only alternative is the app's own default store, so tabs run
//! non-persistent there.

use crate::panels::PanelRoots;
use crate::projects::ProjectWindows;
use crate::chromium::engine;
use crate::webkit::{self, World};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl, Window};

pub const LOAD_TIMEOUT: Duration = Duration::from_secs(20);

/// Logical pixels in the app page's own coordinates (its content area).
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabInfo {
    pub id: u64,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub active: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BrowserEvent {
    /// A tab opened or changed (URL, title, loading).
    Tab { tab: BrowserTabInfo },
    Closed { id: u64 },
    /// The agent acted on the browser: show the panel on this tab.
    Show { id: u64 },
}

#[derive(Default)]
struct Load {
    loading: bool,
    /// Finished loads so far.
    finished: u64,
    url: String,
    title: String,
}

pub struct BrowserTab {
    pub id: u64,
    pub window: String,
    pub label: String,
    load: Mutex<Load>,
    changed: Condvar,
}

#[derive(Default)]
struct WindowTabs {
    tabs: Vec<Arc<BrowserTab>>,
    active: Option<u64>,
    bounds: Option<Bounds>,
    visible: bool,
    /// The panel page's device pixel ratio (the Chromium engine renders at it).
    scale: f64,
    /// Newest `browser_layout` call applied (calls may arrive out of order).
    layout_seq: u64,
}

#[derive(Default)]
pub struct Browsers {
    windows: Mutex<HashMap<String, WindowTabs>>,
    next: AtomicU64,
}

/// What the URL bar or the agent typed, as a URL a tab may load.
/// `localhost:3000` and bare hosts with a port get `http`; other bare hosts `https`.
pub fn normalize_url(input: &str) -> Result<Url, String> {
    let t = input.trim();
    if t.is_empty() {
        return Err("Type an address".into());
    }
    let candidate = if t.contains("://") || t == "about:blank" {
        t.to_string()
    } else {
        let host = t.split(['/', '?', '#']).next().unwrap_or("");
        let local = host.starts_with("localhost")
            || host.starts_with("127.")
            || host.starts_with("[::1]")
            || host.starts_with("0.0.0.0")
            || host.ends_with(".localhost")
            || host.split(':').next().is_some_and(|h| h.ends_with(".localhost") || h.ends_with(".test"));
        if t.contains(char::is_whitespace) || (!host.contains('.') && !host.contains(':') && !local) {
            return Err(format!("{t:?} is not an address"));
        }
        format!("{}://{t}", if local || host.contains(':') { "http" } else { "https" })
    };
    let url = Url::parse(&candidate).map_err(|e| format!("{t:?} is not an address: {e}"))?;
    if !allowed_scheme(&url) {
        return Err(format!("The browser panel opens http and https pages only, not {}:", url.scheme()));
    }
    Ok(url)
}

fn allowed_scheme(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank"
}

/// Whether a tab may navigate to `url`: http(s), never the app's dev server origin.
pub fn page_allowed(url: &Url, dev_url: Option<&Url>) -> bool {
    allowed_scheme(url) && !dev_url.is_some_and(|d| d.origin() == url.origin())
}

/// A stable 16-byte id for the project's website data store (FNV-1a, 128-bit).
pub fn store_id(project: &Path) -> [u8; 16] {
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013B;
    let mut h = OFFSET;
    for b in b"keryx-browser:".iter().chain(project.to_string_lossy().as_bytes()) {
        h ^= *b as u128;
        h = h.wrapping_mul(PRIME);
    }
    h.to_be_bytes()
}

impl Browsers {
    fn with_window<T>(&self, window: &str, f: impl FnOnce(&mut WindowTabs) -> T) -> T {
        f(self.windows.lock().unwrap().entry(window.to_string()).or_default())
    }

    pub fn tab(&self, window: &str, id: Option<u64>) -> Result<Arc<BrowserTab>, String> {
        self.with_window(window, |w| {
            let id = id.or(w.active);
            w.tabs.iter().find(|t| Some(t.id) == id).cloned()
        })
        .ok_or_else(|| match id {
            Some(id) => format!("No browser tab {id} in this window"),
            None => "No browser tab is open; call browser_navigate first".into(),
        })
    }

    pub fn list(&self, window: &str) -> Vec<BrowserTabInfo> {
        self.with_window(window, |w| w.tabs.iter().map(|t| info(t, w.active)).collect())
    }

    pub fn info(&self, window: &str, id: u64) -> Option<BrowserTabInfo> {
        self.with_window(window, |w| w.tabs.iter().find(|t| t.id == id).map(|t| info(t, w.active)))
    }

    pub fn forget_window(&self, window: &str) {
        self.windows.lock().unwrap().remove(window);
    }
}

fn info(t: &BrowserTab, active: Option<u64>) -> BrowserTabInfo {
    let load = t.load.lock().unwrap();
    BrowserTabInfo { id: t.id, url: load.url.clone(), title: load.title.clone(), loading: load.loading, active: active == Some(t.id) }
}

fn emit(app: &AppHandle, window: &str, event: BrowserEvent) {
    let _ = app.emit_to(window, "panel://browser", event);
}

/// Send a browser event to project view `window` (the Chromium engine's tabs use it too).
pub fn emit_event(app: &AppHandle, window: &str, event: BrowserEvent) {
    emit(app, window, event);
}

/// A new tab id, unique across both engines.
pub fn next_tab_id(app: &AppHandle) -> u64 {
    app.state::<Browsers>().next.fetch_add(1, Ordering::SeqCst) + 1
}

fn emit_tab(app: &AppHandle, window: &str, id: u64) {
    if let Some(tab) = app.state::<Browsers>().info(window, id) {
        emit(app, window, BrowserEvent::Tab { tab });
    }
}

fn webview(app: &AppHandle, tab: &BrowserTab) -> Result<Webview, String> {
    app.get_webview(&tab.label).ok_or_else(|| format!("Browser tab {} is gone", tab.id))
}

/// Show the active tab over the panel body, hide every other one; hide them all while the owning
/// project view (`window`) is not the one in front of its window.
pub fn apply_layout(app: &AppHandle, window: &str) {
    let (tabs, active, bounds, visible, scale) = app
        .state::<Browsers>()
        .with_window(window, |w| (w.tabs.clone(), w.active, w.bounds, w.visible, w.scale));
    let visible = visible && app.state::<ProjectWindows>().is_front(window);
    if engine::is_chromium(app, window) {
        // The page is drawn by the panel itself (a screencast); only its size and visibility matter.
        let (app, window) = (app.clone(), window.to_string());
        std::thread::spawn(move || engine::layout(&app, &window, bounds, visible, if scale > 0.0 { scale } else { 2.0 }));
        return;
    }
    // The project view fills its host window from (0, 0) and the tabs are its siblings there, so
    // the page's own coordinates are the tabs' coordinates.
    for t in tabs {
        let Some(wv) = app.get_webview(&t.label) else { continue };
        match (visible && active == Some(t.id), bounds) {
            (true, Some(b)) if b.width >= 1.0 && b.height >= 1.0 => {
                let _ = wv.set_position(LogicalPosition::new(b.x, b.y));
                let _ = wv.set_size(LogicalSize::new(b.width, b.height));
                let _ = wv.show();
            }
            _ => {
                let _ = wv.hide();
            }
        }
    }
}

/// Move every tab of project view `owner` into `window` (the view moved there), in tab order so
/// they stay above the view.
pub fn reparent_tabs(app: &AppHandle, owner: &str, window: &Window) {
    let tabs = app.state::<Browsers>().with_window(owner, |w| w.tabs.clone());
    for t in tabs {
        if let Some(wv) = app.get_webview(&t.label) {
            let _ = wv.reparent(window);
        }
    }
}

/// Close every tab of a project view (the view is closing).
pub fn close_window(app: &AppHandle, window: &str) {
    engine::close_view(app, window);
    let tabs = app.state::<Browsers>().with_window(window, |w| std::mem::take(&mut w.tabs));
    for t in tabs {
        if let Some(wv) = app.get_webview(&t.label) {
            let _ = wv.close();
        }
    }
    app.state::<Browsers>().forget_window(window);
}

const CONSOLE_SHIM: &str = r#"(() => {
  if (window.__keryxConsole) return;
  const buf = [];
  Object.defineProperty(window, "__keryxConsole", { value: buf, enumerable: false });
  const text = (args) => Array.from(args).map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || String(a);
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ").slice(0, 2000);
  const push = (level, args) => {
    try { buf.push({ level, text: text(args), time: Date.now() }); if (buf.length > 500) buf.splice(0, buf.length - 500); } catch {}
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level];
    console[level] = function (...args) { push(level, args); return orig.apply(this, args); };
  }
  addEventListener("error", (e) => push("error", [e.message + (e.filename ? ` (${e.filename}:${e.lineno})` : "")]));
  addEventListener("unhandledrejection", (e) => push("error", ["Unhandled rejection: " + ((e.reason && e.reason.stack) || e.reason)]));
})();"#;

/// Open a tab on `url` for project view `owner` and make it the active one.
pub fn open_tab(app: &AppHandle, owner: &Webview, url: Url) -> Result<BrowserTabInfo, String> {
    let label = owner.label().to_string();
    let root = app.state::<PanelRoots>().get(&label);
    let id = app.state::<Browsers>().next.fetch_add(1, Ordering::SeqCst) + 1;
    let wv_label = format!("{label}-browser-{id}");
    let dev = crate::navigation::dev_url(app);
    let tab = Arc::new(BrowserTab {
        id,
        window: label.clone(),
        label: wv_label.clone(),
        load: Mutex::new(Load { url: url.to_string(), ..Default::default() }),
        changed: Condvar::new(),
    });

    let nav_dev = dev.clone();
    let new_win_app = app.clone();
    let new_win_label = wv_label.clone();
    let new_win_dev = dev.clone();
    let load_app = app.clone();
    let load_tab = tab.clone();
    let title_app = app.clone();
    let title_tab = tab.clone();
    let mut builder = WebviewBuilder::new(&wv_label, WebviewUrl::External(url))
        .on_navigation(move |u| page_allowed(u, nav_dev.as_ref()))
        .on_new_window(move |u, _| {
            // A link that wants a new window opens in the same tab instead.
            if page_allowed(&u, new_win_dev.as_ref()) {
                let app = new_win_app.clone();
                let label = new_win_label.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(wv) = app.get_webview(&label) {
                        let _ = wv.navigate(u);
                    }
                });
            }
            NewWindowResponse::Deny
        })
        .on_download(|_, _| false)
        .on_page_load(move |_, payload| {
            {
                let mut load = load_tab.load.lock().unwrap();
                load.url = payload.url().to_string();
                match payload.event() {
                    PageLoadEvent::Started => load.loading = true,
                    PageLoadEvent::Finished => {
                        load.loading = false;
                        load.finished += 1;
                    }
                }
            }
            load_tab.changed.notify_all();
            emit_tab(&load_app, &load_tab.window, load_tab.id);
        })
        .on_document_title_changed(move |_, title| {
            title_tab.load.lock().unwrap().title = title;
            emit_tab(&title_app, &title_tab.window, title_tab.id);
        })
        .initialization_script(CONSOLE_SHIM)
        .devtools(cfg!(debug_assertions));
    builder = match root {
        Some(root) if webkit::macos_major() >= 14 => builder.data_store_identifier(store_id(&root)),
        _ => builder.incognito(true),
    };

    let bounds = app.state::<Browsers>().with_window(&label, |w| w.bounds);
    let (pos, size) = match bounds {
        Some(b) => (LogicalPosition::new(b.x, b.y), LogicalSize::new(b.width.max(1.0), b.height.max(1.0))),
        None => (LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)),
    };
    // Registered first: the page's first load and title events may arrive before `add_child` returns.
    let previous = app.state::<Browsers>().with_window(&label, |w| {
        w.tabs.push(tab.clone());
        w.active.replace(id)
    });
    if let Err(e) = owner.window().add_child(builder, pos, size) {
        app.state::<Browsers>().with_window(&label, |w| {
            w.tabs.retain(|t| t.id != id);
            w.active = previous;
        });
        return Err(format!("Could not open a browser tab: {e}"));
    }
    apply_layout(app, &label);
    let info = app.state::<Browsers>().info(&label, id).expect("tab just added");
    emit(app, &label, BrowserEvent::Tab { tab: info.clone() });
    Ok(info)
}

pub fn select(app: &AppHandle, window: &str, id: u64) -> Result<(), String> {
    app.state::<Browsers>().tab(window, Some(id))?;
    app.state::<Browsers>().with_window(window, |w| w.active = Some(id));
    apply_layout(app, window);
    Ok(())
}

pub fn navigate(app: &AppHandle, tab: &BrowserTab, url: Url) -> Result<(), String> {
    if !page_allowed(&url, crate::navigation::dev_url(app).as_ref()) {
        return Err(format!("The browser panel does not open {url}"));
    }
    webview(app, tab)?.navigate(url).map_err(|e| e.to_string())
}

pub fn close_tab(app: &AppHandle, window: &str, id: u64) -> Result<(), String> {
    let tab = app.state::<Browsers>().with_window(window, |w| {
        let pos = w.tabs.iter().position(|t| t.id == id)?;
        let tab = w.tabs.remove(pos);
        if w.active == Some(id) {
            w.active = w.tabs.last().map(|t| t.id);
        }
        Some(tab)
    });
    let tab = tab.ok_or_else(|| format!("No browser tab {id} in this window"))?;
    if let Some(wv) = app.get_webview(&tab.label) {
        let _ = wv.close();
    }
    emit(app, window, BrowserEvent::Closed { id });
    apply_layout(app, window);
    Ok(())
}

/// Ask the window to show the panel on `id` (the agent acted on it).
pub fn reveal(app: &AppHandle, window: &str, id: u64) {
    let _ = select(app, window, id);
    emit(app, window, BrowserEvent::Show { id });
}

// ---- agent helpers (client content world: shares the DOM, not the page's globals) ----

const SNAPSHOT_JS: &str = r#"
const S = (globalThis.__kx ??= { refs: new Map(), n: 0 });
S.refs.clear(); S.n = 0;
const out = []; let size = 0; const MAX = 60000;
const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick]';
const interactive = (el) => el.matches(SEL) && el.type !== "hidden";
const visible = (el) => {
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0 || el.children.length > 0;
};
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const name = (el) => {
  const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder")
    || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText
    || (el.tagName === "INPUT" && /^(submit|button|reset)$/.test(el.type) ? el.value : "");
  return clean(label).slice(0, 120);
};
const role = (el) => {
  const r = el.getAttribute("role"); if (r) return r;
  const t = el.tagName.toLowerCase();
  if (t === "a") return "link";
  if (t === "button" || t === "summary") return "button";
  if (t === "select") return "combobox";
  if (t === "textarea") return "textbox";
  if (t === "input") { const ty = el.type || "text"; if (ty === "checkbox" || ty === "radio") return ty; if (/^(submit|button|reset|image)$/.test(ty)) return "button"; return "textbox"; }
  if (el.isContentEditable) return "textbox";
  return t;
};
const push = (d, l) => { const s = "  ".repeat(Math.min(d, 12)) + l; out.push(s); size += s.length + 1; };
const walk = (node, d) => {
  for (const c of node.childNodes) {
    if (size > MAX) return;
    if (c.nodeType === 3) { const t = clean(c.textContent); if (t) push(d, JSON.stringify(t.slice(0, 300))); continue; }
    if (c.nodeType !== 1) continue;
    const el = c, tag = el.tagName;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|SVG|HEAD)$/.test(tag) || !visible(el)) continue;
    if (interactive(el)) {
      const ref = "e" + (++S.n); S.refs.set(ref, new WeakRef(el));
      let line = `${role(el)} ${JSON.stringify(name(el))} [ref=${ref}]`;
      if (el.type === "password") line += " [password]";
      else if ((tag === "INPUT" || tag === "TEXTAREA") && !/^(checkbox|radio|submit|button|reset)$/.test(el.type) && el.value) line += ` value=${JSON.stringify(el.value.slice(0, 120))}`;
      if (tag === "SELECT" && el.selectedOptions[0]) line += ` selected=${JSON.stringify(clean(el.selectedOptions[0].text).slice(0, 80))}`;
      if (el.checked) line += " [checked]";
      if (el.disabled) line += " [disabled]";
      if (tag === "A") line += ` href=${JSON.stringify((el.getAttribute("href") || "").slice(0, 200))}`;
      push(d, line);
      if (!/^(A|BUTTON|SELECT|INPUT|TEXTAREA|SUMMARY)$/.test(tag)) walk(el, d + 1);
      continue;
    }
    if (/^H[1-6]$/.test(tag)) { push(d, `heading ${JSON.stringify(clean(el.innerText).slice(0, 200))}`); continue; }
    if (tag === "IMG") { const a = el.getAttribute("alt"); if (a) push(d, `img ${JSON.stringify(a.slice(0, 120))}`); continue; }
    if (tag === "IFRAME") { push(d, "iframe (contents not read)"); continue; }
    walk(el, d);
  }
};
walk(document.body || document.documentElement, 0);
return JSON.stringify({ url: location.href, title: document.title, snapshot: out.join("\n"), truncated: size > MAX });
"#;

fn element_js(reference: &str, action: &str) -> String {
    let r = serde_json::to_string(reference).unwrap_or_default();
    format!(
        r#"const S = globalThis.__kx; const w = S && S.refs.get({r}); const el = w && w.deref();
if (!el || !el.isConnected) return JSON.stringify({{ error: "Unknown or stale ref " + {r} + "; take a new browser_snapshot" }});
el.scrollIntoView({{ block: "center", inline: "center" }});
{action}"#
    )
}

pub fn snapshot_js() -> String {
    SNAPSHOT_JS.to_string()
}

pub fn click_js(reference: &str) -> String {
    element_js(
        reference,
        r#"if (el.focus) el.focus({ preventScroll: true });
el.click();
return JSON.stringify({ ok: true });"#,
    )
}

pub fn type_js(reference: &str, text: &str, submit: bool) -> String {
    let t = serde_json::to_string(text).unwrap_or_default();
    element_js(
        reference,
        &format!(
            r#"if (el.type === "password") return JSON.stringify({{ error: "The agent does not type into password fields" }});
el.focus({{ preventScroll: true }});
if (el.isContentEditable) {{
  el.textContent = {t};
  el.dispatchEvent(new InputEvent("input", {{ bubbles: true }}));
}} else if ("value" in el) {{
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, {t});
  el.dispatchEvent(new Event("input", {{ bubbles: true }}));
  el.dispatchEvent(new Event("change", {{ bubbles: true }}));
}} else return JSON.stringify({{ error: "This element does not take text" }});
if ({submit}) {{
  if (el.form && el.form.requestSubmit) el.form.requestSubmit();
  else for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, {{ key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }}));
}}
return JSON.stringify({{ ok: true }});"#
        ),
    )
}

pub fn console_js(limit: usize) -> String {
    format!("return JSON.stringify((window.__keryxConsole || []).slice(-{limit}));")
}

/// Run `body` in the tab's page and parse its JSON answer; an `{error}` answer becomes `Err`.
pub fn run_js(app: &AppHandle, tab: &BrowserTab, body: String, world: World) -> Result<serde_json::Value, String> {
    let wv = webview(app, tab)?;
    let text = webkit::call_js(&wv, body, world)?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "The page returned no result".to_string())?;
    if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    Ok(value)
}

/// Wait until the page has finished loading: `document.readyState` is
/// `complete` after a short settle (a navigation that just started still
/// reports the old document for a moment). Page-load callbacks are not relied
/// on: WebKit does not report every finished navigation to them.
pub fn wait_ready(app: &AppHandle, tab: &BrowserTab, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    std::thread::sleep(Duration::from_millis(300));
    while Instant::now() < deadline {
        if let Ok(v) = run_js(app, tab, r#"return JSON.stringify({ state: document.readyState });"#.into(), World::Client) {
            if v.get("state").and_then(|s| s.as_str()) == Some("complete") {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

pub fn screenshot(app: &AppHandle, tab: &BrowserTab) -> Result<Vec<u8>, String> {
    webkit::snapshot_png(&webview(app, tab)?)
}

pub fn go(app: &AppHandle, tab: &BrowserTab, forward: bool) -> Result<(), String> {
    webkit::go(&webview(app, tab)?, forward)
}

// ---- the element picker (the user hands page elements to the agent as context) ----

/// The picker script (`pick.js`): runs in the client content world until the user clicks or cancels.
const PICK_JS: &str = include_str!("pick.js");
/// How long a picker waits for the user before it gives up.
pub const PICK_TIMEOUT: Duration = Duration::from_secs(600);
const PICK_CANCEL_JS: &str = "if (globalThis.__kxPick) globalThis.__kxPick.cancel(); return JSON.stringify({ ok: true });";

/// The part of a picked element's box that is on screen, in the page's viewport coordinates.
pub fn visible_rect(rect: &serde_json::Value, viewport: &serde_json::Value) -> Option<(f64, f64, f64, f64)> {
    let n = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_f64());
    let (x, y, w, h) = (n(rect, "x")?, n(rect, "y")?, n(rect, "width")?, n(rect, "height")?);
    let (vw, vh) = (n(viewport, "width")?, n(viewport, "height")?);
    let (left, top) = (x.max(0.0), y.max(0.0));
    let (right, bottom) = ((x + w).min(vw), (y + h).min(vh));
    (right - left >= 1.0 && bottom - top >= 1.0).then_some((left, top, right - left, bottom - top))
}

pub fn save_png(name: &str, png: &[u8]) -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join("keryx-panel-screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("{name}-{stamp}.png"));
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Let the user pick an element of the tab's page; `{cancelled: true}` when they do not. A picked
/// element comes back described (`pick.js`) with a PNG of its visible part under `screenshot`.
pub fn pick(app: &AppHandle, tab: &BrowserTab) -> Result<serde_json::Value, String> {
    let wv = webview(app, tab)?;
    let text = webkit::call_js_within(&wv, PICK_JS.to_string(), World::Client, PICK_TIMEOUT).inspect_err(|_| {
        let _ = webkit::call_js(&wv, PICK_CANCEL_JS.to_string(), World::Client);
    })?;
    let mut value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "The page returned no result".to_string())?;
    if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    if value.get("cancelled").is_some() {
        return Ok(value);
    }
    let clip = match (value.get("rect"), value.get("viewport")) {
        (Some(r), Some(v)) => visible_rect(r, v),
        _ => None,
    };
    if let Some((x, y, w, h)) = clip {
        // The overlay is gone by the time the script answers; give WebKit a frame to repaint without it.
        std::thread::sleep(Duration::from_millis(60));
        if let Ok(path) = webkit::snapshot_png_rect(&wv, x, y, w, h).and_then(|png| save_png(&format!("pick-{}", tab.id), &png)) {
            value["screenshot"] = serde_json::Value::String(path.to_string_lossy().into_owned());
        }
    }
    Ok(value)
}

// ---- commands (async: `add_child` and WebKit calls wait on the main thread) ----

#[tauri::command]
pub async fn browser_open(app: AppHandle, view: Webview, cwd: String, url: String) -> Result<BrowserTabInfo, String> {
    app.state::<PanelRoots>().set(view.label(), crate::panels::project_dir(&cwd)?);
    let url = normalize_url(&url)?;
    if !page_allowed(&url, crate::navigation::dev_url(&app).as_ref()) {
        return Err(format!("The browser panel does not open {url}"));
    }
    if engine::is_chromium(&app, view.label()) {
        let label = view.label().to_string();
        return blocking(move || engine::open_tab(&app, &label, url.as_str())).await;
    }
    open_tab(&app, &view, url)
}

/// Run blocking engine work off the async workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, view: Webview, id: u64, url: String) -> Result<(), String> {
    if engine::is_chromium(&app, view.label()) {
        let url = normalize_url(&url)?;
        if !page_allowed(&url, crate::navigation::dev_url(&app).as_ref()) {
            return Err(format!("The browser panel does not open {url}"));
        }
        let label = view.label().to_string();
        return blocking(move || engine::page(&app, &label, Some(id))?.1.navigate(url.as_str())).await;
    }
    let tab = app.state::<Browsers>().tab(view.label(), Some(id))?;
    navigate(&app, &tab, normalize_url(&url)?)
}

#[tauri::command]
pub async fn browser_go(app: AppHandle, view: Webview, id: u64, action: String) -> Result<(), String> {
    if engine::is_chromium(&app, view.label()) {
        let label = view.label().to_string();
        return blocking(move || engine::go(&app, &label, id, &action)).await;
    }
    let tab = app.state::<Browsers>().tab(view.label(), Some(id))?;
    match action.as_str() {
        "back" => go(&app, &tab, false),
        "forward" => go(&app, &tab, true),
        "reload" => webview(&app, &tab)?.reload().map_err(|e| e.to_string()),
        other => Err(format!("Unknown browser action {other}")),
    }
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, view: Webview, id: u64) -> Result<(), String> {
    if engine::is_chromium(&app, view.label()) {
        let label = view.label().to_string();
        return blocking(move || engine::close_tab(&app, &label, id)).await;
    }
    close_tab(&app, view.label(), id)
}

#[tauri::command]
pub async fn browser_select(app: AppHandle, view: Webview, id: u64) -> Result<(), String> {
    if engine::is_chromium(&app, view.label()) {
        let label = view.label().to_string();
        return blocking(move || engine::select(&app, &label, id)).await;
    }
    select(&app, view.label(), id)
}

/// Where the panel body is and whether the browser is showing; `None` bounds hide every tab.
#[tauri::command]
pub async fn browser_layout(
    app: AppHandle,
    view: Webview,
    bounds: Option<Bounds>,
    visible: bool,
    seq: u64,
    scale: Option<f64>,
) -> Result<(), String> {
    let fresh = app.state::<Browsers>().with_window(view.label(), |w| {
        if seq < w.layout_seq {
            return false;
        }
        w.layout_seq = seq;
        if let Some(s) = scale {
            w.scale = s;
        }
        if bounds.is_some() {
            w.bounds = bounds;
        }
        w.visible = visible && bounds.is_some();
        true
    });
    if fresh {
        apply_layout(&app, view.label());
    }
    Ok(())
}

/// Pick an element on tab `id` (blocks until the user clicks it or cancels).
#[tauri::command]
pub async fn browser_pick(app: AppHandle, view: Webview, id: u64) -> Result<serde_json::Value, String> {
    if engine::is_chromium(&app, view.label()) {
        let label = view.label().to_string();
        return blocking(move || engine::pick(&app, &label, id, PICK_JS, PICK_TIMEOUT)).await;
    }
    let tab = app.state::<Browsers>().tab(view.label(), Some(id))?;
    tauri::async_runtime::spawn_blocking(move || pick(&app, &tab)).await.map_err(|e| e.to_string())?
}

/// Stop a running picker on tab `id`; its `browser_pick` answers `{cancelled: true}`.
#[tauri::command]
pub async fn browser_pick_cancel(app: AppHandle, view: Webview, id: u64) -> Result<(), String> {
    if engine::is_chromium(&app, view.label()) {
        let label = view.label().to_string();
        return blocking(move || engine::pick_cancel(&app, &label, id, PICK_CANCEL_JS)).await;
    }
    let tab = app.state::<Browsers>().tab(view.label(), Some(id))?;
    tauri::async_runtime::spawn_blocking(move || run_js(&app, &tab, PICK_CANCEL_JS.to_string(), World::Client).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn browser_list(app: AppHandle, view: Webview) -> Vec<BrowserTabInfo> {
    if engine::is_chromium(&app, view.label()) {
        return engine::list(&app, view.label());
    }
    app.state::<Browsers>().list(view.label())
}

/// Which engine this project view's browser uses (`webkit` or `chromium`).
#[tauri::command]
pub fn browser_engine(app: AppHandle, view: Webview) -> engine::Kind {
    engine::kind(&app, view.label())
}

/// The Chromium engine's screencast of the active tab, for the panel's canvas.
#[tauri::command]
pub async fn browser_frames(app: AppHandle, view: Webview, on_frame: tauri::ipc::Channel<engine::Frame>) -> Result<(), String> {
    let label = view.label().to_string();
    blocking(move || engine::attach_frames(&app, &label, on_frame)).await
}

/// The user's mouse, wheel and keys on the panel's canvas (Chromium engine).
#[tauri::command]
pub async fn browser_input(app: AppHandle, view: Webview, id: u64, event: engine::InputEvent) -> Result<(), String> {
    let label = view.label().to_string();
    blocking(move || engine::input(&app, &label, id, &event)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_get_a_scheme_and_only_http_loads() {
        assert_eq!(normalize_url("localhost:3000").unwrap().as_str(), "http://localhost:3000/");
        assert_eq!(normalize_url("127.0.0.1:5173/app").unwrap().as_str(), "http://127.0.0.1:5173/app");
        assert_eq!(normalize_url("example.com").unwrap().as_str(), "https://example.com/");
        assert_eq!(normalize_url("dev.test:8080").unwrap().as_str(), "http://dev.test:8080/");
        assert_eq!(normalize_url(" https://a.b/c ").unwrap().as_str(), "https://a.b/c");
        assert!(normalize_url("about:blank").is_ok());
        for bad in ["file:///etc/passwd", "tauri://localhost/", "javascript:alert(1)", "data:text/html,x", "hello world", "", "foo"] {
            assert!(normalize_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_dev_server_origin_and_other_schemes_are_refused_as_pages() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        assert!(!page_allowed(&Url::parse("http://localhost:1420/x").unwrap(), Some(&dev)));
        assert!(page_allowed(&Url::parse("http://localhost:3000/").unwrap(), Some(&dev)));
        assert!(!page_allowed(&Url::parse("file:///tmp/a.html").unwrap(), None));
        assert!(!page_allowed(&Url::parse("tauri://localhost/").unwrap(), None));
        assert!(page_allowed(&Url::parse("about:blank").unwrap(), None));
    }

    #[test]
    fn store_ids_are_stable_and_differ_per_project() {
        let a = store_id(Path::new("/Users/me/a"));
        assert_eq!(a, store_id(Path::new("/Users/me/a")));
        assert_ne!(a, store_id(Path::new("/Users/me/b")));
    }

    #[test]
    fn a_pick_screenshot_covers_only_the_visible_part_of_the_element() {
        let vp = serde_json::json!({ "width": 800.0, "height": 600.0 });
        let r = |x: f64, y: f64, w: f64, h: f64| serde_json::json!({ "x": x, "y": y, "width": w, "height": h });
        assert_eq!(visible_rect(&r(10.0, 20.0, 100.0, 50.0), &vp), Some((10.0, 20.0, 100.0, 50.0)));
        assert_eq!(visible_rect(&r(-20.0, 580.0, 100.0, 50.0), &vp), Some((0.0, 580.0, 80.0, 20.0)));
        assert_eq!(visible_rect(&r(10.0, 700.0, 100.0, 50.0), &vp), None);
        assert_eq!(visible_rect(&r(10.0, 10.0, 0.0, 0.0), &vp), None);
        assert_eq!(visible_rect(&serde_json::json!({}), &vp), None);
    }

    #[test]
    fn element_scripts_embed_arguments_as_json() {
        let js = type_js("e1\"); alert(1); (\"", "it's \"quoted\"\n", true);
        assert!(js.contains(r#""e1\"); alert(1); (\"""#));
        assert!(js.contains(r#""it's \"quoted\"\n""#));
        assert!(js.contains("if (true)"));
        assert!(js.contains("password"));
    }
}
