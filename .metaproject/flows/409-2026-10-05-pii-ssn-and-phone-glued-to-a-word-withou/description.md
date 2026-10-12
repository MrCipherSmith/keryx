# PII: SSN and phone glued to a word without hyphen; ssn label reported as phone

Status: draft (AC not yet shown to the operator; do not freeze)
Source: operator poll 95 (2026-10-05T18:26Z); follow-up F-003 and a note from flow 261 (PR #906)

## Problem

Two gaps found while closing flow 261, both left out of its scope by decision:

1. An SSN glued to word characters without a hyphen, such as `abc123-45-6789`, is not matched at all, before or after flow 261. The same holds for a phone number. The `\b` boundary in `src/security/detect/pii.ts` does not fire between a letter and a digit, so the number leaks.
2. A value labelled `ssn: 123-45-6789` is reported as `[REDACTED:phone]` instead of `pii.ssn`, so the audit trail names the wrong policy.
3. Found by the second review of the flow 261 guard (flow 410; confirmed for this flow by the operator, poll 97, 2026-10-05T19:26Z): the same `\b\d{3}-\d{2}-\d{4}\b` boundary misses an SSN glued to an underscore (`_123-45-6789`, `<md5>_123-45-6789`) and an SSN written with fullwidth digits (`１２３-45-6789`); none of them reaches the identifier guard.
4. Found by the same review, pre-existing and identical on the baseline: `detectPii` takes quadratic time on very long inputs (160k characters of `123-45-6789-` repeated take about 7 s, 160k of `s.` repeated about 15 s). The cause is in other rules and the 192-character token scan, not in the guard. Moved into flow 410 by the operator (poll 99, 2026-10-05T22:28Z): it is fixed there, not in this flow.

## Expected Outcome

A number-shaped SSN or phone run glued to a word is redacted under the same rule as flow 261 (redact when evidence is ambiguous, suppress only when a real hash or hex identifier is adjacent), and a labelled SSN is reported as `pii.ssn`. Existing SSN and phone corpora show zero regressions.

## Outcome criteria

- Запрос (дословно): «Завести отдельный flow на оба пункта (рекомендую)» (source: operator poll 95, 2026-10-05T18:26Z)
- Эффект (формализация агента): `abc123-45-6789` and its phone analogue are redacted; `ssn: 123-45-6789` is reported as `pii.ssn`; no regression on the existing corpora and no new false redaction of hash and hex identifiers.
- Как наблюдать (предложение агента): `detectPii` on those inputs in tests, in both directions, plus the existing identifier-sweep and SSN/phone tests passing unchanged.

## Out of Scope

- The flow 261 guard itself (merged in PR #906).
- Other PII classes.
