//! Terminal tabs of the side panel (D-13): one PTY per tab, owned by a window.
//!
//! The shell runs in the window's project root with the login-shell
//! environment. Its output goes to whoever is attached (the web view, through
//! a Tauri channel) and into a bounded ring buffer that a re-attached view
//! replays and the agent reads through the panel MCP server.
//!
//! The shell is a session leader (`portable-pty` calls `setsid`), so job
//! control puts its foreground jobs in process groups of their own. Closing a
//! tab therefore signals every process of the shell's session, not only its
//! process group: SIGHUP first, SIGKILL after a short grace.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Bytes of output kept per tab for replay and for the agent.
pub const RING_BYTES: usize = 1024 * 1024;
/// Between SIGHUP and SIGKILL when a tab closes.
pub const HANGUP_GRACE: Duration = Duration::from_millis(500);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    /// Output, as text. A multi-byte sequence split across reads waits for its tail.
    Data { data: String },
    /// The shell exited; `code` is absent when it was killed by a signal.
    Exit { code: Option<u32> },
}

pub type Sink = Box<dyn Fn(PtyEvent) + Send + Sync>;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Owner {
    User,
    Agent,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: u64,
    pub title: String,
    pub owner: Owner,
    pub cwd: String,
    pub running: bool,
    pub exit_code: Option<u32>,
}

/// Output kept for a tab: the last `cap` bytes, plus how many were ever written.
struct Ring {
    bytes: VecDeque<u8>,
    cap: usize,
    total: u64,
}

impl Ring {
    fn new(cap: usize) -> Self {
        Ring { bytes: VecDeque::new(), cap, total: 0 }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len() as u64;
        let chunk = if chunk.len() > self.cap { &chunk[chunk.len() - self.cap..] } else { chunk };
        let overflow = (self.bytes.len() + chunk.len()).saturating_sub(self.cap);
        self.bytes.drain(..overflow);
        self.bytes.extend(chunk);
    }

    /// Bytes written after the `since` mark that are still kept.
    fn since(&self, since: u64) -> Vec<u8> {
        let start_mark = self.total - self.bytes.len() as u64;
        let skip = since.saturating_sub(start_mark).min(self.bytes.len() as u64) as usize;
        self.bytes.iter().skip(skip).copied().collect()
    }
}

/// Decode `chunk` after the bytes `carry` held back; keep an incomplete
/// trailing sequence in `carry`. Invalid bytes become U+FFFD.
pub fn decode_utf8(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut out = String::new();
    let mut rest: &[u8] = carry;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                rest = &[];
                break;
            }
            Err(e) => {
                let (valid, after) = rest.split_at(e.valid_up_to());
                // SAFETY-free: `valid_up_to` marks a valid prefix.
                out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        rest = &after[n..];
                    }
                    None => {
                        rest = after;
                        break;
                    }
                }
            }
        }
    }
    *carry = rest.to_vec();
    out
}

