# PII detector: separator and glue misses found in review round 6

Status: acceptance criteria agreed by the operator (poll 115, 2026-10-07)
Source: flow 410 review round 6 (security reviewer), operator poll 113, answer "Завести их отдельным flow, не терять" (2026-10-07)

## Problem

Round 6 of the review of the SSN guard (flow 410) found PII shapes that `detectPii` does not report, or reports wrongly. All of them were already present in the baseline 6f6d8898 (the detector before PR 916), so they were kept out of the round-6 fix PR by the operator's decision. None is a performance problem; each leaves a value readable in redacted output or flags a harmless value.

1. A hyphen- or dot-joined phone followed by more than 15 digits in total is not reported at all ("415-555-0199-123456", "415.555.0199.415.555.0199"): the over-long run rescan splits only on whitespace.
2. PII glued to word characters is not matched whole ("id4111111111111111", "tel415-555-0199", "GB82WEST12345698765432dolor", "192.168.1.10abc"), so text next to the value defeats the `\b` boundary.
3. Separators outside the fold set evade SSN, card, phone and IP rules: zero-width characters (U+200B, U+200D, U+2060), soft hyphen U+00AD, U+058A, U+30FC, U+2043, newline or tab inside the number, and card separators ".", "/" and "_".
4. An IBAN written with fullwidth Latin letters is not detected, because the normaliser folds digits, dashes, spaces, dots, "@", "+" and parentheses but not letters.
5. About 19 of 200,000 random UUIDs are flagged as credit-card on a three-group prefix, and hyphen-joined digit or hex groups are flagged as card or phone.

## Expected Outcome

Items 1 to 4 are reported (the value is redacted) without a rise in false positives on UUIDs, hashes, base64 and ordinary prose, and without breaking the linear-time scaling tests. Item 5 stops flagging UUID-shaped tokens as cards. Every change comes with a test that fails when the change is reverted.

## Outcome criteria

- Источник: flow 410 review round 6, security reviewer findings F-002, F-003, F-004, F-005, F-008; operator poll 113 (2026-10-07).
- Эффект (формализация агента): the shapes listed under Problem are redacted, or in item 5 no longer flagged, and the detector stays linear in input length.
- Как наблюдать (предложение агента): per-shape tests on the examples above; the differential against baseline 6f6d8898 still shows every baseline span covered; the scaling tests pass; random UUID, hash and base64 samples show no new SSN or card matches.

## Out of Scope

- Findings 1 to 5 of round 6 (the list-marker regression, overlapping spans from two passes, false rescan windows, dead SSN guard code, scanner state reset, concatenated-number tail): fixed in the round-6 fix PR to main.
- Changing which fields are scanned, or the redaction policy of any rule.
