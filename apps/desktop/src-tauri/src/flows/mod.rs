//! The Flows board backend: read `.metaproject/flows/*` of the open project,
//! run an allowlisted set of `keryx flow` mutations, and watch for changes.
//!
//! Reads never leave `<cwd>/.metaproject/flows/` (canonicalized, so a symlink
//! cannot lead elsewhere). Writes are never done here: they go through the
//! keryx binary (see `actions`).

pub mod actions;
pub mod parse;
pub mod watch;

use crate::bridge::{self, AppState};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const MAX_FILE_BYTES: u64 = 512 * 1024;
const FLOWS_SUBDIR: &str = ".metaproject/flows";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowCard {
    pub id: String,
    /// False when `id` is not 1 to 9 digits: the card stays visible, but the UI
    /// must not build a command from the id.
    pub id_valid: bool,
    /// The package directory name under `.metaproject/flows`: the unique key of a
    /// flow (ids are shared across packages) and what every action addresses.
    pub dir: String,
    pub title: String,
    pub status: String,
    pub previous_status: Option<String>,
    pub blocked: bool,
    pub owner: Option<String>,
    pub pr_url: Option<String>,
    pub base_branch: Option<String>,
    pub tasks_done: usize,
    pub tasks_total: usize,
    pub ac_total: usize,
    pub ac_confirmed: usize,
    pub updated_at: Option<String>,
    pub completion_exceptions: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Confirmation {
    pub at: String,
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Criterion {
    pub id: String,
    pub text: String,
    pub verify: Option<String>,
    pub kind: Option<String>,
    pub confirmed: Option<Confirmation>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Attempt {
    pub at: String,
    pub outcome: String,
    pub detail: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub depends_on: Vec<String>,
    pub attempts: usize,
    pub last_attempt: Option<Attempt>,
    pub disposition: Option<String>,
    pub disposition_reason: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct JournalEntry {
    pub at: String,
    pub event: String,
    pub detail: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct FlowDocs {
    pub description: Option<String>,
    pub plan: Option<String>,
    pub context: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlowDetail {
    pub card: FlowCard,
    pub criteria: Vec<Criterion>,
    pub tasks: Vec<TaskRow>,
    pub journal: Vec<JournalEntry>,
    pub docs: FlowDocs,
    pub signatures: Vec<Value>,
    pub completion_attempts: Vec<Value>,
}

/// `<cwd>/.metaproject/flows`, canonical and proven to sit inside `cwd`.
/// `Ok(None)` when the project has no flows folder.
pub fn flows_root(cwd: &Path) -> Result<Option<PathBuf>, String> {
    let project = cwd.canonicalize().map_err(|e| format!("The project folder is not available ({}): {e}", cwd.display()))?;
    let root = match project.join(FLOWS_SUBDIR).canonicalize() {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot read {FLOWS_SUBDIR}: {e}")),
    };
    if !root.starts_with(&project) || !root.is_dir() {
        return Err(format!("{FLOWS_SUBDIR} resolves outside the project"));
    }
    Ok(Some(root))
}

/// Read `name` inside `dir` as text; `None` when missing, too large, or it
/// resolves outside `dir`.
fn read_inside(dir: &Path, name: &str) -> Option<String> {
    let path = dir.join(name).canonicalize().ok()?;
    if !path.starts_with(dir) {
        return None;
    }
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

/// The package name of `entry` when it is a flow package keryx would list: a
/// real directory (a symlink is not, as in keryx's `listFlowDirs`, which reads
/// the entry type without following links) with a package-shaped name.
pub(crate) fn package_name(entry: &std::fs::DirEntry) -> Option<String> {
    let name = entry.file_name().to_str()?.to_string();
    let is_real_dir = entry.file_type().is_ok_and(|t| t.is_dir());
    (is_real_dir && actions::is_flow_dir_name(&name)).then_some(name)
}

/// Flow packages under `root` (name, canonical path), sorted by name. Only what
/// keryx itself lists as a flow is returned: anything else (a file, a symlink,
/// a folder with another name) is never shown and never offered an action.
fn flow_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut dirs: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = package_name(&e)?;
            let path = e.path().canonicalize().ok()?;
            path.starts_with(root).then_some((name, path))
        })
        .collect();
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    dirs
}

/// The card of one package, with its parsed `flow.json` when that parsed.
fn card_for(name: &str, dir: &Path) -> (FlowCard, Option<Value>) {
    let Some(text) = read_inside(dir, "flow.json") else {
        return (parse::broken_card(name, "flow.json is missing, unreadable or too large".to_string()), None);
    };
    let flow = match parse::parse_flow_json(&text) {
        Ok(flow) => flow,
        Err(e) => return (parse::broken_card(name, e), None),
    };
    let criteria_total = read_inside(dir, "acceptance-criteria.md")
        .map(|md| parse::parse_criteria(&md, &Default::default(), &Default::default()).len());
    (parse::card_from_value(&flow, name, criteria_total), Some(flow))
}

pub fn list_flows(cwd: &Path) -> Result<Vec<FlowCard>, String> {
    let Some(root) = flows_root(cwd)? else { return Ok(Vec::new()) };
    Ok(flow_dirs(&root).iter().map(|(name, dir)| card_for(name, dir).0).collect())
}

/// Read one flow by its directory name (exact match, never by id).
pub fn get_flow(cwd: &Path, dir_name: &str) -> Result<FlowDetail, String> {
    actions::validate_flow_dir(dir_name)?;
    let root = flows_root(cwd)?.ok_or_else(|| format!("This project has no {FLOWS_SUBDIR} folder"))?;
    for (name, dir) in flow_dirs(&root) {
        if name != dir_name {
            continue;
        }
        // flow.json is parsed once, for the card and the body alike.
        let (card, flow) = card_for(&name, &dir);
        let body = flow.as_ref().map(parse::body_from_value);
        let (kinds, confirmed) = body.as_ref().map(|b| (b.kinds.clone(), b.confirmed.clone())).unwrap_or_default();
        let criteria = read_inside(&dir, "acceptance-criteria.md")
            .map(|md| parse::parse_criteria(&md, &kinds, &confirmed))
            .unwrap_or_default();
        let journal_md = read_inside(&dir, "journal.md").map(|md| parse::parse_journal(&md)).unwrap_or_default();
        let (tasks, signatures, completion_attempts, history) = match body {
            Some(b) => (b.tasks, b.signatures, b.completion_attempts, b.history),
            None => Default::default(),
        };
        return Ok(FlowDetail {
            card,
            criteria,
            tasks,
            journal: parse::merge_journal(journal_md, history),
            docs: FlowDocs {
                description: read_inside(&dir, "description.md"),
                plan: read_inside(&dir, "plan.md"),
                context: read_inside(&dir, "context.md"),
            },
            signatures,
            completion_attempts,
        });
    }
    Err(format!("Flow {dir_name} was not found"))
}

/// Refuse unless `dir_name` is one existing flow directory under `cwd`.
pub fn require_flow_dir(cwd: &Path, dir_name: &str) -> Result<(), String> {
    actions::validate_flow_dir(dir_name)?;
    let root = flows_root(cwd)?.ok_or_else(|| format!("This project has no {FLOWS_SUBDIR} folder"))?;
    if flow_dirs(&root).iter().any(|(name, _)| name == dir_name) {
        Ok(())
    } else {
        Err(format!("Flow {dir_name} was not found"))
    }
}

#[tauri::command]
pub async fn flows_list(cwd: String) -> Result<Vec<FlowCard>, String> {
    tauri::async_runtime::spawn_blocking(move || list_flows(Path::new(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn flows_get(cwd: String, dir: String) -> Result<FlowDetail, String> {
    tauri::async_runtime::spawn_blocking(move || get_flow(Path::new(&cwd), &dir))
        .await
        .map_err(|e| e.to_string())?
}

/// The argv for `action` on the package `dir` of the project at `cwd`, or why
/// it is refused. Validates before anything is resolved or spawned, and the
/// directory must be exactly one existing package: a name that does not
/// resolve here would otherwise be handed to keryx as a fuzzy reference.
pub fn prepare_action(cwd: &Path, dir: &str, action: &actions::FlowAction) -> Result<Vec<String>, String> {
    let argv = actions::build_argv(dir, action)?;
    require_flow_dir(cwd, dir)?;
    Ok(argv)
}

#[tauri::command]
pub async fn flows_action(
    app: AppHandle,
    cwd: String,
    dir: String,
    action: actions::FlowAction,
) -> Result<actions::ActionResult, String> {
    // Everything here blocks (the listing, the first login-env capture, the
    // settings file, keryx itself): none of it runs on an async worker.
    tauri::async_runtime::spawn_blocking(move || {
        let argv = prepare_action(Path::new(&cwd), &dir, &action)?;
        let env = app.state::<AppState>().environment().clone();
        let settings = bridge::load_settings(&app);
        actions::run_action(&cwd, argv, env, &settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn flows_watch(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, watch::FlowWatchers>,
    cwd: String,
) -> Result<(), String> {
    state.start(app, window.label(), &cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/flows/project")
    }

    #[test]
    fn lists_fixture_flows_including_the_broken_one() {
        let cards = list_flows(&fixture()).unwrap();
        // id-map.json and README.md are files and never appear.
        assert_eq!(cards.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["101", "102", "103", "103"]);
        let good = &cards[0];
        assert_eq!(good.title, "A good flow");
        assert!(good.blocked);
        assert_eq!(good.previous_status.as_deref(), Some("in-progress"));
        assert_eq!(good.owner.as_deref(), Some("alice"));
        assert_eq!(good.pr_url.as_deref(), Some("https://github.com/o/r/pull/7"));
        assert_eq!((good.tasks_done, good.tasks_total), (2, 3));
        assert_eq!((good.ac_confirmed, good.ac_total), (1, 4));
        assert!(good.completion_exceptions);
        assert_eq!(good.dir, "101-2026-01-01-good-flow");
        assert!(good.id_valid);
        assert!(good.error.is_none());

        // FB1: a broken flow.json stays on the board as an error card.
        let broken = &cards[1];
        assert_eq!(broken.title, "102-2026-01-02-broken-flow");
        assert!(broken.error.as_deref().unwrap().contains("flow.json"));

        assert_eq!(cards[2].id, "103");
        assert_eq!(cards[2].status, "done");
        // two packages share id 103: only the directory tells them apart
        assert_eq!(cards[3].id, "103");
        assert_ne!(cards[2].dir, cards[3].dir);
    }

    #[test]
    fn detail_merges_criteria_tasks_journal_and_docs() {
        let d = get_flow(&fixture(), "101-2026-01-01-good-flow").unwrap();
        assert_eq!(d.criteria.len(), 4);
        assert_eq!(d.criteria[0].kind.as_deref(), Some("exec"));
        assert_eq!(d.criteria[0].confirmed.as_ref().unwrap().note.as_deref(), Some("checked by hand"));
        assert_eq!(d.criteria[3].verify.as_deref(), Some("none — not testable"));
        assert_eq!(d.tasks.len(), 3);
        assert_eq!(d.tasks[1].depends_on, ["T1"]);
        assert_eq!(d.tasks[1].attempts, 2);
        assert_eq!(d.tasks[1].last_attempt.as_ref().unwrap().detail.as_deref(), Some("tests red"));
        assert_eq!(d.tasks[2].disposition_reason.as_deref(), Some("not needed"));
        // journal (4 lines incl. the colon one) + history, deduped on (at, event).
        let events: Vec<_> = d.journal.iter().map(|j| j.event.as_str()).collect();
        assert_eq!(events, ["blocked", "note", "task-attempt", "flow created", "created"]);
        assert_eq!(d.journal[1].detail.as_deref(), Some("something: with a colon in the detail"));
        assert_eq!(d.docs.description.as_deref().map(str::trim), Some("Describe the flow."));
        assert!(d.docs.context.is_none());
        assert_eq!(d.signatures.len(), 1);
        assert_eq!(d.completion_attempts.len(), 1);
    }

    #[test]
    fn detail_of_a_broken_flow_is_the_error_card() {
        let d = get_flow(&fixture(), "102-2026-01-02-broken-flow").unwrap();
        assert!(d.card.error.is_some());
        assert!(d.tasks.is_empty() && d.journal.is_empty());
    }

    #[test]
    fn dirs_that_escape_or_do_not_exist_are_refused() {
        assert!(get_flow(&fixture(), "../..").is_err());
        assert!(get_flow(&fixture(), "101/../x").is_err());
        assert!(get_flow(&fixture(), "-101").is_err());
        assert!(get_flow(&fixture(), "999-nope").unwrap_err().contains("not found"));
        // a bare id is not a directory name: refused before any lookup
        assert!(get_flow(&fixture(), "101").unwrap_err().contains("Invalid flow directory"));
        assert!(require_flow_dir(&fixture(), "101-2026-01-01-good-flow").is_ok());
        assert!(require_flow_dir(&fixture(), "101").is_err());
        assert!(require_flow_dir(&fixture(), "../flows").is_err());
    }

    #[test]
    fn two_packages_sharing_an_id_are_addressed_by_directory() {
        let a = get_flow(&fixture(), "103-2026-01-03-numeric-id").unwrap();
        let b = get_flow(&fixture(), "103-2026-01-04-duplicate-id").unwrap();
        assert_eq!(a.card.id, "103");
        assert_eq!(b.card.id, "103");
        assert_eq!(a.card.title, "Numeric id");
        assert_eq!(b.card.title, "Duplicate id");
    }

    #[test]
    fn symlinks_out_of_the_flows_folder_are_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("flow.json"), r#"{"id":"999","title":"escaped","status":"done","tasks":[]}"#).unwrap();
        std::fs::write(tmp.path().join("secret.md"), "secret").unwrap();

        let project = tmp.path().join("proj");
        let flows = project.join(".metaproject/flows");
        let good = flows.join("001-2026-01-01-ok");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(good.join("flow.json"), r#"{"id":"1","title":"ok","status":"ready","tasks":[]}"#).unwrap();
        // a directory symlink pointing outside, and a file symlink inside a good flow
        std::os::unix::fs::symlink(&outside, flows.join("002-escape")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("secret.md"), good.join("description.md")).unwrap();

        let cards = list_flows(&project).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].id, "1");
        assert!(get_flow(&project, "002-escape").is_err());
        assert!(get_flow(&project, "001-2026-01-01-ok").unwrap().docs.description.is_none());

        // the flows folder itself symlinked out of the project is refused
        let project2 = tmp.path().join("proj2");
        std::fs::create_dir_all(project2.join(".metaproject")).unwrap();
        std::os::unix::fs::symlink(&flows, project2.join(".metaproject/flows")).unwrap();
        assert!(list_flows(&project2).is_err());
    }

    #[test]
    fn only_real_package_directories_are_listed_and_offered_actions() {
        let tmp = tempfile::tempdir().unwrap();
        let flows = tmp.path().join(".metaproject/flows");
        let live = flows.join("493-2026-11-15-shell-images");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join("flow.json"), r#"{"id":"493","title":"live","status":"ready","tasks":[]}"#).unwrap();
        // Not packages: keryx would resolve `shell-images` by slug to the live
        // flow above, so an action from such a card would hit the wrong flow.
        for other in ["shell-images", "notes", "1234-2026-01-01-x", "494-2026-11-15-Upper", "495-a.b"] {
            std::fs::create_dir_all(flows.join(other)).unwrap();
            std::fs::write(flows.join(other).join("flow.json"), r#"{"id":"9","status":"ready"}"#).unwrap();
        }
        // A package-named symlink to a package inside the flows folder.
        std::os::unix::fs::symlink(&live, flows.join("496-2026-11-15-alias")).unwrap();

        let cards = list_flows(tmp.path()).unwrap();
        assert_eq!(cards.iter().map(|c| c.dir.as_str()).collect::<Vec<_>>(), ["493-2026-11-15-shell-images"]);

        let block = actions::FlowAction::Block { reason: "waiting".into() };
        assert_eq!(
            prepare_action(tmp.path(), "493-2026-11-15-shell-images", &block).unwrap(),
            ["flow", "block", "493-2026-11-15-shell-images", "--reason", "waiting"]
        );
        for refused in [
            "shell-images",
            "notes",
            "1234-2026-01-01-x",
            "494-2026-11-15-Upper",
            "495-a.b",
            "496-2026-11-15-alias",
            "493",
        ] {
            assert!(prepare_action(tmp.path(), refused, &block).is_err(), "{refused}");
            assert!(get_flow(tmp.path(), refused).is_err(), "{refused}");
        }
        // A well-formed name that is not on disk is refused too.
        assert!(prepare_action(tmp.path(), "497-2026-11-15-gone", &block).unwrap_err().contains("not found"));
    }

    #[test]
    fn prepare_action_builds_argv_for_a_fixture_package_and_refuses_a_bare_id() {
        let next = actions::FlowAction::Next;
        assert_eq!(
            prepare_action(&fixture(), "103-2026-01-04-duplicate-id", &next).unwrap(),
            ["flow", "next", "103-2026-01-04-duplicate-id", "--json"]
        );
        assert!(prepare_action(&fixture(), "103", &next).is_err());
        let bad_text = actions::FlowAction::Block { reason: "--force".into() };
        assert!(prepare_action(&fixture(), "103-2026-01-04-duplicate-id", &bad_text).is_err());
    }

    #[test]
    fn a_project_without_flows_lists_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_flows(tmp.path()).unwrap().is_empty());
        assert!(list_flows(&tmp.path().join("nope")).is_err());
    }

    #[test]
    fn card_json_uses_camel_case_keys() {
        let cards = list_flows(&fixture()).unwrap();
        let v = serde_json::to_value(&cards[0]).unwrap();
        for key in [
            "id", "idValid", "dir", "title", "status", "previousStatus", "blocked", "owner", "prUrl", "baseBranch",
            "tasksDone", "tasksTotal", "acTotal", "acConfirmed", "updatedAt", "completionExceptions", "error",
        ] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
    }
}
