#!/usr/bin/env python3
"""A/B bench for review rules and lenses. Python 3 standard library only.

    bench.py setup  --suite seeded|history --arm NAME=DIR [--arm ...] --reps N [--cases ID,...] [--seed S] [--run NAME]
    bench.py judges --suite ... [--run NAME] [--truth DIR]
    bench.py score  --suite ... [--run NAME]

Everything generated goes to bench/rules-ab/.work/<run>/ (run defaults to the suite name).
Reviewers and judges are NOT dispatched here: agents read the task files this script writes.
Truth and decoys are never read from the main tree: pass --truth DIR or set KERYX_BENCH_TRUTH.
"""
import argparse
import collections
import json
import os
import random
import re
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCORE = {"match": 1, "partial": 0.5}
CAND_FIELDS = ("file", "line", "severity", "problem", "impact", "quote")
# history diffs leave out files that describe the review itself or are generated
HISTORY_EXCLUDES = [":!.metaproject", ":!CHANGELOG.md", ":!bun.lock"]
# where the truth lives inside a checkout of the research branch, per suite
TRUTH_SUBDIRS = {"seeded": "qbench/truth", "history": "bench/truth"}


def die(msg):
    sys.exit("bench.py: " + msg)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(obj, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def git(*args):
    p = subprocess.run(["git", "-C", HERE, *args], capture_output=True, text=True, errors="replace")
    if p.returncode != 0:
        die("git %s failed: %s" % (" ".join(args), p.stderr.strip()))
    return p.stdout


def suite_dir(suite):
    return os.path.join(HERE, "suites", suite)


def load_cases(suite):
    return load(os.path.join(suite_dir(suite), "cases.json"))["cases"]


def work_dir(args):
    return os.path.join(HERE, ".work", args.run or args.suite)


def resolve_truth(args, cases):
    base = args.truth or os.environ.get("KERYX_BENCH_TRUTH")
    if not base:
        die("truth is not in this tree: pass --truth DIR or set KERYX_BENCH_TRUTH to a checkout of the research branch")
    probe = cases[0]["id"] + ".json"
    for cand in (base, os.path.join(base, "truth"), os.path.join(base, TRUTH_SUBDIRS[args.suite])):
        if os.path.isfile(os.path.join(cand, probe)):
            return cand
    die("no %s under %s (looked in ., truth/, %s)" % (probe, base, TRUTH_SUBDIRS[args.suite]))


def parse_arms(specs):
    arms = {}
    for spec in specs:
        name, sep, path = spec.partition("=")
        if not sep or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name):
            die("--arm must be NAME=DIR with NAME of letters, digits and underscores: %r" % spec)
        path = os.path.abspath(path)
        if not os.path.isdir(path):
            die("arm directory does not exist: " + path)
        if name in arms:
            die("duplicate arm " + name)
        arms[name] = path
    if len(arms) < 2:
        die("give at least two --arm NAME=DIR")
    return arms


def arm_listing(path):
    files = []
    for root, _, names in os.walk(path):
        for n in sorted(names):
            files.append(os.path.relpath(os.path.join(root, n), path))
    return sorted(files)[:60]


