# Implementation Plan — Flow 013 (W10 guarded mutation + approval)

Status: frozen scope (W10 only) — Release 1, SECURITY-CRITICAL

## Approach

Add a guarded-mutation + approval layer in `src/harness/mutation/` over the W3
policy engine + W8 recovery, test-first, fail-closed by default. Canonical
action-fingerprints, single-use fingerprint-bound approvals, path/argv/env rules,
and a fail-closed scan state (M-01); monitored trusted-local mutation with an
execution receipt + reconciliation, unattended-untrusted blocked without isolation
(M-02). Fake/injected mutation adapter — NO real filesystem mutation. Reuse/compose
W3/W8/src-contracts; deterministic, offline.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer track |
|---|---|---|---|---|
| T5 (M-01 RED) | test | tests-creator | **Sonnet** | security |
| T6 (M-01) | implement | task-implementer | **Opus 4.8** | security |
| T7 (M-02 RED) | test | tests-creator | **Sonnet** | security/logic |
| T8 (M-02) | implement | task-implementer | **Opus 4.8** | security/logic |
| T9 | review | review-orchestrator | **Opus 4.8** | security |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, each with
the worktree-guard (cd + pwd).

## Steps

1. T1: invariant + module map (context.md).
2. T5 (M-01 RED): action-fingerprint + approval lifecycle (single-use/stale/
   headless/expired) + path/symlink/shell/redirect/credential deny + fail-closed
   scan-state tests.
3. T6 (M-01 GREEN): `src/harness/mutation/{fingerprint,approval,guard}.ts` composing
   W3 `decide`.
4. T7 (M-02 RED): guarded trusted-local mutation → receipt+evidence; unattended-
   untrusted blocked without isolation; unknown-side-effect reconciliation tests.
5. T8 (M-02 GREEN): `src/harness/mutation/execute.ts` (fake mutation adapter +
   execution-receipt + reconcile via W8 recoverFrom).
6. T9: SECURITY-focused review — `tsc` + full `bun test` (≥844 + new green); M-01/
   M-02 coverage; fail-closed invariants (stale/denied/headless/expired NEVER
   execute; path/symlink/shell/redirect/credential denied; unattended-untrusted
   blocked); determinism/offline; NO real fs mutation; `deps {}`; reuse-only; frozen
   + src/eval + src/contracts untouched.
7. `keryx health run`; confirm ACs; completion choice (ask user A/B/C).

## Verification (TDD, security)

Each task RED before impl, GREEN after. Gate: `tsc` clean; full `bun test` ≥844 +
new green; every fail-closed invariant asserted (an unsafe path must never
execute); approval/receipt payloads schema-valid; NO real fs mutation; no new
dependency.

## Risks

- **A denied/stale/headless/expired approval executing** → fail-closed engine;
  every negative asserted; approval bound to the action-fingerprint and consumed
  once; T9 security review is the gate.
- **Path traversal / symlink escape / shell injection / egress** → canonical
  fingerprint + path realpath-within-root + argv/env rules; negatives rejected.
- **Real side effects** → fake/injected mutation adapter; AC forbids real fs
  mutation; `execute` monitored + receipted.
- **Unattended-untrusted mutation without isolation** → blocked (fail-closed).
- **Rewriting W3/W8** → additive `mutation/` module that COMPOSES `decide` /
  `recoverFrom`; if a W3/W8 change seems needed, STOP and report.
- **Wrong-worktree / tsc-cast / index-guard / frozen-array** → guard directives in
  every dispatch (immutability via `.toThrow()`).
