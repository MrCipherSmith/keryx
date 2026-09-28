#!/usr/bin/env python3
"""Measurement 1 — retrospective disagreement over the keryx flow corpus.

Replicates the deterministic half of `src/flow/check-ac.ts` (flow 328):
  * extractCriterionTokens  — backticked tokens, bare file paths, `keryx <sub>`
  * allTokensAbsent         — tokens.length > 0 && tokensPresent.length === 0
  * NOT_CHECKABLE_MARKERS   — with the clause-splitting rule
No model is called. Nothing is written back.
"""
import subprocess, json, re, collections, sys

REPO = "/home/altsay/keryx"

def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, cwd=REPO,
                          errors="replace", **kw).stdout

# --- faithful ports of check-ac.ts ----------------------------------------
BACKTICK = re.compile(r"`([^`]+)`")
BAREPATH = re.compile(r"\b[\w.-]+/[\w./-]+\.[a-zA-Z]{1,6}\b")
KERYXCMD = re.compile(r"\bkeryx\s+([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?)")

def extract_tokens(text):
    out = []
    seen = set()
    def add(t):
        if t and t not in seen:
            seen.add(t); out.append(t)
    for m in BACKTICK.finditer(text):
        add((m.group(1) or "").strip())
    for m in BAREPATH.finditer(text):
        add(m.group(0))
    for m in KERYXCMD.finditer(text):
        add(m.group(0))
    return out

MARKERS = [
    ("live check",            re.compile(r"\blive[- ]?check\b|\brun(?:s|ning)? with\b.*\benv\b|\blive[- ]?run\b", re.I)),
    ("CI green",              re.compile(r"\bCI (?:is )?green\b|\bCI passes\b", re.I)),
    ("health passing",        re.compile(r"\bhealth run\b|\bhealth (?:passes|passing)\b|\bkeryx health run\b", re.I)),
    ("docs published",        re.compile(r"\bdocs?(?:umentation)? (?:published|live|deployed|site)\b", re.I)),
    ("manual verification",   re.compile(r"\bmanually verified\b|\bmanual(?:ly)? tested?\b|\ba human (?:verifies|confirms|checks)\b", re.I)),
    ("operator confirmation", re.compile(r"\ban? operator\b.*\b(?:confirms?|signs? off|approves?)\b", re.I)),
]

def classify_clause(t):
    for label, rx in MARKERS:
        if rx.search(t):
            return label
    return None

def not_checkable(text):
    clauses = [c.strip() for c in re.split(r"[,;]", text) if c.strip()]
    if len(clauses) <= 1:
        return classify_clause(text)
    labels = [classify_clause(c) for c in clauses]
    if any(l is None for l in labels):
        return None
    return labels[0]

AC_LINE = re.compile(r"^\s*[-*]\s*(AC\d+)\s*:\s?(.*)$", re.I)

# --- corpus ---------------------------------------------------------------
tree = sh(["git", "ls-tree", "-r", "--name-only", "origin/main", ".metaproject/flows/"]).splitlines()
flow_json = [p for p in tree if p.endswith("/flow.json")]
ac_md = {p.rsplit("/", 1)[0]: p for p in tree if p.endswith("/acceptance-criteria.md")}

# PR number -> squash commit on main
pr_commit = {}
for line in sh(["git", "log", "origin/main", "--format=%H%x09%s"]).splitlines():
    if "\t" not in line:
        continue
    sha, subject = line.split("\t", 1)
    m = re.search(r"\(#(\d+)\)\s*$", subject)
    if m:
        pr_commit.setdefault(m.group(1), sha)

diff_cache = {}
def commit_data(sha):
    if sha not in diff_cache:
        files = [l for l in sh(["git", "show", "--name-only", "--format=", sha]).splitlines() if l.strip()]
        text = sh(["git", "show", "--format=", sha])
        diff_cache[sha] = (files, text)
    return diff_cache[sha]

C = collections.Counter()
examples = []
per_flow_absent = collections.Counter()
flows_measured = 0

