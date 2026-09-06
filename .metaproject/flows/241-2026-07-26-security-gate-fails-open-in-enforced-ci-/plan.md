# Implementation Plan

Status: ready

## Approach

**Mode-aware error handling at the seam, not a blanket try/catch.** Every
fail-open site shares one shape: `try { …work… } catch { return <allow> }`. The
fix is uniform — determine the mode *before* the work, and branch the catch on
`isBlockingMode(mode)`.

Alternatives considered and rejected:

- *Let engine errors propagate to callers.* Rejected: the seam's contract is
  "never throws", and ~20 call sites across memory/wiki/testing/gdctx/flow would
  each need their own handler — more places to get fail-open wrong, not fewer.
- *Always fail closed, including advisory.* Rejected: it violates the #1 rule in
  `guard.ts`'s own header — advisory only reports, never blocks, never mutates —
  and would break every advisory workspace on a transient engine error.
- *Only fix `guardOutput`.* Rejected: `redactRaw` is the higher-traffic seam
  (every gdctx artifact, every MCP tool result) and leaks content rather than
  merely allowing a write.

## Steps

1. **Introduce an explicit "unevaluated" decision.** `ALLOW_DECISION` carries
   zero findings, which is why the failure is unreportable. Add a distinct
   engine-error decision so `formatGuardWarning` returns a non-null string and
   advisory callers can surface it.
2. **`guardOutput`** — hoist `loadSecurityConfig` out of the work `try` so `mode`
   is known before anything can fail; on engine error return `allowed: false`
   with an explicit reason in `enforced`/`ci`, and the reportable
   engine-error decision (still `allowed: true`) otherwise. Treat a
   `loadSecurityConfig` failure itself as blocking in a blocking workspace.
3. **`redactRaw`** — on engine error, blocking modes must not emit the original
   content. Return a whole-content mask plus an explicit failure marker on the
   result; advisory keeps today's byte-identical passthrough but reports.
4. **`redactToolOutput`** (`src/mcp/redact-seam.ts`) — stop double-swallowing;
   honor the failure marker from `redactRaw` instead of its own blanket catch.
5. **`securityFlowGate`** — never return `null` on a config error (only when the
   module is genuinely disabled). Emit `fail` in blocking modes, `skipped` with
   detail otherwise.
6. **`flow complete`** — a `skipped` security gate must not count as passing in a
   blocking workspace (`service.ts:431`). Decide fail-vs-pass from the mode the
   gate reports, not from mere presence.
7. **`isSecurityEnabled`** — distinguish parse failure from file absence. A
   corrupt manifest must not read as "disabled"; surface it as an error state.
8. **Tests** — one regression test per hole, each asserting the *blocking* mode
   behavior and the unchanged advisory behavior side by side.

## Risks

- **Blast radius.** `guardOutput` and `redactRaw` are called from memory, wiki,
  testing, gdctx, flow and MCP. A behavior change in a blocking workspace is
  intended; a behavior change in an *advisory* workspace is a regression. Every
  test must pin both modes.
- **The golden rule.** Several suites assert byte-identical artifacts. Advisory
  passthrough must stay byte-identical when nothing is detected.
- **Self-hosting.** This repo runs its own pre-push security hook; a fail-closed
  bug here can block the very push that fixes it. Verify with a deliberately
  corrupt manifest in a temp workspace, never in the repo root.
- **Over-blocking `redactRaw`.** Masking whole content on error is safe but
  destroys output. Confirm the failure marker reaches callers so they can report
  *why* the output is empty rather than showing an unexplained blank.
