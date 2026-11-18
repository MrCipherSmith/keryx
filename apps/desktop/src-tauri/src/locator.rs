//! Resolve which keryx binary to run.
//!
//! * `auto` (the default, decision D-15): `keryx` on `PATH` — the npm install,
//!   so `npm i -g` updates the agent without a new app — and the bundled
//!   sidecar when there is none.
//! * `bundled`: the sidecar Tauri places next to the main executable
//!   (`Keryx.app/Contents/MacOS/keryx`; `target/<profile>/keryx` in dev).
//!   Tauri strips the `-<target-triple>` suffix when it copies an
//!   `externalBin`, so the runtime name is plain `keryx`.
//! * `path`: `keryx` found on `PATH` (the login-shell PATH, not the minimal
//!   Finder environment).
//! * `custom`: an explicit file chosen in Settings.
//!
//! A missing bundled sidecar falls back to `PATH` with a note, so a dev build
//! without a sidecar still works for anyone who has keryx installed.

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub const SIDECAR_NAME: &str = "keryx";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum KeryxSource {
    #[default]
    Auto,
    Bundled,
    Path,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub path: PathBuf,
    /// The source actually used (may differ from the requested one after a fallback).
    pub source: KeryxSource,
    pub note: Option<String>,
}

fn is_executable_file(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Search the absolute entries of `path_var` for an executable called `name`.
/// Relative (and empty) entries are skipped: they resolve against the current
/// directory, which must never supply the program.
pub fn which(name: &str, path_var: Option<&OsStr>) -> Option<PathBuf> {
    let path_var = path_var?;
    std::env::split_paths(path_var)
        .filter(|d| d.is_absolute())
        .map(|d| d.join(name))
        .find(|c| is_executable_file(c))
}

fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}

/// The keryx bundled with the app, when the file is there.
pub fn bundled(exe_dir: Option<&Path>) -> Option<PathBuf> {
    exe_dir.map(|d| d.join(SIDECAR_NAME)).filter(|p| is_executable_file(p))
}

/// The keryx to run for `source`. `prefer_bundled` (Automatic only) skips `PATH`: the app found
/// the keryx there too old to serve it and starts again on the bundled one.
pub fn locate_for_app(
    source: KeryxSource,
    custom_path: Option<&str>,
    exe_dir: Option<&Path>,
    path_var: Option<&OsStr>,
    prefer_bundled: bool,
) -> Result<Located, String> {
    if prefer_bundled && source == KeryxSource::Auto {
        if let Some(path) = bundled(exe_dir) {
            return Ok(Located { path, source: KeryxSource::Bundled, note: None });
        }
    }
    locate(source, custom_path, exe_dir, path_var)
}

/// Automatic picked `PATH` and a bundled keryx exists: the app may fall back to it.
pub fn can_fall_back(source: KeryxSource, located: &Located, exe_dir: Option<&Path>) -> bool {
    source == KeryxSource::Auto && located.source == KeryxSource::Path && bundled(exe_dir).is_some()
}

