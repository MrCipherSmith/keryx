# Verification sensitivity: mark exec/invariant checks proven to catch a failure

Status: formalized
Source: operator request of 2026-10-11, the "Обновление 11 октября 2026" section of the verify-kind flow request (keryx-handoff), prompted by a reader's comment on part 1 of the role-blurring study. Stacked on flow 422 (PR #957), whose marker work it extends.

## Problem

The `[verify: …]` marker (flows 379, 422) says *how* a criterion is checked, not whether the check can
detect a failure. A reproducible test can keep confirming a criterion that is too narrow. The reader's
example: a successful form submission does not check what happens when the CRM is down; a
failure scenario with an observable result is needed (the request is saved, the error is visible, a
retry creates no duplicate). keryx has hit this: in flow 397 removing one of the calls left every test
green.

Today negative scenarios are separate criteria by convention (flow 414 AC4, AC7), and sensitivity is
sometimes written into the text ("the test fails on revert", 412 AC1; a mutation run, 417 AC14), but
nothing records it.

## Expected Outcome

- An optional sensitivity note on `exec`/`invariant` markers, e.g.
  `[verify: exec \`<command>\` · sensitive: revert]`, value one of `revert|mutation|failure-scenario`.
  It sits inside the criterion line, so the checksum covers it; existing markers without it parse
  exactly as before; on `judged`/`none` it is rejected as a parser error (reads `unclassified`, like
  any malformed marker).
- `keryx flow ac kinds` reports how many `exec`/`invariant` criteria carry the note and how many do not.
- The flow-init criteria step and flow-orchestrator (both copies) get one line: behaviour with an
  external dependency or a failure path gets its own failure-scenario criterion with an observable
  result; a test claimed to catch a regression says how that was proven.
- `keryx flow ac confirm` on a criterion with a sensitivity note prints a warning when `--note` names
  no evidence of the proof (a revert/mutation run or failure-scenario reference), and confirms anyway.
- `sync-status.md` shows the share of `exec`/`invariant` criteria with the note among criteria of flows
  frozen in the last 7 days. No threshold, no warning: an observation, not a target.
- Docs (`cli-reference.md`) and CHANGELOG.

## Outcome criteria

- not measured as a target: the share in `sync-status.md` is a research observation for part 2
  (candidate extension of M1: "verification stated" vs "verification proven sensitive"), not a
  confirmatory measure of the protocol.

## Out of Scope

- Any gate on kinds or on the sensitivity note (the "a kind never blocks" constraint holds).
- Retro-tagging existing flows.
- Running mutation testing automatically.
