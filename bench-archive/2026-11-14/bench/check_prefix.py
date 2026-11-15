"""For each eligible package: is the recorded head a PRE-fix snapshot?

A finding is usable only when the defect is still present at `head`:
- every commit named in its disposition evidence is NOT an ancestor of head, and
- when the finding carries a quote, the quote is present in the file at head.
"""
import json, os, re, subprocess, collections

ROOT = "$REPO"
HERE = os.path.dirname(os.path.abspath(__file__))


def git(*a):
    r = subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True, errors="replace")
    return r.returncode, r.stdout


rows = json.load(open(HERE + "/eligible.json"))
seen_heads = {}
out = []
for r in rows:
    if r["head"] in seen_heads:
        continue
    f = json.load(open(r["path"] + "/findings.json"))
    _, names = git("diff", "--name-only", r["base"], r["head"], "--", ".", ":!.metaproject", ":!CHANGELOG.md", ":!bun.lock")
    files = set(names.strip().split("\n"))
    usable = []
    status = collections.Counter()
    for x in f:
        d = x.get("disposition")
        if not (isinstance(d, dict) and d.get("state") == "acted-on" and x.get("severity") in ("blocker", "major") and x.get("file")):
            continue
        path = x["file"].split(":")[0].strip()
        if path not in files:
            status["file-not-in-diff"] += 1
            continue
        shas = set(re.findall(r"\b[0-9a-f]{7,40}\b", (d.get("evidence") or "") + " " + (d.get("reason") or "")))
        shas = {s for s in shas if git("cat-file", "-e", s + "^{commit}")[0] == 0}
        fixed_before = [s for s in shas if git("merge-base", "--is-ancestor", s, r["head"])[0] == 0]
        if fixed_before:
            status["fix-commit-already-in-head"] += 1
            continue
        q = (x.get("quote") or "").strip()
        if q:
            rc, body = git("show", "%s:%s" % (r["head"], path))
            if rc != 0 or q not in body:
                status["quote-not-at-head"] += 1
                continue
            status["ok-quote-at-head"] += 1
            conf = "quote"
        elif shas:
            status["ok-fix-after-head"] += 1
            conf = "fix-after-head"
        else:
            status["unproven"] += 1
            continue
        usable.append(dict(id=x["id"], reviewer=re.sub(r"-chunk-\d+$", "", str(x.get("reviewer"))), severity=x["severity"], file=path, line=x.get("line"), problem=x.get("problem"), impact=x.get("impact"), quote=q or None, proof=conf))
    seen_heads[r["head"]] = True
    print("%-50s lines=%5d usable=%2d %s" % (r["pkg"][:50], r["lines"], len(usable), dict(status)))
    if len(usable) >= 2:
        out.append(dict(pkg=r["pkg"], base=r["base"], head=r["head"], lines=r["lines"], nfiles=r["nfiles"], created=r["created"], findings=usable))
json.dump(out, open(HERE + "/corpus.json", "w"), indent=1, ensure_ascii=False)
tot = collections.Counter(x["reviewer"] for r in out for x in r["findings"])
print("\ncorpus packages:", len(out), "findings:", sum(tot.values()))
print("by reviewer:", tot.most_common())
print("by proof:", collections.Counter(x["proof"] for r in out for x in r["findings"]))
