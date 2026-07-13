# Context — Flow 013 (W10 guarded mutation + approval)

Collected by `keryx flow init` and enriched for W10. (T1 context.) SECURITY-CRITICAL, fail-closed.

## Baseline
- `bun test` = 844 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ 33f8e8d.

## Build on (reuse/compose — do NOT rewrite)
- W3 `src/harness/policy/*`: `decide(call,ctx,deps)`, `contextIsPolicyTrusted`, `PolicyProfile`, `PolicyTrustMode` (read-only|trusted-local|untrusted), `Approval`, `PolicyContext`, `PolicyDecision`, defaults (read/write/shell/network/delegate), hard-deny/headless-ask/stale-approval already handled.
- W8 `src/harness/resume/recovery.ts`: `ExecutionReceipt`, `recoverFrom`, `RecoveryDecision` (outcome-unknown → blocked).
- W5 tool ports, W6 fakes, `src/contracts` validator.

## Scenarios (acceptance.feature)
- M-01 (13): SC_R05_POLICY_OUTCOME/HARD_DENY/HEADLESS_ASK/STALE_APPROVAL (@release-0 — W7-covered, reuse), SC_R15_READ_WITHIN_ROOT, SC_R15_CREDENTIAL_REQUEST_DENIED, **SC_R15_PATH_TRAVERSAL_DENIED**, **SC_R15_SYMLINK_ESCAPE_DENIED**, **SC_R15_SHELL_INJECTION_DENIED**, **SC_R15_REDIRECT_PRIVATE_ADDRESS_DENIED**, **SC_R15_FAIL_CLOSED_ISOLATION**, **SC_R04_GUARDED_MUTATION**, **SC_R04_SHELL_CONTAINMENT**.
- M-02: SC_R04_GUARDED_MUTATION (mutation after approval → receipt), SC_R15_FAIL_CLOSED_ISOLATION (unattended-untrusted blocked), unknown-side-effect reconciliation (reuse W8 recoverFrom).

## Schemas (validate via src/contracts)
- `approval-request`: schemaVersion, approvalId, toolCallId, causal, binding, toolId, toolVersion, inputHash, requestedAt, expiresAt, status.
- `approval-result`: schemaVersion, approvalResultId, approvalId, binding, decision, actorId, decidedAt.
- `execution-receipt` (W8): receiptId, executionId, idempotencyKey, inputHash, observedAt, outcome, evidenceRefs.
- `policy-profile`: profileId, profileVersion, fingerprint, trustMode, defaults, requiredControls.

## Invariant map
- **Action-fingerprint (M-01):** canonicalize `{path (realpath within root), argv (normalized), env (allowlist)}` → stable sha256. Approval BINDS to it (approval `binding`/`inputHash`).
- **Approval lifecycle (M-01):** approval-request (inputHash/binding/expiresAt) → approval-result (decision). **single-use** (consumed once); **stale** on fingerprint change → invalidated; **headless** (interactive:false)+ask → deny; **denied**/**expired** → NEVER execute.
- **Path/argv/env rules (M-01):** path-traversal/symlink-escape outside worktree-root → deny; shell-injection (argv) → deny; redirect/private-address egress → deny; direct credential access → deny; read within approved root → allow.
- **Fail-closed scan-state (M-01):** required scan/isolation unavailable → deny (never silent-allow).
- **Trusted-local vs unattended-untrusted (M-02):** `trusted-local` + valid single-use approval → mutation monitored, executed via fake adapter, persist `execution-receipt`+evidence. `unattended-untrusted` stays BLOCKED without isolation boundary. Unknown side-effects → reconciliation (reuse W8 recoverFrom; outcome-unknown blocks).

## Target modules (src/harness/mutation/)
- `fingerprint.ts` (M-01) — canonical action-fingerprint (path/argv/env).
- `approval.ts` (M-01) — approval-request/result lifecycle: single-use/stale/expired/headless.
- `guard.ts` (M-01) — path/argv/env/credential rules + fail-closed scan-state; composes W3 `decide`.
- `execute.ts` (M-02) — monitored trusted-local mutation (fake adapter) + execution-receipt + reconciliation; unattended-untrusted blocked.

## Decisions (approved)
- Modules in `src/harness/mutation/`. Fake/injected mutation adapter (NO real fs mutation; real-fs adapter deferred). Reuse/compose W3 policy + W8 recovery + src/contracts; NO rewrite, NO new port/validator/dependency, NO network/SDK; deterministic; **fail-closed by default**.

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. Verify after each. fetch-mocks `as unknown as typeof fetch`; guard array indexing; immutability via `.toThrow()`; NO real fs mutation.
- TDD order: M-01 (T5→T6), M-02 (T7→T8), review T9 (security).
