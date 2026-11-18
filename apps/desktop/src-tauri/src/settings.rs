//! JSON settings in the app config dir, and the commands that read and
//! change them.

use crate::locator::KeryxSource;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const MAX_RECENT: usize = 10;

/// The settings layout version. 1 = decision D-15 (`auto` keryx source).
pub const SETTINGS_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub keryx_source: KeryxSource,
    pub custom_path: Option<String>,
    pub recent_projects: Vec<String>,
    /// Absent (0) in files written before D-15.
    pub settings_version: u32,
}

impl Settings {
    /// Load; a missing or unreadable file yields defaults (never an error: a
    /// corrupt settings file must not stop the app from starting).
    pub fn load(path: &Path) -> Settings {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .unwrap_or_default()
            .migrated()
    }

    /// Bring an older file up to `SETTINGS_VERSION`. Before D-15 the app wrote
    /// its default source (`bundled`) on every save, so a stored `bundled`
    /// there is no choice and becomes `auto`. A later explicit `bundled` stays.
    pub fn migrated(mut self) -> Settings {
        if self.settings_version < 1 && self.keryx_source == KeryxSource::Bundled {
            self.keryx_source = KeryxSource::Auto;
        }
        self.settings_version = SETTINGS_VERSION;
        self
    }

    /// Write atomically (temp file + rename). The temp name is unique to this
    /// write, so a rename never moves another writer's half-written file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        static SAVES: AtomicU64 = AtomicU64::new(0);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let n = SAVES.fetch_add(1, Ordering::Relaxed);
        let tmp = path.with_extension(format!("json.{}-{n}.tmp", std::process::id()));
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        let written = std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, path));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written
    }

    /// Move `project` to the front of the recents, deduplicated and capped.
    pub fn add_recent(&mut self, project: &str) {
        self.recent_projects.retain(|p| p != project);
        self.recent_projects.insert(0, project.to_string());
        self.recent_projects.truncate(MAX_RECENT);
    }
}

/// Held across every load-modify-save of the settings file: the commands run
/// on blocking workers, concurrently, and an unlocked read-modify-write loses
/// the other writer's change.
static SETTINGS_IO: Mutex<()> = Mutex::new(());

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|d| d.join("settings.json")).map_err(|e| e.to_string())
}

pub fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app).map(|p| Settings::load(&p)).unwrap_or_default()
}

/// Load, change and save the file at `path` under the settings lock.
fn update(path: &Path, change: impl FnOnce(&mut Settings)) -> std::io::Result<Settings> {
    let _io = SETTINGS_IO.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = Settings::load(path);
    change(&mut s);
    s.save(path)?;
    Ok(s)
}

/// Replace the user-editable fields; recents are owned by `add_recent`, so a
/// stale form must not clobber them.
fn set_settings(path: &Path, next: Settings) -> std::io::Result<Settings> {
    update(path, move |s| {
        *s = Settings { recent_projects: std::mem::take(&mut s.recent_projects), settings_version: SETTINGS_VERSION, ..next }
    })
}

/// Run blocking settings file I/O off the main thread and the async workers.
async fn settings_io<T: Send + 'static>(
    app: AppHandle,
    io: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || io(&app))
        .await
        .map_err(|e| format!("settings failed: {e}"))?
}

#[tauri::command]
pub async fn settings_get(app: AppHandle) -> Result<Settings, String> {
    settings_io(app, |app| Ok(load_settings(app))).await
}

#[tauri::command]
pub async fn settings_set(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    settings_io(app, move |app| set_settings(&settings_path(app)?, settings).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn settings_add_recent(app: AppHandle, project: String) -> Result<Settings, String> {
    settings_io(app, move |app| update(&settings_path(app)?, |s| s.add_recent(&project)).map_err(|e| e.to_string()))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_corrupt_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let defaults = Settings::default().migrated();
        assert_eq!(defaults.keryx_source, KeryxSource::Auto);
        assert_eq!(Settings::load(&dir.path().join("none.json")), defaults);
        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, "{not json").unwrap();
        assert_eq!(Settings::load(&bad), defaults);
    }

    #[test]
    fn round_trips_with_camel_case_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/settings.json");
        let s = Settings {
            keryx_source: KeryxSource::Custom,
            custom_path: Some("/x/keryx".into()),
            recent_projects: vec!["/p".into()],
            settings_version: SETTINGS_VERSION,
        };
        s.save(&path).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"keryxSource\": \"custom\""));
        assert_eq!(Settings::load(&path), s);
    }

    #[test]
    fn partial_files_fill_in_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.json");
        std::fs::write(&path, "{\"keryxSource\":\"path\"}").unwrap();
        let s = Settings::load(&path);
        assert_eq!(s.keryx_source, KeryxSource::Path);
        assert!(s.recent_projects.is_empty());
    }

    #[test]
    fn a_pre_d10_bundled_default_becomes_auto_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.json");
        std::fs::write(&path, "{\"keryxSource\":\"bundled\",\"recentProjects\":[\"/p\"]}").unwrap();
        let s = Settings::load(&path);
        assert_eq!(s.keryx_source, KeryxSource::Auto);
        assert_eq!(s.settings_version, SETTINGS_VERSION);
        assert_eq!(s.recent_projects, ["/p"]);
        // An explicit choice made after D-15 is kept.
        let chosen = set_settings(&path, Settings { keryx_source: KeryxSource::Bundled, ..Settings::default() }).unwrap();
        assert_eq!(chosen.keryx_source, KeryxSource::Bundled);
        assert_eq!(Settings::load(&path).keryx_source, KeryxSource::Bundled);
        // Other pre-D-15 choices are kept as they were.
        std::fs::write(&path, "{\"keryxSource\":\"custom\",\"customPath\":\"/k\"}").unwrap();
        assert_eq!(Settings::load(&path).keryx_source, KeryxSource::Custom);
    }

    #[test]
    fn recents_are_deduplicated_most_recent_first_and_capped() {
        let mut s = Settings::default();
        for i in 0..15 {
            s.add_recent(&format!("/p{i}"));
        }
        s.add_recent("/p7");
        assert_eq!(s.recent_projects.len(), MAX_RECENT);
        assert_eq!(s.recent_projects[0], "/p7");
        assert_eq!(s.recent_projects.iter().filter(|p| *p == "/p7").count(), 1);
    }

    #[test]
    fn concurrent_updates_lose_nothing_and_leave_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || {
                    if i % 2 == 0 {
                        update(&path, |s| s.add_recent(&format!("/p{i}"))).unwrap();
                    } else {
                        set_settings(&path, Settings { custom_path: Some(format!("/k{i}")), ..Settings::default() }).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let s = Settings::load(&path);
        let mut recents = s.recent_projects.clone();
        recents.sort();
        assert_eq!(recents, ["/p0", "/p2", "/p4", "/p6"], "every recent survives a concurrent settings write");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().filter_map(Result::ok).map(|e| e.file_name()).collect();
        assert_eq!(leftovers, [std::ffi::OsString::from("settings.json")]);
    }

    #[test]
    fn set_keeps_the_recents_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        update(&path, |s| s.add_recent("/a")).unwrap();
        let stale = Settings { keryx_source: KeryxSource::Path, recent_projects: vec!["/stale".into()], ..Settings::default() };
        let saved = set_settings(&path, stale).unwrap();
        assert_eq!(saved.keryx_source, KeryxSource::Path);
        assert_eq!(saved.recent_projects, ["/a"]);
    }
}
