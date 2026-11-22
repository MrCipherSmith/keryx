//! Read-only Metaproject requests scoped to the calling project view.
use crate::{
    bridge::AppState, child, locator, panels::project_dir, projects::ProjectWindows,
    review::invoke_review, settings,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::{AtomicUsize, Ordering}, Mutex},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager, Webview};

const INVALID: &str = "configuration: Invalid Metaproject request.";
const V2_BYTES: usize = 1024 * 1024;
const V1_BYTES: usize = 32 * 1024 * 1024;
const PROBE: &str = r#"{"action":"capabilities","version":2}"#;
const LEGACY_CATALOG: &str = r#"{"action":"catalog"}"#;
const ACTIONS: [&str; 6] = ["catalog", "detail", "search", "neighbors", "openspec-list", "openspec-history"];

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Catalog {},
    Detail { id: String },
    Search { query: String },
    Neighbors { id: String, depth: u8, direction: Direction, kinds: Vec<Kind> },
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Direction { Both, Incoming, Outgoing }
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind { Imports, Asset, Describes, Links, Contains, Defines, Calls, ChangesSpec, SpecContext }
#[derive(Clone, Copy, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope { Graph, Wiki, Spec, Change, Archive }
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Collection { Spec, Change, Archive }

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
enum RequestV2 {
    Capabilities {},
    Catalog { expected_snapshot_id: Option<String> },
    Detail {
        id: String, artifact: Option<String>, section: Option<String>, digest: Option<String>,
        expected_snapshot_id: Option<String>,
    },
    Search {
        query: String, scopes: Option<Vec<Scope>>, cursor: Option<String>,
        expected_snapshot_id: Option<String>,
    },
    Neighbors {
        id: String, depth: u8, direction: Direction, kinds: Vec<Kind>, include_archive: Option<bool>,
        expected_snapshot_id: Option<String>,
    },
    OpenspecList { collection: Collection, cursor: Option<String>, expected_snapshot_id: Option<String> },
    OpenspecHistory { id: String, cursor: Option<String>, expected_snapshot_id: Option<String> },
}

fn digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn valid_text(s: &str) -> bool {
    !s.is_empty() && s.encode_utf16().count() <= 4096
}

fn relative_path(s: &str) -> bool {
    valid_text(s) && !s.contains('\\') && !s.chars().any(|ch| ch.is_ascii_control())
        && !matches!(s.as_bytes(), [first, b':', ..] if first.is_ascii_alphabetic())
        && s.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

fn valid_v1(request: Request) -> bool {
    match request {
        Request::Catalog {} => true,
        Request::Detail { id } => !id.is_empty() && id.len() <= 4096,
        Request::Search { query } => query.len() <= 4096,
        Request::Neighbors { id, depth, direction, kinds } => {
            let _ = direction;
            !id.is_empty() && id.len() <= 4096 && (1..=2).contains(&depth) && kinds.len() <= 7
                && !kinds.iter().any(|kind| matches!(kind, Kind::ChangesSpec | Kind::SpecContext))
        }
    }
}

fn valid_v2(request: RequestV2) -> bool {
    let (valid, pin) = match request {
        RequestV2::Capabilities {} => (true, None),
        RequestV2::Catalog { expected_snapshot_id } => (true, expected_snapshot_id),
        RequestV2::Detail { id, artifact, section, digest: expected_digest, expected_snapshot_id } => (
            valid_text(&id) && artifact.as_deref().map_or(true, relative_path)
                && section.as_deref().map_or(true, valid_text) && expected_digest.as_deref().map_or(true, digest),
            expected_snapshot_id,
        ),
        RequestV2::Search { query, scopes, cursor, expected_snapshot_id } => (
            query.encode_utf16().count() <= 4096
                && scopes.map_or(true, |choices| !choices.is_empty() && choices.len() <= 5
                    && choices.iter().enumerate().all(|(i, scope)| !choices[..i].contains(scope)))
                && cursor.as_deref().map_or(true, valid_text),
            expected_snapshot_id,
        ),
        RequestV2::Neighbors { id, depth, direction, kinds, include_archive, expected_snapshot_id } => {
            let _ = (direction, include_archive);
            (valid_text(&id) && (1..=2).contains(&depth) && kinds.len() <= 9, expected_snapshot_id)
        }
        RequestV2::OpenspecList { collection, cursor, expected_snapshot_id } => {
            let _ = collection;
            (cursor.as_deref().map_or(true, valid_text), expected_snapshot_id)
        }
        RequestV2::OpenspecHistory { id, cursor, expected_snapshot_id } => (
            valid_text(&id) && cursor.as_deref().map_or(true, valid_text), expected_snapshot_id,
        ),
    };
    valid && pin.as_deref().map_or(true, digest)
}

fn metaproject_args(request: &Value) -> Result<Vec<String>, String> {
    let payload = request.to_string();
    if payload.len() > 16 * 1024 { return Err("configuration: Metaproject request is too large.".into()); }
    let valid = if request.get("version").is_some() {
        let Some(mut body) = request.as_object().cloned() else { return Err(INVALID.into()); };
        body.remove("version") == Some(Value::from(2)) && !body.values().any(Value::is_null)
            && serde_json::from_value::<RequestV2>(Value::Object(body)).is_ok_and(valid_v2)
    } else {
        serde_json::from_value::<Request>(request.clone()).is_ok_and(valid_v1)
    };
    if !valid { return Err(INVALID.into()); }
    Ok(vec!["metaproject-explorer".into(), "--request".into(), payload])
}

#[derive(Eq, PartialEq)]
struct ProbeKey {
    executable: PathBuf,
    checkout: PathBuf,
    modified: Option<SystemTime>,
    bytes: u64,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
    #[cfg(unix)]
    checkout_identity: (u64, u64),
}

impl ProbeKey {
    fn new(executable: &Path, checkout: &Path) -> Result<Self, String> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        let info = executable.metadata().map_err(|_| "unavailable: The selected Keryx CLI is unavailable.")?;
        #[cfg(unix)]
        let checkout_info = checkout.metadata().map_err(|_| "unavailable: The Metaproject checkout is unavailable.")?;
        Ok(Self {
            executable: executable.to_path_buf(),
            checkout: checkout.to_path_buf(),
            modified: info.modified().ok(),
            bytes: info.len(),
            #[cfg(unix)]
            identity: (info.dev(), info.ino(), info.ctime(), info.ctime_nsec()),
            #[cfg(unix)]
            checkout_identity: (checkout_info.dev(), checkout_info.ino()),
        })
    }
}

