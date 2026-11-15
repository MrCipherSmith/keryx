"""Code-quality bench for review-clean-code: QB (current lens, current rules) vs QN (one standard: new lens + new rules).
usage: setup | judges | score"""
import json, os, random, shutil, subprocess, sys, collections, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.dirname(HERE)
CASES = ["q01", "q02", "q03", "q04", "q05"]
ARMS = ["QB", "QN"]
REPS = 3
SEALED = SP + "/sealed/qbench-key.json"

def rid(case, arm, rep): return f"{arm}{rep}-{case}"

if sys.argv[1] == "setup":
    runs = []
    for case in CASES:
        for arm in ARMS:
            for rep in (1, 2, 3):
                r = rid(case, arm, rep)
                snap = f"{HERE}/wt/{case}" if arm == "QB" else f"{HERE}/wtn/{case}"
                task = f"{HERE}/tasks/{r}.md"
                out = f"{HERE}/out/{r}.json"
                open(task, "w").write(
                    f"Exercise task. Follow the brief at `{HERE}/reviewer-brief.md` exactly.\n\n"
                    f"- Snapshot: `{snap}` (`cd` there first and stay inside it; other reviewers read it too, so change nothing).\n"
                    f"- The change: `{HERE}/diff/{case}.diff`\n"
                    f"- Your lens: `{SP}/lenses/{arm}/review-clean-code/SKILL.md` (review-clean-code)\n"
                    f"- Write your JSON array to: `{out}`\n")
                runs.append(dict(rid=r, case=case, arm=arm, rep=rep, task=task, out=out))
    order = runs[:]; random.seed(4920); random.shuffle(order)
    json.dump(order, open(f"{HERE}/runs.json", "w"), indent=1)
    print(len(order), "runs")
elif sys.argv[1] == "judges":
    runs = json.load(open(f"{HERE}/runs.json"))
    missing = [r["rid"] for r in runs if not os.path.exists(r["out"])]
    assert not missing, missing
    keys = [r["rid"] for r in runs]; random.seed(4921); random.shuffle(keys)
    byrid = {r["rid"]: r for r in runs}; key = {}
    for i, k in enumerate(keys, 1):
        r = byrid[k]; jid = f"h{i:02d}"
        cand = [dict(id=f"G{n}", **{f: x.get(f) for f in ("file", "line", "severity", "problem", "impact", "quote")}) for n, x in enumerate(json.load(open(r["out"])), 1)]
        truth = json.load(open(f"{HERE}/truth/{r['case']}.json"))
        decoys = [dict(x, did=f"D{n}") for n, x in enumerate(json.load(open(f"{HERE}/truth/{r['case']}.decoys.json")), 1)]
        json.dump(dict(truth=truth, decoys=decoys, candidate=cand), open(f"{HERE}/judge/{jid}.in.json", "w"), indent=1, ensure_ascii=False)
        key[jid] = dict(rid=k, case=r["case"], arm=r["arm"], rep=r["rep"])
    os.makedirs(os.path.dirname(SEALED), exist_ok=True)
    json.dump(key, open(SEALED, "w"), indent=1)
    print(" ".join(f"{j}:{v['case']}" for j, v in sorted(key.items())))
else:
    key = json.load(open(SEALED))
    S = collections.defaultdict(lambda: collections.Counter())
    for jid, k in key.items():
        v = json.load(open(f"{HERE}/judge/{jid}.out.json"))
        c = S[(k["arm"], k["rep"])]
        for t in v["truth"]:
            c["recall"] += {"match": 1, "partial": 0.5}.get(t["verdict"], 0)
            c[f"major_recall" if False else "t"] += 1
        for g in v["candidates"]:
            c[g["label"]] += 1
        c["cands"] += len(v["candidates"])
        c[f"case_{k['case']}"] += sum({"match": 1, "partial": 0.5}.get(t["verdict"], 0) for t in v["truth"])
        if k["case"] == "q05": c["control_findings"] += len(v["candidates"])
    total_t = sum(len(json.load(open(f"{HERE}/truth/{c}.json"))) for c in CASES)
    for arm in ARMS:
        reps = [S[(arm, r)] for r in (1, 2, 3)]
        def col(name): vals = [c[name] for c in reps]; return vals, round(statistics.mean(vals), 2)
        print(arm, "recall", col("recall"), f"/ {total_t}", "| cands", col("cands"), "| valid", col("valid"), "| noise", col("noise"), "| decoy", col("decoy"), "| control findings", col("control_findings"))
        print("   per case", {c: col(f"case_{c}")[1] for c in CASES})
