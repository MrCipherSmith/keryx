import json, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
corpus = json.load(open(HERE + "/corpus.json"))
rows = []
for i, r in enumerate(corpus, 1):
    tag = "c%02d" % i
    out = json.load(open(HERE + "/judge/%s.out.json" % tag))
    assert len(out) == len(r["findings"]), tag
    for x, j in zip(r["findings"], out):
        rv = x["reviewer"]
        if not rv.startswith("review-") or rv == "review-orchestrator" or rv == "review-pr510":
            rv = "(unnamed)"
        rows.append(dict(tag=tag, rv=rv, sev=x["severity"], proof=x["proof"], v=j["verdict"], why=j.get("why", "")))


def tab(sel, label):
    g = collections.defaultdict(collections.Counter)
    for r in sel:
        g[r["rv"]][r["v"]] += 1
        g["ALL"][r["v"]] += 1
    print("\n" + label)
    print("%-26s %4s %6s %8s %5s %8s" % ("lens", "n", "match", "partial", "miss", "found%"))
    for k in sorted(g, key=lambda k: (k == "ALL", -sum(g[k].values()))):
        c = g[k]
        n = sum(c.values())
        print("%-26s %4d %6d %8d %5d %7.0f%%" % (k, n, c["match"], c["partial"], c["miss"], 100 * (c["match"] + 0.5 * c["partial"]) / n))


tab(rows, "ALL 46 (found% counts partial as half)")
tab([r for r in rows if r["proof"] == "quote"], "ONLY quote-proven (defect text present at head)")
tab([r for r in rows if r["proof"] != "quote"], "ONLY fix-after-head (weaker proof)")
print("\nper case:")
for t in sorted({r["tag"] for r in rows}):
    c = collections.Counter(r["v"] for r in rows if r["tag"] == t)
    p = collections.Counter(r["proof"] for r in rows if r["tag"] == t)
    print(t, dict(c), dict(p))
