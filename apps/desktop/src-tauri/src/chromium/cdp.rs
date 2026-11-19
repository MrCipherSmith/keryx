//! A Chrome DevTools Protocol client over the browser's debugging pipe
//! (`--remote-debugging-pipe`): messages are JSON, each ended by a NUL byte;
//! the app writes to the browser's fd 3 and reads from its fd 4. There is no
//! network port, so no other local process can attach to the browser.
//!
//! Calls are written from the calling thread (one writer at a time) and each
//! waits on its own channel for the answer with the same id; a reader thread
//! routes answers and fans every event out to the subscribers. Sessions are
//! flat (`Target.attachToTarget` with `flatten: true`): a call or event names
//! its `sessionId`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// The largest message read (a full-page screenshot is big).
const MAX_MESSAGE: usize = 512 << 20;

/// A CDP event: `method` and `params`, from the browser (`session: None`) or one attached target.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub session: Option<String>,
    pub method: String,
    pub params: Value,
}

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;
type Subscribers = Arc<Mutex<Vec<Sender<Event>>>>;

pub struct Cdp {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Pending,
    subscribers: Subscribers,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
}

/// What one incoming message is.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Reply { id: u64, result: Result<Value, String> },
    Event(Event),
    Junk,
}

pub fn parse_incoming(text: &str) -> Incoming {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Incoming::Junk };
    if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
        let result = match v.get("error") {
            Some(e) => Err(e.get("message").and_then(|m| m.as_str()).unwrap_or("CDP error").to_string()),
            None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
        };
        return Incoming::Reply { id, result };
    }
    match v.get("method").and_then(|m| m.as_str()) {
        Some(method) => Incoming::Event(Event {
            session: v.get("sessionId").and_then(|s| s.as_str()).map(String::from),
            method: method.to_string(),
            params: v.get("params").cloned().unwrap_or(Value::Null),
        }),
        None => Incoming::Junk,
    }
}

/// The text of one call.
pub fn call_text(id: u64, session: Option<&str>, method: &str, params: Value) -> String {
    let mut msg = json!({ "id": id, "method": method, "params": params });
    if let Some(s) = session {
        msg["sessionId"] = Value::String(s.to_string());
    }
    msg.to_string()
}

