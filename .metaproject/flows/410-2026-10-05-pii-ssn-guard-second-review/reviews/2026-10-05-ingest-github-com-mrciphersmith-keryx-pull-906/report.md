# Flow 261 independent round A: merged PR #906

Round A reviewed merged PR #906 (merge 7b93fc97, PR head 19321fa3). Fixes for its findings are in follow-up PR #909 (branch fix/pii-ssn-truncation-test): fefa7eae and bf0ce9dce.

## Recording notes

- Reviewers: review-logic and review-security-code, agent types, run read-only.
- No verifier ran for this round. `review-verifier` was not available to the recorder, so no verdict is recorded and none is invented. `verification_mode` is `off`.
- The recorder, not the reviewers, wrote `impact`, `suggested_fix` and `confidence`, because the finding schema requires them. Where the recorder was not given a value the field says so, and `confidence` is the placeholder `medium`, not a reviewer statement.
- No file, line or quote is recorded: the recorder was given none, and none was invented.
- This round sits beside four earlier rounds that were reconstructed from transcripts after the fact; see the flow journal. This round records reviewer output as received.

## Observations (not findings)

- The SSN `\b` boundary does not match underscore-glued, letter-glued or fullwidth-digit SSNs. Pre-existing; tracked in flow 409.
- Quadratic time on 40k to 160k character inputs is identical to the baseline. Pre-existing, in other rules.

```json keryx:findings
[
  {
    "id": "logic-F-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The truncation-guard test cannot fail: deleting `if (truncated)` passes all 19 sweep tests.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Mutation by the reviewer: deleting `if (truncated)` leaves all 19 sweep tests passing.",
    "confidence": "medium"
  },
  {
    "id": "logic-F-002",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "An abbreviation period ends the label window.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against PR #906 at head 19321fa3.",
    "confidence": "medium"
  },
  {
    "id": "logic-F-003",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "The labels `S.S.N.`, `Soc. Sec. No.` and `SS#` do not veto suppression.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against PR #906 at head 19321fa3.",
    "confidence": "medium"
  },
  {
    "id": "sec-F-001",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "A crafted or accidental adjacent hex run of 16 or more characters suppresses a genuine SSN, for example `cafebabecafebabe-078-05-1120`.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against PR #906 at head 19321fa3; example input as quoted in `problem`.",
    "confidence": "medium"
  },
  {
    "id": "sec-F-002",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "The label veto is narrow: `SS#`, `NSS`, `СНИЛС` and `Sozialversicherungsnummer` do not veto, nor does a label beyond 32 characters, a label after the value, or a label after a sentence break.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against PR #906 at head 19321fa3.",
    "confidence": "medium"
  },
  {
    "id": "sec-F-003",
    "reviewer": "review-security-code",
    "severity": "info",
    "problem": "A run of digits followed by `e` counts as hex evidence.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against PR #906 at head 19321fa3.",
    "confidence": "medium"
  }
]
```
