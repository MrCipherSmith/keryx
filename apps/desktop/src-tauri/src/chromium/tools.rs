//! The panel's `browser_*` agent tools on the Chromium engine (the WebKit
//! engine's versions stay in `panel_mcp`). Same names and arguments, plus what
//! CDP adds: real input, full-page and element screenshots, network.
//!
//! - Acting on a non-local site asks the user first (`consent`, decision 2).
//! - Screenshots go to `.keryx/browser/screenshots/` in the project, which the
//!   app adds to the project's `.gitignore` the first time (decision 7).

use super::consent;
use super::engine;
use super::page::Shot;
use crate::browser;
use crate::panels::PanelRoots;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const ARTEFACTS: &str = ".keryx/browser";
const SETTLE: Duration = Duration::from_secs(5);

fn arg_u64(params: &Value, key: &str) -> Option<u64> {
    params.get("arguments").and_then(|a| a.get(key)).and_then(|v| v.as_u64())
}

fn arg_str<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get("arguments").and_then(|a| a.get(key)).and_then(|v| v.as_str())
}

fn arg_bool(params: &Value, key: &str) -> bool {
    params.get("arguments").and_then(|a| a.get(key)).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// `.keryx/browser/<kind>` in `root`, created, with `.keryx/browser/` ignored by git when the
/// project is a git repository.
pub fn artefact_dir(root: &Path, kind: &str) -> Result<PathBuf, String> {
    let dir = root.join(ARTEFACTS).join(kind);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    if root.join(".git").exists() {
        ensure_ignored(&root.join(".gitignore"))?;
    }
    Ok(dir)
}

/// Add `.keryx/browser/` to a `.gitignore` that does not list it yet.
pub fn ensure_ignored(gitignore: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(gitignore).unwrap_or_default();
    let listed = text.lines().map(str::trim).any(|l| l == ".keryx/browser/" || l == ".keryx/browser" || l == "/.keryx/browser/" || l == ".keryx/" || l == ".keryx");
    if listed {
        return Ok(());
    }
    let mut next = text;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# Keryx browser panel: screenshots, recordings, run reports\n.keryx/browser/\n");
    std::fs::write(gitignore, next).map_err(|e| format!("Could not update {}: {e}", gitignore.display()))
}

fn stamp() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{ms}")
}

fn pretty(v: &impl serde::Serialize) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn tab_line(app: &AppHandle, window: &str, id: u64) -> String {
    engine::list(app, window).into_iter().find(|t| t.id == id).map(|t| pretty(&t)).unwrap_or_default()
}

