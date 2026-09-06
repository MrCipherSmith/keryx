# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: In `enforced` and `ci`, when `createSecurityService(cwd).check()` throws, `guardOutput` returns `allowed: false` with a non-empty, leak-safe `reason` naming the engine failure; the reason contains no raw content, no redacted preview, and no hash.
- AC2: In `enforced` and `ci`, when `loadSecurityConfig` itself throws, `guardOutput` returns `allowed: false` — the mode is resolved before any fallible work, so a config failure in a blocking workspace cannot yield a synthetic pass.
- AC3: In `advisory` and `gateway`, `guardOutput` still returns `allowed: true` on an engine error, but the returned decision is distinguishable from a clean pass and `formatGuardWarning(decision)` returns a non-null string, so the failure is reportable rather than silent.
- AC4: In `enforced` and `ci`, when the redaction engine throws, `redactRaw` does not return the original content, and its result carries an explicit failure marker; in `advisory` and `gateway` it returns the original content byte-identically and sets the same marker.
- AC5: `redactToolOutput` honors `redactRaw`'s failure marker instead of applying its own blanket catch, so the MCP choke point cannot emit unredacted content in a blocking mode.
- AC6: `securityFlowGate` returns `null` only when the security module is genuinely disabled; when `loadSecurityConfig` throws it returns a gate object — `fail` in `enforced`/`ci`, `skipped` with detail otherwise.
- AC7: `flow complete` cannot report "all gates passed" when the security gate is `skipped` in a blocking workspace; a run with an unevaluated security gate in `enforced`/`ci` reports failure.
- AC8: `isSecurityEnabled` distinguishes an absent manifest from an unparseable one; a corrupt `.metaproject/metaproject.json` does not silently read as "security disabled" and is surfaced as an error state rather than a quiet `false`.
- AC9: Each of AC1–AC8 has a regression test that asserts the blocking-mode behavior and the unchanged advisory behavior in the same test file; all new tests fail against the pre-fix code.
- AC10: `bun run check` passes with zero failures, and the existing byte-identical-artifact suites still pass — advisory workspaces with nothing detected produce unchanged output.
