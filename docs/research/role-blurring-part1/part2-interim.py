#!/usr/bin/env python3
"""Interim numbers for Part 2 of «Размытие ролей…»: what the data on hand says about P1–P7 of protocol-part2.md (v2).

Run from the keryx repository root on branch research/part2-data. Reads .metaproject/flows/*, the merged decisions
export and the retrospective verify tags; writes part2-interim.json next to this script. Interim and descriptive:
no prediction is tested here unless its protocol minimum is met, and none is.
"""
import collections, datetime, glob, json, math, os, random, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
PROTOCOL_CUT = '2026-10-04T15:26:00Z'      # protocol v2 published; confirmatory sample starts here
FLOW_379_DATE = '2026-09-28'                # verify tag introduced (flow 379)
FLOW_422_MERGED = '2026-10-11T08:09:19Z'    # verify tag prompted by template, skills and freeze (PR #957)
ARM_WEIGHTS = {'A': 0.4, 'B': 0.2, 'C': 0.2, 'D': 0.2}
BOOT = 2000
rng = random.Random(20261004)


def load(p):
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception:
        return None


def wilson(k, n, z=1.96):
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 4), round(c + h, 4)]


def newcombe(k1, n1, k2, n2, z=1.96):
    """CI of p2 - p1 (Newcombe hybrid score)."""
    if n1 == 0 or n2 == 0:
        return None
    l1, u1 = wilson(k1, n1, z); l2, u2 = wilson(k2, n2, z)
    p1, p2 = k1 / n1, k2 / n2
    d = p2 - p1
    return [round(d - math.sqrt((p2 - l2) ** 2 + (u1 - p1) ** 2), 4), round(d + math.sqrt((u2 - p2) ** 2 + (p1 - l1) ** 2), 4)]


def chi2_sf_df3(x):
    return math.erfc(math.sqrt(x / 2)) + math.sqrt(2 * x / math.pi) * math.exp(-x / 2)


def cluster_boot_share(clusters, num, den):
    """95% percentile CI of sum(num)/sum(den), resampling clusters (flows)."""
    if not clusters:
        return None
    vals = []
    for _ in range(BOOT):
        s = [rng.choice(clusters) for _ in clusters]
        dn = sum(den(c) for c in s)
        if dn:
            vals.append(sum(num(c) for c in s) / dn)
    vals.sort()
    return [round(vals[int(0.025 * len(vals))], 4), round(vals[int(0.975 * len(vals)) - 1], 4)] if vals else None


out = {
    'commit': subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], text=True).strip(),
    'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='minutes').replace('+00:00', 'Z'),
    'protocol': 'protocol-part2.md v2 (2026-10-04)',
    'protocol_cut': PROTOCOL_CUT,
    'status_note': 'interim, descriptive; not the confirmatory analysis',
}

# ---------------------------------------------------------------- flows
retro = collections.defaultdict(dict)
for t in load(os.path.join(HERE, 'retro-verify-tags-410-419.json')) or []:
    retro[str(t['flow'])][t['criterion']] = t['kind']

flows = []
for f in sorted(glob.glob('.metaproject/flows/[0-9]*/')):
    d = load(f + 'flow.json') or {}
    text = open(f + 'acceptance-criteria.md', encoding='utf-8').read() if os.path.exists(f + 'acceptance-criteria.md') else ''
    crit = []
    for line in re.findall(r'^- AC\d+:.*$', text, re.M):
        ac = re.match(r'^- (AC\d+):', line).group(1)
        placeholder = '<replace with a hard, verifiable criterion' in line
        m = re.search(r'\[verify:\s*(exec|invariant|judged|none)\b', line)
        kind = m.group(1) if m else 'unclassified'
        sens = bool(re.search(r'sensitive:\s*(revert|mutation|failure-scenario)', line))
        crit.append({'ac': ac, 'kind': kind, 'retro': retro.get(str(d.get('id')), {}).get(ac), 'placeholder': placeholder, 'sensitive': sens})
    hist = d.get('history') or []
    first = lambda ev: next((h.get('at') for h in hist if h.get('event') == ev), None)
    o = d.get('origin')
    flows.append({
        'id': str(d.get('id') or os.path.basename(f.rstrip('/')).split('-')[0]),
        'createdAt': d.get('createdAt') or '',
        'status': d.get('status'),
        'frozenAt': first('frozen'),
        'doneAt': first('done'),
        'origin': o.get('kind') if isinstance(o, dict) else None,
        'outcomeAuthor': d.get('outcomeAuthor'),
        'criteria': crit,
    })

