# Flow 261 independent round C: PR #909 at 3aa5b61c

Round C reviewed 3aa5b61c on PR #909. No blocker or major, no leak. Fixes are in 37d19f1c.

## Recording notes

- Reviewers: review-logic and review-security-code, agent types, run read-only.
- No verifier ran for this round. `review-verifier` was not available to the recorder, so no verdict is recorded and none is invented. `verification_mode` is `off`.
- The recorder, not the reviewers, wrote `impact`, `suggested_fix` and `confidence`, because the finding schema requires them. Where the recorder was not given a value the field says so, and `confidence` is the placeholder `medium`, not a reviewer statement.
- No file, line or quote is recorded: the recorder was given none, and none was invented.
- This round sits beside four earlier rounds that were reconstructed from transcripts after the fact; see the flow journal. This round records reviewer output as received.

## Not re-reviewed

The round C fixes (37d19f1c) were verified by tests and mutation (the sweep file has 39 tests; `bun test src/security/detect` passes 239) but have NOT been re-reviewed by a fourth round.

## Open for the operator

logic-R3-2 is left open on purpose. Only the operator dismisses it.

```json keryx:findings
[
  {
    "id": "logic-R3-1",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The label fold iterates UTF-16 code units, so astral characters (a math-bold `ssn`) and wider invisible characters (LRM/RLM, U+202A to U+202E, U+2062, U+180E, U+3164, tag characters) defeat the label.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against 3aa5b61c.",
    "confidence": "medium"
  },
  {
    "id": "sec-F-001",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "The label fold iterates UTF-16 code units, so astral characters (a math-bold `ssn`) and wider invisible characters (LRM/RLM, U+202A to U+202E, U+2062, U+180E, U+3164, tag characters) defeat the label. Same defect as logic-R3-1, raised independently.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against 3aa5b61c.",
    "confidence": "medium"
  },
  {
    "id": "sec-F-002",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "The label can be defeated with `S/S/N`, `S:S:N`, long separator runs, and Cyrillic and Greek lookalike letters.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against 3aa5b61c. The severity of this item was not carried in the information the recorder was given; the recorder entered `minor`, the same class as sec-F-001 of this round.",
    "confidence": "medium"
  },
  {
    "id": "logic-R3-2",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "`nss` and `social` are unanchored, so `dnssec`, `libnss3`, `Jonsson` and `socialite` next to a real hash are redacted. The effect is false redaction only.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against 3aa5b61c. Not changed: this follows the operator rule to redact when ambiguous. Left OPEN for the operator to decide; the recorder does not dismiss it.",
    "confidence": "medium"
  },
  {
    "id": "sec-F-003",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "Performance: the fold cost grew 10 to 20 times per candidate; the worst case is about 2 s at 160k characters, and it is linear.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against 3aa5b61c. The severity of this item was not carried in the information the recorder was given; the recorder entered `minor`.",
    "confidence": "medium"
  }
]
```
