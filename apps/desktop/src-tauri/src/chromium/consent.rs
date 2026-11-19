//! The user's confirmation before the agent touches a site that is not local
//! (owner decisions: always, even in `trust` and `auto`; reading counts as
//! touching). Opening, clicking, typing, hovering, pressing keys, and reading a
//! page (snapshot, screenshot, console, network) on an outside site all ask.
//!
//! It fails closed: a page whose address is empty or cannot be read is treated
//! as an outside site, and such an "unknown page" grant is never remembered.
//! The address comes from the browser (CDP target info, or the host's own load
//! events on WebKit), never from script in the page.
//!
//! The question is shown by the project view (`panel://consent`) and answered
//! with `browser_consent_answer`; no answer within `WAIT` is a no. "For this
//! session" grants last until the app quits, per project view and origin.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url, Webview};

pub const WAIT: Duration = Duration::from_secs(180);

/// Shown and keyed when a page's address is missing or unreadable.
pub const UNKNOWN_ORIGIN: &str = "an unknown page";

/// The project view asking, and where its answer (allow, remember) goes.
type Waiting = (String, Sender<(bool, bool)>);

#[derive(Default)]
pub struct Consents {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, Waiting>>,
    /// (project view, origin) allowed for the rest of the app run.
    granted: Mutex<HashSet<(String, String)>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRequest {
    pub id: u64,
    /// What the agent wants to do, in words ("click", "type into", "open", "read").
    pub action: String,
    pub origin: String,
    pub url: String,
}

/// Whether `url` is the user's own machine or a local test host.
pub fn is_local(url: &Url) -> bool {
    match url.host_str() {
        Some(h) => {
            let h = h.trim_start_matches('[').trim_end_matches(']');
            h == "localhost"
                || h == "0.0.0.0"
                || h.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
                || h.ends_with(".localhost")
                || h.ends_with(".test")
        }
        None => false,
    }
}

/// What touching `url` needs.
#[derive(Debug, PartialEq, Eq)]
pub enum Need {
    /// A local site, or a new tab's empty page: no question.
    Nothing,
    /// Ask about `origin`; `rememberable` is false for a page whose address is unknown.
    Ask { origin: String, rememberable: bool },
}

/// Decide for `url`. `about:blank` is free only for a tab nobody else opened (the caller passes the
/// opener's address instead for a popup); anything empty or unparseable asks.
pub fn need(url: &str) -> Need {
    let url = url.trim();
    if url == "about:blank" {
        return Need::Nothing;
    }
    match Url::parse(url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => {
            if is_local(&u) {
                Need::Nothing
            } else {
                Need::Ask { origin: origin_of(&u), rememberable: true }
            }
        }
        _ => Need::Ask { origin: UNKNOWN_ORIGIN.into(), rememberable: false },
    }
}

/// The origin `url` belongs to for consent purposes (`None` when no question would be asked).
pub fn origin_key(url: &str) -> Option<String> {
    match need(url) {
        Need::Nothing => None,
        Need::Ask { origin, .. } => Some(origin),
    }
}

fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// Ask before the agent does `action` on `url` from project view `window`; Ok when allowed.
pub fn confirm(app: &AppHandle, window: &str, action: &str, url: &str) -> Result<(), String> {
    let Need::Ask { origin, rememberable } = need(url) else { return Ok(()) };
    let consents = app.state::<Consents>();
    if rememberable && consents.granted.lock().unwrap().contains(&(window.to_string(), origin.clone())) {
        return Ok(());
    }
    let id = consents.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel();
    consents.waiting.lock().unwrap().insert(id, (window.to_string(), tx));
    let req = ConsentRequest { id, action: action.into(), origin: origin.clone(), url: url.into() };
    if app.emit_to(window, "panel://consent", req).is_err() {
        consents.waiting.lock().unwrap().remove(&id);
        return Err("Could not ask the user".into());
    }
    let answer = rx.recv_timeout(WAIT);
    consents.waiting.lock().unwrap().remove(&id);
    // Tell the view the question is gone (answered elsewhere or timed out).
    let _ = app.emit_to(window, "panel://consent-closed", id);
    match answer {
        Ok((true, remember)) => {
            if remember && rememberable {
                consents.granted.lock().unwrap().insert((window.to_string(), origin));
            }
            Ok(())
        }
        Ok((false, _)) => Err(format!("The user did not allow the agent to {action} {origin}. Ask them what to do instead.")),
        Err(_) => Err(format!("The user did not answer whether the agent may {action} {origin}; nothing was done.")),
    }
}

/// Ask for `url` (read by `current` from the browser), then read it again and refuse when the page
/// moved to another origin while the question was open.
pub fn confirm_current(app: &AppHandle, window: &str, action: &str, current: impl Fn() -> String) -> Result<(), String> {
    let before = current();
    confirm(app, window, action, &before)?;
    let after = current();
    if origin_key(&before) != origin_key(&after) {
        return Err(format!("The page moved to {} while waiting for the answer; nothing was done. Try again.", origin_key(&after).unwrap_or_else(|| "a local page".into())));
    }
    Ok(())
}

/// The view's answer to consent question `id`.
#[tauri::command]
pub fn browser_consent_answer(app: AppHandle, view: Webview, id: u64, allow: bool, remember: bool) -> Result<(), String> {
    let consents = app.state::<Consents>();
    let waiting = consents.waiting.lock().unwrap();
    match waiting.get(&id) {
        Some((w, tx)) if w == view.label() => {
            let _ = tx.send((allow, remember));
            Ok(())
        }
        _ => Err("That question is no longer open".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_hosts_need_no_question() {
        for u in ["http://localhost:3000/x", "http://127.0.0.1:5173", "http://[::1]:8080", "http://app.localhost", "http://shop.test:8000", "about:blank"] {
            assert_eq!(need(u), Need::Nothing, "{u}");
        }
        for u in ["https://example.com", "https://localhost.example.com", "http://10.0.0.5", "https://127.0.0.1.nip.io"] {
            assert!(matches!(need(u), Need::Ask { rememberable: true, .. }), "{u}");
        }
    }

    #[test]
    fn an_empty_or_unreadable_address_asks_and_is_never_remembered() {
        for u in ["", "   ", "not a url", "chrome-error://chromewebdata/", "data:text/html,x", "about:srcdoc", "file:///etc/hosts"] {
            assert_eq!(need(u), Need::Ask { origin: UNKNOWN_ORIGIN.into(), rememberable: false }, "{u:?}");
        }
    }

    #[test]
    fn origins_ignore_paths() {
        assert_eq!(origin_key("https://example.com/a?b"), Some("https://example.com".into()));
        assert_eq!(origin_key("http://localhost:3000/x"), None);
        assert_eq!(origin_key(""), Some(UNKNOWN_ORIGIN.into()));
    }
}
