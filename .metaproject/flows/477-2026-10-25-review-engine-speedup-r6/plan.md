# Implementation Plan

Status: draft

## Approach

One new module, `src/review/estimate-actual.ts`, owns the projection: the plan from `plan.json` (`dispatches`, `minutes.min/max`), else `plan-confirmation.json`; the actual time from the mtimes of `raw/*.txt` (the same reader the wave journal uses); pauses are gaps between neighbouring raw replies longer than 10 minutes; active time is calendar time minus the pauses. Marks are called unusable when the first raw reply is older than `plan.json` (a copied package). The estimate code is not touched.

Consumers: `completeManagedReview` upserts the line into `report.md` (after the `Evidence level:` line, before the package hash is recorded) and `review complete` prints it; the review panel row (`formatReviewDepthRowLines`) shows it for open and closed rounds.

Decisions taken from the code, not from the doc text:
- `plan.json` is written by `keryx review plan`; packages without it (9 of 28 in doc 21) fall back to `plan-confirmation.json` and otherwise say there is no recorded plan. The estimate is not recomputed: doc 21 found 4 of 19 recorded plans differ from a recomputation, and the line must quote what the round was held to.
- The clock is the raw mtimes, as in doc 21, so it covers packages older than the wave journal.
- The line says nothing about the time after the last raw reply (verifier, premise, ingest, publication).

## Steps

1. T1 module and unit tests (plan sources, pauses, unusable marks, idempotent upsert).
2. T2 `review complete` upsert, output and help; panel row.
3. T3 docs, CHANGELOG; acceptance on `cp -a` copies of #8174 and #8086 with fingerprints of the originals; verification.md.

## Risks

- mtimes of copied packages are not the round's: the unusable-marks rule, and copies for acceptance are made with `cp -a`.
- `ingest` rewrites `report.md` and drops the line: `complete` writes it again.
- A package completed twice after more raw replies updates the line, never duplicates it.
