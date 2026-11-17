//! Per-window change watcher for `.metaproject/flows/*/flow.json`.
//!
//! A 2 s poll over (name, mtime, size) of every `flow.json` rather than
//! filesystem events: it needs no extra crate, works the same on every
//! volume, and a poll tick is already a debounce (a burst of writes inside one
//! interval yields one event). One watcher per window; a second call replaces
//! it, and closing the window stops it.

use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

type Snapshot = HashMap<String, (Option<SystemTime>, u64)>;

/// What changed-detection compares: every flow package the board lists (same
/// rule as `flow_dirs`) with its `flow.json` mtime and size (`None`/0 when the
/// file is missing).
pub fn snapshot(root: &Path) -> Snapshot {
    let Ok(entries) = std::fs::read_dir(root) else { return Snapshot::new() };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| Some((super::package_name(&e)?, e)))
        .map(|(name, e)| {
            let meta = std::fs::metadata(e.path().join("flow.json")).ok();
            (name, (meta.as_ref().and_then(|m| m.modified().ok()), meta.map_or(0, |m| m.len())))
        })
        .collect()
}

struct Watcher {
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct FlowWatchers {
    by_window: Mutex<HashMap<String, Watcher>>,
}

impl FlowWatchers {
    pub fn start(&self, app: AppHandle, label: &str, cwd: &str) -> Result<(), String> {
        let project = Path::new(cwd)
            .canonicalize()
            .map_err(|e| format!("The project folder is not available ({cwd}): {e}"))?;
        let root: PathBuf = project.join(".metaproject/flows");
        let stop = Arc::new(AtomicBool::new(false));
        self.replace(label, Watcher { stop: stop.clone() });

        let label = label.to_string();
        let cwd = cwd.to_string();
        std::thread::spawn(move || {
            let mut last = snapshot(&root);
            while !stop.load(Ordering::SeqCst) {
                // Sleep in short slices so a replaced or closed watcher exits promptly.
                let mut waited = Duration::ZERO;
                while waited < POLL_INTERVAL && !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                    waited += Duration::from_millis(100);
                }
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let now = snapshot(&root);
                if now != last {
                    last = now;
                    let _ = app.emit_to(label.as_str(), "flows://changed", json!({ "cwd": cwd }));
                }
            }
        });
        Ok(())
    }

    fn replace(&self, label: &str, watcher: Watcher) {
        if let Some(old) = self.by_window.lock().unwrap().insert(label.to_string(), watcher) {
            old.stop.store(true, Ordering::SeqCst);
        }
    }

    pub fn stop_window(&self, label: &str) {
        if let Some(old) = self.by_window.lock().unwrap().remove(label) {
            old.stop.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_changes_when_a_flow_json_changes_or_a_flow_appears() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("001-a")).unwrap();
        std::fs::write(root.join("001-a/flow.json"), "{}").unwrap();
        let before = snapshot(root);
        assert_eq!(before, snapshot(root));

        std::fs::write(root.join("001-a/flow.json"), r#"{"status":"done"}"#).unwrap();
        let edited = snapshot(root);
        assert_ne!(before, edited);

        std::fs::create_dir_all(root.join("002-b")).unwrap();
        assert_ne!(edited, snapshot(root));
    }

    #[test]
    fn replacing_or_stopping_a_watcher_signals_the_old_one() {
        let w = FlowWatchers::default();
        let first = Arc::new(AtomicBool::new(false));
        w.replace("project-1", Watcher { stop: first.clone() });
        let second = Arc::new(AtomicBool::new(false));
        w.replace("project-1", Watcher { stop: second.clone() });
        assert!(first.load(Ordering::SeqCst));
        assert!(!second.load(Ordering::SeqCst));
        w.stop_window("project-1");
        assert!(second.load(Ordering::SeqCst));
    }
}
