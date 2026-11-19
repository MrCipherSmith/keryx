//! The page as the agent reads it: Chrome's accessibility tree
//! (`Accessibility.getFullAXTree`) as an indented outline. Interactive nodes get
//! a ref (`e1`, `e2`, …) bound to their DOM node, for clicking and typing with
//! real input. The format matches the WebKit engine's `browser_snapshot`, so the
//! tool reads the same on either engine.

use serde_json::Value;
use std::collections::HashMap;

pub const MAX_BYTES: usize = 60_000;

const INTERACTIVE: &[&str] = &[
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem",
];
/// Interactive roles whose children only repeat their name.
const LEAF: &[&str] = &["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "option", "menuitem", "switch", "slider", "spinbutton", "tab"];
/// Structure that carries nothing by itself: its children are shown in its place.
const TRANSPARENT: &[&str] = &["none", "generic", "presentation", "RootWebArea", "WebArea", "LineBreak", "InlineTextBox", "Section", "paragraph", "group", "div", "LabelText"];

#[derive(Debug, Default, PartialEq)]
pub struct Snapshot {
    pub text: String,
    /// ref → backend DOM node id
    pub refs: HashMap<String, i64>,
    pub truncated: bool,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.get("value")).and_then(|x| x.as_str()).unwrap_or("")
}

fn prop<'a>(node: &'a Value, name: &str) -> Option<&'a Value> {
    node.get("properties")?.as_array()?.iter().find(|p| p.get("name").and_then(|n| n.as_str()) == Some(name))?.get("value")?.get("value")
}

fn clean(t: &str, max: usize) -> String {
    let one: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > max {
        one.chars().take(max).collect::<String>() + "…"
    } else {
        one
    }
}

/// Build the outline from the `nodes` of `Accessibility.getFullAXTree`.
pub fn build(nodes: &[Value]) -> Snapshot {
    let by_id: HashMap<&str, &Value> = nodes.iter().filter_map(|n| Some((n.get("nodeId")?.as_str()?, n))).collect();
    let root = nodes
        .iter()
        .find(|n| n.get("parentId").is_none())
        .or_else(|| nodes.first());
    let mut out = Snapshot::default();
    let mut lines: Vec<String> = Vec::new();
    let mut size = 0usize;
    if let Some(root) = root {
        walk(root, 0, &by_id, &mut out, &mut lines, &mut size);
    }
    out.text = lines.join("\n");
    out
}

