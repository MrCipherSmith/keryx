//! JSON settings in the app config dir.

use crate::locator::KeryxSource;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const MAX_RECENT: usize = 10;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub keryx_source: KeryxSource,
    pub custom_path: Option<String>,
    pub recent_projects: Vec<String>,
}

impl Settings {
    /// Load; a missing or unreadable file yields defaults (never an error: a
    /// corrupt settings file must not stop the app from starting).
    pub fn load(path: &Path) -> Settings {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Write atomically (temp file + rename).
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)
    }

    /// Move `project` to the front of the recents, deduplicated and capped.
    pub fn add_recent(&mut self, project: &str) {
        self.recent_projects.retain(|p| p != project);
        self.recent_projects.insert(0, project.to_string());
        self.recent_projects.truncate(MAX_RECENT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_corrupt_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Settings::load(&dir.path().join("none.json")), Settings::default());
        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, "{not json").unwrap();
        assert_eq!(Settings::load(&bad), Settings::default());
    }

    #[test]
    fn round_trips_with_camel_case_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/settings.json");
        let s = Settings {
            keryx_source: KeryxSource::Custom,
            custom_path: Some("/x/keryx".into()),
            recent_projects: vec!["/p".into()],
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
}
