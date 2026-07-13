# Tasks — Flow 013 (W10 guarded mutation + approval)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W10** (implementation-plan.md §W10). Guarded mutation + approval over
W3/W8 — reuse/compose, do not rewrite. SECURITY-CRITICAL, fail-closed. NO real fs
mutation (fake adapter). Deterministic/offline; no new dep/SDK/network. Worktree-guard.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Invariant + module map (context.md). |
| T2 | implement | — | Umbrella: implement per plan (closed when T6+T8 done). |
| T3 | test | — | Umbrella: TDD tests (closed when T5/T7 authored + impls green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T9 + completion done). |
| T5 | test (M-01 RED) | Sonnet | `src/harness/mutation/` tests: canonical action-fingerprint (path/argv/env) deterministic; approval-request/result (schema-valid) single-use/stale(fingerprint-change)/expired/headless → NEVER execute; path-traversal + symlink-escape outside root denied; shell-injection (argv) denied; redirect/private-address egress denied; direct credential access denied; read-within-root allowed; fail-closed scan-state (required scan/isolation unavailable → deny). SC_R15_*/SC_R04_*. RED before T6. |
| T6 | impl (M-01) | Opus | `src/harness/mutation/{fingerprint,approval,guard}.ts`: canonical fingerprint; approval lifecycle; path/argv/env/credential rules + fail-closed scan; composes W3 `decide`. Make T5 green. |
| T7 | test (M-02 RED) | Sonnet | `src/harness/mutation/execute.test.ts`: under `trusted-local` + valid single-use approval → mutation monitored, executed via fake adapter, `execution-receipt`+evidence persisted (SC_R04_GUARDED_MUTATION); `unattended-untrusted` blocked without isolation (SC_R15_FAIL_CLOSED_ISOLATION); unknown side-effect → reconciliation (reuse W8 recoverFrom, outcome-unknown blocks); NO real fs mutation. RED before T8. |
| T8 | impl (M-02) | Opus | `src/harness/mutation/execute.ts`: fake mutation adapter + monitored execution + `execution-receipt` + reconcile via W8 recoverFrom; unattended-untrusted blocked. Make T7 green. |
| T9 | review | Opus | SECURITY-focused code-verifier (`tsc` + full `bun test` ≥844 + new green); M-01/M-02 scenario coverage; fail-closed invariants (stale/denied/headless/expired never execute; path/symlink/shell/redirect/credential denied; unattended-untrusted blocked without isolation); determinism/offline; NO real fs mutation (`ctx rg` writeFile/mkdir/etc = 0 in mutation runtime); `deps {}`; W3/W8/W5/W6/src-contracts reused not rewritten; frozen requirements pkg + src/eval + src/contracts + ADRs untouched. |
