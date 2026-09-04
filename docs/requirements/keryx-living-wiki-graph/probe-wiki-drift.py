#!/usr/bin/env python3
"""Throwaway probe: how stale is keryx's own wiki, measured with git alone?

No graph traversal, no describes edge, no model. Approximates VerifiedAt by
"the last commit that touched the page file", and the describe-set by "the
directory the page's slug denotes" (moduleNameFromProjectPath = dirname,
slug = slugify). Deliberately crude: the point is to get a number today,
before building anything.

Two counts per page:
  raw   - any commit touching the module since the page was last touched.
          This is roughly what today's sha256-over-key-files would flag,
          since any byte change flips that hash.
  real  - same range, but `git diff -w --ignore-blank-lines` reports an
          actual difference. Whitespace-only churn drops out.
The gap between them is a LOWER BOUND on what a `cosmetic` class would save
(-w ignores whitespace but not comment-only edits).
"""
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone

ROOT = "/Users/tsaitler.aleksandr/goodea/keryx"
WIKI = os.path.join(ROOT, ".metaproject", "wiki")
NODES = os.path.join(ROOT, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl")


def git(*args, check_exit_only=False):
    p = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    if check_exit_only:
        return p.returncode
    return p.stdout.strip()


def slugify(value: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", value.lower())
    return s.strip("-") or "root"


def module_of(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    return "root" if len(parts) <= 1 else "/".join(parts[:-1])


# slug -> (module dir, files DIRECTLY in it), from the graph's own node list.
# The file list matters: a git pathspec of "src" matches the whole subtree,
# but the module "src" is only the files sitting directly in src/. Using the
# directory as a pathspec inflates every parent module enormously (first run
# of this probe reported src.md as 481 commits behind for exactly that
# reason). The explicit file list is also the honest stand-in for a
# describe-set.
slug_to_module = {}
module_files = defaultdict(list)
with open(NODES) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        node = json.loads(line)
        if node.get("kind") == "asset":
            continue
        path = str(node.get("path") or node.get("id") or "")
        mod = module_of(path)
        slug_to_module.setdefault(slugify(mod), mod)
        module_files[mod].append(path)

pages = sorted(
    f for f in os.listdir(os.path.join(WIKI, "components")) if f.endswith(".md")
)

now = datetime.now(timezone.utc)
rows, unmapped, orphans = [], [], []
page_commit_dates = defaultdict(int)

for page in pages:
    slug = page[:-3]
    rel_page = os.path.join(".metaproject", "wiki", "components", page)
    module = slug_to_module.get(slug)

    if module is None:
        # slug maps to no module currently in the graph
        if os.path.isdir(os.path.join(ROOT, slug.replace("-", "/"))):
            unmapped.append(page)
        else:
            orphans.append(page)
        continue

    out = git("log", "-1", "--format=%H %ct", "--", rel_page)
    if not out:
        unmapped.append(page)
        continue
    page_sha, page_ts = out.split()
    page_ts = int(page_ts)
    page_commit_dates[datetime.fromtimestamp(page_ts, timezone.utc).strftime("%Y-%m")] += 1

    files = module_files.get(module, [])
    log = git("log", "--format=%H", f"{page_sha}..HEAD", "--", *files)
    raw = len([l for l in log.splitlines() if l.strip()])
    real = 0
    if raw:
        # exit 1 == differences remain after ignoring whitespace
        real = raw if git("diff", "-w", "--ignore-blank-lines", "--quiet",
                          f"{page_sha}..HEAD", "--", *files,
                          check_exit_only=True) != 0 else 0

    days = (now - datetime.fromtimestamp(page_ts, timezone.utc)).days
    rows.append({"page": page, "module": module, "files": len(files),
                 "raw": raw, "real": real, "days": days})

total = len(rows)
drifted_raw = [r for r in rows if r["raw"] > 0]
drifted_real = [r for r in rows if r["real"] > 0]

print(f"HEAD: {git('rev-parse', '--short', 'HEAD')}   pages in components/: {len(pages)}")
print(f"mapped to a module: {total}   unmapped: {len(unmapped)}   orphan (module gone): {len(orphans)}")
print()
print(f"drifted, any change (~ what today's hash would flag): {len(drifted_raw)}/{total}"
      f"  ({100*len(drifted_raw)//max(total,1)}%)")
print(f"drifted, ignoring whitespace  (~ what LWG would flag): {len(drifted_real)}/{total}"
      f"  ({100*len(drifted_real)//max(total,1)}%)")
print(f"whitespace-only drift (lower bound on `cosmetic` savings): "
      f"{len(drifted_raw) - len(drifted_real)} pages")
print()
if drifted_real:
    behind = sorted(r["raw"] for r in drifted_real)
    mid = behind[len(behind)//2]
    print(f"commits behind, among really-drifted: min {behind[0]}  median {mid}  max {behind[-1]}"
          f"  total {sum(behind)}")
    stale_days = sorted(r["days"] for r in drifted_real)
    print(f"days since page last touched:        min {stale_days[0]}  median "
          f"{stale_days[len(stale_days)//2]}  max {stale_days[-1]}")
print()
print("worst 12 by commits behind:")
for r in sorted(drifted_real, key=lambda r: -r["raw"])[:12]:
    print(f"  {r['raw']:4d} commits  {r['days']:4d}d  {r['files']:3d} files  {r['module']}")
if orphans:
    print(f"\norphan pages (module no longer in graph): {', '.join(orphans)}")
if unmapped:
    print(f"\nunmapped (probe could not resolve): {', '.join(unmapped)}")
print("\npage last-commit distribution by month:")
for month in sorted(page_commit_dates):
    print(f"  {month}: {page_commit_dates[month]}")