impl Cdp {
    /// Talk CDP over a pair of streams: `reader` carries the browser's messages, `writer` takes ours.
    pub fn over(reader: impl Read + Send + 'static, writer: impl Write + Send + 'static) -> Arc<Cdp> {
        let cdp = Arc::new(Cdp {
            writer: Mutex::new(Box::new(writer)),
            pending: Arc::default(),
            subscribers: Arc::default(),
            next: AtomicU64::new(0),
            closed: Arc::default(),
        });
        let pending = cdp.pending.clone();
        let subscribers = cdp.subscribers.clone();
        let closed = cdp.closed.clone();
        let _ = std::thread::Builder::new().name("cdp-reader".into()).spawn(move || read_loop(reader, pending, subscribers, closed));
        cdp
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Call `method` (on `session`, or the browser) and wait for its result.
    pub fn call(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
        self.call_within(session, method, params, CALL_TIMEOUT)
    }

    pub fn call_within(&self, session: Option<&str>, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if self.is_closed() {
            return Err("The browser connection is closed".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut text = call_text(id, session, method, params).into_bytes();
        text.push(0);
        let written = {
            let mut w = self.writer.lock().unwrap();
            w.write_all(&text).and_then(|_| w.flush())
        };
        // A call may carry secrets (imported cookie values): wipe our copy of the text.
        zeroize::Zeroize::zeroize(&mut text);
        if let Err(e) = written {
            self.pending.lock().unwrap().remove(&id);
            self.closed.store(true, Ordering::SeqCst);
            return Err(format!("The browser connection broke: {e}"));
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r.map_err(|e| format!("{method}: {e}")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("{method}: the browser did not answer in time"))
            }
        }
    }

    /// Every event from now on (all sessions); filter on `Event::session`. The channel ends when the
    /// browser connection closes.
    pub fn subscribe(&self) -> Receiver<Event> {
        let (tx, rx) = mpsc::channel();
        self.subscribers.lock().unwrap().push(tx);
        rx
    }
}

fn read_loop(reader: impl Read, pending: Pending, subscribers: Subscribers, closed: Arc<AtomicBool>) {
    let mut r = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.by_ref().take(MAX_MESSAGE as u64).read_until(0, &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buf.last() == Some(&0) {
            buf.pop();
        } else if buf.len() >= MAX_MESSAGE {
            // An oversized message cannot be framed again: give up on the connection.
            break;
        }
        match parse_incoming(&String::from_utf8_lossy(&buf)) {
            Incoming::Reply { id, result } => {
                if let Some(tx) = pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(result);
                }
            }
            Incoming::Event(ev) => subscribers.lock().unwrap().retain(|s| s.send(ev.clone()).is_ok()),
            Incoming::Junk => {}
        }
    }
    closed.store(true, Ordering::SeqCst);
    for (_, tx) in pending.lock().unwrap().drain() {
        let _ = tx.send(Err("The browser closed the connection".into()));
    }
    // Dropping the senders ends every subscriber's channel.
    subscribers.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_errors_and_events_are_told_apart() {
        assert_eq!(parse_incoming(r#"{"id":3,"result":{"a":1}}"#), Incoming::Reply { id: 3, result: Ok(json!({"a":1})) });
        assert_eq!(
            parse_incoming(r#"{"id":4,"error":{"code":-32000,"message":"No node"}}"#),
            Incoming::Reply { id: 4, result: Err("No node".into()) }
        );
        assert_eq!(
            parse_incoming(r#"{"method":"Page.loadEventFired","params":{"timestamp":1},"sessionId":"S1"}"#),
            Incoming::Event(Event { session: Some("S1".into()), method: "Page.loadEventFired".into(), params: json!({"timestamp":1}) })
        );
        assert_eq!(parse_incoming("not json"), Incoming::Junk);
        assert_eq!(parse_incoming(r#"{"x":1}"#), Incoming::Junk);
    }

    #[test]
    fn calls_carry_their_session() {
        let v: Value = serde_json::from_str(&call_text(7, Some("S"), "Page.navigate", json!({"url":"http://a"}))).unwrap();
        assert_eq!(v, json!({"id":7,"method":"Page.navigate","params":{"url":"http://a"},"sessionId":"S"}));
        let v: Value = serde_json::from_str(&call_text(8, None, "Target.getTargets", json!({}))).unwrap();
        assert!(v.get("sessionId").is_none());
    }

    /// A fake browser on a socket pair: answers every call with its method and sends an event first.
    #[cfg(unix)]
    #[test]
    fn calls_and_events_travel_over_nul_framed_streams() {
        use std::os::unix::net::UnixStream;
        let (app_side, browser_side) = UnixStream::pair().unwrap();
        let cdp = Cdp::over(app_side.try_clone().unwrap(), app_side);
        let events = cdp.subscribe();
        std::thread::spawn(move || {
            let mut r = BufReader::new(browser_side.try_clone().unwrap());
            let mut w = browser_side;
            let mut buf = Vec::new();
            while r.read_until(0, &mut buf).unwrap_or(0) > 0 {
                buf.pop();
                let v: Value = serde_json::from_slice(&buf).unwrap();
                let ev = json!({ "method": "Test.called", "params": { "m": v["method"] }, "sessionId": "S" }).to_string();
                let reply = json!({ "id": v["id"], "result": { "echo": v["method"] } }).to_string();
                w.write_all(format!("{ev}\0{reply}\0").as_bytes()).unwrap();
                buf.clear();
            }
        });
        assert_eq!(cdp.call(None, "Browser.getVersion", json!({})).unwrap(), json!({ "echo": "Browser.getVersion" }));
        assert_eq!(cdp.call(Some("S"), "Page.enable", json!({})).unwrap(), json!({ "echo": "Page.enable" }));
        let ev = events.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!((ev.method.as_str(), ev.session.as_deref()), ("Test.called", Some("S")));
    }

    #[cfg(unix)]
    #[test]
    fn a_closed_browser_fails_calls_and_ends_event_channels() {
        use std::os::unix::net::UnixStream;
        let (app_side, browser_side) = UnixStream::pair().unwrap();
        let cdp = Cdp::over(app_side.try_clone().unwrap(), app_side);
        let events = cdp.subscribe();
        drop(browser_side);
        std::thread::sleep(Duration::from_millis(150));
        assert!(cdp.is_closed());
        assert!(cdp.call(None, "Browser.getVersion", json!({})).is_err());
        assert!(events.recv_timeout(Duration::from_secs(1)).is_err());
    }
}
