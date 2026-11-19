//! One browser tab over CDP: what the panel's `browser_*` tools do on the
//! Chromium engine. Input is real (`Input.dispatch*`, `Input.insertText`), so
//! pages see trusted events, hover and focus as from a user; the snapshot is
//! Chrome's own accessibility tree; console and network come from CDP events
//! (every frame, every request), not from a script in the page.

use super::cdp::{Cdp, Event};
use super::snapshot::{self, Snapshot};
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_LOG: usize = 500;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ConsoleEntry {
    pub level: String,
    pub text: String,
    pub time: u64,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEntry {
    pub id: String,
    pub method: String,
    pub url: String,
    pub resource_type: String,
    pub status: Option<i64>,
    pub mime_type: Option<String>,
    pub failed: Option<String>,
    pub bytes: Option<f64>,
    pub finished: bool,
}

#[derive(Default)]
struct Logs {
    console: VecDeque<ConsoleEntry>,
    network: VecDeque<NetworkEntry>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn push_capped<T>(q: &mut VecDeque<T>, v: T) {
    q.push_back(v);
    while q.len() > MAX_LOG {
        q.pop_front();
    }
}

/// The text of one console argument (a `Runtime.RemoteObject`).
fn arg_text(a: &Value) -> String {
    if let Some(v) = a.get("value") {
        return match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
    }
    a.get("description").or_else(|| a.get("unserializableValue")).and_then(|d| d.as_str()).unwrap_or("").to_string()
}

/// Fold one event of this page's session into its logs.
fn record(logs: &mut Logs, ev: &Event) {
    let p = &ev.params;
    let str_of = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    match ev.method.as_str() {
        "Runtime.consoleAPICalled" => {
            let text: Vec<String> = p.get("args").and_then(|a| a.as_array()).into_iter().flatten().map(arg_text).collect();
            let level = match str_of(p, "type").as_str() {
                "warning" => "warn".to_string(),
                t => t.to_string(),
            };
            push_capped(&mut logs.console, ConsoleEntry { level, text: text.join(" ").chars().take(2000).collect(), time: now_ms() });
        }
        "Runtime.exceptionThrown" => {
            let d = p.get("exceptionDetails").cloned().unwrap_or(Value::Null);
            let text = d.get("exception").and_then(|e| e.get("description")).and_then(|x| x.as_str()).map(String::from).unwrap_or_else(|| str_of(&d, "text"));
            push_capped(&mut logs.console, ConsoleEntry { level: "error".into(), text: text.chars().take(2000).collect(), time: now_ms() });
        }
        "Log.entryAdded" => {
            let e = p.get("entry").cloned().unwrap_or(Value::Null);
            let url = str_of(&e, "url");
            let text = if url.is_empty() { str_of(&e, "text") } else { format!("{} ({url})", str_of(&e, "text")) };
            push_capped(&mut logs.console, ConsoleEntry { level: str_of(&e, "level"), text: text.chars().take(2000).collect(), time: now_ms() });
        }
        "Network.requestWillBeSent" => {
            let id = str_of(p, "requestId");
            let req = p.get("request").cloned().unwrap_or(Value::Null);
            // A redirect reuses the id: the earlier hop is finished.
            if let Some(prev) = logs.network.iter_mut().rev().find(|n| n.id == id && !n.finished) {
                prev.finished = true;
            }
            push_capped(
                &mut logs.network,
                NetworkEntry { id, method: str_of(&req, "method"), url: str_of(&req, "url"), resource_type: str_of(p, "type"), ..Default::default() },
            );
        }
        "Network.responseReceived" => {
            let id = str_of(p, "requestId");
            let resp = p.get("response").cloned().unwrap_or(Value::Null);
            if let Some(n) = logs.network.iter_mut().rev().find(|n| n.id == id) {
                n.status = resp.get("status").and_then(|s| s.as_i64());
                n.mime_type = resp.get("mimeType").and_then(|m| m.as_str()).map(String::from);
            }
        }
        "Network.loadingFinished" => {
            let id = str_of(p, "requestId");
            if let Some(n) = logs.network.iter_mut().rev().find(|n| n.id == id) {
                n.finished = true;
                n.bytes = p.get("encodedDataLength").and_then(|b| b.as_f64());
            }
        }
        "Network.loadingFailed" => {
            let id = str_of(p, "requestId");
            if let Some(n) = logs.network.iter_mut().rev().find(|n| n.id == id) {
                n.finished = true;
                let canceled = p.get("canceled").and_then(|c| c.as_bool()) == Some(true);
                n.failed = Some(if canceled { "canceled".into() } else { str_of(p, "errorText") });
            }
        }
        _ => {}
    }
}

/// What a screenshot covers.
#[derive(Clone, Debug, PartialEq)]
pub enum Shot {
    Viewport,
    FullPage,
    Element(String),
    /// A rectangle of the viewport, in CSS pixels: (x, y, width, height).
    Clip(f64, f64, f64, f64),
}

/// Keys `press_key` knows: (key, code, Windows virtual key code, text).
fn key_info(key: &str) -> Option<(&'static str, &'static str, i64, &'static str)> {
    Some(match key {
        "Enter" => ("Enter", "Enter", 13, "\r"),
        "Tab" => ("Tab", "Tab", 9, ""),
        "Escape" => ("Escape", "Escape", 27, ""),
        "Backspace" => ("Backspace", "Backspace", 8, ""),
        "Delete" => ("Delete", "Delete", 46, ""),
        "ArrowUp" => ("ArrowUp", "ArrowUp", 38, ""),
        "ArrowDown" => ("ArrowDown", "ArrowDown", 40, ""),
        "ArrowLeft" => ("ArrowLeft", "ArrowLeft", 37, ""),
        "ArrowRight" => ("ArrowRight", "ArrowRight", 39, ""),
        "Home" => ("Home", "Home", 36, ""),
        "End" => ("End", "End", 35, ""),
        "PageUp" => ("PageUp", "PageUp", 33, ""),
        "PageDown" => ("PageDown", "PageDown", 34, ""),
        " " | "Space" => (" ", "Space", 32, " "),
        _ => return None,
    })
}

/// The centre of a quad `[x1,y1,x2,y2,x3,y3,x4,y4]`.
pub fn quad_center(q: &[f64]) -> Option<(f64, f64)> {
    if q.len() < 8 {
        return None;
    }
    Some(((q[0] + q[2] + q[4] + q[6]) / 4.0, (q[1] + q[3] + q[5] + q[7]) / 4.0))
}

/// The bounding box of a quad: (x, y, width, height).
pub fn quad_bounds(q: &[f64]) -> Option<(f64, f64, f64, f64)> {
    if q.len() < 8 {
        return None;
    }
    let xs = [q[0], q[2], q[4], q[6]];
    let ys = [q[1], q[3], q[5], q[7]];
    let (x0, x1) = (xs.iter().cloned().fold(f64::MAX, f64::min), xs.iter().cloned().fold(f64::MIN, f64::max));
    let (y0, y1) = (ys.iter().cloned().fold(f64::MAX, f64::min), ys.iter().cloned().fold(f64::MIN, f64::max));
    Some((x0, y0, x1 - x0, y1 - y0))
}

/// A connection to a running browser.
pub struct Browser {
    pub cdp: Arc<Cdp>,
}

impl Browser {
    pub fn connect(ws_url: &str) -> Result<Browser, String> {
        Ok(Browser { cdp: Cdp::connect(ws_url)? })
    }

    /// Open a new tab (on `about:blank`; navigate it afterwards).
    pub fn open_page(&self) -> Result<Arc<Page>, String> {
        let target = self.cdp.call(None, "Target.createTarget", json!({ "url": "about:blank" }))?;
        let target_id = target.get("targetId").and_then(|t| t.as_str()).ok_or("No target id")?.to_string();
        Page::attach(self.cdp.clone(), target_id)
    }
}

pub struct Page {
    cdp: Arc<Cdp>,
    pub target_id: String,
    pub session: String,
    logs: Arc<Mutex<Logs>>,
    refs: Mutex<HashMap<String, i64>>,
    closed: Arc<AtomicBool>,
}

impl Page {
    /// Attach to `target_id` and start recording its console and network.
    pub fn attach(cdp: Arc<Cdp>, target_id: String) -> Result<Arc<Page>, String> {
        // Subscribe before attaching, so no early event is missed.
        let events = cdp.subscribe();
        let attached = cdp.call(None, "Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }))?;
        let session = attached.get("sessionId").and_then(|s| s.as_str()).ok_or("No session id")?.to_string();
        let page = Arc::new(Page {
            cdp: cdp.clone(),
            target_id,
            session: session.clone(),
            logs: Arc::default(),
            refs: Mutex::default(),
            closed: Arc::default(),
        });
        let logs = page.logs.clone();
        let closed = page.closed.clone();
        std::thread::Builder::new()
            .name("cdp-page-events".into())
            .spawn(move || {
                while !closed.load(Ordering::SeqCst) {
                    match events.recv_timeout(Duration::from_millis(500)) {
                        Ok(ev) if ev.session.as_deref() == Some(session.as_str()) => record(&mut logs.lock().unwrap(), &ev),
                        Ok(ev) if ev.method == "Target.detachedFromTarget"
                            && ev.params.get("sessionId").and_then(|s| s.as_str()) == Some(session.as_str()) =>
                        {
                            closed.store(true, Ordering::SeqCst)
                        }
                        Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        for domain in ["Page.enable", "Runtime.enable", "Network.enable", "Log.enable", "DOM.enable", "Accessibility.enable"] {
            page.call(domain, json!({}))?;
        }
        Ok(page)
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.cdp.call(Some(&self.session), method, params)
    }

    pub fn call_within(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.cdp.call_within(Some(&self.session), method, params, timeout)
    }

    /// A JavaScript world of the main frame that shares the DOM but not the page's globals
    /// (the page cannot see or tamper with what runs there).
    pub fn isolated_world(&self, name: &str) -> Result<i64, String> {
        let tree = self.call("Page.getFrameTree", json!({}))?;
        let frame = tree.get("frameTree").and_then(|t| t.get("frame")).and_then(|f| f.get("id")).and_then(|i| i.as_str()).ok_or("No main frame")?;
        let w = self.call("Page.createIsolatedWorld", json!({ "frameId": frame, "worldName": name, "grantUniveralAccess": false }))?;
        w.get("executionContextId").and_then(|c| c.as_i64()).ok_or_else(|| "No isolated world".to_string())
    }

    /// Run `expression` in execution context `context`, awaiting a promise, for at most `timeout`.
    pub fn evaluate_in(&self, context: i64, expression: &str, timeout: Duration) -> Result<Value, String> {
        let r = self.call_within(
            "Runtime.evaluate",
            json!({ "expression": expression, "contextId": context, "returnByValue": true, "awaitPromise": true }),
            timeout,
        )?;
        if let Some(ex) = r.get("exceptionDetails") {
            let text = ex.get("exception").and_then(|e| e.get("description")).and_then(|d| d.as_str()).or_else(|| ex.get("text").and_then(|t| t.as_str()));
            return Err(text.unwrap_or("The script threw").to_string());
        }
        Ok(r.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null))
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst) || self.cdp.is_closed()
    }

    /// Run `expression` in the page and return its value (promises are awaited).
    pub fn evaluate(&self, expression: &str) -> Result<Value, String> {
        let r = self.call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }))?;
        if let Some(ex) = r.get("exceptionDetails") {
            let text = ex.get("exception").and_then(|e| e.get("description")).and_then(|d| d.as_str()).or_else(|| ex.get("text").and_then(|t| t.as_str()));
            return Err(text.unwrap_or("The script threw").to_string());
        }
        Ok(r.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null))
    }

    pub fn url_and_title(&self) -> (String, String) {
        let v = self.evaluate("({ url: location.href, title: document.title })").unwrap_or(Value::Null);
        let g = |k| v.get(k).and_then(|x: &Value| x.as_str()).unwrap_or("").to_string();
        (g("url"), g("title"))
    }

    /// Wait until `document.readyState` is `complete` (after a short settle).
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        std::thread::sleep(Duration::from_millis(150));
        while Instant::now() < deadline {
            if self.evaluate("document.readyState").ok().as_ref().and_then(|v| v.as_str()) == Some("complete") {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    pub fn navigate(&self, url: &str) -> Result<(), String> {
        let r = self.call("Page.navigate", json!({ "url": url }))?;
        if let Some(e) = r.get("errorText").and_then(|e| e.as_str()).filter(|e| !e.is_empty()) {
            return Err(format!("Could not open {url}: {e}"));
        }
        self.wait_ready(LOAD_TIMEOUT);
        Ok(())
    }

    pub fn history(&self, delta: i64) -> Result<(), String> {
        let h = self.call("Page.getNavigationHistory", json!({}))?;
        let index = h.get("currentIndex").and_then(|i| i.as_i64()).unwrap_or(0) + delta;
        let entries = h.get("entries").and_then(|e| e.as_array()).cloned().unwrap_or_default();
        let Some(entry) = usize::try_from(index).ok().and_then(|i| entries.get(i)) else { return Ok(()) };
        let id = entry.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
        self.call("Page.navigateToHistoryEntry", json!({ "entryId": id }))?;
        self.wait_ready(LOAD_TIMEOUT);
        Ok(())
    }

    pub fn reload(&self) -> Result<(), String> {
        self.call("Page.reload", json!({}))?;
        self.wait_ready(LOAD_TIMEOUT);
        Ok(())
    }

    /// The accessibility outline; refs from earlier snapshots stop working.
    pub fn snapshot(&self) -> Result<Snapshot, String> {
        let r = self.call("Accessibility.getFullAXTree", json!({}))?;
        let nodes = r.get("nodes").and_then(|n| n.as_array()).cloned().unwrap_or_default();
        let mut snap = snapshot::build(&nodes);
        *self.refs.lock().unwrap() = std::mem::take(&mut snap.refs);
        Ok(snap)
    }

    fn backend(&self, reference: &str) -> Result<i64, String> {
        self.refs.lock().unwrap().get(reference).copied().ok_or_else(|| format!("Unknown or stale ref {reference}; take a new browser_snapshot"))
    }

    /// The element's border box in viewport coordinates, scrolled into view first.
    fn element_box(&self, backend: i64) -> Result<(f64, f64, f64, f64), String> {
        let _ = self.call("DOM.scrollIntoViewIfNeeded", json!({ "backendNodeId": backend }));
        let model = self.call("DOM.getBoxModel", json!({ "backendNodeId": backend })).map_err(|_| "The element has no box (it is hidden or gone)".to_string())?;
        let quad: Vec<f64> = model
            .get("model")
            .and_then(|m| m.get("border"))
            .and_then(|q| q.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_f64()).collect())
            .unwrap_or_default();
        quad_bounds(&quad).ok_or_else(|| "The element has no box".to_string())
    }

    fn mouse(&self, kind: &str, x: f64, y: f64, click_count: i64) -> Result<(), String> {
        let mut p = json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": click_count });
        if kind == "mouseMoved" {
            p["button"] = json!("none");
        }
        self.call("Input.dispatchMouseEvent", p).map(|_| ())
    }

    /// A real click at the element's centre.
    pub fn click(&self, reference: &str) -> Result<(), String> {
        let (x, y, w, h) = self.element_box(self.backend(reference)?)?;
        let (cx, cy) = (x + w / 2.0, y + h / 2.0);
        self.mouse("mouseMoved", cx, cy, 0)?;
        self.mouse("mousePressed", cx, cy, 1)?;
        self.mouse("mouseReleased", cx, cy, 1)
    }

    /// Move the pointer over the element (hover menus, tooltips).
    pub fn hover(&self, reference: &str) -> Result<(), String> {
        let (x, y, w, h) = self.element_box(self.backend(reference)?)?;
        self.mouse("mouseMoved", x + w / 2.0, y + h / 2.0, 0)
    }

    /// Replace the element's text with `text` as typed input; `submit` presses Enter.
    pub fn type_text(&self, reference: &str, text: &str, submit: bool) -> Result<(), String> {
        let backend = self.backend(reference)?;
        let _ = self.call("DOM.scrollIntoViewIfNeeded", json!({ "backendNodeId": backend }));
        let obj = self.call("DOM.resolveNode", json!({ "backendNodeId": backend }))?;
        let object_id = obj.get("object").and_then(|o| o.get("objectId")).and_then(|o| o.as_str()).ok_or("The element is gone")?;
        let r = self.call(
            "Runtime.callFunctionOn",
            json!({
                "objectId": object_id,
                "returnByValue": true,
                "functionDeclaration": "function () {
                    if (this.type === 'password') return 'password';
                    if (!('value' in this) && !this.isContentEditable) return 'not-text';
                    this.focus();
                    if (typeof this.select === 'function') this.select();
                    else if (this.isContentEditable) {
                        const r = document.createRange(); r.selectNodeContents(this);
                        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
                    }
                    return 'ok';
                }",
            }),
        )?;
        match r.get("result").and_then(|v| v.get("value")).and_then(|v| v.as_str()) {
            Some("password") => return Err("The agent does not type into password fields".into()),
            Some("not-text") => return Err("This element does not take text".into()),
            _ => {}
        }
        if text.is_empty() {
            self.press_key("Backspace")?;
        } else {
            self.call("Input.insertText", json!({ "text": text }))?;
        }
        if submit {
            self.press_key("Enter")?;
        }
        Ok(())
    }

    /// Press one named key (Enter, Tab, Escape, arrows, …) on the focused element.
    pub fn press_key(&self, key: &str) -> Result<(), String> {
        let (k, code, vk, text) = key_info(key).ok_or_else(|| format!("Unknown key {key}"))?;
        let mut down = json!({ "type": "keyDown", "key": k, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk });
        if !text.is_empty() {
            down["text"] = json!(text);
            down["unmodifiedText"] = json!(text);
        }
        self.call("Input.dispatchKeyEvent", down)?;
        self.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": k, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk }))
            .map(|_| ())
    }

    /// Image bytes of the viewport, the whole page, or one element.
    pub fn screenshot(&self, what: &Shot, format: &str) -> Result<Vec<u8>, String> {
        let format = match format {
            "jpeg" | "jpg" => "jpeg",
            "webp" => "webp",
            _ => "png",
        };
        let mut params = json!({ "format": format, "captureBeyondViewport": false });
        match what {
            Shot::Viewport => {}
            Shot::FullPage => {
                let m = self.call("Page.getLayoutMetrics", json!({}))?;
                let size = m.get("cssContentSize").or_else(|| m.get("contentSize")).cloned().unwrap_or(Value::Null);
                let w = size.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0).ceil();
                let h = size.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0).ceil();
                params["captureBeyondViewport"] = json!(true);
                params["clip"] = json!({ "x": 0, "y": 0, "width": w.max(1.0), "height": h.clamp(1.0, 16384.0), "scale": 1 });
            }
            Shot::Element(_) | Shot::Clip(..) => {
                let (x, y, w, h) = match what {
                    Shot::Element(reference) => self.element_box(self.backend(reference)?)?,
                    Shot::Clip(x, y, w, h) => (*x, *y, *w, *h),
                    _ => unreachable!(),
                };
                // The clip is in document coordinates: add the scroll offset.
                let m = self.call("Page.getLayoutMetrics", json!({}))?;
                let vp = m.get("cssLayoutViewport").or_else(|| m.get("layoutViewport")).cloned().unwrap_or(Value::Null);
                let px = vp.get("pageX").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let py = vp.get("pageY").and_then(|v| v.as_f64()).unwrap_or(0.0);
                params["captureBeyondViewport"] = json!(true);
                params["clip"] = json!({ "x": x + px, "y": y + py, "width": w.max(1.0), "height": h.max(1.0), "scale": 1 });
            }
        }
        let r = self.call("Page.captureScreenshot", params)?;
        let data = r.get("data").and_then(|d| d.as_str()).ok_or("The browser returned no image")?;
        base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())
    }

    pub fn console(&self, limit: usize) -> Vec<ConsoleEntry> {
        let logs = self.logs.lock().unwrap();
        logs.console.iter().rev().take(limit).rev().cloned().collect()
    }

    pub fn clear_logs(&self) {
        let mut logs = self.logs.lock().unwrap();
        logs.console.clear();
        logs.network.clear();
    }

    /// The latest requests, optionally only those whose URL contains `filter`.
    pub fn network(&self, limit: usize, filter: Option<&str>) -> Vec<NetworkEntry> {
        let logs = self.logs.lock().unwrap();
        let f = filter.unwrap_or("");
        let hits: Vec<&NetworkEntry> = logs.network.iter().filter(|n| n.url.contains(f)).collect();
        hits.iter().rev().take(limit).rev().map(|n| (*n).clone()).collect()
    }

    /// A response body as text (bodies over `max` bytes are cut).
    pub fn response_body(&self, request_id: &str, max: usize) -> Result<String, String> {
        let r = self.call("Network.getResponseBody", json!({ "requestId": request_id }))?;
        let body = r.get("body").and_then(|b| b.as_str()).unwrap_or("");
        let text = if r.get("base64Encoded").and_then(|b| b.as_bool()) == Some(true) {
            match base64::engine::general_purpose::STANDARD.decode(body) {
                Ok(bytes) => String::from_utf8(bytes).unwrap_or_else(|_| "(binary body)".into()),
                Err(_) => "(undecodable body)".into(),
            }
        } else {
            body.to_string()
        };
        Ok(if text.len() > max { format!("{}… [{} bytes in all]", &text[..text.floor_char_boundary_compat(max)], text.len()) } else { text })
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.cdp.call(None, "Target.closeTarget", json!({ "targetId": self.target_id }));
    }
}

