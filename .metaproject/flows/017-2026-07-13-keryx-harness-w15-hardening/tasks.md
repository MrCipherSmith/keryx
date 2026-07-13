# Tasks — Flow 017 (W15 security & recovery hardening)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W15** (implementation-plan.md H-01/H-02). Additive fail-closed guards in
existing modules (each test-covered; a guard only DENIES more, never changes an
allow-path) + two small PURE new modules (`src/harness/extension/`, `src/harness/
budget/`) + one new doc (`docs/decisions/keryx-harness/`). Reuse-only for W1–W13
behavior. NO network/SDK/new dep (W14 real provider NOT here). D-02. Deterministic.
Worktree-guard. Deferred: RP-01/provider families → post-W14 H-01 re-run; @release-2
extension scenarios → H-02 doc only.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Hardening surface map + 4 deferred concerns + RP-01/W14 & release-tag deferrals (context.md). |
| T2 | implement | — | Umbrella: additive hardening per plan (closed when T6 done). |
| T3 | test | — | Umbrella: TDD + hardening suites (closed when T5/T7 authored + impl green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T9 + completion done). |
| T5 | test (H-01 security RED) | Sonnet | RED red-team tests. **SSRF (`src/harness/mutation/guard.ts`):** an argv token carrying `::1`/`[::1]` (IPv6 loopback), decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, short `127.1`, `172.17.`–`172.31.`, `0.0.0.0`, CGNAT `100.64.`, or uppercase `LOCALHOST` is DENIED (currently pass → RED). **NaN-date (`src/harness/mutation/approval.ts`):** an unparseable/NaN `expiresAt` or `now` → the approval is INVALID (fail-closed), never fail-open unexpired (RED). **Unregistered extension (`src/harness/extension/registry.ts`, missing → RED):** an extension lacking a pinned manifest OR a capability grant → `{ok:false}` deny with no discovery-time mutation/authority (SC_R18_UNREGISTERED_EXTENSION_DENIED). **Budget reconcile (`src/harness/budget/reconcile.ts`, missing → RED):** planned/reserved/consumed/remaining reconcile with reliability (exact|estimated|unknown); consumed > reserved (or negative remaining) → fail-closed (SC_R16_BUDGET_RESERVATION). **Regression-lock (already green):** W12 `inheritPolicy`/`inheritBudget`, W13 scheduler ceilings, W10 guard/approval fail-closed hold under adversarial inputs. RED before T6. |
| T6 | impl (H-01 hardening) | Opus (security) | Make T5 green, minimal & ADDITIVE: broaden `guard.ts` private-egress detection (a shared `isPrivateEgressToken` covering IPv6 loopback, decimal/hex/octal IPs, full 172.16–31, 0.0.0.0, CGNAT, short forms, case-insensitive) — only DENIES more, existing allow-paths unchanged; `approval.ts` — parse `expiresAt`/`now` fail-closed (NaN/unparseable → invalid, additive/backward-compatible reason); NEW `src/harness/extension/registry.ts` (`registerExtension` PURE fail-closed); NEW `src/harness/budget/reconcile.ts` (`reconcileBudget` PURE fail-closed). Deterministic. Make T5 green. |
| T7 | test (H-01 recovery/replay/migration/perf) | Sonnet | Test-only regression/hardening suites over EXISTING modules (no production edits): recovery (W8 `src/harness/resume/*`) under crash/torn-write cut points + outcome-unknown blocks unsafe retry; replay (W7 `src/harness/replay.ts`) effect-free re-execution; migration (session/flow `schemaVersion`) read-time migration deterministic (two loads identical); performance/SLO = deterministic bounds (bounded event/context growth — no unbounded accumulation), measured with injected counters (no wall-clock). |
| T8 | docs (H-02) | Sonnet | `docs/decisions/keryx-harness/H-02-deferred-extension-capability-contract.md`: define the deferred extension capability grants + isolation model WITHOUT enabling them (Release 0/1 only registers-and-denies via T6's registry); cite `SC_R18_REGISTERED_EXTENSION_PROVENANCE` (@R18 @R5 @release-2) + `SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY` (@release-2) as explicitly later scope; reference (do NOT edit) frozen ADR-0001..0004. |
| T9 | review | Opus (security) | code-verifier (`tsc` + full `bun test` ≥1008 + new green); **every new guard fail-closed** (adversarial: probe for a remaining SSRF bypass, a NaN fail-open, an extension/budget escape); **no regression** (existing allow-paths preserved, no prior test flipped); no new high-severity; deferred families (RP-01/provider, @release-2 extension) explicitly marked not-gated; reuse-only (W1–W13 behavior unchanged — guards additive only); D-02 (no flow.json write in new modules); determinism (no Date.now/Math.random); frozen requirements pkg + canonical schemas + src/eval + src/contracts + ADR-0001..0004 untouched; deps `{}`. Lens: security + testing/performance. |
