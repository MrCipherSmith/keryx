# Implementation Plan

Status: draft

## Approach

One new module, `src/review/chunk-findings.ts`, owns everything about pass findings: read the live pass (`computeChunkPass`), decide which are "in the round" (match by `file:line`, or title when there is no line, against `findings.json`), and convert a pass finding into a round finding. The four consumers call it: `chunks merge` (print), `completeManagedReview` (warn + report.md section), `createManagedReviewPackage` (inject before the screen), the skill (step text).

Decisions taken from the code, not from the doc text:
- The finding's `source` field is an enum (internal|external), so the pass origin is encoded in `reviewer`: `review-regression/chunk-NNN` (the screen already matches by containment of `review-regression`).
- Ingest id is `<chunk>-<id>` (R-001 of chunk-001 becomes `chunk-001-R-001` before `assignGlobalIds` renumbers), so ids from different chunks cannot collide.
- Ingest reads the live pass through `computeChunkPass`, not `chunk-pass.json`, so a pass merged after the last `merge` is not stale. It needs `--review-id` of the package where the chunks ran.
- Dedupe by `file:line`: a pass finding already present in the round is not injected twice.
- The screen skips `outside-set` and `no-link-to-change` for the pass reviewers only (`isChunkPassReviewer`); `non-regression-severity` stays, so a minor is dropped. The record in `scope.md` and `blast-radius` JSON names the exemption.
- Schema: a major or blocker needs `class_scope`. Pass findings carry none. Open decision for the operator (poll): honest placeholder `class_scope` (use the pass's own when present), versus refusing, versus relaxing the schema.
- `review complete` warns (variant A). The report.md section is rewritten idempotently before the package hash is recorded.

## Steps

1. T1 module `chunk-findings.ts` and its unit tests.
2. T2 `chunks merge` output and help, `--json` fields.
3. T3 screen exemption and its markdown record; ingest injection and `class_scope` handling.
4. T4 `complete` warning and report.md section; skill (four copies byte-identical), docs, CHANGELOG; acceptance on copies of #8111 and #8158 with fingerprints of the originals; verification.md.

## Risks

- A slash in `reviewer` may upset the ledger or the TUI grouping: checked by `review ledger build` on the ingested copy.
- Pass findings have no `quote`: they become `quote_unlocated`, not a refusal.
- A pass that finishes after the report was written: the skill repeats ingest and report; `complete` warns if it did not.
- The doc line numbers refer to build 0.3.131: every claim is re-checked in code and discrepancies are listed in verification.md.