trait FloorCharBoundary {
    fn floor_char_boundary_compat(&self, i: usize) -> usize;
}

impl FloorCharBoundary for String {
    fn floor_char_boundary_compat(&self, i: usize) -> usize {
        let mut i = i.min(self.len());
        while !self.is_char_boundary(i) {
            i -= 1;
        }
        i
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(method: &str, params: Value) -> Event {
        Event { session: Some("S".into()), method: method.into(), params }
    }

    #[test]
    fn console_and_errors_are_recorded_from_events() {
        let mut logs = Logs::default();
        record(&mut logs, &ev("Runtime.consoleAPICalled", json!({ "type": "warning", "args": [{ "type": "string", "value": "low" }, { "type": "number", "value": 3 }] })));
        record(&mut logs, &ev("Runtime.exceptionThrown", json!({ "exceptionDetails": { "text": "Uncaught", "exception": { "description": "TypeError: x is undefined" } } })));
        record(&mut logs, &ev("Log.entryAdded", json!({ "entry": { "level": "error", "text": "Failed to load resource", "url": "http://a/x.js" } })));
        let c: Vec<_> = logs.console.iter().map(|e| (e.level.as_str(), e.text.as_str())).collect();
        assert_eq!(c, vec![("warn", "low 3"), ("error", "TypeError: x is undefined"), ("error", "Failed to load resource (http://a/x.js)")]);
    }

    #[test]
    fn requests_follow_their_response_and_end() {
        let mut logs = Logs::default();
        record(&mut logs, &ev("Network.requestWillBeSent", json!({ "requestId": "1", "type": "Fetch", "request": { "method": "POST", "url": "http://a/api" } })));
        record(&mut logs, &ev("Network.responseReceived", json!({ "requestId": "1", "response": { "status": 404, "mimeType": "application/json" } })));
        record(&mut logs, &ev("Network.loadingFinished", json!({ "requestId": "1", "encodedDataLength": 120.0 })));
        record(&mut logs, &ev("Network.requestWillBeSent", json!({ "requestId": "2", "type": "Image", "request": { "method": "GET", "url": "http://a/i.png" } })));
        record(&mut logs, &ev("Network.loadingFailed", json!({ "requestId": "2", "errorText": "net::ERR_BLOCKED" })));
        let a = &logs.network[0];
        assert_eq!((a.method.as_str(), a.status, a.mime_type.as_deref(), a.bytes, a.finished), ("POST", Some(404), Some("application/json"), Some(120.0), true));
        assert_eq!(logs.network[1].failed.as_deref(), Some("net::ERR_BLOCKED"));
    }

    #[test]
    fn logs_are_capped() {
        let mut logs = Logs::default();
        for i in 0..(MAX_LOG + 10) {
            record(&mut logs, &ev("Runtime.consoleAPICalled", json!({ "type": "log", "args": [{ "value": i }] })));
        }
        assert_eq!(logs.console.len(), MAX_LOG);
        assert_eq!(logs.console.front().unwrap().text, "10");
    }

    #[test]
    fn quads_give_centres_and_boxes() {
        let q = [10.0, 20.0, 110.0, 20.0, 110.0, 60.0, 10.0, 60.0];
        assert_eq!(quad_center(&q), Some((60.0, 40.0)));
        assert_eq!(quad_bounds(&q), Some((10.0, 20.0, 100.0, 40.0)));
        assert_eq!(quad_center(&[1.0]), None);
    }

    #[test]
    fn known_keys_have_codes() {
        assert_eq!(key_info("Enter"), Some(("Enter", "Enter", 13, "\r")));
        assert!(key_info("F13").is_none());
    }
}