conf = [f for f in flows if f['createdAt'] >= PROTOCOL_CUT]
out['flows'] = {
    'total': len(flows),
    'confirmatory': len(conf),
    'confirmatory_ids': [f['id'] for f in conf],
    'confirmatory_by_status': dict(collections.Counter(f['status'] for f in conf)),
    'confirmatory_done': sum(1 for f in conf if f['status'] == 'done'),
}


# ---------------------------------------------------------------- M1 timeline: verify tag share by period of creation
def period(f):
    c = f['createdAt']
    if c < FLOW_379_DATE:
        return '1 before flow 379'
    if c < PROTOCOL_CUT:
        return '2 flow 379 to protocol'
    if c < FLOW_422_MERGED:
        return '3 protocol to 422 merge'
    return '4 after 422 merge'


m1 = collections.defaultdict(lambda: collections.Counter())
for f in flows:
    for c in f['criteria']:
        if c['placeholder']:
            m1[period(f)]['placeholder'] += 1
        else:
            m1[period(f)][c['kind']] += 1
out['m1_verify_tags_by_period'] = {
    p: {**dict(v), 'criteria': sum(n for k, n in v.items() if k != 'placeholder'),
        'tagged_share': round(1 - v['unclassified'] / max(1, sum(n for k, n in v.items() if k != 'placeholder')), 4)}
    for p, v in sorted(m1.items())
}
after = [c for f in flows if period(f) == '4 after 422 merge' for c in f['criteria'] if c['kind'] in ('exec', 'invariant')]
out['m1_sensitivity_after_422'] = {'exec_or_invariant': len(after), 'with_sensitivity_note': sum(1 for c in after if c['sensitive'])}

# ---------------------------------------------------------------- M2 origin, outcome author
out['m2_origin_confirmatory'] = dict(collections.Counter(f['origin'] or 'none' for f in conf))
out['outcome_author_confirmatory'] = dict(collections.Counter(str(f['outcomeAuthor']) for f in conf))


# ---------------------------------------------------------------- P2: technical residue among confirmatory criteria
def p2_view(use_retro):
    clusters = []
    tally = collections.Counter()
    for f in conf:
        kinds = []
        for c in f['criteria']:
            if c['placeholder']:
                continue
            k = c['kind']
            if k == 'unclassified' and use_retro and c['retro']:
                k = c['retro']
            kinds.append(k)
        tally.update(kinds)
        if kinds:
            clusters.append(kinds)
    tagged = sum(n for k, n in tally.items() if k != 'unclassified')
    resid = tally['judged'] + tally['none']
    num = lambda ks: sum(1 for k in ks if k in ('judged', 'none'))
    den = lambda ks: sum(1 for k in ks if k != 'unclassified')
    return {
        'flows_with_criteria': len(clusters),
        'criteria': sum(tally.values()),
        'kinds': dict(tally),
        'tagged': tagged,
        'residue_share_of_tagged': round(resid / tagged, 4) if tagged else None,
        'residue_ci95_cluster_bootstrap': cluster_boot_share([c for c in clusters if den(c)], num, den),
        'unknown_share': round(tally['unclassified'] / max(1, sum(tally.values())), 4),
    }


out['P2'] = {
    'as_recorded': p2_view(False),
    'with_retro_tags_410_419': p2_view(True),
    'minimum': '150 criteria in 20 flows, after reformulation with blind equivalence check',
    'status': 'insufficient: reformulation step and blind equivalence rating not done; the numbers are the pre-reformulation residue',
}

# ---------------------------------------------------------------- P3: group sizes only
before379 = [c for f in flows if f['createdAt'] < FLOW_379_DATE for c in f['criteria'] if not c['placeholder']]
after379 = [c for f in flows if f['createdAt'] >= FLOW_379_DATE for c in f['criteria'] if c['kind'] != 'unclassified']
out['P3'] = {
    'criteria_before_flow_379': len(before379),
    'tagged_criteria_from_flow_379': len(after379),
    'minimum': '100 per group, matched by flow type; blind rubric 0-2, kappa >= 0.6',
    'status': 'insufficient: blind rubric scoring not done (data available for both groups)',
}

# ---------------------------------------------------------------- P1, P4, P5, P6: availability
now = datetime.datetime.now(datetime.timezone.utc)
done_conf = sorted(f['doneAt'] for f in conf if f['doneAt'])
first_window = None
if done_conf:
    first_window = (datetime.datetime.fromisoformat(done_conf[0].replace('Z', '+00:00')) + datetime.timedelta(days=30)).date().isoformat()
out['P1'] = {'confirmatory_flows': len(conf), 'minimum': '30 flows and 100 human decisions coded by stage',
             'status': 'insufficient: stage coding of human decisions in flow artefacts not done'}
