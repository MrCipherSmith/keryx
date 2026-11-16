//! Pure parsers for a flow package: `flow.json`, `acceptance-criteria.md` and
//! `journal.md`. No I/O here, so every shape is testable from a string.
//!
//! `flow.json` is read leniently through `serde_json::Value`: this repository
//! holds packages written by many keryx versions, and a missing optional field
//! must never turn a flow into a broken card.

use super::{Attempt, Criterion, FlowCard, JournalEntry, TaskRow};
use serde_json::Value;
use std::collections::HashMap;

fn str_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(str_of)
}

/// The leading digits of a directory name like `492-2026-11-14-slug`.
pub fn dir_id(dir_name: &str) -> String {
    let head: String = dir_name.chars().take_while(char::is_ascii_digit).collect();
    if head.is_empty() {
        dir_name.to_string()
    } else {
        head
    }
}

/// A card for a directory whose `flow.json` is unreadable: never dropped.
pub fn broken_card(dir_name: &str, rel_dir: &str, error: String) -> FlowCard {
    FlowCard {
        id: dir_id(dir_name),
        dir: rel_dir.to_string(),
        title: dir_name.to_string(),
        status: "unknown".to_string(),
        previous_status: None,
        blocked: false,
        owner: None,
        pr_url: None,
        base_branch: None,
        tasks_done: 0,
        tasks_total: 0,
        ac_total: 0,
        ac_confirmed: 0,
        updated_at: None,
        completion_exceptions: false,
        error: Some(error),
    }
}

fn has_exceptions(list: Option<&Value>) -> bool {
    list.and_then(Value::as_array).is_some_and(|items| {
        items.iter().any(|item| item.get("exceptions").and_then(Value::as_array).is_some_and(|e| !e.is_empty()))
    })
}

/// Parse `flow.json` text into a card. `criteria_total` is the count from
/// `acceptance-criteria.md`, when that file was read; otherwise `acKinds` is used.
pub fn parse_card(text: &str, dir_name: &str, rel_dir: &str, criteria_total: Option<usize>) -> Result<FlowCard, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("flow.json: {e}"))?;
    if !v.is_object() {
        return Err("flow.json: not a JSON object".to_string());
    }
    let status = field(&v, "status").unwrap_or_else(|| "unknown".to_string());
    let tasks = v.get("tasks").and_then(Value::as_array);
    let tasks_total = tasks.map_or(0, Vec::len);
    let tasks_done = tasks.map_or(0, |t| t.iter().filter(|x| field(x, "status").as_deref() == Some("done")).count());
    let ac_confirmed = v.get("acConfirmed").and_then(Value::as_object).map_or(0, |m| m.len());
    let ac_total = criteria_total
        .or_else(|| v.get("acKinds").and_then(Value::as_object).map(|m| m.len()))
        .unwrap_or(0);
    let owner = v.get("owner").and_then(|o| match o {
        Value::Object(_) => field(o, "value"),
        other => str_of(other),
    });
    Ok(FlowCard {
        id: field(&v, "id").unwrap_or_else(|| dir_id(dir_name)),
        dir: rel_dir.to_string(),
        title: field(&v, "title").unwrap_or_else(|| dir_name.to_string()),
        blocked: status == "blocked",
        status,
        previous_status: field(&v, "previousStatus"),
        owner,
        pr_url: v.get("pr").and_then(|p| field(p, "url")),
        base_branch: field(&v, "baseBranch"),
        tasks_done,
        tasks_total,
        ac_total,
        ac_confirmed,
        updated_at: field(&v, "updatedAt"),
        completion_exceptions: has_exceptions(v.get("signatures")) || has_exceptions(v.get("completionAttempts")),
        error: None,
    })
}

/// Tasks, signatures, completion attempts, history and acKinds of a parsed flow.
pub struct FlowBody {
    pub tasks: Vec<TaskRow>,
    pub signatures: Vec<Value>,
    pub completion_attempts: Vec<Value>,
    pub history: Vec<JournalEntry>,
    pub confirmed: HashMap<String, (String, Option<String>)>,
    pub kinds: HashMap<String, String>,
}

