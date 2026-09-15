# pii.ssn has the same identifier-fragment hole the phone pattern had

Status: draft
Source: flow 260's review round (PR #541), reviewer `review-testing-practices`

## Problem

`pii.ssn` is `/\b\d{3}-\d{2}-\d{4}\b/`. `\b` is satisfied by a hyphen, exactly
as the phone rule's `(?<![\w.])` / `(?![\w.])` were, so an SSN-shaped run inside
a longer hyphenated identifier matches:

```
detectPii("release-123-45-6789-hotfix")  →  pii.ssn "123-45-6789"
```

`isValidSsn` only range-checks the groups; it cannot tell a fragment from a
whole. This is the same bug class flow 260 repaired for `pii.phone`, left
unrepaired here — deliberately, because whether to narrow SSN detection is a
decision about SSN recall and not a side effect of a phone fix.

It is currently asserted as expected behaviour in
`src/security/detect/pii-identifier-sweep.test.ts` ("an SSN-shaped run inside a
hyphenated identifier is detected today"). That test is a record of the gap, not
an endorsement of it, and it must be updated by whoever closes this flow.

## Why it is separate from 260

The direction of the trade-off is not obvious here, and flow 260 settled the
phone case in a way that may not transfer:

- For **phone**, the failure modes are asymmetric — a false negative leaks a
  person's number — so 260 chose to redact whenever the evidence is ambiguous,
  and only suppresses on positive hex-identifier evidence.
- For **SSN**, a false positive corrupts an identifier in exactly the same way,
  but the false negative leaks something more sensitive still. The same rule may
  be right; it needs deciding rather than assuming.

## Expected Outcome

- A decision, written down, on whether an SSN-shaped run inside a longer
  identifier should be redacted.
- Whatever is decided, the behaviour is asserted, and the sweep test's comment
  points at this flow instead of at nothing.
- If the guard is applied: no number the existing SSN corpus catches is lost.

## Out of Scope

- The phone rule (done, flow 260).
- The remaining PII rules — the same round checked them and found no other rule
  reachable by this shape; that check is recorded in
  `src/security/detect/pii-identifier-sweep.test.ts`.
