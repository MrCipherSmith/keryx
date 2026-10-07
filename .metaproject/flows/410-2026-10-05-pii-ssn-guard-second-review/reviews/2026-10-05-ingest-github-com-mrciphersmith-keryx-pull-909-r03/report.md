# Flow 410 round D: PR #909 head f6068a19, post-fix re-check at 6f6d8898

Round D has two parts, recorded as they happened.

1. A fourth real review of the merged guard (head f6068a19; src/security/detect is byte-identical to the later main 6f6d8898 apart from the fixes below). review-logic and review-security-code ran read-only and raised six minor/info findings (ids `r4-*`). All six were confirmed by a review-verifier run (reproduction or mutation) and fixed in PR #911, merged as 6f6d8898456b95aa48819daecf7efa6b32ee9696.
2. A post-fix verifier pass at 6f6d8898: the eleven earlier findings at or above `minor` that were fixed in rounds 1-3 (ids `r1-*`, `r2-*`, `r3-*`), carried forward unchanged from their original records so a verifier verdict can attach to them, and the six round-D findings. Each was re-checked by running the original defect input against the current code.

## Recording notes

- Reviewers: review-logic and review-security-code, agent types, read-only. Verifier: review-verifier (a separate agent, never a reviewer of these findings).
- The wording of each carried finding is copied from its original round; nothing was sharpened.
- Not re-reviewed: the PR #911 fixes were checked by tests and the post-fix verifier pass, not by a fifth review round.
- logic-R3-2 (round 3, info) is NOT carried here and stays open for the operator; only the operator dismisses it.
- Findings of severity info from rounds 1-3, and the findings dismissed as out of scope or won't-fix there (deferred to flow 409 where named), are not carried; they keep their round records.