pub fn parse_body(text: &str) -> Result<FlowBody, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("flow.json: {e}"))?;
    let tasks = v
        .get("tasks")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(parse_task).collect())
        .unwrap_or_default();
    let list = |key: &str| v.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let history = list("history")
        .iter()
        .filter_map(|h| {
            Some(JournalEntry { at: field(h, "at")?, event: field(h, "event")?, detail: field(h, "detail") })
        })
        .collect();
    let confirmed = v
        .get("acConfirmed")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, c)| (k.clone(), (field(c, "at").unwrap_or_default(), field(c, "note"))))
                .collect()
        })
        .unwrap_or_default();
    let kinds = v
        .get("acKinds")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, c)| Some((k.clone(), field(c, "kind")?))).collect())
        .unwrap_or_default();
    Ok(FlowBody {
        tasks,
        signatures: list("signatures"),
        completion_attempts: list("completionAttempts"),
        history,
        confirmed,
        kinds,
    })
}

fn parse_task(t: &Value) -> TaskRow {
    let log = t.get("attempts").and_then(|a| a.get("log")).and_then(Value::as_array);
    let count = t
        .get("attempts")
        .and_then(|a| a.get("count"))
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .or_else(|| log.map(Vec::len))
        .unwrap_or(0);
    let last_attempt = log.and_then(|l| l.last()).map(|a| Attempt {
        at: field(a, "at").unwrap_or_default(),
        outcome: field(a, "outcome").unwrap_or_default(),
        detail: field(a, "detail"),
    });
    TaskRow {
        id: field(t, "id").unwrap_or_default(),
        title: field(t, "title").unwrap_or_default(),
        kind: field(t, "kind").unwrap_or_default(),
        status: field(t, "status").unwrap_or_default(),
        depends_on: t
            .get("dependsOn")
            .and_then(Value::as_array)
            .map(|d| d.iter().filter_map(str_of).collect())
            .unwrap_or_default(),
        attempts: count,
        last_attempt,
        disposition: field(t, "disposition"),
        disposition_reason: field(t, "dispositionReason"),
    }
}

/// Split a trailing `[verify: ...]` tag off a criterion's text.
fn split_verify(text: &str) -> (String, Option<String>) {
    let trimmed = text.trim_end();
    if let Some(open) = trimmed.rfind("[verify:") {
        if let Some(inner) = trimmed[open + "[verify:".len()..].strip_suffix(']') {
            return (trimmed[..open].trim_end().to_string(), Some(inner.trim().to_string()));
        }
    }
    (trimmed.to_string(), None)
}

/// Criteria lines `- ACn: text [verify: ...]`, in file order.
pub fn parse_criteria(
    md: &str,
    kinds: &HashMap<String, String>,
    confirmed: &HashMap<String, (String, Option<String>)>,
) -> Vec<Criterion> {
    let mut out = Vec::new();
    for line in md.lines() {
        let Some(rest) = line.trim_start().strip_prefix("- AC") else { continue };
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            continue;
        }
        let Some(body) = rest[digits.len()..].strip_prefix(':') else { continue };
        let id = format!("AC{digits}");
        let (text, verify) = split_verify(body.trim());
        out.push(Criterion {
            kind: kinds.get(&id).cloned(),
            confirmed: confirmed.get(&id).map(|(at, note)| super::Confirmation { at: at.clone(), note: note.clone() }),
            id,
            text,
            verify,
        });
    }
    out
}

fn looks_like_iso(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 10 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-' && s.contains('T')
}

/// Journal lines `- <ISO> - <event>: detail` (the `: detail` part is optional).
pub fn parse_journal(md: &str) -> Vec<JournalEntry> {
    let mut out = Vec::new();
    for line in md.lines() {
        let Some(rest) = line.strip_prefix("- ") else { continue };
        let Some((at, tail)) = rest.split_once(" - ") else { continue };
        if !looks_like_iso(at) {
            continue;
        }
        let tail = tail.trim();
        let (event, detail) = match tail.split_once(": ") {
            Some((e, d)) if !e.contains(' ') => (e.to_string(), Some(d.trim().to_string())),
            _ => (tail.trim_end_matches(':').to_string(), None),
        };
        out.push(JournalEntry { at: at.to_string(), event, detail });
    }
    out
}

