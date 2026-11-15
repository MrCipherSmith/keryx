"""QD arm (QN lens + old-debt rule). usage: setup | judges | score"""
import json, os, random, sys, collections, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.dirname(HERE)
CASES = ["q01", "q02", "q03", "q04", "q05"]
SEALED = SP + "/sealed/qbench-qd-key.json"
RUNS = f"{HERE}/runs-qd.json"

if sys.argv[1] == "setup":
    runs = []
    for case in CASES:
        for rep in (1, 2, 3):
            r = f"QD{rep}-{case}"
            task = f"{HERE}/tasks/{r}.md"
            out = f"{HERE}/out/{r}.json"
            open(task, "w").write(
                f"Exercise task. Follow the brief at `{HERE}/reviewer-brief.md` exactly.\n\n"
                f"- Snapshot: `{HERE}/wtn/{case}` (`cd` there first and stay inside it; other reviewers read it too, so change nothing).\n"
                f"- The change: `{HERE}/diff/{case}.diff`\n"
                f"- Your lens: `{SP}/lenses/QD/review-clean-code/SKILL.md` (review-clean-code)\n"
                f"- Write your JSON array to: `{out}`\n")
            runs.append(dict(rid=r, case=case, arm="QD", rep=rep, task=task, out=out))
    random.seed(4930); random.shuffle(runs)
    json.dump(runs, open(RUNS, "w"), indent=1)
    print(" ".join(r["rid"] for r in runs))
elif sys.argv[1] == "judges":
    runs = json.load(open(RUNS))
    missing = [r["rid"] for r in runs if not os.path.exists(r["out"])]
    assert not missing, missing
    random.seed(4931); random.shuffle(runs)
    key = {}
    for i, r in enumerate(runs, 1):
        jid = f"d{i:02d}"
        cand = [dict(id=f"G{n}", **{f: x.get(f) for f in ("file", "line", "severity", "problem", "impact", "quote")}) for n, x in enumerate(json.load(open(r["out"])), 1)]
        truth = json.load(open(f"{HERE}/truth/{r['case']}.json"))
        decoys = [dict(x, did=f"D{n}") for n, x in enumerate(json.load(open(f"{HERE}/truth/{r['case']}.decoys.json")), 1)]
        json.dump(dict(truth=truth, decoys=decoys, candidate=cand), open(f"{HERE}/judge/{jid}.in.json", "w"), indent=1, ensure_ascii=False)
        key[jid] = dict(rid=r["rid"], case=r["case"], arm="QD", rep=r["rep"])
    json.dump(key, open(SEALED, "w"), indent=1)
    print(" ".join(f"{j}:{v['case']}" for j, v in sorted(key.items())))
else:
    keys = {**json.load(open(SP + "/sealed/qbench-key.json")), **json.load(open(SEALED))}
    S = collections.defaultdict(collections.Counter)
    for jid, k in keys.items():
        v = json.load(open(f"{HERE}/judge/{jid}.out.json"))
        c = S[(k["arm"], k["rep"])]
        c["recall"] += sum({"match": 1, "partial": 0.5}.get(t["verdict"], 0) for t in v["truth"])
        for g in v["candidates"]:
            c[g["label"]] += 1
            if k["case"] == "q05": c["ctl_" + g["label"]] += 1
        c["cands"] += len(v["candidates"])
        if k["case"] == "q05": c["ctl"] += len(v["candidates"])
    for arm in ("QB", "QN", "QD"):
        reps = [S[(arm, r)] for r in (1, 2, 3)]
        m = lambda n: (round(statistics.mean(c[n] for c in reps), 2), [c[n] for c in reps])
        print(arm, "recall/24", m("recall"), "cands", m("cands"), "valid", m("valid"), "noise", m("noise"), "decoy", m("decoy"))
        print("   control: findings", m("ctl"), "valid", m("ctl_valid"), "noise", m("ctl_noise"))
