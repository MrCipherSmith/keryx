# Verification — flow 477 (review-engine-speedup R6: H1, H2)

Acceptance by the `Verification:` fields of the package, run on `cp -a` copies of the two vantage-frontend review packages
(#8174, #8086) with the build from this worktree (`bun src/cli.ts review status <copy>`). The originals were fingerprinted
(path, size, mtime of every file, sha256 of the sorted list) before and after: unchanged (`#8174` 159 files, `a1f4d4552f59`;
`#8086` 273 files, `f6a98f89bdfe`).

## Result per package

| Check | Result |
|---|---|
| H1 `review status`, #8174 copy | `Plan estimate vs actual: plan 28-70 min (54 dispatches); actual so far 43 min from first to last raw reply (67 replies); pauses over 10 min: 0` |
| H1 `review status`, #8086 copy | `Plan estimate vs actual: plan 44-110 min (88 dispatches); actual so far 106 min from first to last raw reply (132 replies); pauses over 10 min: 1 (59 min), 46 min without them` |
| H1 `review complete` | `estimate-actual-complete.test.ts`: the line lands right after `Evidence level:`, is returned and printed, a second close leaves one line, a package with neither plan nor raw replies keeps its report byte for byte |
| H2 constants | `estimate.test.ts` pins `TYPICAL_DISPATCH_MINUTES=2`, `CHILD_DEADLINE_MINUTES=5`, `ASSUMED_PARALLEL_DISPATCHES=4`, `DEFAULT_MAX_DISPATCHES=40`, `DEFAULT_MAX_MINUTES=90`; `src/review/estimate.ts` is not in the diff |

Both numbers match doc 21 (28-70 / about 43 / 0 pauses; 44-110 / 106 calendar / one pause of 59 / about 46 active).

## Findings the text did not predict

1. **Neither real package can be completed.** Both are unfinished (`status: draft`, `report.md` is a 60-byte stub, readiness
   NOT READY), so `review complete` is refused on them. The real-package acceptance ran through `review status` (which
   now prints the same line, read-only); the `complete` path is covered by `estimate-actual-complete.test.ts` on a
   completable fixture. AC1/AC2 were re-worded before the freeze to say this. Operator poll 305 on this wording had no
   answer at the time of the freeze.
2. **"So far" on a draft package.** `status` marks any package that is not `closed` as open, so the real copies read `actual so
   far`. The numbers are the final ones; the packages simply were never closed.
3. **A stale `report.md` was written back.** `completeManagedReview` read the report before the readiness waivers, which put
   the `Partial review:` header at its top; writing the line from that stale text dropped the header. `readiness.test.ts`
   caught it; the report is now read again right before the edit. This also removes the same hazard for the chunk-pass
   section.
4. **Copied packages.** The copies made by `cp -a` keep mtimes, so the numbers above are the round's. A copy by plain `cp`
   would set every raw file to the copy time; the line then says `actual not shown` (tested with five replies within a
   minute, and with replies older than `plan.json`).
5. **46 or 47 minutes.** Doc 21 says about 46; the computed value is 46 (the raw times are not whole minutes: 106.x - 59.x).
6. **Doc 21: 4 of 19 recorded plans differ from a recomputation**, so the line quotes `plan.json` as recorded and never
   recomputes.

## Requirements and how they were accepted

| Requirement | Evidence |
|---|---|
| H1 line with plan, actual, pauses over 10 min | the two copies (above); `estimate-actual.test.ts` (19: pauses, exactly 10 min is not a pause, plan sources, missing plan, missing replies, open round, unusable marks, idempotent upsert) |
| H1 in the report | `estimate-actual-complete.test.ts` (2) |
| H1 in the panel | `review-panel.test.ts` "plan estimate against the actual time" (2: closed and open, row without anything unchanged) |
| H2 estimate unchanged | `estimate.test.ts` pin; no diff in `src/review/estimate.ts` |
| Docs | `docs/docs/cli-reference.md` (review complete section), `docs/docs/guides/review-with-a-record.md` ("The plan against the clock"), `review complete` and `review status` help, `CHANGELOG.md` `[Unreleased]` |

Tests: `bun test src/review/estimate.test.ts src/review/estimate-actual.test.ts src/review/estimate-actual-complete.test.ts
src/tui/review-panel.test.ts src/tui/review-inspector.test.ts` green; `bun test src/review src/tui src/commands/review` 7994
tests: all green except two `src/tui/ci-triage-source.test.ts` cases ("not opted in") that fail the same way in the r4
worktree off main (unrelated; they depend on the environment); `bun run typecheck` clean.

## TUI (AC6)

The review panel row (`formatReviewDepthRowLines`, shared by the `/reviews` Review depth tab and the readline text) carries
the line through a new `timing` field of `ReviewDepthRow`; `/reviews` is the surface for it. A row with no plan and no raw
replies has no `timing` and is unchanged.

## Could not be checked

- `review complete` on a real closed package: both vantage-frontend packages are unfinished; only the fixture covers it.
- The time after the last raw reply (verifier, premise, ingest, publication): no file records it, and the line says so.
- A live round after this build, with `wave-events.jsonl` next to the raw files (the clock is the raw mtimes on purpose).