def cmd_setup(args):
    cases = load_cases(args.suite)
    if args.cases:
        wanted = args.cases.split(",")
        unknown = sorted(set(wanted) - {c["id"] for c in cases})
        if unknown:
            die("unknown case ids: " + " ".join(unknown))
        cases = [c for c in cases if c["id"] in wanted]
    arms = parse_arms(args.arm)
    work = work_dir(args)
    if os.path.exists(os.path.join(work, "runs.json")):
        die("%s already holds a run; pick another --run name or delete it" % work)
    repo = git("rev-parse", "--show-toplevel").strip()
    sdir = suite_dir(args.suite)
    wt_cmds = []
    for c in cases:
        wt = os.path.join(work, "wt", c["id"])
        wt_cmds.append("git -C %s worktree add --detach %s %s" % (repo, wt, c["head"]))
        if args.suite == "history":
            wt_cmds.append("ln -s %s/node_modules %s/node_modules" % (repo, wt))
        c["_wt"] = wt
        if c.get("diff"):
            c["_diff"] = os.path.join(sdir, c["diff"])
        else:  # history: regenerate the diff from the two commits
            c["_diff"] = os.path.join(work, "diff", c["id"] + ".diff")
            # ":/" is the repository root; "." would mean bench/rules-ab, since git runs with -C HERE
            text = git("diff", c["base"], c["head"], "--", ":/", *HISTORY_EXCLUDES)
            if not text.strip():
                die("empty diff for %s (%s..%s)" % (c["id"], c["base"], c["head"]))
            write(c["_diff"], text)
    runs = []
    for c in cases:
        for arm, path in arms.items():
            for rep in range(1, args.reps + 1):
                rid = "%s%d-%s" % (arm, rep, c["id"])
                out = os.path.join(work, "out", rid + ".json")
                task = os.path.join(work, "tasks", rid + ".md")
                listing = "\n".join("  - " + f for f in arm_listing(path))
                write(task,
                      "Exercise task. Follow the brief at `%s` exactly.\n\n"
                      "- Snapshot: `%s` (`cd` there first and stay inside it; other reviewers read it too, so change nothing).\n"
                      "- The change: `%s`\n"
                      "- Your arm files: `%s` (read its `SKILL.md` as your lens, and any rule files it contains):\n%s\n"
                      "- Write your JSON array to: `%s`\n"
                      % (os.path.join(sdir, "reviewer-brief.md"), c["_wt"], c["_diff"], path, listing, out))
                runs.append(dict(rid=rid, case=c["id"], kind=c["kind"], arm=arm, rep=rep, task=task, out=out))
    random.Random(args.seed).shuffle(runs)
    os.makedirs(os.path.join(work, "out"), exist_ok=True)
    dump(dict(suite=args.suite, seed=args.seed, reps=args.reps, arms=arms, runs=runs), os.path.join(work, "runs.json"))
    script = os.path.join(work, "worktrees.sh")
    write(script, "#!/bin/sh\nset -e\n" + "\n".join(wt_cmds) + "\n")
    print("%d reviewer runs (%d cases x %d arms x %d reps); task files in %s" % (len(runs), len(cases), len(arms), args.reps, os.path.join(work, "tasks")))
    print("Run list (shuffled, dispatch in this order): %s" % os.path.join(work, "runs.json"))
    print("\nMaterialise the case worktrees (not run by this script; also saved to %s):" % script)
    print("\n".join(wt_cmds))


def read_candidates(path):
    return [dict(id="G%d" % n, **{f: x.get(f) for f in CAND_FIELDS}) for n, x in enumerate(load(path), 1)]


def cmd_judges(args):
    cases = load_cases(args.suite)
    work = work_dir(args)
    meta = load(os.path.join(work, "runs.json"))
    runs = meta["runs"]
    missing = [r["rid"] for r in runs if not os.path.exists(r["out"])]
    if missing:
        die("reviewer outputs missing: " + " ".join(missing))
    tdir = resolve_truth(args, cases)
    ids = [r["rid"] for r in runs]
    random.Random(meta["seed"] + 1).shuffle(ids)
    byrid = {r["rid"]: r for r in runs}
    sdir = suite_dir(args.suite)
    key = {}
    for i, rid in enumerate(ids, 1):
        r = byrid[rid]
        jid = "h%02d" % i
        item = dict(truth=load(os.path.join(tdir, r["case"] + ".json")))
        if args.suite == "seeded":
            decoys = load(os.path.join(tdir, r["case"] + ".decoys.json"))
            item["decoys"] = [dict(x, did="D%d" % n) for n, x in enumerate(decoys, 1)]
        item["candidate"] = read_candidates(r["out"])
        jin = os.path.join(work, "judge", jid + ".in.json")
        jout = os.path.join(work, "judge", jid + ".out.json")
        dump(item, jin)
        write(os.path.join(work, "judge", jid + ".task.md"),
              "Exercise task. Follow the brief at `%s` exactly.\n\n"
              "- Input lists: `%s`\n"
              "- Code snapshot (read only): `%s`\n"
              "- Write your JSON to: `%s`\n" % (os.path.join(sdir, "judge-brief.md"), jin, os.path.join(work, "wt", r["case"]), jout))
        key[jid] = dict(rid=rid, case=r["case"], kind=r["kind"], arm=r["arm"], rep=r["rep"])
    dump(key, os.path.join(work, "sealed", "key.json"))
    print("%d judge inputs in %s (arm hidden; key in sealed/ - judges must not read it)" % (len(key), os.path.join(work, "judge")))
    print(" ".join("%s:%s" % (j, v["case"]) for j, v in sorted(key.items())))


