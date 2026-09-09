# keryx review ingest takes no findings, so verification verdicts are discarded and the flow gate cannot be satisfied

Version: 0.2.0
Type: known-mistake
Status: draft
Confidence: high
Caveat: Observed on 0.2.84/0.2.85 while closing flow 243. The flow completion
gate and `review ingest` were read directly; no fix was attempted.

## Summary

`keryx flow complete` refuses to close a flow whose findings are marked
`acted-on` without a verifier verdict of `refuted`. That verdict can only reach
a round through `keryx review ingest --verifications`, and ingest silently drops
every claim whose finding is not already in the round — but ingest has no way to
put findings INTO a round. `ManagedReviewIngestInput` carries no `findings`
field and the CLI exposes no flag for one, so `findings.json` is always written
`[]` and every verdict is discarded. The gate asks for a record the only
available path cannot write.

## Details

The sequence, reproduced three times on flow 243:

1. `keryx review ingest --report <md> --flow <id> --ref <pr>` creates the
   package and writes `findings.json` as `[]`. A markdown report is not parsed
   for findings — the reviewer agents are expected to have written them.
2. Passing `--verifications <file>` at the same time prints
   `verification claims discarded: N`, because each claim names a finding that
   the round does not contain.
3. Writing `findings.json` by hand afterwards DOES work for the gate — it reads
   the file live — but the manifest's verification counters were already fixed
   at ingest, so the verdicts never attach.

The gate's individual refusals are all correct and worth keeping:

- a disposition of `acted-on` whose evidence names no commit SHA is a claim, not
  a record;
- `review complete` will not overwrite an existing disposition, because the
  outcome and the record of it are one record — a correction must be a new
  round;
- a round run against a SHA that is not the PR head proves nothing about what
  merges;
- `verification_mode: off` means nobody but the finding's author checked it.

The defect is not the strictness. It is that the strict condition is
unreachable through the documented path.

The round cap makes this visible rather than silent: at three rounds with the
gate unsatisfied the tool says the decision is the operator's, which is the
correct behaviour for a gate it cannot itself satisfy. Flow 243 was left
`in-progress` rather than forced.

## What to do instead

Until ingest accepts findings, do not plan on closing a flow through
`review ingest`. Either produce the round with the reviewer path that writes
`findings.json` (`review start` / `review attach`), or expect the flow to stay
open and say so.

The fix, when someone takes it: give `keryx review ingest` a `--findings <file>`
flag feeding the `findings` field that `ManagedReviewInput` already has, so
verifications have something to attach to at ingest time.

## Provenance

- Source: manual
- Link: https://github.com/MrCipherSmith/keryx/pull/499
- Author: MrCipherSmith
- Confirmed-By: reproduced three times on flow 243 (rounds r01, r02, r03)
- Created: 2026-09-09
- Updated: 2026-09-09

## Related Scopes

- Module: review, flow
- Entity: ManagedReviewIngestInput, createManagedReviewPackage, flow-complete gate
- Files: src/commands/review.ts, src/review/managed.ts, src/flow/review-gate.e2e.test.ts
- Skills:

## Tags

review, flow, gate, verification, tooling-gap

## Changelog

- 0.1.0 - Initial version.
- 0.2.0 - Recorded from flow 243: three rounds, the exact discard path, and the
  shape of the fix.
