"""Extra arms. usage: qx.py setup ARM CASES... | judges TAG | score"""
import json, os, random, sys, collections, glob
HERE = os.path.dirname(os.path.abspath(__file__)); SP = os.path.dirname(HERE)
RUNS = f"{HERE}/runs-x.json"
if sys.argv[1] == "setup":
    arm, cases = sys.argv[2], sys.argv[3:]
    runs = json.load(open(RUNS)) if os.path.exists(RUNS) else []
    for case in cases:
        for rep in (1, 2, 3):
            r = f"{arm}{rep}-{case}"; task = f"{HERE}/tasks/{r}.md"; out = f"{HERE}/out/{r}.json"
            open(task, "w").write(
                f"Exercise task. Follow the brief at `{HERE}/reviewer-brief.md` exactly.\n\n"
                f"- Snapshot: `{HERE}/wtn/{case}` (`cd` there first and stay inside it; other reviewers read it too, so change nothing).\n"
                f"- The change: `{HERE}/diff/{case}.diff`\n"
                f"- Your lens: `{SP}/lenses/{arm}/review-clean-code/SKILL.md` (review-clean-code)\n"
                f"- Write your JSON array to: `{out}`\n")
            runs.append(dict(rid=r, case=case, arm=arm, rep=rep, out=out))
    json.dump(runs, open(RUNS, "w"), indent=1)
    print(" ".join(r["rid"] for r in runs if r["arm"] == arm))
elif sys.argv[1] == "judges":
    tag = sys.argv[2]; runs = json.load(open(RUNS))
    missing = [r["rid"] for r in runs if not os.path.exists(r["out"])]; assert not missing, missing
    random.seed(4951); random.shuffle(runs); key = {}
    for i, r in enumerate(runs, 1):
        jid = f"{tag}{i:02d}"
        cand = [dict(id=f"G{n}", **{f: x.get(f) for f in ("file", "line", "severity", "problem", "impact", "quote")}) for n, x in enumerate(json.load(open(r["out"])), 1)]
        truth = json.load(open(f"{HERE}/truth/{r['case']}.json"))
        decoys = [dict(x, did=f"D{n}") for n, x in enumerate(json.load(open(f"{HERE}/truth/{r['case']}.decoys.json")), 1)]
        json.dump(dict(truth=truth, decoys=decoys, candidate=cand), open(f"{HERE}/judge/{jid}.in.json", "w"), indent=1, ensure_ascii=False)
        key[jid] = dict(rid=r["rid"], case=r["case"], arm=r["arm"], rep=r["rep"])
    json.dump(key, open(f"{SP}/sealed/qbench-x-key.json", "w"), indent=1)
    print(" ".join(f"{j}:{v['case']}" for j, v in sorted(key.items())))
else:
    keys = {}
    for f in glob.glob(f"{SP}/sealed/qbench*-key.json"): keys.update(json.load(open(f)))
    S = collections.defaultdict(collections.Counter)
    for jid, k in keys.items():
        p = f"{HERE}/judge/{jid}.out.json"
        if not os.path.exists(p): continue
        v = json.load(open(p)); c = S[(k["arm"], k["case"])]; c["n"] += 1
        c["recall"] += sum({"match": 1, "partial": 0.5}.get(t["verdict"], 0) for t in v["truth"])
        for g in v["candidates"]: c[g["label"]] += 1
        c["cands"] += len(v["candidates"])
    arms = sorted({a for a, _ in S}); cases = sorted({c for _, c in S})
    for arm in arms:
        row = {c: S[(arm, c)] for c in cases if S[(arm, c)]["n"]}
        per = {c: round(x["recall"] / x["n"], 2) for c, x in row.items()}
        tot = lambda f: round(sum(x[f] / x["n"] for x in row.values()), 2)
        q5 = row.get("q05")
        print(arm, "recall/case", per, "| sum recall", tot("recall"), "cands", tot("cands"), "valid", tot("valid"), "noise", tot("noise"), "decoy", tot("decoy"),
              "| q05 cands/valid/noise", (round(q5["cands"]/q5["n"],2), round(q5["valid"]/q5["n"],2), round(q5["noise"]/q5["n"],2)) if q5 else None)