def truth_verdicts(v):
    """Judge output -> list of truth verdict dicts (history judges write a bare list)."""
    return v["truth"] if isinstance(v, dict) else v


def mean(vals):
    return round(statistics.mean(vals), 2)


def cmd_score(args):
    cases = load_cases(args.suite)
    case_ids = [c["id"] for c in cases]
    work = work_dir(args)
    key = load(os.path.join(work, "sealed", "key.json"))
    S = collections.defaultdict(collections.Counter)
    n_truth = {}
    skipped = []
    for jid, k in key.items():
        p = os.path.join(work, "judge", jid + ".out.json")
        if not os.path.exists(p):
            skipped.append(jid)
            continue
        v = load(p)
        tv = truth_verdicts(v)
        n_truth[k["case"]] = len(tv)
        c = S[(k["arm"], k["rep"])]
        got = sum(SCORE.get(t["verdict"], 0) for t in tv)
        c["recall"] += got
        c["case_" + k["case"]] += got
        for t in tv:
            c["v_" + t["verdict"]] += 1
        if args.suite == "seeded":
            for g in v["candidates"]:
                c[g["label"]] += 1
            c["cands"] += len(v["candidates"])
            if k["kind"] == "control":
                c["control_findings"] += len(v["candidates"])
    if skipped:
        print("warning: %d judge outputs missing, skipped: %s" % (len(skipped), " ".join(skipped)))
    total_t = sum(n_truth.get(c, 0) for c in case_ids)
    arms = sorted({a for a, _ in S})
    for arm in arms:
        reps = [S[(arm, r)] for r in sorted({r for a, r in S if a == arm})]

        def col(name):
            vals = [c[name] for c in reps]
            return vals, mean(vals)

        if args.suite == "seeded":
            print(arm, "recall", col("recall"), "/ %s" % total_t, "| cands", col("cands"), "| valid", col("valid"),
                  "| noise", col("noise"), "| decoy", col("decoy"), "| control findings", col("control_findings"))
        else:
            print(arm, "recall", col("recall"), "/ %s" % total_t, "| match", col("v_match"), "| partial", col("v_partial"),
                  "| miss", col("v_miss"), "| found %s%%" % round(100 * col("recall")[1] / total_t) if total_t else "")
        print("   per case", {c: col("case_" + c)[1] for c in case_ids if n_truth.get(c)})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["setup", "judges", "score"])
    ap.add_argument("--suite", required=True, choices=sorted(TRUTH_SUBDIRS))
    ap.add_argument("--run", help="work dir name under .work/ (default: the suite name)")
    ap.add_argument("--arm", action="append", default=[], help="NAME=DIR, repeat per arm (setup)")
    ap.add_argument("--reps", type=int, default=3, help="reviewer runs per case and arm (setup)")
    ap.add_argument("--cases", help="comma-separated case ids to run, e.g. c06,c07 (setup; default: all)")
    ap.add_argument("--seed", type=int, default=4920, help="shuffle seed (setup); judges use seed+1")
    ap.add_argument("--truth", help="truth directory from the research checkout (judges); or env KERYX_BENCH_TRUTH")
    args = ap.parse_args()
    if args.reps < 1:
        die("--reps must be at least 1")
    {"setup": cmd_setup, "judges": cmd_judges, "score": cmd_score}[args.cmd](args)


if __name__ == "__main__":
    main()
