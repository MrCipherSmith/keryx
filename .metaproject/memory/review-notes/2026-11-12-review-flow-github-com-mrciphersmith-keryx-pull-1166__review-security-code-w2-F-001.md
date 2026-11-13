# Review finding 2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w2:F-001 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-security-code raised 2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w2:F-001 (minor) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166#review-security-code-w2:F-001` (display id `review-security-code-w2:F-001`)
- Reviewer: `review-security-code`
- Severity: `minor`
- Location: `src/review/managed.ts`:1057
- Origin: `internal`
- What it claimed: The operator-reason requirement for `review complete --head` applies only when a head was recorded at start. When `stored.target.head` is absent or empty, any well-formed `--head` is written to `manifest.target.head` with no `--head-reason`, no TTY check and no `head_override` record. `completeHeadGate` then compares that agent-supplied value with the PR head (`reviewed !== null && prHead !== null && !sameCommit(...)`), so passing the PR's current head makes item `head` pass whatever tree the reviewers actually read.
- Why it was dismissed: operator (host-question claude-code:premise-empty-head, 2026-11-12T13:03:19.698Z) on the premise question: Operator: no bypass (item head already passes with no recorded head); head_override from:null goes to flow 490
- Attested by: human — operator (host-question claude-code:premise-empty-head, 2026-11-12T13:03:19.698Z) on the premise question: Operator: no bypass (item head already passes with no recorded head); head_override from:null goes to flow 490

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/reviews/2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166
- Created: 2026-11-13
- Updated: 2026-11-13

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- review-note
- false-positive
- round:2026-11-12-review-flow-github-com-mrciphersmith-keryx-pull-1166
- commit:e9ac9253fde7

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