/// Terminal output as plain text: escape sequences dropped, `\r` overwrites
/// treated as the line's final state, backspaces applied.
pub fn plain_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut cleaned = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    // CSI: parameters and intermediates, then one final byte in @..~.
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('_') | Some('^') => {
                    // OSC / DCS / APC / PM: up to BEL or ST (ESC \).
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(') | Some(')') | Some('#') => {
                    chars.next();
                }
                _ => {}
            },
            '\u{8}' => {
                cleaned.pop();
            }
            '\u{7}' => {}
            c => cleaned.push(c),
        }
    }
    cleaned
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            line.rsplit('\r').next().unwrap_or(line).to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The last `lines` lines of `text` (all of it when it has fewer).
pub fn tail_lines(text: &str, lines: usize) -> String {
    let trimmed = text.trim_end_matches('\n');
    let all: Vec<&str> = trimmed.split('\n').collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

pub struct Pty {
    pub id: u64,
    pub window: String,
    pub owner: Owner,
    title: String,
    cwd: String,
    pid: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    ring: Mutex<Ring>,
    /// Signalled on every output chunk and on exit.
    activity: Condvar,
    sink: Mutex<Option<Sink>>,
    exit: Mutex<Option<Option<u32>>>,
    closed: std::sync::atomic::AtomicBool,
}

impl Pty {
    pub fn info(&self) -> TabInfo {
        let exit = *self.exit.lock().unwrap();
        TabInfo {
            id: self.id,
            title: self.title.clone(),
            owner: self.owner,
            cwd: self.cwd.clone(),
            running: exit.is_none(),
            exit_code: exit.flatten(),
        }
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        if self.exit.lock().unwrap().is_some() {
            return Err("This terminal's shell has exited".into());
        }
        let mut w = self.writer.lock().unwrap();
        w.write_all(data).and_then(|_| w.flush()).map_err(|e| format!("Could not write to the terminal: {e}"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
        self.master.lock().unwrap().resize(size).map_err(|e| e.to_string())
    }

    /// Mark of the output written so far, for `output_since`.
    pub fn mark(&self) -> u64 {
        self.ring.lock().unwrap().total
    }

    pub fn output_since(&self, mark: u64) -> Vec<u8> {
        self.ring.lock().unwrap().since(mark)
    }

    pub fn has_exited(&self) -> bool {
        self.exit.lock().unwrap().is_some()
    }

    /// Wait until output stops arriving for `quiet` (after at least one chunk
    /// past `mark`), the shell exits, or `max` elapses.
    pub fn wait_settled(&self, mark: u64, quiet: Duration, max: Duration) {
        let deadline = Instant::now() + max;
        let mut ring = self.ring.lock().unwrap();
        let mut last_total = ring.total;
        let mut last_change = Instant::now();
        loop {
            let now = Instant::now();
            if now >= deadline || self.has_exited() {
                return;
            }
            if ring.total > mark && now.duration_since(last_change) >= quiet {
                return;
            }
            let step = (deadline - now).min(quiet);
            ring = self.activity.wait_timeout(ring, step).unwrap().0;
            if ring.total != last_total {
                last_total = ring.total;
                last_change = Instant::now();
            }
        }
    }

    /// Send replay of the kept output, then live output, to `sink`.
    pub fn attach(&self, sink: Sink) {
        // Hold the ring lock across replay and install so no chunk is lost or doubled.
        let ring = self.ring.lock().unwrap();
        let replay = ring.since(0);
        if !replay.is_empty() {
            sink(PtyEvent::Data { data: String::from_utf8_lossy(&replay).into_owned() });
        }
        if let Some(code) = *self.exit.lock().unwrap() {
            sink(PtyEvent::Exit { code });
        }
        *self.sink.lock().unwrap() = Some(sink);
        drop(ring);
    }

    pub fn detach(&self) {
        *self.sink.lock().unwrap() = None;
    }

    /// Hang up every process of the shell's session; SIGKILL what is left
    /// after `grace`. Blocking for up to `grace`.
    pub fn close(&self, grace: Duration) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.detach();
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            let members = session_members(pid as i32);
            signal_all(pid as i32, &members, libc::SIGHUP);
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline && !session_members(pid as i32).is_empty() {
                std::thread::sleep(Duration::from_millis(20));
            }
            let left = session_members(pid as i32);
            signal_all(pid as i32, &left, libc::SIGKILL);
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

/// Every live process whose session id is `sid` (the shell's pid).
#[cfg(target_os = "macos")]
pub fn session_members(sid: i32) -> Vec<i32> {
    let mut pids = vec![0i32; 8192];
    // SAFETY: the buffer is sized in bytes as the call expects.
    let n = unsafe {
        libc::proc_listallpids(pids.as_mut_ptr() as *mut libc::c_void, (pids.len() * std::mem::size_of::<i32>()) as i32)
    };
    if n <= 0 {
        return Vec::new();
    }
    pids.truncate(n as usize);
    pids.into_iter()
        .filter(|&p| p > 0)
        // SAFETY: plain syscall on a pid; -1 for one that is gone.
        .filter(|&p| unsafe { libc::getsid(p) } == sid)
        .filter(|&p| !is_zombie(p))
        .collect()
}

#[cfg(target_os = "macos")]
fn is_zombie(pid: i32) -> bool {
    // SAFETY: zeroed proc_bsdinfo is a valid out-parameter.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: the buffer is exactly one proc_bsdinfo.
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    n == size && info.pbi_status == libc::SZOMB
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn session_members(sid: i32) -> Vec<i32> {
    let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
    dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<i32>().ok())
        // SAFETY: plain syscall on a pid.
        .filter(|&p| unsafe { libc::getsid(p) } == sid)
        .collect()
}

#[cfg(unix)]
fn signal_all(sid: i32, members: &[i32], sig: i32) {
    // SAFETY: kill(2) on pids and the shell's group; errors (ESRCH) are ignored.
    unsafe {
        libc::kill(-sid, sig);
        for &p in members {
            libc::kill(p, sig);
        }
    }
}

pub struct OpenSpec<'a> {
    pub window: &'a str,
    pub owner: Owner,
    pub cwd: &'a Path,
    pub env: &'a HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    /// Program to run instead of the login shell (tests).
    pub program: Option<(&'a str, &'a [&'a str])>,
}

#[derive(Default)]
pub struct PtyManager {
    tabs: Mutex<HashMap<u64, Arc<Pty>>>,
    next: AtomicU64,
    /// Agent tabs opened so far per window, for their titles.
    agent_counts: Mutex<HashMap<String, u64>>,
}

/// The user's shell from the login environment, `/bin/zsh` otherwise.
pub fn user_shell(env: &HashMap<String, String>) -> String {
    env.get("SHELL")
        .filter(|s| Path::new(s.as_str()).is_absolute() && Path::new(s.as_str()).exists())
        .cloned()
        .unwrap_or_else(|| "/bin/zsh".into())
}

impl PtyManager {
    pub fn open(&self, spec: OpenSpec<'_>) -> Result<Arc<Pty>, String> {
        let size = PtySize { rows: spec.rows.max(1), cols: spec.cols.max(1), pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(|e| format!("Could not open a terminal: {e}"))?;
        let shell = user_shell(spec.env);
        let mut cmd = match spec.program {
            Some((program, args)) => {
                let mut c = CommandBuilder::new(program);
                c.args(args);
                c
            }
            None => {
                let mut c = CommandBuilder::new(&shell);
                c.arg("-l");
                c
            }
        };
        cmd.env_clear();
        for (k, v) in spec.env {
            cmd.env(k, v);
        }
        cmd.env("SHELL", &shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Keryx");
        cmd.env_remove("TERM_PROGRAM_VERSION");
        cmd.cwd(spec.cwd);
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Could not start {shell}: {e}"))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let title = match spec.owner {
            Owner::User => Path::new(&shell).file_name().and_then(|s| s.to_str()).unwrap_or("shell").to_string(),
            Owner::Agent => {
                let mut counts = self.agent_counts.lock().unwrap();
                let n = counts.entry(spec.window.to_string()).or_default();
                *n += 1;
                if *n == 1 { "agent".to_string() } else { format!("agent {n}") }
            }
        };
        let pty = Arc::new(Pty {
            id,
            window: spec.window.to_string(),
            owner: spec.owner,
            title,
            cwd: spec.cwd.display().to_string(),
            pid: child.process_id(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(child.clone_killer()),
            ring: Mutex::new(Ring::new(RING_BYTES)),
            activity: Condvar::new(),
            sink: Mutex::new(None),
            exit: Mutex::new(None),
            closed: Default::default(),
        });
        spawn_reader(pty.clone(), reader, move || child.wait().ok().map(|s| s.exit_code()));
        self.tabs.lock().unwrap().insert(id, pty.clone());
        Ok(pty)
    }

    pub fn get(&self, window: &str, id: u64) -> Result<Arc<Pty>, String> {
        self.tabs
            .lock()
            .unwrap()
            .get(&id)
            .filter(|p| p.window == window)
            .cloned()
            .ok_or_else(|| format!("No terminal tab {id} in this window"))
    }

    pub fn list(&self, window: &str) -> Vec<TabInfo> {
        let mut out: Vec<TabInfo> =
            self.tabs.lock().unwrap().values().filter(|p| p.window == window).map(|p| p.info()).collect();
        out.sort_by_key(|t| t.id);
        out
    }

    /// Close one tab (blocking up to the hang-up grace).
    pub fn close(&self, window: &str, id: u64) {
        let pty = {
            let mut tabs = self.tabs.lock().unwrap();
            match tabs.get(&id) {
                Some(p) if p.window == window => tabs.remove(&id),
                _ => None,
            }
        };
        if let Some(p) = pty {
            p.close(HANGUP_GRACE);
        }
    }

    fn take_where(&self, keep: impl Fn(&Pty) -> bool) -> Vec<Arc<Pty>> {
        let mut tabs = self.tabs.lock().unwrap();
        let ids: Vec<u64> = tabs.iter().filter(|(_, p)| !keep(p)).map(|(id, _)| *id).collect();
        ids.into_iter().filter_map(|id| tabs.remove(&id)).collect()
    }

    /// Every tab of a destroyed window, closed in parallel on background threads.
    pub fn close_window(&self, window: &str) {
        for p in self.take_where(|p| p.window != window) {
            std::thread::spawn(move || p.close(HANGUP_GRACE));
        }
    }

    /// App quit: close every tab in parallel and wait for all of them.
    pub fn close_all(&self) {
        let handles: Vec<_> = self
            .take_where(|_| false)
            .into_iter()
            .map(|p| std::thread::spawn(move || p.close(HANGUP_GRACE)))
            .collect();
        for h in handles {
            let _ = h.join();
        }
    }
}

fn spawn_reader(pty: Arc<Pty>, mut reader: Box<dyn Read + Send>, wait: impl FnOnce() -> Option<u32> + Send + 'static) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let mut carry = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    let ring = {
                        let mut ring = pty.ring.lock().unwrap();
                        ring.push(chunk);
                        ring
                    };
                    let text = decode_utf8(&mut carry, chunk);
                    // Send under the ring lock so `attach` never sees a chunk twice or misses one.
                    if !text.is_empty() {
                        if let Some(sink) = pty.sink.lock().unwrap().as_ref() {
                            sink(PtyEvent::Data { data: text });
                        }
                    }
                    drop(ring);
                    pty.activity.notify_all();
                }
            }
        }
        let code = wait();
        {
            let _ring = pty.ring.lock().unwrap();
            *pty.exit.lock().unwrap() = Some(code);
            if let Some(sink) = pty.sink.lock().unwrap().as_ref() {
                sink(PtyEvent::Exit { code });
            }
        }
        pty.activity.notify_all();
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn env() -> HashMap<String, String> {
        std::env::vars().collect()
    }

    fn collect(pty: &Pty) -> mpsc::Receiver<PtyEvent> {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        pty.attach(Box::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        }));
        rx
    }

    fn read_until(rx: &mpsc::Receiver<PtyEvent>, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut all = String::new();
        while Instant::now() < deadline {
            if let Ok(PtyEvent::Data { data }) = rx.recv_timeout(Duration::from_millis(100)) {
                all.push_str(&data);
                if all.contains(needle) {
                    return all;
                }
            }
        }
        panic!("never saw {needle:?}; got {all:?}");
    }

    fn open_sh(mgr: &PtyManager, window: &str, dir: &Path, owner: Owner) -> Arc<Pty> {
        mgr.open(OpenSpec {
            window,
            owner,
            cwd: dir,
            env: &env(),
            cols: 80,
            rows: 24,
            program: Some(("/bin/sh", &[])),
        })
        .unwrap()
    }

    #[test]
    fn decode_utf8_holds_back_a_split_sequence() {
        let mut carry = Vec::new();
        let bytes = "ж!".as_bytes();
        assert_eq!(decode_utf8(&mut carry, &bytes[..1]), "");
        assert_eq!(decode_utf8(&mut carry, &bytes[1..]), "ж!");
        assert!(carry.is_empty());
        assert_eq!(decode_utf8(&mut carry, b"a\xffb"), "a\u{FFFD}b");
    }

    #[test]
    fn plain_text_drops_escapes_and_applies_carriage_returns() {
        let raw = b"\x1b[1;32mok\x1b[0m\r\n\x1b]0;title\x0750%\r100%\r\nab\x08c\n";
        assert_eq!(plain_text(raw), "ok\n100%\nac\n");
        assert_eq!(tail_lines("a\nb\nc\n", 2), "b\nc");
    }

    #[test]
    fn ring_keeps_the_tail_and_counts_everything() {
        let mut r = Ring::new(4);
        r.push(b"abc");
        r.push(b"def");
        assert_eq!(r.total, 6);
        assert_eq!(r.since(0), b"cdef");
        assert_eq!(r.since(4), b"ef");
        r.push(b"0123456789");
        assert_eq!(r.since(0), b"6789");
    }

    #[test]
    fn pty_runs_in_the_cwd_with_the_env_and_replays_on_attach() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PtyManager::default();
        let pty = open_sh(&mgr, "w", dir.path(), Owner::User);
        let rx = collect(&pty);
        pty.write(b"pwd; echo \"T=$TERM\"; echo done-$((0+1))\n").unwrap();
        let out = read_until(&rx, "done-1\r\n");
        let real = std::fs::canonicalize(dir.path()).unwrap();
        assert!(out.contains(real.to_str().unwrap()) || out.contains(dir.path().to_str().unwrap()), "{out}");
        assert!(out.contains("T=xterm-256color"), "{out}");
        // A second view gets the kept output first.
        let rx2 = collect(&pty);
        let replay = read_until(&rx2, "done-1");
        assert!(replay.contains("T=xterm-256color"));
        let plain = plain_text(&pty.output_since(0));
        assert!(plain.contains("done-1"));
        mgr.close("w", pty.id);
        assert!(mgr.list("w").is_empty());
    }

    #[test]
    fn resize_reaches_the_shell() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PtyManager::default();
        let pty = open_sh(&mgr, "w", dir.path(), Owner::User);
        let rx = collect(&pty);
        pty.resize(120, 40).unwrap();
        pty.write(b"stty size; echo done-$((1+1))\n").unwrap();
        let out = read_until(&rx, "done-2\r\n");
        assert!(out.contains("40 120"), "{out}");
        mgr.close_all();
    }

    #[test]
    fn closing_a_tab_kills_background_and_foreground_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PtyManager::default();
        let pty = open_sh(&mgr, "w", dir.path(), Owner::User);
        let rx = collect(&pty);
        // A job-control shell would give the foreground job its own group; set -m forces that here.
        pty.write(b"set -m; sleep 301 & echo started; sleep 302\n").unwrap();
        read_until(&rx, "started");
        std::thread::sleep(Duration::from_millis(300));
        let sid = pty.pid.unwrap() as i32;
        assert!(session_members(sid).len() >= 3, "shell + two sleeps: {:?}", session_members(sid));
        mgr.close("w", pty.id);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && !session_members(sid).is_empty() {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(session_members(sid).is_empty(), "left behind: {:?}", session_members(sid));
    }

    #[test]
    fn exit_is_reported_and_tabs_are_per_window() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PtyManager::default();
        let a = open_sh(&mgr, "w1", dir.path(), Owner::User);
        let b = open_sh(&mgr, "w2", dir.path(), Owner::Agent);
        assert!(mgr.get("w2", a.id).is_err());
        assert_eq!(mgr.list("w2")[0].title, "agent");
        let rx = collect(&a);
        a.write(b"exit 3\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut code = None;
        while Instant::now() < deadline {
            if let Ok(PtyEvent::Exit { code: c }) = rx.recv_timeout(Duration::from_millis(100)) {
                code = Some(c);
                break;
            }
        }
        assert_eq!(code, Some(Some(3)));
        assert!(a.write(b"x").is_err());
        mgr.close_window("w1");
        assert!(mgr.list("w1").is_empty());
        assert_eq!(mgr.list("w2").len(), 1);
        mgr.close("w2", b.id);
    }

    #[test]
    fn wait_settled_returns_after_output_goes_quiet() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PtyManager::default();
        let pty = open_sh(&mgr, "w", dir.path(), Owner::Agent);
        std::thread::sleep(Duration::from_millis(200));
        let mark = pty.mark();
        pty.write(b"echo quiet-test\n").unwrap();
        let start = Instant::now();
        pty.wait_settled(mark, Duration::from_millis(200), Duration::from_secs(5));
        assert!(start.elapsed() < Duration::from_secs(3));
        assert!(plain_text(&pty.output_since(mark)).contains("quiet-test"));
        mgr.close_all();
    }
}
