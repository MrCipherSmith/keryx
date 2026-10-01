# Review finding 2026-09-27-ingest-861be8c20e366df1c1a6eea22728ab2e0d2a886e#T5 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-testing-practices raised 2026-09-27-ingest-861be8c20e366df1c1a6eea22728ab2e0d2a886e#T5 (info) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-27-ingest-861be8c20e366df1c1a6eea22728ab2e0d2a886e#T5` (display id `T5`)
- Reviewer: `review-testing-practices`
- Severity: `info`
- Location: `src/cli.test.ts`
- Origin: `internal`
- What it claimed: The name runBunExpectingFailure reads as if it asserts or requires a non-zero exit, but it resolves with whatever exit code occurred, unlike runBun which rejects on non-zero.
- Why it was dismissed: refuted by review-verifier (site-check): keryx ctx rg for `runBunExpectingFailure` in src/cli.test.ts at 70538bea returns zero matches; `runBunCapture` (7 call sites) is the only capture helper in the file. Its JSDoc now reads: 'Same spawn as {@link runBun}, but it never rejects on the exit code: it resolves with stdout/stderr/code whatever the code was, so a test can assert exit 1 (flow 353 AC3) or exit 0 as the case under test.' The name no longer implies a required failure exit, so the naming-vs-behavior mismatch T5 reported is gone.
- Attested by: verifier — review-verifier (site-check): keryx ctx rg for `runBunExpectingFailure` in src/cli.test.ts at 70538bea returns zero matches; `runBunCapture` (7 call sites) is the only capture helper in the file. Its JSDoc now reads: 'Same spawn as {@link runBun}, but it never rejects on the exit code: it resolves with stdout/stderr/code whatever the code was, so a test can assert exit 1 (flow 353 AC3) or exit 0 as the case under test.' The name no longer implies a required failure exit, so the naming-vs-behavior mismatch T5 reported is gone.

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/flows/353-2026-09-27-p0-w5-first-hour-keryx-doctor-did-you-me/reviews/2026-09-27-ingest-origin-main-70538bea
- Created: 2026-09-27
- Updated: 2026-09-27

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- review-note
- false-positive
- round:2026-09-27-ingest-origin-main-70538bea
- commit:f2ee4c8896dde3402c57a8c8544f75544289d0b2

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
