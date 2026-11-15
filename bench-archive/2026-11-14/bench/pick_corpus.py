import json, os, glob, collections, subprocess, re

ROOT = "$REPO"
MP = ROOT + "/.metaproject"
OUT = os.path.dirname(os.path.abspath(__file__))


def git(*a):
    r = subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


def ld(p):
    try:
        return json.load(open(p))
    except Exception:
        return None


dirs = [MP + "/reviews/" + d for d in sorted(os.listdir(MP + "/reviews")) if os.path.isdir(MP + "/reviews/" + d) and d != "pr-comments"]
dirs += sorted(p for p in glob.glob(MP + "/flows/*/reviews/*") if os.path.isdir(p))
best = {}
for P in dirs:
    f = ld(P + "/findings.json")
    m = ld(P + "/manifest.json")
    if not isinstance(f, list) or m is None:
        continue
    key = os.path.basename(P)
    score = sum(1 for x in f if x.get("disposition"))
    if key not in best or score > best[key][0]:
        best[key] = (score, P, f, m)

why = collections.Counter()
rows = []
for key, (_, P, f, m) in sorted(best.items()):
    rnd = ld(P + "/round.json") or {}
    if rnd.get("mode") == "delta" or (rnd.get("round") or 1) > 1:
        why["delta-round"] += 1
        continue
    t = m.get("target") or {}
    head = t.get("head") if isinstance(t, dict) else None
    if not head:
        why["no-head"] += 1
        continue
    if git("cat-file", "-e", head + "^{commit}")[0] != 0:
        why["head-not-in-repo"] += 1
        continue
    base = (t.get("base") if isinstance(t, dict) else None) or rnd.get("mergeBase")
    if not base or git("cat-file", "-e", str(base) + "^{commit}")[0] != 0:
        rc, base = git("merge-base", head, "origin/main")
        if rc != 0:
            why["no-merge-base"] += 1
            continue
    if git("rev-parse", base)[1] == git("rev-parse", head)[1]:
        why["base-equals-head"] += 1
        continue
    acted = []
    for x in f:
        d = x.get("disposition")
        if isinstance(d, dict) and d.get("state") == "acted-on" and x.get("severity") in ("blocker", "major") and x.get("file"):
            acted.append(x)
    if len(acted) < 2:
        why["<2 acted blocker/major"] += 1
        continue
    rc, names = git("diff", "--name-only", base, head, "--", ".", ":!.metaproject", ":!CHANGELOG.md", ":!bun.lock")
    files = set(names.split("\n")) if names else set()
    infiles = [x for x in acted if x["file"].split(":")[0].strip() in files]
    if len(infiles) < 2:
        why["acted findings not in diff files"] += 1
        continue
    rc, stat = git("diff", "--shortstat", base, head, "--", ".", ":!.metaproject", ":!CHANGELOG.md", ":!bun.lock")
    ins = sum(int(n) for n in re.findall(r"(\d+) insertion", stat)) + sum(int(n) for n in re.findall(r"(\d+) deletion", stat))
    if ins < 80 or ins > 4000:
        why["diff size out of range (%s)" % ("small" if ins < 80 else "large")] += 1
        continue
    revs = collections.Counter(re.sub(r"-chunk-\d+$", "", str(x.get("reviewer"))) for x in infiles)
    rows.append(dict(pkg=key, path=P, base=git("rev-parse", base)[1], head=head, lines=ins, nfiles=len(files), acted=len(infiles), reviewers=dict(revs), created=(m.get("createdAt") or "")[:10], mode=m.get("mode")))

print("rejected:", why.most_common())
print("eligible:", len(rows))
allrev = collections.Counter()
for r in rows:
    allrev.update(r["reviewers"])
    print("%-52s %s %5d lines %3d files acted=%2d %s" % (r["pkg"][:52], r["created"], r["lines"], r["nfiles"], r["acted"], r["reviewers"]))
print("findings by reviewer across eligible:", allrev.most_common())
json.dump(rows, open(OUT + "/eligible.json", "w"), indent=1)
