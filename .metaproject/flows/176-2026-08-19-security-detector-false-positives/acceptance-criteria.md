# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `detectPii` returns no `pii.phone` match for a flow-directory listing containing `001-2026-07-09-managed-review-feedback-loop` and `144-2026-08-11-agent-mode-web-fetch`, and `keryx ctx run -- ls .metaproject/flows` shows those prefixes unmasked.
- AC2: `detectPii` still returns a `pii.phone` match for each of `+1 415 555 0199`, `415-555-0199` and `+14155550199`, and the existing numeric-report-column case stays unmatched.
- AC3: `detectEntropy` masks a dotted composite credential (`<32 hex>.<16 alnum>` on a `"ZAI_API_KEY": "…"` line) as ONE match spanning the whole value, dot included, so no fragment of the key survives redaction.
- AC4: `detectEntropy` masks a 32-character hex credential next to a sensitive label even when its Shannon entropy is below the 3.6 floor, and a 24+ char hex string with NO sensitive label on the same line is still not matched.
- AC5: A token that only becomes long enough by joining dotted words (e.g. an identifier or filename with a short extension) is still not reported as a secret.
- AC6: When an action request draws a toolless prose reply twice in a row with DIFFERENT text, the agent driver injects two reprompts, the second textually stronger than the first, before ending the turn.
- AC7: When the model repeats its toolless reply verbatim, the driver stops immediately without spending the remaining reprompt budget and emits the existing tool-capability warning.
- AC8: `bun test` passes over the full suite, with new regression tests covering AC1-AC7 co-located with the code they exercise.
- AC9: `redactSensitiveText` masks EVERY credential value in a JSON credential store read back as tool output (`"NAME_API_KEY": "<value>"`), including a value carrying no recognised provider prefix, while leaving the key names readable.
