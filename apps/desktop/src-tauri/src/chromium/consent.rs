//! The user's confirmation before the agent acts on a site that is not local
//! (owner decision 2: always, even in `trust` and `auto`). Reading a page
//! (snapshot, screenshot, console, network) needs none; navigating to,
//! clicking, typing, hovering or pressing keys on an outside site does.
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
    /// What the agent wants to do, in words ("click", "type into", "open").
    pub action: String,
    pub origin: String,
    pub url: String,
}

/// Whether `url` is the user's own machine or a local test host (no question asked).
pub fn is_local(url: &Url) -> bool {
    if url.scheme() == "about" {
        return true;
    }
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

fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// Ask before the agent does `action` on `url` from project view `window`; Ok when allowed.
pub fn confirm(app: &AppHandle, window: &str, action: &str, url: &str) -> Result<(), String> {
    let Ok(parsed) = Url::parse(url) else { return Ok(()) };
    if is_local(&parsed) {
        return Ok(());
    }
    let origin = origin_of(&parsed);
    let consents = app.state::<Consents>();
    if consents.granted.lock().unwrap().contains(&(window.to_string(), origin.clone())) {
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
            if remember {
                consents.granted.lock().unwrap().insert((window.to_string(), origin));
            }
            Ok(())
        }
        Ok((false, _)) => Err(format!("The user did not allow the agent to {action} on {origin}. Ask them what to do instead.")),
        Err(_) => Err(format!("The user did not answer whether the agent may {action} on {origin}; nothing was done.")),
    }
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
            assert!(is_local(&Url::parse(u).unwrap()), "{u}");
        }
        for u in ["https://example.com", "https://localhost.example.com", "http://10.0.0.5", "https://127.0.0.1.nip.io"] {
            assert!(!is_local(&Url::parse(u).unwrap()), "{u}");
        }
    }

    #[test]
    fn origins_ignore_paths() {
        assert_eq!(origin_of(&Url::parse("https://example.com/a?b").unwrap()), "https://example.com");
    }
}
