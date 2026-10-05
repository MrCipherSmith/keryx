# PII: second review of the ssn identifier guard (rounds, fixes and verifier)

Status: draft (AC not yet shown to the operator; do not freeze)
Source: operator request "Тогда сделай строже" (helyx message 186203, 2026-10-05) and polls 96 and 97

## Problem

Flow 261 closed the pii.ssn identifier-fragment guard (PR #906), but its review package was rebuilt from transcripts by the closing agent: inferred head commit, added fields, a self-named verifier. The operator asked for a stricter treatment. Three fresh rounds of independent read-only reviewers (review-logic, review-security-code) found real defects in the merged guard: a 16-128 char hex neighbour let a crafted prefix launder a genuine SSN, the label veto was narrow and easy to defeat (invisible characters, astral and confusable letters, separators, a label at the window edge), and the truncation-guard test could not fail. The fixes live in PR #909. Recording those rounds inside the closed flow 261 would break its completion check (no verifier verdict, head mismatch, five-round cap), so the work is tracked here with its own package.

## Expected Outcome

The guard suppresses an SSN-shaped match only next to an adjacent hex token of exactly 32, 40 or 64 characters, a label within 64 characters either side (after folding) vetoes the suppression, tokens over 192 characters never suppress, and the phone rule is unchanged. Every finding of every round has a terminal disposition in a review package that carries real data and a real verifier run.

## Outcome criteria

- Запрос (дословно): «Тогда сделай строже» (source: helyx message 186203, 2026-10-05); decisions in poll 96 (narrow the exclusion, widen the labels) and poll 97 (new flow, move old defects to flow 409)
- Эффект (формализация агента): a genuine SSN is redacted unless an exact-length md5/sha1/sha256 hash is adjacent and no SSN label is near it; the review record of this work is real and gate-clean.
- Как наблюдать (предложение агента): the named tests in `src/security/detect/pii-identifier-sweep.test.ts` on main, mutation results in the review package, and `keryx flow check-complete` for this flow.

## Out of Scope

- The SSN `\b` boundary (SSN glued to a letter, underscore or fullwidth digits) and the quadratic time on very long inputs: pre-existing, moved to flow 409 as items.
- The unanchored `nss` and `social` over-match (false redaction only): left open for the operator.
- The phone rule.
- TUI surfaces: the detector has no operator-visible setting, so the standing TUI rule has nothing to attach to here.
