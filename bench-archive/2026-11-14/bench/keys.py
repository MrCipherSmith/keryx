import json, os, glob, collections

MP = "$REPO/.metaproject"
dirs = [MP + "/reviews/" + d for d in sorted(os.listdir(MP + "/reviews")) if os.path.isdir(MP + "/reviews/" + d) and d != "pr-comments"]
dirs += sorted(p for p in glob.glob(MP + "/flows/*/reviews/*") if os.path.isdir(p))
mk = collections.Counter()
fk = collections.Counter()
rk = collections.Counter()
sample = None
for P in dirs:
    try:
        m = json.load(open(P + "/manifest.json"))
        f = json.load(open(P + "/findings.json"))
    except Exception:
        continue
    mk.update(m.keys())
    if isinstance(f, list):
        for x in f:
            fk.update(x.keys())
    try:
        r = json.load(open(P + "/round.json"))
        rk.update(r.keys())
    except Exception:
        pass
    if sample is None and isinstance(f, list) and any(isinstance(x.get("disposition"), dict) for x in f):
        sample = (P, m, [x for x in f if isinstance(x.get("disposition"), dict)][0])
print("manifest keys", mk.most_common(40))
print("finding keys", fk.most_common(40))
print("round keys", rk.most_common(20))
P, m, x = sample
print(P)
print(json.dumps({k: (v if not isinstance(v, (list, dict)) else str(v)[:300]) for k, v in m.items()}, indent=1, ensure_ascii=False)[:3000])
print(json.dumps(x, indent=1, ensure_ascii=False)[:2500])