fn walk(node: &Value, depth: usize, by_id: &HashMap<&str, &Value>, out: &mut Snapshot, lines: &mut Vec<String>, size: &mut usize) {
    if *size > MAX_BYTES {
        out.truncated = true;
        return;
    }
    let ignored = node.get("ignored").and_then(|i| i.as_bool()).unwrap_or(false);
    let role = s(node, "role");
    let name = clean(s(node, "name"), 120);
    let children = || node.get("childIds").and_then(|c| c.as_array()).into_iter().flatten().filter_map(|id| id.as_str()).filter_map(|id| by_id.get(id).copied());
    let mut push = |depth: usize, line: String| {
        let l = format!("{}{line}", "  ".repeat(depth.min(12)));
        *size += l.len() + 1;
        lines.push(l);
    };

    if ignored || (TRANSPARENT.contains(&role) && name.is_empty()) || (TRANSPARENT.contains(&role) && role != "group") {
        for c in children() {
            walk(c, depth, by_id, out, lines, size);
        }
        return;
    }
    if role == "StaticText" {
        let t = clean(s(node, "name"), 300);
        if !t.is_empty() {
            push(depth, serde_json::to_string(&t).unwrap_or_default());
        }
        return;
    }
    if role == "image" || role == "img" {
        if !name.is_empty() {
            push(depth, format!("img {}", serde_json::to_string(&name).unwrap_or_default()));
        }
        return;
    }
    if role == "Iframe" {
        push(depth, "iframe (contents not read)".into());
        return;
    }

    let mut line = if name.is_empty() { role.to_string() } else { format!("{role} {}", serde_json::to_string(&name).unwrap_or_default()) };
    if role == "heading" {
        if let Some(l) = prop(node, "level").and_then(|l| l.as_i64()) {
            line = format!("heading[{l}] {}", serde_json::to_string(&name).unwrap_or_default());
        }
    }
    let interactive = INTERACTIVE.contains(&role);
    if interactive {
        if let Some(backend) = node.get("backendDOMNodeId").and_then(|b| b.as_i64()) {
            let r = format!("e{}", out.refs.len() + 1);
            line.push_str(&format!(" [ref={r}]"));
            out.refs.insert(r, backend);
        }
        let value = s(node, "value");
        // A password field's value comes masked; never show even that.
        if !value.is_empty() && !value.chars().all(|c| c == '•' || c == '*') {
            line.push_str(&format!(" value={}", serde_json::to_string(&clean(value, 120)).unwrap_or_default()));
        }
        match prop(node, "checked").and_then(|c| c.as_str()) {
            Some("true") => line.push_str(" [checked]"),
            Some("mixed") => line.push_str(" [mixed]"),
            _ => {}
        }
        if prop(node, "disabled").and_then(|d| d.as_bool()) == Some(true) {
            line.push_str(" [disabled]");
        }
        if let Some(e) = prop(node, "expanded").and_then(|e| e.as_bool()) {
            line.push_str(if e { " [expanded]" } else { " [collapsed]" });
        }
        if prop(node, "selected").and_then(|x| x.as_bool()) == Some(true) {
            line.push_str(" [selected]");
        }
        if let Some(url) = prop(node, "url").and_then(|u| u.as_str()) {
            line.push_str(&format!(" href={}", serde_json::to_string(&clean(url, 200)).unwrap_or_default()));
        }
    }
    push(depth, line);
    // A named heading's children only repeat its name.
    if (interactive && LEAF.contains(&role)) || (role == "heading" && !name.is_empty()) {
        return;
    }
    for c in children() {
        walk(c, depth + 1, by_id, out, lines, size);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn n(id: &str, parent: Option<&str>, role: &str, name: &str, kids: &[&str], backend: i64) -> Value {
        let mut v = json!({
            "nodeId": id, "ignored": false,
            "role": { "type": "role", "value": role },
            "name": { "type": "computedString", "value": name },
            "childIds": kids, "backendDOMNodeId": backend,
        });
        if let Some(p) = parent {
            v["parentId"] = json!(p);
        }
        v
    }

    #[test]
    fn interactive_nodes_get_refs_and_structure_collapses() {
        let mut h = n("3", Some("2"), "heading", "Settings", &[], 30);
        h["properties"] = json!([{ "name": "level", "value": { "type": "integer", "value": 1 } }]);
        let mut input = n("6", Some("4"), "textbox", "Email", &[], 60);
        input["value"] = json!({ "type": "string", "value": "a@b.c" });
        let mut pass = n("8", Some("4"), "textbox", "Password", &[], 80);
        pass["value"] = json!({ "type": "string", "value": "•••••" });
        let mut check = n("9", Some("4"), "checkbox", "Remember me", &[], 90);
        check["properties"] = json!([{ "name": "checked", "value": { "type": "tristate", "value": "true" } }]);
        let mut ignored = n("10", Some("4"), "generic", "", &["11"], 100);
        ignored["ignored"] = json!(true);
        let nodes = vec![
            n("1", None, "RootWebArea", "Pick test", &["2"], 1),
            n("2", Some("1"), "generic", "", &["3", "4"], 2),
            h,
            n("4", Some("2"), "form", "", &["5", "6", "8", "9", "10"], 40),
            n("5", Some("4"), "StaticText", "Your   details", &[], 50),
            input,
            pass,
            check,
            ignored,
            n("11", Some("10"), "button", "Save changes", &["12"], 110),
            n("12", Some("11"), "StaticText", "Save changes", &[], 120),
        ];
        let snap = build(&nodes);
        assert_eq!(
            snap.text,
            [
                "heading[1] \"Settings\"",
                "form",
                "  \"Your details\"",
                "  textbox \"Email\" [ref=e1] value=\"a@b.c\"",
                "  textbox \"Password\" [ref=e2]",
                "  checkbox \"Remember me\" [ref=e3] [checked]",
                "  button \"Save changes\" [ref=e4]",
            ]
            .join("\n")
        );
        assert_eq!(snap.refs.get("e4"), Some(&110));
        assert_eq!(snap.refs.len(), 4);
        assert!(!snap.truncated);
    }

    #[test]
    fn a_huge_page_is_cut_and_says_so() {
        let mut nodes = vec![n("r", None, "RootWebArea", "", &[], 1)];
        let kids: Vec<String> = (0..5000).map(|i| format!("t{i}")).collect();
        nodes[0]["childIds"] = json!(kids);
        for (i, k) in kids.iter().enumerate() {
            nodes.push(n(k, Some("r"), "StaticText", &format!("line {i} with some text to fill the outline"), &[], 0));
        }
        let snap = build(&nodes);
        assert!(snap.truncated);
        assert!(snap.text.len() < MAX_BYTES + 200);
    }
}
