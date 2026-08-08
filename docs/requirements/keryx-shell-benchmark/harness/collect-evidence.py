#!/usr/bin/env python3
"""Copy finished run bundles out of the gitignored harness runs directory into
the tracked evidence tree.

`harness/runs/` is gitignored and lives next to the disposable worktrees, so a
cleanup — or a session that ends before anything is committed — takes the
evidence with it. This copies the small, readable part of each bundle
(transcript, meta, post-state, prompt, final screenshot) into
`evidence/run-2/<case>-<leg>/`.

Run 1's curated evidence in `evidence/transcripts` and `evidence/screens` is
left alone: the two runs measured different harnesses and must stay
distinguishable.

    ./collect-evidence.py [--since 2026-08-06T18:15]

The default cutoff is the graph fix (a5781969); anything older measured an
empty workspace and is not worth copying.
"""
import argparse
import glob
import json
import os
import shutil

HARNESS = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HARNESS)
DEFAULT_SINCE = "2026-08-06T18:15"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default=DEFAULT_SINCE,
                    help="ISO timestamp; runs started earlier are skipped")
    ap.add_argument("--target", default="helyx")
    ap.add_argument("--into", default=os.path.join(PKG, "evidence", "run-2"))
    args = ap.parse_args()

    src_root = os.path.join(HARNESS, "runs", args.target)
    copied = []
    for meta_path in sorted(glob.glob(src_root + "/*/*/meta.json")):
        meta = json.load(open(meta_path))
        if meta.get("startedAt", "") < args.since:
            continue
        src = os.path.dirname(meta_path)
        name = "%s-%s" % (meta["caseId"], meta["variantId"])
        out = os.path.join(args.into, name)
        os.makedirs(out, exist_ok=True)
        for f in ("transcript.txt", "meta.json", "status.txt", "prompt.txt"):
            p = os.path.join(src, f)
            if os.path.exists(p):
                shutil.copy2(p, os.path.join(out, f))
        screens = sorted(glob.glob(os.path.join(src, "screens", "*.png")))
        if screens:
            shutil.copy2(screens[-1], os.path.join(out, "final.png"))
        copied.append(name)

    for name in copied:
        print(name)
    print("collected %d bundle(s) into %s" % (len(copied), args.into))


if __name__ == "__main__":
    main()
