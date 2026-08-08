#!/usr/bin/env python3
"""Self-test for the guards in drive.py that decide what counts as a result.

Run: python3 drive-selftest.py

There is no python test runner in this repository, and these guards are the
reason four dead legs in run 3 were recorded as measurements — so they are
checked against the REAL transcripts those legs produced, kept under
evidence/run-3/blocked/, rather than against strings retyped from memory.

A fixture that no longer exists is a failure, not a skip: the whole point is
that the check is pinned to evidence.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drive import provider_wall  # noqa: E402

PKG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
BLOCKED = os.path.join(PKG, "evidence", "run-3", "blocked")

failures = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


def read(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


# --- the two walls that were recorded as DONE in run 3 -----------------------

deepseek = os.path.join(BLOCKED, "A3-keryx-deepseek-insufficient-balance.txt")
check("deepseek balance transcript is still on disk", os.path.exists(deepseek), deepseek)
if os.path.exists(deepseek):
    hit = provider_wall(read(deepseek))
    check("deepseek balance wall is detected", hit == "Insufficient Balance", repr(hit))

grok = os.path.join(BLOCKED, "A1-baseline-grok-weekly-limit", "transcript.txt")
check("grok weekly-limit transcript is still on disk", os.path.exists(grok), grok)
if os.path.exists(grok):
    hit = provider_wall(read(grok))
    check("grok weekly-limit wall is detected", hit == "You hit your weekly limit", repr(hit))

# --- a real answer must not be mistaken for a wall ---------------------------

good = os.path.join(PKG, "evidence", "run-3", "A1-baseline-claude", "transcript.txt")
check("a real answered transcript is still on disk", os.path.exists(good), good)
if os.path.exists(good):
    hit = provider_wall(read(good))
    check("a real answer is not flagged as a wall", hit is None, repr(hit))

# --- the generic-word trap ---------------------------------------------------
#
# An agent reading code can legitimately write these. Matching on "quota" or
# "rate limit" as words would fail the run for saying them, which is why
# PROVIDER_WALLS holds provider phrases instead.

prose = (
    "The retry helper in src/lib/http.ts backs off on a rate limit, and the "
    "quota for the search index is configured per project. Nothing here is "
    "exceeded — I am describing the code, not hitting a limit."
)
check("prose about rate limits and quotas is not a wall",
      provider_wall(prose) is None, repr(provider_wall(prose)))

# --- case-insensitivity, since providers are not consistent ------------------

check("matching is case-insensitive",
      provider_wall("[error] INSUFFICIENT BALANCE") == "Insufficient Balance")

print()
if failures:
    print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1)
print("all checks passed")
