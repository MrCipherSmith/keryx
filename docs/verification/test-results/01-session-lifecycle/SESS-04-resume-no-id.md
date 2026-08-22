# SESS-04 — `-r` with no id resumes the last session

**Area:** 1. Session lifecycle · **Date:** 2026-08-22 · **Status:** PASS (corrected — see note)

## Test case (from the catalog)

> `-r` with no id resumes the **last** session (undocumented-by-flag-shape gotcha, confirmed
> live) — same as `-c`.

## Correction note

A first attempt at this test (dispatched to a Haiku subagent during a large wave of ~10 truly
concurrent subagents, all creating/updating `keryx shell` sessions in this same project
simultaneously) reported FAIL: neither `-r` nor `-c` resumed the just-created fresh session —
each picked up a *different*, unrelated older session. That result is preserved below as a real
observation, but the conclusion drawn from it (a bug in session selection) does not hold up: this
project's session store is shared across every concurrent `keryx shell` invocation, and "most
recent session" is a genuinely moving target when a dozen other processes are creating/updating
sessions in the same window. The original attempt almost certainly raced against a sibling
subagent's own session write between its "create fresh" and "resume" steps.

**Re-run immediately below, back-to-back, with no other `keryx shell` activity in flight**,
confirms the documented behavior holds.

## What was actually run (clean re-run)

```bash
printf 'sess04-fresh-marker\n' | DEEPSEEK_API_KEY="$(...)" keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
# -> fresh session id: 21500985

printf 'sess04-resume-check\n' | DEEPSEEK_API_KEY="$(...)" keryx shell -r --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
# -> "Resumed session 21500985 ..." — SAME id
```

## Summary

Confirmed exactly as documented: `-r` with no id resumes the same session `-c` would, i.e. the
most recently updated one — when there is no concurrent session activity to confound "most
recent."

## Analysis

The original FAIL result is retained as a secondary, real observation worth keeping in mind for
this whole testing campaign's methodology, not as a product defect: **`keryx sessions`
"most-recent" selection is genuinely shared, project-wide, mutable state** — any test relying on
"the session I just created is the most recent one" is only valid if nothing else touches that
project's session store in between. Several other reports in this campaign ran many parallel
subagents against the same project concurrently; any test that assumed session-store isolation
without actually enforcing it could show the same kind of false failure. Worth a light second
pass over other reports from the high-concurrency waves if their conclusions hinge on "most
recent."

## Improvement / fix suggestion

None for the product — behaves as documented under normal (non-adversarially-concurrent) use.
For future test campaigns of this shape: either serialize session-lifecycle tests specifically
(they're cheap and few), or have each test explicitly verify no other session was touched
between its own create/resume steps (e.g. via a session-store snapshot before/after) rather than
assuming isolation.