out['P4'] = {'confirmatory_flows_done': len(done_conf), 'first_30_day_window_closes': first_window,
             'minimum': '40 reworks; 30-day window after closing; blind cause coding',
             'status': 'insufficient by design until 30-day windows close; rework search rule and coding not done'}
out['P5'] = {'flows_with_effect_record': 0,
             'status': 'insufficient: M3 (expectation, metric, deadline, verdict) is not recorded in flow records'}
out['P6'] = {'status': 'insufficient: same window and coding as P4; 30 reworks per period needed'}

# ---------------------------------------------------------------- P7: recommendation journal
rows = [json.loads(l) for l in open(os.path.join(HERE, 'decisions-export-latest.jsonl'), encoding='utf-8') if l.strip()]
live = [r for r in rows if not r.get('backfilled') and (r.get('openedAt') or '') >= PROTOCOL_CUT]
elig = [r for r in live if r.get('eligible')]
sample = [r for r in elig if r.get('hasRecommendation')]
outcome = [r for r in sample if r.get('deviation') is not None]
by_arm = {}
for a in 'ABCD':
    rs = [r for r in outcome if r['arm'] == a]
    k = sum(1 for r in rs if r['deviation'] is False)
    t = sorted(r['timeToAnswerMs'] for r in rs if isinstance(r.get('timeToAnswerMs'), (int, float)))
    by_arm[a] = {
        'assigned': sum(1 for r in sample if r['arm'] == a),
        'with_outcome': len(rs),
        'matches': k,
        'match_rate': round(k / len(rs), 4) if rs else None,
        'ci95': wilson(k, len(rs)),
        'median_time_to_answer_s': round(t[len(t) // 2] / 1000, 1) if t else None,
        'reason_requested': sum(1 for r in rs if r.get('reasonRequested')),
        'reason_named': sum(1 for r in rs if r.get('reasonNamed')),
        'other_answer': sum(1 for r in rs if r.get('other')),
        'changed_after_first': sum(1 for r in rs if (r.get('changes') or 0) > 0),
    }
contrasts = {}
A = by_arm['A']
for a in 'BCD':
    b = by_arm[a]
    if A['with_outcome'] and b['with_outcome']:
        contrasts[f'{a}-A'] = {
            'diff': round(b['match_rate'] - A['match_rate'], 4),
            'ci95': newcombe(A['matches'], A['with_outcome'], b['matches'], b['with_outcome']),
            'ci90': newcombe(A['matches'], A['with_outcome'], b['matches'], b['with_outcome'], z=1.645),
        }
n = len(sample)
cnt = collections.Counter(r['arm'] for r in sample)
x2 = sum((cnt[a] - n * w) ** 2 / (n * w) for a, w in ARM_WEIGHTS.items()) if n else 0
forced = [r for r in live if r.get('forced')]
out['P7'] = {
    'decisions_live_after_cut': len(live),
    'sources': len({r['host'] for r in rows}),
    'eligible': len(elig),
    'forced': len(forced),
    'forced_share': round(len(forced) / max(1, len(live)), 4),
    'forced_by_stage': dict(collections.Counter(r.get('stage') for r in forced).most_common()),
    'eligible_without_recommendation_all_arm_A': len(elig) - len(sample),
    'comparison_sample': n,
    'arm_balance': {'observed': dict(cnt), 'expected': {a: round(n * w, 1) for a, w in ARM_WEIGHTS.items()},
                    'chi2_df3': round(x2, 2), 'p': round(chi2_sf_df3(x2), 3) if n else None},
    'by_arm': by_arm,
    'contrasts_vs_A': contrasts,
    'rated_by_quality': sum(1 for r in outcome if r.get('ratings')),
    'per_source_comparison_sample': dict(collections.Counter(r['host'] for r in sample).most_common()),
    'thresholds': {'min_per_arm': 150, 'mde_pp': 15, 'equivalence_pp': 10},
    'status': 'insufficient: fewer than 150 questions per arm in every arm',
}
first_day = min((r['openedAt'] for r in sample), default=None)
if first_day:
    days = (now - datetime.datetime.fromisoformat(first_day.replace('Z', '+00:00'))).total_seconds() / 86400
    rate = n / days if days else 0
    out['P7']['pace'] = {'days_since_first': round(days, 1), 'per_day': round(rate, 1),
                         'questions_needed_total_for_150_in_B_C_D': int(150 / 0.2),
                         'days_to_150_per_arm_at_current_pace': round((750 - n) / rate) if rate else None}

json.dump(out, open(os.path.join(HERE, 'part2-interim.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(json.dumps({k: out[k] for k in ('commit', 'flows', 'P2', 'P7')}, ensure_ascii=False, indent=1)[:6000])