static PROBES: Mutex<VecDeque<(ProbeKey, Value)>> = Mutex::new(VecDeque::new());
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
const MAX_ACTIVE: usize = 8;
const MAX_PROBES: usize = 32;

struct ReadPermit;
impl ReadPermit {
    fn acquire() -> Result<Self, String> {
        ACTIVE.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| (count < MAX_ACTIVE).then_some(count + 1))
            .map(|_| Self).map_err(|_| "unavailable: Too many Metaproject reads. Retry shortly.".into())
    }
}
impl Drop for ReadPermit {
    fn drop(&mut self) { ACTIVE.fetch_sub(1, Ordering::Relaxed); }
}

fn cli_response(mut command: Command, payload: &str, limit: usize) -> Result<Value, String> {
    command.args(["metaproject-explorer", "--request", payload]);
    let output = child::run_bounded(command, Duration::from_secs(150), limit + 1)
        .map_err(|_| "unavailable: Could not read Metaproject from the selected CLI.".to_string())?;
    if !output.status.success() {
        let reason = output.stderr.trim();
        return Err(if reason.is_empty() {
            "unavailable: The selected CLI did not complete the Metaproject read.".into()
        } else {
            reason.to_owned()
        });
    }
    if output.stdout.len() > limit {
        return Err("unavailable: Metaproject response exceeds the byte limit.".into());
    }
    serde_json::from_str(&output.stdout)
        .map_err(|_| "unavailable: The selected CLI returned invalid Metaproject JSON.".into())
}

fn capability_response(value: &Value) -> bool {
    value.as_object().is_some_and(|data| data.len() == 2)
        && value["schemaVersion"] == 2 && value["actions"] == json!(ACTIONS)
}

fn rows(value: &Value, limit: usize, valid: impl Fn(&Value) -> bool) -> bool {
    value.as_array().is_some_and(|items| items.len() <= limit && items.iter().all(valid))
}
fn one_of(value: &Value, options: &[&str]) -> bool {
    value.as_str().is_some_and(|text| options.contains(&text))
}
fn optional_string(value: &Value, key: &str) -> bool {
    value.get(key).map_or(true, Value::is_string)
}
fn optional_uint(value: &Value, key: &str) -> bool {
    value.get(key).map_or(true, |number| number.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991))
}
fn legacy_catalog(value: &Value) -> bool {
    let node = |node: &Value| {
        ["id", "title", "path"].iter().all(|key| node[*key].is_string())
            && one_of(&node["kind"], &["wiki", "module", "file", "symbol"])
            && ["module", "pageType", "status"].iter().all(|key| optional_string(node, key))
            && optional_uint(node, "line")
    };
    let edge = |edge: &Value| {
        edge["from"].is_string() && edge["to"].is_string()
            && one_of(&edge["kind"], &["imports", "asset", "describes", "links", "contains", "defines", "calls"])
            && edge.get("evidence").map_or(true, |items| rows(items, 400, Value::is_string))
            && optional_uint(edge, "count")
    };
    value["schemaVersion"] == 1 && value["snapshotId"].is_string()
        && rows(&value["nodes"], 12_000, node) && rows(&value["edges"], 40_000, edge)
        && value["truncated"].is_boolean() && value["hasWikiLayer"].is_boolean()
        && value["hasSymbolLayer"].is_boolean() && optional_string(value, "graphReason")
        && one_of(&value["graph"], &["ready", "stale", "missing", "unknown"])
        && ["files", "wiki", "modules"].iter().all(|key| value["counts"].get(*key).is_some()
            && optional_uint(&value["counts"], key))
}

