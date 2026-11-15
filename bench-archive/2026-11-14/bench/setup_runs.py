import json, os, subprocess

ROOT = "$REPO"
HERE = os.path.dirname(os.path.abspath(__file__))
corpus = json.load(open(HERE + "/corpus.json"))
os.makedirs(HERE + "/wt", exist_ok=True)
os.makedirs(HERE + "/diff", exist_ok=True)
os.makedirs(HERE + "/out", exist_ok=True)
os.makedirs(HERE + "/truth", exist_ok=True)
runs = []
for i, r in enumerate(corpus, 1):
    tag = "c%02d" % i
    wt = HERE + "/wt/" + tag
    if not os.path.isdir(wt):
        p = subprocess.run(["git", "-C", ROOT, "worktree", "add", "--detach", wt, r["head"]], capture_output=True, text=True)
        assert p.returncode == 0, p.stderr
        os.symlink(ROOT + "/node_modules", wt + "/node_modules")
    d = subprocess.run(["git", "-C", ROOT, "diff", r["base"], r["head"], "--", ".", ":!.metaproject", ":!CHANGELOG.md", ":!bun.lock"], capture_output=True, text=True, errors="replace").stdout
    open(HERE + "/diff/" + tag + ".diff", "w").write(d)
    # ground truth, reviewer names stripped and order kept, for the blind judge
    truth = [dict(tid="T%d" % (j + 1), file=x["file"], line=x["line"], severity=x["severity"], problem=x["problem"], impact=x["impact"], quote=x["quote"]) for j, x in enumerate(r["findings"])]
    json.dump(truth, open(HERE + "/truth/" + tag + ".json", "w"), indent=1, ensure_ascii=False)
    runs.append(dict(tag=tag, pkg=r["pkg"], base=r["base"], head=r["head"], wt=wt, diff_lines=d.count("\n"), truth=len(truth), reviewers=[x["reviewer"] for x in r["findings"]]))
    print(tag, r["pkg"][:48], "diff lines", d.count("\n"), "truth", len(truth))
json.dump(runs, open(HERE + "/runs.json", "w"), indent=1)
