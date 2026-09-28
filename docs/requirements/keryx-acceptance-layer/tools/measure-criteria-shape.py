#!/usr/bin/env python3
"""Measurements 1b and 1c — what the frozen criteria already say about their
own verification, and how that changed over time.

No diff, no model, no network. Reads `.metaproject/flows/*/acceptance-criteria.md`
from the working tree and reports:

  1b  how many criteria claim verification in prose, how many name a concrete
      test file, how many name any runnable command, and how many claim
      coverage while naming nothing runnable;
  1c  the same, sliced by flow number, which is chronological.

Caveat that belongs with the output, not in a footnote: a backticked command is
often the criterion's SUBJECT rather than its check — "`keryx flow status` shows
X" names a command that verifies nothing. No regex separates the two, so the
"names anything runnable" figure is an upper bound, never an estimate.

Usage:  python3 measure-criteria-shape.py [repo-root]
"""
import collections
import glob
import os
import re
import sys

AC = re.compile(r"^\s*[-*]\s*(AC\d+)\s*:\s?(.*)$", re.I)
COVERED = re.compile(r"\bcover(?:ed|s)\b|\bproven by\b|\bdemonstrat(?:ed|es)\b", re.I)
TEST_FILE = re.compile(r"[\w./-]+\.(?:test|spec)\.[tj]sx?\b")
RUNNABLE_CMD = re.compile(r"`(bun|npm|pnpm|keryx|tsc|git)[^`]*`")
BACKTICK = re.compile(r"`([^`]+)`")
BARE_PATH = re.compile(r"\b[\w.-]+/[\w./-]+\.[a-zA-Z]{1,6}\b")

BUCKETS = ((100, "1-100"), (200, "101-200"), (300, "201-300"), (10**9, "301+"))


def bucket_for(flow_number: int) -> str:
    for ceiling, label in BUCKETS:
        if flow_number <= ceiling:
            return label
    return BUCKETS[-1][1]


def classify(text: str) -> dict:
    tokens = set()
    for match in BACKTICK.finditer(text):
        tokens.add((match.group(1) or "").strip())
    for match in BARE_PATH.finditer(text):
        tokens.add(match.group(0))
    names_test = bool(TEST_FILE.search(text))
    names_cmd = bool(RUNNABLE_CMD.search(text))
    return {
        "claims": bool(COVERED.search(text)),
        "names_test": names_test,
        "runnable": names_test or names_cmd,
        "no_artefact": not tokens,
    }


def main(root: str) -> int:
    overall = collections.Counter()
    by_bucket = collections.defaultdict(collections.Counter)
    pattern = os.path.join(root, ".metaproject", "flows", "*", "acceptance-criteria.md")
    files = sorted(glob.glob(pattern))
    if not files:
        print(f"no acceptance-criteria.md under {pattern}", file=sys.stderr)
        return 1

    for path in files:
        match = re.search(r"/flows/(\d+)-", path)
        label = bucket_for(int(match.group(1))) if match else "unnumbered"
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                parsed = AC.match(line)
                if not parsed:
                    continue
                text = (parsed.group(2) or "").strip()
                if not text:
                    continue
                flags = classify(text)
                overall["n"] += 1
                by_bucket[label]["n"] += 1
                for key, hit in flags.items():
                    if hit:
                        overall[key] += 1
                        by_bucket[label][key] += 1
                if flags["claims"] and not flags["runnable"]:
                    overall["claims_nothing_runnable"] += 1

    def pct(counter, key):
        return 100 * counter[key] / counter["n"] if counter["n"] else 0.0

    print(f"criteria                              : {overall['n']}")
    print(f"claim verification in prose           : {overall['claims']:5d}  {pct(overall,'claims'):5.1f}%")
    print(f"name a concrete test file             : {overall['names_test']:5d}  {pct(overall,'names_test'):5.1f}%")
    print(f"name anything runnable (UPPER BOUND)  : {overall['runnable']:5d}  {pct(overall,'runnable'):5.1f}%")
    print(f"name no artefact at all               : {overall['no_artefact']:5d}  {pct(overall,'no_artefact'):5.1f}%")
    print(f"claim coverage, name nothing runnable : {overall['claims_nothing_runnable']:5d}  "
          f"{100*overall['claims_nothing_runnable']/overall['n'] if overall['n'] else 0:5.1f}%")
    print()
    print(f"{'flows':10s} {'criteria':>9s} {'claims':>9s} {'names test':>12s}")
    for _, label in BUCKETS:
        counter = by_bucket.get(label)
        if not counter:
            continue
        print(f"{label:10s} {counter['n']:9d} {pct(counter,'claims'):8.1f}% {pct(counter,'names_test'):11.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
