# Review finding 2026-09-28-pr-776-round2-2a2db6b7#REG-F1 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-regression raised 2026-09-28-pr-776-round2-2a2db6b7#REG-F1 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-776-round2-2a2db6b7#REG-F1` (display id `REG-F1`)
- Reviewer: `review-regression`
- Severity: `major`
- Location: `src/security/detect/entropy.ts`
- Origin: `internal`
- What it claimed: isSingleTransitionTag only forgives a segment that changes character class at most once. Medium's and GitHub Gist's common '<slug>-<hex id>' URL convention interleaves letters and digits many times in the trailing id, which fails isWordSlug entirely (one bad segment poisons the whole slug check) and falls through to the entropy gate, qualifying as secret-shaped.
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971: containsOutboundSecret('https://medium.com/real-time-data-evolution/rag-architecture-in-2026-how-to-keep-retrieval-actually-fresh-3a9bae9ec8f9') -> false (was true/refused); containsOutboundSecret('https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890') -> false (was true/refused). bun test src/harness/web/outbound-secret.test.ts -t "REG-F2" -> 8 pass, 0 fail. Both halves of the finding's own repro (Medium URL, Gist URL) now pass at 536a6971 (content-identical to PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c).
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971: containsOutboundSecret('https://medium.com/real-time-data-evolution/rag-architecture-in-2026-how-to-keep-retrieval-actually-fresh-3a9bae9ec8f9') -> false (was true/refused); containsOutboundSecret('https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890') -> false (was true/refused). bun test src/harness/web/outbound-secret.test.ts -t "REG-F2" -> 8 pass, 0 fail. Both halves of the finding's own repro (Medium URL, Gist URL) now pass at 536a6971 (content-identical to PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c).

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/flows/355-2026-09-28-audit-remediation-2-security-depth-entro/reviews/2026-09-28-pr-781-round5-verdicts
- Created: 2026-09-28
- Updated: 2026-09-28

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- review-note
- false-positive
- round:2026-09-28-pr-781-round5-verdicts
- commit:22478bc0a9970324373cbe38fb5fd7e34568f64c

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
