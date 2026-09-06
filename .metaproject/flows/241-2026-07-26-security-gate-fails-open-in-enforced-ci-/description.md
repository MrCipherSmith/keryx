# Security gate fails open in enforced/ci: guardOutput/redactRaw/securityFlowGate swallow engine errors and a corrupt manifest silently disables enforcement

Status: formalized
Source: user description (review 2026-07-26, finding B-04)

## Problem

ADR-0003 makes fail-closed containment mandatory. The shared write seam
(`src/security/guard.ts`) is fail-**open** on the enforcement path, and nothing
anywhere reports it. Five distinct holes, all reachable in `enforced`/`ci`:

1. `guardOutput` (`guard.ts:93-106`) assigns `mode` **inside** the `try`, so any
   exception from `loadSecurityConfig` or `check()` returns
   `{ allowed: true, decision: ALLOW_DECISION }` — a synthetic *pass* — including
   in blocking modes. It is silent: `formatGuardWarning(ALLOW_DECISION)` returns
   `null` because the decision carries zero findings, so no caller can print a
   warning even if it wanted to.
2. `redactRaw` (`guard.ts:146-148`) catches engine errors and returns the
   **original unredacted content**. Every gdctx artifact and every MCP tool
   result flows through it, so an engine failure writes raw secrets to disk and
   over the transport.
3. `redactToolOutput` (`src/mcp/redact-seam.ts:29`) repeats the same shape one
   layer up, so the MCP choke point has two independent fail-open catches.
4. `securityFlowGate` (`guard.ts:190-195`) returns `null` when
   `loadSecurityConfig` throws. `flow/service.ts:416-421` only pushes a gate when
   the dep returns non-null, and `passed = gates.every(g => g.status !== "fail")`
   (`service.ts:431`) cannot fail on a gate that was never pushed — so
   `flow complete` silently omits the security gate and reports "all gates
   passed". A `skipped` gate passes for the same reason.
5. `isSecurityEnabled` (`guard.ts:60-69`) uses `readJsonFileOr(manifestPath, {})`,
   which collapses "file absent" and "file present but unparseable" into the same
   `{}`. A corrupt `.metaproject/metaproject.json` therefore **silently disables
   all security enforcement and redaction project-wide**, indistinguishable from
   an intentional opt-out.

The unifying defect is that "advisory-safe" — an engine error must not break the
caller — was applied uniformly, including to the two modes whose entire purpose
is to stop the write.

## Expected Outcome

- In `enforced`/`ci`, an engine or config error **blocks** rather than allows,
  and the reason says so explicitly (masked, leak-safe — no raw content).
- In `advisory`/`gateway`, behavior is unchanged (never blocks) but the failure
  is **reportable** rather than silent: the returned decision distinguishes
  "clean" from "could not be evaluated".
- No path returns unredacted content in a blocking mode after a redaction
  failure.
- `flow complete` can never report "all gates passed" when the security gate was
  omitted or unevaluated in a blocking mode.
- A corrupt manifest is distinguishable from an absent one; it must not read as
  "security intentionally disabled".

## Out of Scope

- The other open review findings (B-01 egress allowlist bypass, B-05 lock theft,
  and the CB-/AI- series) — separate flows.
- Redesigning the detector set, policies, or the eval corpus.
- Changing `advisory` semantics: advisory still never blocks and never mutates.
- The Phase 4 `gateway` mode's own behavior beyond treating it as non-blocking,
  as today.
