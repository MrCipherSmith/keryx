# Implementation Plan

Status: approved by operator instruction (operator chat channel 172447)

## Approach

Reuse the existing review machinery: `runModelTurn` (fail-closed single turn) for the reviewer and one verifier turn per finding, the `keryx:findings` format and `keryx review ingest` for the managed review, and `pr-comments.ts` for GitHub access. Add exactly one write endpoint (`POST pulls/{n}/reviews`) to the allow-list, posted as a single COMMENT review. Metrics are computed from managed review packages, never from a separate store. Rejected: pull_request_target for fork PRs (secret exposure); per-comment posting (noisy, no atomicity).

## Steps

1. `src/review/bot/run.ts`: diff acquisition with byte cap, reviewer turn, verifier turns, ingest.
2. `src/review/bot/post.ts` + allow-list change in `pr-comments.ts`: diff-line anchoring, body fallback, dry run default, head-SHA and open-state guards, redaction check, fork guard.
3. `src/review/bot/metrics.ts` + CLI route `review metrics` (add to GROUP_SUBCOMMANDS).
4. `action.yml` + example workflow under docs; workflow lint test.
5. TUI: `/reviews`, modal, sidebar, readline equivalent.
6. Docs, README, CHANGELOG, version bump.

## Risks

- Model-produced line numbers off the diff: anchor only lines present in the parsed diff hunks, otherwise body.
- Cost of unbounded diffs: byte cap, stated in output.
- Prompt injection from PR text into the reviewer: output check on every comment body, findings withheld and counted.
