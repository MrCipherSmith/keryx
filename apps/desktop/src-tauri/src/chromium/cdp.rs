//! A Chrome DevTools Protocol client over the browser's WebSocket.
//!
//! One I/O thread owns the socket: it reads with a short timeout and, between
//! reads, sends queued calls. A call waits on its own channel for the answer
//! with the same id; every other message is an event, fanned out to the
//! subscribers. Sessions are flat (`Target.attachToTarget` with
//! `flatten: true`): a call or event names its `sessionId`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(10);

/// A CDP event: `method` and `params`, from the browser (`session: None`) or one attached target.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub session: Option<String>,
    pub method: String,
    pub params: Value,
}

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

pub struct Cdp {
    outgoing: Sender<String>,
    pending: Pending,
    subscribers: Arc<Mutex<Vec<Sender<Event>>>>,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
}

/// What one incoming text frame is.
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
    /// Connect to `ws://127.0.0.1:<port>/devtools/...`.
    pub fn connect(ws_url: &str) -> Result<Arc<Cdp>, String> {
        let url = tungstenite::http::Uri::try_from(ws_url).map_err(|e| format!("Bad DevTools address {ws_url}: {e}"))?;
        let host = url.host().unwrap_or("127.0.0.1");
        if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
            return Err(format!("The DevTools address must be local, not {host}"));
        }
        let port = url.port_u16().ok_or("The DevTools address has no port")?;
        let stream = TcpStream::connect((host, port)).map_err(|e| format!("Could not reach the browser: {e}"))?;
        stream.set_nodelay(true).ok();
        let config = WebSocketConfig { max_message_size: Some(512 << 20), max_frame_size: Some(512 << 20), ..Default::default() };
        let (socket, _) = tungstenite::client::client_with_config(ws_url, stream, Some(config))
            .map_err(|e| format!("Could not open the DevTools socket: {e}"))?;
        socket.get_ref().set_read_timeout(Some(POLL)).map_err(|e| e.to_string())?;

        let (outgoing, queue) = mpsc::channel::<String>();
        let cdp = Arc::new(Cdp {
            outgoing,
            pending: Arc::default(),
            subscribers: Arc::default(),
            next: AtomicU64::new(0),
            closed: Arc::default(),
        });
        let pending = cdp.pending.clone();
        let subscribers = cdp.subscribers.clone();
        let closed = cdp.closed.clone();
        std::thread::Builder::new()
            .name("cdp-io".into())
            .spawn(move || io_loop(socket, queue, pending, subscribers, closed))
            .map_err(|e| e.to_string())?;
        Ok(cdp)
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
        if self.outgoing.send(call_text(id, session, method, params)).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("The browser connection is closed".into());
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r.map_err(|e| format!("{method}: {e}")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("{method}: the browser did not answer in time"))
            }
        }
    }

    /// Every event from now on (all sessions); filter on `Event::session`.
    pub fn subscribe(&self) -> Receiver<Event> {
        let (tx, rx) = mpsc::channel();
        self.subscribers.lock().unwrap().push(tx);
        rx
    }
}

fn io_loop(
    mut socket: WebSocket<TcpStream>,
    queue: Receiver<String>,
    pending: Pending,
    subscribers: Arc<Mutex<Vec<Sender<Event>>>>,
    closed: Arc<AtomicBool>,
) {
    let fail_all = |why: &str| {
        for (_, tx) in pending.lock().unwrap().drain() {
            let _ = tx.send(Err(why.to_string()));
        }
    };
    loop {
        // Send everything queued.
        loop {
            match queue.try_recv() {
                Ok(text) => {
                    if let Err(e) = socket.send(Message::Text(text)) {
                        closed.store(true, Ordering::SeqCst);
                        fail_all(&format!("The browser connection broke: {e}"));
                        return;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                // Every `Cdp` handle is gone: close quietly.
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = socket.close(None);
                    closed.store(true, Ordering::SeqCst);
                    return;
                }
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => match parse_incoming(&text) {
                Incoming::Reply { id, result } => {
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(result);
                    }
                }
                Incoming::Event(ev) => subscribers.lock().unwrap().retain(|s| s.send(ev.clone()).is_ok()),
                Incoming::Junk => {}
            },
            Ok(Message::Close(_)) => {
                closed.store(true, Ordering::SeqCst);
                fail_all("The browser closed the connection");
                return;
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => {
                closed.store(true, Ordering::SeqCst);
                fail_all(&format!("The browser connection broke: {e}"));
                return;
            }
        }
    }
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

    #[test]
    fn only_local_browsers_are_reached() {
        let err = Cdp::connect("ws://example.com:9222/devtools/browser/x").err().unwrap();
        assert!(err.contains("must be local"), "{err}");
    }
}