fn legacy_probe_error(error: &str) -> bool {
    error == "Invalid request" || error.strip_prefix("unsupported-version: ").is_some_and(|message| !message.is_empty())
}

fn probe(make_command: impl Fn() -> Command, key: ProbeKey) -> Result<Value, String> {
    if let Some(value) = PROBES.lock().ok().and_then(|cache| {
        cache.iter().find(|(candidate, _)| *candidate == key).map(|(_, value)| value.clone())
    }) {
        return Ok(value);
    }
    let result = match cli_response(make_command(), PROBE, V2_BYTES) {
        Ok(response) if capability_response(&response) => response,
        Ok(_) => return Err("unavailable: The selected CLI returned invalid Metaproject capabilities.".into()),
        Err(error) if legacy_probe_error(&error) => {
            let response = cli_response(make_command(), LEGACY_CATALOG, V1_BYTES)?;
            if !legacy_catalog(&response) {
                return Err("unavailable: The selected CLI returned an incompatible legacy Metaproject catalog.".into());
            }
            json!({"schemaVersion": 1, "legacyHandshake": true})
        }
        Err(error) => return Err(error),
    };
    // A settings or executable replacement during negotiation cannot seed the cache.
    if ProbeKey::new(&key.executable, &key.checkout).is_ok_and(|current| current == key) {
        if let Ok(mut cache) = PROBES.lock() {
            if cache.len() == MAX_PROBES { cache.pop_front(); }
            cache.push_back((key, result.clone()));
        }
        Ok(result)
    } else {
        Err("unavailable: Metaproject CLI or checkout changed. Refresh to retry.".into())
    }
}

async fn v2_request(app: AppHandle, view: Webview, cwd: String, request: Value, payload: String) -> Result<Value, String> {
    let registered = app.state::<ProjectWindows>().cwd_for(view.label());
    if registered.as_deref() != Some(cwd.as_str()) {
        return Err("configuration: Open this project in the current view to use Metaproject.".into());
    }
    let permit = ReadPermit::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let checkout = project_dir(&cwd)?;
        let state = app.state::<AppState>();
        let env = state.environment();
        let prefs = settings::load_settings(&app);
        let exe = std::env::current_exe().map_err(|_| "unavailable: The Keryx app path is unavailable.")?;
        let reader = locator::locate_for_app(
            prefs.keryx_source, prefs.custom_path.as_deref(), exe.parent(),
            env.get("PATH").map(OsStr::new), true,
        )?;
        let make_command = || {
            let mut cmd = Command::new(&reader.path);
            cmd.current_dir(&checkout).env_clear().envs(env);
            cmd
        };
        if request["action"] == "capabilities" {
            probe(make_command, ProbeKey::new(&reader.path, &checkout)?)
        } else {
            cli_response(make_command(), &payload, V2_BYTES)
        }
    }).await.map_err(|_| "unavailable: Could not finish the Metaproject read.".to_string())?
}

#[tauri::command]
pub async fn metaproject_request(app: AppHandle, view: Webview, cwd: String, request: Value) -> Result<Value, String> {
    let mut args = metaproject_args(&request)?;
    if request.get("version").is_some() {
        let payload = args.pop().ok_or(INVALID)?;
        return v2_request(app, view, cwd, request, payload).await;
    }
    invoke_review(app, view, cwd, args, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metaproject_accepts_only_closed_read_requests() {
        let body = json!({"action":"detail", "id":"--help"});
        assert_eq!(metaproject_args(&body).unwrap(), vec!["metaproject-explorer", "--request", &body.to_string()]);
        assert!(metaproject_args(&json!({"action":"rebuild"})).is_err());
        assert!(metaproject_args(&json!({"action":"catalog", "cwd":"/tmp"})).is_err());
        assert!(metaproject_args(&json!({"action":"neighbors", "id":"x", "depth":3, "direction":"both", "kinds":[]})).is_err());
        assert!(metaproject_args(&json!({"action":"neighbors", "id":"x", "depth":1, "direction":"both", "kinds":["write"]})).is_err());
    }

    #[test]
    fn validates_versioned_actions_without_widening_legacy_requests() {
        assert!(metaproject_args(&json!({"version":2, "action":"capabilities"})).is_ok());
        assert!(metaproject_args(&json!({"version":2, "action":"capabilities", "cwd":"/tmp"})).is_err());
        assert!(metaproject_args(&json!({"version":2, "action":"openspec-list", "collection":"archive"})).is_ok());
        assert!(metaproject_args(&json!({"version":2, "action":"detail", "id":"id", "artifact":"../escape.md"})).is_err());
        assert!(metaproject_args(&json!({"version":2, "action":"search", "query":"x", "scopes":["wiki", "wiki"]})).is_err());
        assert!(metaproject_args(&json!({"version":2, "action":"detail", "id":"id", "digest":null})).is_err());
        assert!(metaproject_args(&json!({"action":"neighbors", "id":"x", "depth":1, "direction":"both", "kinds":["spec-context"]})).is_err());
    }
}