/// Run one `browser_*` tool for project view `window`.
pub fn call(app: &AppHandle, window: &str, name: &str, params: &Value) -> Result<String, String> {
    let tab_arg = arg_u64(params, "tab");
    // Every action and every read on a page asks first when the page is not local (decision 2,
    // reads included); the address comes from the browser and is checked again after the answer.
    let guarded = |verb: &str, reveal: bool| -> Result<(u64, std::sync::Arc<super::page::Page>), String> {
        let (id, page) = engine::page(app, window, tab_arg)?;
        consent::confirm_current(app, window, verb, || engine::consent_url(app, window, id))?;
        if reveal {
            engine::reveal(app, window, id);
        }
        Ok((id, page))
    };
    let act = |verb: &str| guarded(verb, true);
    let read = |verb: &str| guarded(verb, false);
    match name {
        "browser_tabs" => Ok(pretty(&engine::list(app, window))),
        "browser_navigate" => {
            let url = browser::normalize_url(arg_str(params, "url").ok_or("url is required")?)?;
            if !browser::page_allowed(&url, crate::navigation::dev_url(app).as_ref()) {
                return Err(format!("The browser panel does not open {url}"));
            }
            consent::confirm(app, window, "open", url.as_str())?;
            let existing = if arg_bool(params, "new_tab") { None } else { engine::page(app, window, tab_arg).ok() };
            let id = match existing {
                Some((id, page)) => {
                    engine::reveal(app, window, id);
                    page.navigate(url.as_str())?;
                    id
                }
                None => {
                    let info = engine::open_tab(app, window, url.as_str())?;
                    engine::reveal(app, window, info.id);
                    info.id
                }
            };
            Ok(tab_line(app, window, id))
        }
        "browser_snapshot" => {
            let (id, page) = read("read")?;
            let snap = page.snapshot()?;
            let (url, title) = page.url_and_title();
            let more = if snap.truncated { "\n[snapshot truncated]" } else { "" };
            Ok(format!("tab {id} — {title} — {url}\n{}{more}", snap.text))
        }
        "browser_click" => {
            let reference = arg_str(params, "ref").ok_or("ref is required")?;
            let (id, page) = act("click")?;
            page.click(reference)?;
            page.wait_ready(SETTLE);
            Ok(format!("done; now {}", tab_line(app, window, id)))
        }
        "browser_hover" => {
            let reference = arg_str(params, "ref").ok_or("ref is required")?;
            let (id, page) = act("hover")?;
            page.hover(reference)?;
            Ok(format!("done; now {}", tab_line(app, window, id)))
        }
        "browser_type" => {
            let reference = arg_str(params, "ref").ok_or("ref is required")?;
            let text = arg_str(params, "text").ok_or("text is required")?;
            let (id, page) = act("type into")?;
            page.type_text(reference, text, arg_bool(params, "submit"))?;
            page.wait_ready(SETTLE);
            Ok(format!("done; now {}", tab_line(app, window, id)))
        }
        "browser_press_key" => {
            let key = arg_str(params, "key").ok_or("key is required")?;
            let (id, page) = act("press keys on")?;
            page.press_key(key)?;
            page.wait_ready(SETTLE);
            Ok(format!("done; now {}", tab_line(app, window, id)))
        }
        "browser_screenshot" => {
            let (id, page) = read("take a screenshot of")?;
            let format = arg_str(params, "format").unwrap_or("png");
            let shot = match (arg_str(params, "ref"), arg_bool(params, "full_page")) {
                (Some(r), _) => Shot::Element(r.to_string()),
                (None, true) => Shot::FullPage,
                (None, false) => Shot::Viewport,
            };
            let bytes = page.screenshot(&shot, format)?;
            let root = app.state::<PanelRoots>().get(window).ok_or("This project has no folder registered")?;
            let ext = match format {
                "jpeg" | "jpg" => "jpg",
                "webp" => "webp",
                _ => "png",
            };
            let path = artefact_dir(&root, "screenshots")?.join(format!("tab-{id}-{}.{ext}", stamp()));
            std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
            let what = match shot {
                Shot::Element(r) => format!("element {r}"),
                Shot::FullPage => "whole page".into(),
                _ => "visible page".into(),
            };
            Ok(format!("Saved a screenshot of the {what} ({} bytes) to {}", bytes.len(), path.display()))
        }
        "browser_console" => {
            let (_, page) = read("read the console of")?;
            let limit = arg_u64(params, "limit").unwrap_or(100).clamp(1, 500) as usize;
            let lines: Vec<String> = page.console(limit).iter().map(|e| format!("[{}] {}", e.level, e.text)).collect();
            Ok(if lines.is_empty() { "No console messages since the tab opened.".into() } else { lines.join("\n") })
        }
        "browser_network" => {
            let (_, page) = read("read the network log of")?;
            if let Some(req) = arg_str(params, "request_id") {
                return page.response_body(req, 20_000);
            }
            let limit = arg_u64(params, "limit").unwrap_or(100).clamp(1, 500) as usize;
            let rows: Vec<String> = page
                .network(limit, arg_str(params, "filter"))
                .iter()
                .map(|n| {
                    let status = n.failed.clone().unwrap_or_else(|| n.status.map(|s| s.to_string()).unwrap_or_else(|| "…".into()));
                    format!("{} {} {} [{}] id={}", n.method, status, n.url, n.resource_type, n.id)
                })
                .collect();
            Ok(if rows.is_empty() { "No requests recorded.".into() } else { rows.join("\n") })
        }
        other => Err(format!("Unknown tool {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_artefact_folder_is_ignored_once() {
        let dir = tempfile::tempdir().unwrap();
        let gi = dir.path().join(".gitignore");
        std::fs::write(&gi, "node_modules/").unwrap();
        ensure_ignored(&gi).unwrap();
        ensure_ignored(&gi).unwrap();
        let text = std::fs::read_to_string(&gi).unwrap();
        assert_eq!(text.matches(".keryx/browser/").count(), 1);
        assert!(text.starts_with("node_modules/\n"));

        let other = dir.path().join("b.gitignore");
        std::fs::write(&other, ".keryx/\n").unwrap();
        ensure_ignored(&other).unwrap();
        assert_eq!(std::fs::read_to_string(&other).unwrap(), ".keryx/\n");
    }

    #[test]
    fn artefacts_go_under_the_project_and_git_learns_to_ignore_them() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        let shots = artefact_dir(dir.path(), "screenshots").unwrap();
        assert!(shots.ends_with(".keryx/browser/screenshots") && shots.is_dir());
        assert!(std::fs::read_to_string(dir.path().join(".gitignore")).unwrap().contains(".keryx/browser/"));

        let plain = tempfile::tempdir().unwrap();
        artefact_dir(plain.path(), "screenshots").unwrap();
        assert!(!plain.path().join(".gitignore").exists());
    }
}
