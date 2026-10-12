# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The decision on SSN-shaped runs inside a longer identifier is written down in the flow (description.md, section Decision) with the trade-off stated: the SSN false negative leaks more than a corrupted identifier costs, so the same rule as for phone applies (redact when the evidence is ambiguous, suppress only on positive hex-identifier evidence). The operator confirms this decision.
- AC2: `detectPii` still reports `pii.ssn` for every number the existing SSN corpus catches (zero regressions), shown by the existing SSN tests passing unchanged.
- AC3: `detectPii("release-123-45-6789-hotfix")` has a pinned result in a test, the one the decision in AC1 gives, and `src/security/detect/pii-identifier-sweep.test.ts` no longer says "detected today" as if it were an accident: its comment points at flow 261.
- AC4: If the decision adds a hex-identifier guard for SSN, a run such as `build-a1b2c3d4-123-45-6789` or a hex-looking identifier whose digits are part of a hash is not redacted, and a plain SSN in prose, in a hyphenated sentence and next to a letter label (`ssn: 123-45-6789`) still is. Both directions are tests.
- AC5: Independent review round with no open blocker or major finding, and CI is green on the PR head.