for fj in flow_json:
    d_dir = fj.rsplit("/", 1)[0]
    raw = sh(["git", "show", "origin/main:" + fj])
    if not raw.strip():
        continue
    try:
        flow = json.loads(raw)
    except Exception:
        continue
    if flow.get("status") != "done":
        C["flows_skipped_not_done"] += 1
        continue
    pr = flow.get("pr")
    prnum = None
    if isinstance(pr, str):
        m = re.search(r"(\d+)\s*$", pr.strip().rstrip("/"))
        prnum = m.group(1) if m else None
    elif isinstance(pr, dict):
        v = pr.get("number") or pr.get("url") or ""
        m = re.search(r"(\d+)\s*$", str(v).strip().rstrip("/"))
        prnum = m.group(1) if m else None
    elif isinstance(pr, (int, float)):
        prnum = str(int(pr))
    if not prnum or prnum not in pr_commit:
        C["flows_no_resolvable_commit"] += 1
        continue
    if d_dir not in ac_md:
        continue
    acraw = sh(["git", "show", "origin/main:" + ac_md[d_dir]])
    crits = []
    for line in acraw.splitlines():
        m = AC_LINE.match(line)
        if m:
            crits.append((m.group(1).upper(), (m.group(2) or "").strip()))
    if not crits:
        continue
    files, text = commit_data(pr_commit[prnum])
    confirmed = flow.get("acConfirmed") or {}
    flows_measured += 1
    for cid, ctext in crits:
        C["criteria_measured"] += 1
        is_conf = cid in confirmed
        if is_conf:
            C["confirmed"] += 1
        nc = not_checkable(ctext)
        if nc:
            C["not_checkable"] += 1
            if is_conf:
                C["not_checkable_confirmed"] += 1
            continue
        toks = extract_tokens(ctext)
        if not toks:
            C["no_named_artefact"] += 1
            if is_conf:
                C["no_named_artefact_confirmed"] += 1
            continue
        present = [t for t in toks if (t in text) or any(t in f for f in files)]
        if present:
            C["tokens_present"] += 1
            if is_conf:
                C["tokens_present_confirmed"] += 1
        else:
            C["all_tokens_absent"] += 1
            if is_conf:
                C["all_tokens_absent_confirmed"] += 1
                per_flow_absent[d_dir.split("/")[-1][:38]] += 1
                if len(examples) < 6:
                    examples.append((d_dir.split("/")[-1][:38], cid, ctext[:150], toks[:4]))

print("=" * 72)
print("MEASUREMENT 1 — retrospective disagreement (facts only, no model)")
print("=" * 72)
print(f"flows measured (status=done, PR resolved to a commit) : {flows_measured}")
for k in ("flows_skipped_not_done", "flows_no_resolvable_commit"):
    print(f"  {k:52s}: {C[k]}")
print()
print(f"criteria measured                                     : {C['criteria_measured']}")
print(f"  confirmed                                           : {C['confirmed']}")
print()
print("classification of measured criteria")
print(f"  not-checkable by marker (no diff can record them)    : {C['not_checkable']:5d}  confirmed: {C['not_checkable_confirmed']}")
print(f"  names no artefact at all (facts can say nothing)     : {C['no_named_artefact']:5d}  confirmed: {C['no_named_artefact_confirmed']}")
print(f"  named artefacts present in the diff                  : {C['tokens_present']:5d}  confirmed: {C['tokens_present_confirmed']}")
print(f"  ALL named artefacts ABSENT from the diff             : {C['all_tokens_absent']:5d}  confirmed: {C['all_tokens_absent_confirmed']}")
print()
checkable = C["tokens_present"] + C["all_tokens_absent"]
if checkable:
    print(f"disagreement rate among criteria the facts CAN judge   : "
          f"{C['all_tokens_absent_confirmed']}/{checkable} = {100*C['all_tokens_absent_confirmed']/checkable:.1f}%")
if C["criteria_measured"]:
    opaque = C["not_checkable"] + C["no_named_artefact"]
    print(f"criteria the deterministic half cannot judge at all    : "
          f"{opaque}/{C['criteria_measured']} = {100*opaque/C['criteria_measured']:.1f}%")
print()
print("flows contributing the most disagreements:")
for name, n in per_flow_absent.most_common(6):
    print(f"  {n:3d}  {name}")
print()
print("examples (criterion confirmed, every named artefact absent from its diff):")
for flow, cid, ctext, toks in examples:
    print(f"  [{flow}] {cid}: {ctext}")
    print(f"      named: {toks}")
