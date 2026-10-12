# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: PR #909 is merged into main with a merge commit and its CI is green; `src/security/detect/pii-identifier-sweep.test.ts` passes on main.
- AC2: detectPii redacts a genuine SSN next to a hex token of any length, including an adjacent md5 (32), sha1 (40) and sha256 (64) hash, before and after the value, and next to hex runs of 16, 31 and 33 characters (for example `cafebabecafebabe-[REDACTED:ssn]`); named tests in src/security/detect/pii-identifier-sweep.test.ts cover each.
- AC3: A label (`ssn`, `social`, `SS#`, `NSS`, `СНИЛС`, `Sozialversicherungsnummer`, `S.S.N.`, `Soc. Sec. No.`, `social security number` and their spaced, zero-width, accented, fullwidth and lookalike forms) near the value does not change the result: the SSN is redacted with or without a label, at any distance, and a test covers a label next to an adjacent hash.
- AC4: A token longer than 192 characters next to an SSN does not suppress it: the SSN is redacted, proven by a test with a real adjacent hash and a long token.
- AC5: `detectPii` runs in time linear in input length for every rule, the phone rule included: scaling tests on very long inputs for the email, name and phone shapes fail when their fix is reverted, and a differential on phone, email and name inputs matches the pre-change rules span for span (PR #912 and the phone fix are merged).
- AC6: The review package of this flow holds the three rounds already run (head bf0ce9dce, 3aa5b61c and the round on PR #906) and one more round on the final merged head, all by review-logic and review-security-code, with a real review-verifier run per round, every finding with a terminal disposition, and `keryx flow check-complete` passes its review gate.
- AC7: The pre-existing defects found by the reviewers (SSN glued to a letter, underscore or fullwidth digits; quadratic time on very long inputs) are items in the description of flow 409, and the operator has confirmed them (poll 97).
- AC8: The open item logic-R3-2 (unanchored `nss` and `social` over-match) has an operator disposition recorded in the review package; flow 261's journal marks its four earlier rounds as reconstructed.
