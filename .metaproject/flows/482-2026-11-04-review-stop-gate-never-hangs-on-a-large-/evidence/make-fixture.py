"""Fixture repo for the review stop gate: an open package plus a large leftover mutation scratch tree."""
import json, os, sys

root = sys.argv[1]
n = int(sys.argv[2])
pkg = os.path.join(root, ".metaproject", "reviews", "2026-11-04-review-flow-fixture")
os.makedirs(pkg, exist_ok=True)
with open(os.path.join(pkg, "manifest.json"), "w") as f:
    json.dump({"reviewId": "2026-11-04-review-flow-fixture", "mode": "review-flow", "status": "draft"}, f)
os.makedirs(os.path.join(root, ".git"), exist_ok=True)
where = sys.argv[3] if len(sys.argv) > 3 else "scratch"
scratch = (
    os.path.join(pkg, "research-evidence", "head")
    if where == "package"
    else os.path.join(root, ".metaproject", "data", "review", "mutate-scratch", "keryx-mutate-AS0xE6", "tree")
)
per_dir = 200
for i in range(n):
    d = os.path.join(scratch, ".claude", "worktrees", f"wt{i // 5000}", "src", f"d{i // per_dir}")
    if i % per_dir == 0:
        os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"f{i}.ts"), "w") as f:
        f.write(f"export const v{i} = {i};\n" * 20)
os.makedirs(os.path.join(root, ".metaproject", "data", "review", "drivers"), exist_ok=True)
with open(os.path.join(root, ".metaproject", "data", "review", "drivers", "review-logic-w1.json"), "w") as f:
    f.write("{}")
print(f"fixture {root}: {n} scratch files")
