#!/usr/bin/env python3
"""Counts behind Part 1 of «Размытие ролей…» / "Role Blurring…".
Run from the keryx repository root. Reads only .metaproject/flows/*.
Prints the numbers used in §3.1, §6 and §7 and writes part1-counts.json next to it.
"""
import glob, json, re, collections, subprocess, datetime

FLOWS = sorted(glob.glob('.metaproject/flows/[0-9]*/'))
BASELINE_DATE = '2026-09-28'   # flow 379, check-type tag introduced

def load(p):
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception:
        return None

out = {}
try:
    out['commit'] = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], text=True).strip()
except Exception:
    out['commit'] = None
out['generated_at'] = datetime.datetime.utcnow().isoformat(timespec='minutes') + 'Z'

# --- flows, criteria, confirmations, tags ---
ac_total = 0; tags = collections.Counter(); confirmed = 0; since_baseline = 0
outcome_author = collections.Counter(); origin = collections.Counter(); status = collections.Counter()
reviewed_flows = 0; rounds = 0
for f in FLOWS:
    t = open(f + 'acceptance-criteria.md', encoding='utf-8').read() if glob.glob(f + 'acceptance-criteria.md') else ''
    lines = re.findall(r'^- AC\d+:.*$', t, re.M)
    ac_total += len(lines)
    for l in lines:
        m = re.search(r'\[verify:\s*(\w+)', l)
        tags[m.group(1) if m else 'untagged'] += 1
    d = load(f + 'flow.json') or {}
    c = d.get('acConfirmed') or {}
    confirmed += len(c)
    status[d.get('status')] += 1
    if (d.get('createdAt') or '') >= BASELINE_DATE:
        since_baseline += 1
    outcome_author[str(d.get('outcomeAuthor'))] += 1
    o = d.get('origin')
    origin[(o.get('kind') if isinstance(o, dict) else str(o))] += 1
    r = glob.glob(f + 'reviews/*/manifest.json')
    if r:
        reviewed_flows += 1; rounds += len(r)

out['flows'] = len(FLOWS)
out['flows_by_status'] = dict(status)
out['acceptance_criteria'] = ac_total
out['acceptance_criteria_confirmed'] = confirmed
out['verify_tags'] = dict(tags)
out['flows_since_baseline'] = since_baseline
out['outcome_author'] = dict(outcome_author)
out['origin'] = dict(origin)
out['reviewed_flows'] = reviewed_flows
out['review_rounds'] = rounds

# --- review findings and verdicts ---
findings = 0; blockers = 0; verdict = collections.Counter(); refuted_disp = collections.Counter(); severity = collections.Counter()
for fj in glob.glob('.metaproject/flows/*/reviews/*/findings.json'):
    f = load(fj)
    if f is None:
        continue
    items = f if isinstance(f, list) else f.get('findings', [])
    for it in items:
        findings += 1
        severity[it.get('severity')] += 1
        if it.get('severity') == 'blocker':
            blockers += 1
        v = (it.get('verification') or {}).get('verdict')
        verdict[v or 'no-verdict'] += 1
        if v == 'refuted':
            d = it.get('disposition')
            refuted_disp[d.get('state') if isinstance(d, dict) else (d or 'no-disposition')] += 1
out['findings'] = findings
out['findings_by_severity'] = dict(severity)
out['findings_blocking'] = blockers
out['verdicts'] = dict(verdict)
out['refuted_by_disposition'] = dict(refuted_disp)

json.dump(out, open('part1-counts.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
for k, v in out.items():
    print(f'{k}: {v}')