/// Merge journal lines with `history`, drop duplicates (same instant and event;
/// the journal wins because its detail is the fuller text), newest first.
pub fn merge_journal(journal: Vec<JournalEntry>, history: Vec<JournalEntry>) -> Vec<JournalEntry> {
    let mut seen = std::collections::HashSet::new();
    let mut all: Vec<JournalEntry> = Vec::new();
    for entry in journal.into_iter().chain(history) {
        if seen.insert((entry.at.clone(), entry.event.clone())) {
            all.push(entry);
        }
    }
    all.sort_by(|a, b| b.at.cmp(&a.at));
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn criteria_with_and_without_verify_tags() {
        let md = "## Criteria\n\n- AC1: Reads `a.json` [odd]. [verify: exec `bun test x`]\n- AC2: Plain.\n- AC10: Judged. [verify: judged]\nnot a line\n- ACx: nope\n";
        let kinds = HashMap::from([("AC1".to_string(), "exec".to_string())]);
        let conf = HashMap::from([("AC2".to_string(), ("t".to_string(), Some("n".to_string())))]);
        let c = parse_criteria(md, &kinds, &conf);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].id, "AC1");
        assert_eq!(c[0].text, "Reads `a.json` [odd].");
        assert_eq!(c[0].verify.as_deref(), Some("exec `bun test x`"));
        assert_eq!(c[0].kind.as_deref(), Some("exec"));
        assert!(c[1].verify.is_none() && c[1].kind.is_none());
        assert_eq!(c[1].confirmed.as_ref().unwrap().note.as_deref(), Some("n"));
        assert_eq!(c[2].id, "AC10");
        assert_eq!(c[2].verify.as_deref(), Some("judged"));
    }

    #[test]
    fn journal_lines_with_and_without_detail() {
        let md = "# Flow Journal\n\n- 2026-01-01T10:00:00.000Z - flow created\n- 2026-01-02T08:00:00.000Z - task-done: T2: Implement: it\ngarbage\n- not-a-date - x: y\n";
        let j = parse_journal(md);
        assert_eq!(j.len(), 2);
        assert_eq!((j[0].event.as_str(), j[0].detail.as_deref()), ("flow created", None));
        assert_eq!((j[1].event.as_str(), j[1].detail.as_deref()), ("task-done", Some("T2: Implement: it")));
    }

    #[test]
    fn merge_dedups_and_sorts_newest_first() {
        let e = |at: &str, ev: &str, d: Option<&str>| JournalEntry {
            at: at.into(),
            event: ev.into(),
            detail: d.map(String::from),
        };
        let m = merge_journal(
            vec![e("2026-01-02", "a", Some("full")), e("2026-01-01", "b", None)],
            vec![e("2026-01-02", "a", Some("short")), e("2026-01-03", "c", None)],
        );
        assert_eq!(m.iter().map(|x| x.event.as_str()).collect::<Vec<_>>(), ["c", "a", "b"]);
        assert_eq!(m[1].detail.as_deref(), Some("full"));
    }

    #[test]
    fn numeric_id_and_missing_fields_are_tolerated() {
        let c = parse_card(r#"{"id": 7, "status": "ready"}"#, "007-x", "d", None).unwrap();
        assert_eq!(c.id, "7");
        assert_eq!(c.title, "007-x");
        assert!(!c.blocked);
    }

    #[test]
    fn malformed_json_is_an_error_not_a_panic() {
        assert!(parse_card("{ \"id\": ", "1-x", "d", None).is_err());
        assert!(parse_card("[]", "1-x", "d", None).is_err());
        assert_eq!(dir_id("492-2026-11-14-slug"), "492");
    }
}
