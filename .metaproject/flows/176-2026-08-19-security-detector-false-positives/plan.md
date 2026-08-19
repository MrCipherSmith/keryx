# Implementation Plan

Status: chosen

## Approach

Each defect gets the narrowest guard that removes it, added in the same style as
the guards already in these files (`hasPhoneSeparatorShape` for report columns,
`isWordSlug` for kebab-case identifiers, the `/`-drop note in the shape gate).
No detector is loosened globally and no threshold is moved for everything: a
broad change here trades one class of false positive for a class of missed
credentials, which is the wrong direction for a redaction layer.

Rejected alternative for P1 — dropping the digit-run phone rule, or requiring a
`+` country code. Both silently stop masking real phone numbers, which is a
policy change (`pii.default`), not a bug fix.

Rejected alternative for P2 — lowering the global entropy floor below 3.6. It
would catch the hex case, but the floor exists to keep ordinary code identifiers
and paths out of the redactor; the two prior regressions recorded in this file's
comments (report columns, filenames masked as secrets) came from exactly that
kind of broad move.

Rejected alternative for P3 — forcing `tool_choice: "required"` on the retry.
That is the correct long-term fix but no provider adapter in the tree exposes
`tool_choice`; it is recorded as out of scope.

## Steps

1. **P1 — `src/security/detect/pii.ts`.** Add `containsCalendarDate(value)`: a
   candidate carrying an embedded ISO-8601 date (`(19|20)\d{2}-(0[1-9]|1[0-2])-
   (0[1-9]|[12]\d|3[01])`) is a dated identifier, not a dialling sequence.
   Gate it next to the existing `pii.phone` guards in `detectPii`.
2. **P2a — `src/security/detect/entropy.ts`.** Extend `TOKEN` so a qualifying
   head segment absorbs `.`-joined continuation segments of 6+ token characters,
   and evaluate every gate (shape, slug, entropy, label) on the HEAD while
   reporting `start`/`end` over the whole span, so a dotted credential is masked
   end to end and dot-joined prose/filenames cannot qualify on their own.
3. **P2b — `src/security/detect/entropy.ts`.** Treat a pure-hex head of 24+
   characters next to a sensitive label as a credential without requiring the
   3.6 entropy floor (the label requirement is unchanged), with confidence
   floored into the existing heuristic band.
3b. **P2c — `src/security/detect/secrets.ts` (added in T4, the actual leak).**
   Allow an optional quote between a sensitive key NAME and its `:`/`=` in
   `secrets.env-assignment`, so the JSON/YAML form (`"NAME_API_KEY": "…"`) is
   recognised as an assignment. This is the rule that governs tool-output
   scrubbing; the entropy work above does not run on that path.
4. **P3 — `src/commands/agent.ts`.** Raise `MAX_TOOLLESS_REPROMPTS` to 2, make
   the second nudge explicitly stronger than the first, and abandon the budget
   early when the model's toolless reply repeats the previous one verbatim
   (normalized), so a genuinely tool-incapable model still ends the turn fast.
5. **Tests.** Extend `src/security/detect/*.test.ts` and the agent driver tests
   with a case per defect, each asserting the observed failure, plus the
   negative cases (a real phone still masked, a real credential still masked, a
   tool-capable model unaffected).
6. **Verification.** `bun test` over the affected suites, then the full suite,
   plus `keryx security eval` for detector-corpus regressions.

## Risks

- **P2a widens what a single match covers.** A dotted span could over-mask if a
  qualifying token is immediately followed by a dotted word. Mitigated by
  requiring 6+ token characters per continuation segment and by keeping every
  gate on the head; covered by a negative test.
- **P2b is a targeted floor bypass.** A 24+ char hex string that is not a secret
  but sits within 40 characters of a `key`/`token`/`secret` label on the same
  line will now be masked (e.g. a commit SHA in credential-shaped output). Most
  such blobs already clear 3.6 entropy, so the incremental exposure is small,
  and over-masking fails safe in a redactor.
- **P3 raises token spend by one extra model round** on providers that cannot
  emit tool calls at all. Mitigated by the verbatim-repeat early exit, which ends
  those turns at the same point as today.
- The installed `keryx` on PATH is a stale build, so `keryx security eval` may
  not exercise this working tree. Verification therefore leans on `bun test`
  (`memory/constraints/stale-installed-keryx-binary.md`).