pub fn locate(
    source: KeryxSource,
    custom_path: Option<&str>,
    exe_dir: Option<&Path>,
    path_var: Option<&OsStr>,
) -> Result<Located, String> {
    match source {
        KeryxSource::Auto => {
            if let Some(path) = which(SIDECAR_NAME, path_var) {
                return Ok(Located { path, source: KeryxSource::Path, note: None });
            }
            match exe_dir.map(|d| d.join(SIDECAR_NAME)).filter(|p| is_executable_file(p)) {
                Some(path) => Ok(Located {
                    path,
                    source: KeryxSource::Bundled,
                    note: Some("No keryx on PATH; using the keryx bundled with the app. `npm i -g @mrciphersmith/keryx` installs one that updates on its own.".to_string()),
                }),
                None => Err("No `keryx` is on PATH and the bundled keryx was not found next to the app.".to_string()),
            }
        }
        KeryxSource::Custom => {
            let raw = custom_path
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Settings select a custom keryx path, but none is set.".to_string())?;
            let p = expand_home(raw);
            if is_executable_file(&p) {
                Ok(Located { path: p, source, note: None })
            } else {
                Err(format!("The custom keryx path is not an executable file: {}", p.display()))
            }
        }
        KeryxSource::Path => which(SIDECAR_NAME, path_var)
            .map(|path| Located { path, source, note: None })
            .ok_or_else(|| "No `keryx` was found on PATH.".to_string()),
        KeryxSource::Bundled => {
            if let Some(dir) = exe_dir {
                let p = dir.join(SIDECAR_NAME);
                if is_executable_file(&p) {
                    return Ok(Located { path: p, source, note: None });
                }
            }
            match which(SIDECAR_NAME, path_var) {
                Some(path) => Ok(Located {
                    path,
                    source: KeryxSource::Path,
                    note: Some("The bundled keryx was not found; using keryx from PATH.".to_string()),
                }),
                None => Err("The bundled keryx was not found next to the app and no `keryx` is on PATH.".to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_exec(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    #[test]
    fn auto_is_the_default_and_prefers_path() {
        assert_eq!(KeryxSource::default(), KeryxSource::Auto);
        let exe = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        make_exec(exe.path(), "keryx");
        let on_path = make_exec(bin.path(), "keryx");
        let path_var = std::env::join_paths([bin.path()]).unwrap();
        let got = locate(KeryxSource::Auto, None, Some(exe.path()), Some(&path_var)).unwrap();
        assert_eq!(got.path, on_path);
        assert_eq!(got.source, KeryxSource::Path);
        assert!(got.note.is_none());
    }

    #[test]
    fn auto_falls_back_to_the_sidecar_with_a_note() {
        let exe = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let sidecar = make_exec(exe.path(), "keryx");
        let path_var = std::env::join_paths([bin.path()]).unwrap();
        let got = locate(KeryxSource::Auto, None, Some(exe.path()), Some(&path_var)).unwrap();
        assert_eq!(got.path, sidecar);
        assert_eq!(got.source, KeryxSource::Bundled);
        assert!(got.note.is_some());
        assert!(locate(KeryxSource::Auto, None, Some(bin.path()), Some(&path_var)).is_err());
    }

    #[test]
    fn prefer_bundled_skips_path_only_for_auto() {
        let bin = tempfile::tempdir().unwrap();
        make_exec(bin.path(), "keryx");
        let exe = tempfile::tempdir().unwrap();
        let sidecar = make_exec(exe.path(), "keryx");
        let path_var = std::env::join_paths([bin.path()]).unwrap();
        let auto = locate(KeryxSource::Auto, None, Some(exe.path()), Some(&path_var)).unwrap();
        assert!(can_fall_back(KeryxSource::Auto, &auto, Some(exe.path())));
        let got = locate_for_app(KeryxSource::Auto, None, Some(exe.path()), Some(&path_var), true).unwrap();
        assert_eq!((got.path, got.source), (sidecar, KeryxSource::Bundled));
        let path_only = locate_for_app(KeryxSource::Path, None, Some(exe.path()), Some(&path_var), true).unwrap();
        assert_eq!(path_only.source, KeryxSource::Path);
        assert!(!can_fall_back(KeryxSource::Path, &path_only, Some(exe.path())));
    }

    #[test]
    fn auto_serializes_as_lowercase() {
        assert_eq!(serde_json::to_string(&KeryxSource::Auto).unwrap(), "\"auto\"");
    }

    #[test]
    fn bundled_prefers_the_file_next_to_the_executable() {
        let exe = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let sidecar = make_exec(exe.path(), "keryx");
        make_exec(bin.path(), "keryx");
        let path_var = std::env::join_paths([bin.path()]).unwrap();
        let got = locate(KeryxSource::Bundled, None, Some(exe.path()), Some(&path_var)).unwrap();
        assert_eq!(got.path, sidecar);
        assert_eq!(got.source, KeryxSource::Bundled);
        assert!(got.note.is_none());
    }

    #[test]
    fn bundled_falls_back_to_path_with_a_note() {
        let exe = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let on_path = make_exec(bin.path(), "keryx");
        let path_var = std::env::join_paths([bin.path()]).unwrap();
        let got = locate(KeryxSource::Bundled, None, Some(exe.path()), Some(&path_var)).unwrap();
        assert_eq!(got.path, on_path);
        assert_eq!(got.source, KeryxSource::Path);
        assert!(got.note.is_some());
    }

    #[test]
    fn bundled_errors_when_nothing_is_found() {
        let exe = tempfile::tempdir().unwrap();
        assert!(locate(KeryxSource::Bundled, None, Some(exe.path()), None).is_err());
    }

    #[test]
    fn path_source_ignores_the_sidecar() {
        let exe = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        make_exec(exe.path(), "keryx");
        let on_path = make_exec(bin.path(), "keryx");
        let path_var = std::env::join_paths([bin.path()]).unwrap();
        let got = locate(KeryxSource::Path, None, Some(exe.path()), Some(&path_var)).unwrap();
        assert_eq!(got.path, on_path);
    }

    #[test]
    fn path_source_errors_without_keryx_on_path() {
        let bin = tempfile::tempdir().unwrap();
        let path_var = std::env::join_paths([bin.path()]).unwrap();
        assert!(locate(KeryxSource::Path, None, None, Some(&path_var)).is_err());
    }

    #[test]
    fn custom_requires_an_executable_file() {
        let dir = tempfile::tempdir().unwrap();
        let exe = make_exec(dir.path(), "wrapper.sh");
        let got = locate(KeryxSource::Custom, exe.to_str(), None, None).unwrap();
        assert_eq!(got.path, exe);
        assert!(locate(KeryxSource::Custom, Some("/definitely/not/here"), None, None).is_err());
        assert!(locate(KeryxSource::Custom, None, None, None).is_err());
        assert!(locate(KeryxSource::Custom, Some("  "), None, None).is_err());
        // A directory is not an executable file.
        assert!(locate(KeryxSource::Custom, dir.path().to_str(), None, None).is_err());
    }

    #[test]
    fn relative_path_entries_are_never_searched() {
        let bin = tempfile::tempdir().unwrap();
        make_exec(bin.path(), "keryx");
        // A relative entry that does resolve to `bin` from the test's working
        // directory (`..` stops at `/`), so only the absolute-entry rule refuses it.
        let rel = format!("{}{}", "../".repeat(64), bin.path().strip_prefix("/").unwrap().display());
        assert!(Path::new(&rel).join("keryx").exists(), "the relative entry must point at the real file");
        assert!(which("keryx", Some(OsStr::new(&rel))).is_none());
        assert!(locate(KeryxSource::Path, None, None, Some(OsStr::new(&rel))).is_err());
        let abs = std::env::join_paths([bin.path()]).unwrap();
        assert!(which("keryx", Some(&abs)).is_some());
    }

    #[test]
    fn non_executable_file_is_not_found_on_path() {
        let bin = tempfile::tempdir().unwrap();
        fs::write(bin.path().join("keryx"), "x").unwrap();
        let path_var = std::env::join_paths([bin.path()]).unwrap();
        assert!(which("keryx", Some(&path_var)).is_none());
    }
}
