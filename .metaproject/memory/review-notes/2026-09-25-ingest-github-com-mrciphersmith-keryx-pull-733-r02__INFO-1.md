# Review finding 2026-09-25-ingest-github-com-mrciphersmith-keryx-pull-733-r02#INFO-1 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-orchestrator raised 2026-09-25-ingest-github-com-mrciphersmith-keryx-pull-733-r02#INFO-1 (info) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-25-ingest-github-com-mrciphersmith-keryx-pull-733-r02#INFO-1` (display id `INFO-1`)
- Reviewer: `review-orchestrator`
- Severity: `info`
- Location: not located
- Origin: `internal`
- What it claimed: anti_patterns tokens also present in calibration.known_right for scenarios naming the exact pattern reviewed
- Why it was dismissed: assessed against I6/I7's actual requirement; not a defect, no action needed
- Attested by: verifier — flow-338-runner (round-2 opus verification + runner follow-up) (site-check): stack-pack-eval-integrity.test.ts I6/I7 definitions re-read directly; confirmed presence-only requirement, not absence from known_right

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/flows/338-2026-09-25-wave-4-batch-6-stack-packs-for-docker-k8/reviews/2026-09-25-ingest-github-com-mrciphersmith-keryx-pull-733-r02
- Created: 2026-09-25
- Updated: 2026-09-25

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- review-note
- false-positive
- round:2026-09-25-ingest-github-com-mrciphersmith-keryx-pull-733-r02
- commit:41c1be03

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
