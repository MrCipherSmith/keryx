# Flow 261 independent round B: PR #909 at bf0ce9dce

Round B reviewed PR #909 at head bf0ce9dce. No blocker or major. Fixes are in 3aa5b61c on the same PR.

## Recording notes

- Reviewers: review-logic and review-security-code, agent types, run read-only.
- No verifier ran for this round. `review-verifier` was not available to the recorder, so no verdict is recorded and none is invented. `verification_mode` is `off`.
- The recorder, not the reviewers, wrote `impact`, `suggested_fix` and `confidence`, because the finding schema requires them. Where the recorder was not given a value the field says so, and `confidence` is the placeholder `medium`, not a reviewer statement.
- No file, line or quote is recorded: the recorder was given none, and none was invented.
- This round sits beside four earlier rounds that were reconstructed from transcripts after the fact; see the flow journal. This round records reviewer output as received.


```json keryx:findings
[
  {
    "id": "logic-F-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "Label gaps: `SS #`, `S S N`, `SS number`, `SS no`, `SS-Nr`, `Sozialversicherung`, `Sozialversicherungsnr.`, `SV-Nummer`, `Versicherungsnummer`, `N.S.S.`, `Soc.Sec.#` and fullwidth forms do not veto suppression.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against PR #909 at head bf0ce9dce.",
    "confidence": "medium"
  },
  {
    "id": "logic-F-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "A label that straddles the 64-character window edge does not veto.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against PR #909 at head bf0ce9dce.",
    "confidence": "medium"
  },
  {
    "id": "logic-F-003",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "The SSN `\\b` boundary does not match underscore-glued, letter-glued or fullwidth-digit SSNs. Pre-existing, not introduced by this PR.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against PR #909 at head bf0ce9dce as pre-existing; tracked in flow 409.",
    "confidence": "medium"
  },
  {
    "id": "logic-F-004",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "The `nss` label over-matches. The reviewer classed this as safe: the only effect is a false redaction.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against PR #909 at head bf0ce9dce.",
    "confidence": "medium"
  },
  {
    "id": "logic-F-005",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "Test gaps: two mutants survived, a scan limit changed from 192 to 100 and `s\\.\\s*s\\.\\s*n` changed to `s\\.s\\.n`.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Mutation by the reviewer: both mutants left the tests passing. The severity of this item was not carried in the information the recorder was given; the recorder entered `minor`, the same class as the survived-mutant finding in round A.",
    "confidence": "medium"
  },
  {
    "id": "sec-F-001",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "The label veto is cheap to defeat: zero-width and soft-hyphen characters, fullwidth forms, `S-S-N` and `numéro de sécu` all get past it.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against PR #909 at head bf0ce9dce.",
    "confidence": "medium"
  },
  {
    "id": "sec-F-002",
    "reviewer": "review-security-code",
    "severity": "info",
    "problem": "The SSN `\\b` boundary issue, pre-existing and not introduced by this PR.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against PR #909 at head bf0ce9dce as pre-existing; tracked in flow 409.",
    "confidence": "medium"
  },
  {
    "id": "sec-F-003",
    "reviewer": "review-security-code",
    "severity": "info",
    "problem": "Quadratic time on large inputs, pre-existing and identical to the baseline.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against PR #909 at head bf0ce9dce as pre-existing, same as the baseline.",
    "confidence": "medium"
  }
]
```