```json keryx:findings
[
  {
    "id": "r1-logic-F-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The truncation-guard test cannot fail: deleting `if (truncated)` passes all 19 sweep tests.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906#logic-F-001 so a post-fix verifier verdict can attach to it. Mutation by the reviewer: deleting `if (truncated)` leaves all 19 sweep tests passing.",
    "confidence": "medium"
  },
  {
    "id": "r1-sec-F-001",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "A crafted or accidental adjacent hex run of 16 or more characters suppresses a genuine SSN, for example `cafebabecafebabe-078-05-1120`.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906#sec-F-001 so a post-fix verifier verdict can attach to it. Reported by review-security-code against PR #906 at head 19321fa3; example input as quoted in `problem`.",
    "confidence": "medium"
  },
  {
    "id": "r1-sec-F-002",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "The label veto is narrow: `SS#`, `NSS`, `СНИЛС` and `Sozialversicherungsnummer` do not veto, nor does a label beyond 32 characters, a label after the value, or a label after a sentence break.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906#sec-F-002 so a post-fix verifier verdict can attach to it. Reported by review-security-code against PR #906 at head 19321fa3.",
    "confidence": "medium"
  },
  {
    "id": "r2-logic-F-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "Label gaps: `SS #`, `S S N`, `SS number`, `SS no`, `SS-Nr`, `Sozialversicherung`, `Sozialversicherungsnr.`, `SV-Nummer`, `Versicherungsnummer`, `N.S.S.`, `Soc.Sec.#` and fullwidth forms do not veto suppression.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-909#logic-F-001 so a post-fix verifier verdict can attach to it. Reported by review-logic against PR #909 at head bf0ce9dce.",
    "confidence": "medium"
  },
  {
    "id": "r2-logic-F-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "A label that straddles the 64-character window edge does not veto.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-909#logic-F-002 so a post-fix verifier verdict can attach to it. Reported by review-logic against PR #909 at head bf0ce9dce.",
    "confidence": "medium"
  },
  {
    "id": "r2-logic-F-005",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "Test gaps: two mutants survived, a scan limit changed from 192 to 100 and `s\\.\\s*s\\.\\s*n` changed to `s\\.s\\.n`.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-909#logic-F-005 so a post-fix verifier verdict can attach to it. Mutation by the reviewer: both mutants left the tests passing. The severity of this item was not carried in the information the recorder was given; the recorder entered `minor`, the same class as the survived-mutant finding in round A.",
    "confidence": "medium"
  },
  {
    "id": "r2-sec-F-001",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "The label veto is cheap to defeat: zero-width and soft-hyphen characters, fullwidth forms, `S-S-N` and `numéro de sécu` all get past it.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-909#sec-F-001 so a post-fix verifier verdict can attach to it. Reported by review-security-code against PR #909 at head bf0ce9dce.",
    "confidence": "medium"
  },
  {
    "id": "r3-logic-R3-1",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The label fold iterates UTF-16 code units, so astral characters (a math-bold `ssn`) and wider invisible characters (LRM/RLM, U+202A to U+202E, U+2062, U+180E, U+3164, tag characters) defeat the label.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-909-r02#logic-R3-1 so a post-fix verifier verdict can attach to it. Reported by review-logic against 3aa5b61c.",
    "confidence": "medium"
  },
  {
    "id": "r3-sec-F-001",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "The label fold iterates UTF-16 code units, so astral characters (a math-bold `ssn`) and wider invisible characters (LRM/RLM, U+202A to U+202E, U+2062, U+180E, U+3164, tag characters) defeat the label. Same defect as logic-R3-1, raised independently.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-909-r02#sec-F-001 so a post-fix verifier verdict can attach to it. Reported by review-security-code against 3aa5b61c.",
    "confidence": "medium"
  },
  {
    "id": "r3-sec-F-002",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "The label can be defeated with `S/S/N`, `S:S:N`, long separator runs, and Cyrillic and Greek lookalike letters.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-909-r02#sec-F-002 so a post-fix verifier verdict can attach to it. Reported by review-security-code against 3aa5b61c. The severity of this item was not carried in the information the recorder was given; the recorder entered `minor`, the same class as sec-F-001 of this round.",
    "confidence": "medium"
  },
  {
    "id": "r3-sec-F-003",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "Performance: the fold cost grew 10 to 20 times per candidate; the worst case is about 2 s at 160k characters, and it is linear.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Carried forward from 2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-909-r02#sec-F-003 so a post-fix verifier verdict can attach to it. Reported by review-security-code against 3aa5b61c. The severity of this item was not carried in the information the recorder was given; the recorder entered `minor`.",
    "confidence": "medium"
  },
  {
    "id": "r4-logic-F-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The 192-character scan limit is applied to each side of the SSN separately, so a token of up to about 380 characters (150 characters either side of a 32/40/64-hex hash) is still suppressed although the rule says a token over 192 characters never suppresses (pii.ts isSsnIdentifierFragment).",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against f6068a19.",
    "confidence": "medium"
  },
  {
    "id": "r4-logic-F-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The label veto window is asymmetric: a label whose start is 64 characters before the token vetoes, a label 64 characters after it does not (lookbehind start offset <=64, lookahead <=63).",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against f6068a19.",
    "confidence": "medium"
  },
  {
    "id": "r4-logic-F-003",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The test 'a truncated token never buys suppression' cannot fail on truncation: its input has no 32/40/64-hex hash adjacent to the SSN, so it yields the SSN with or without the truncated branch.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against f6068a19.",
    "confidence": "medium"
  },
  {
    "id": "r4-logic-F-004",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "No test pins the exact 192/193 boundary of the token scan limit: the suite stays green for every SSN_TOKEN_SCAN_LIMIT from 186 to 233.",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against f6068a19.",
    "confidence": "medium"
  },
  {
    "id": "r4-logic-F-005",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "The label region slice starts at tokenStart-64, which drops the character before the label, so a label preceded by a letter can match at the window edge (`xs s n` + 59 spaces vetoes, 58 spaces does not).",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-logic against f6068a19. Severity info.",
    "confidence": "medium"
  },
  {
    "id": "r4-sec-F-001",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "Control characters (so\\x00cial, soc\\x01ial) and the dotless i (soc\\u0131al) defeat the label fold, so these spellings of a label do not veto suppression (pii.ts label fold, LABEL_STRIP and LABEL_CONFUSABLES).",
    "impact": "Not stated separately in the information the recorder was given; see `problem`.",
    "suggested_fix": "Not carried in the information the recorder was given; the fix actually applied is named in the disposition.",
    "evidence": "Reported by review-security-code against f6068a19.",
    "confidence": "medium"
  }
]
```
