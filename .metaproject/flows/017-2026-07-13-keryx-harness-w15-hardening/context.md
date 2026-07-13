# Context — Flow 017 (W15 security & recovery hardening)

Collected by `keryx flow init` and enriched for W15. (T1 context.) Release 1.

## Baseline
- `bun test` = 1008 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ 4cb839c.

## Frozen spec (implementation-plan.md — execute verbatim)
- **H-01** (test, reviewer=security/testing/performance): "Run security, recovery,
  replay, migration, performance, and red-team hardening suites." Depends M-02, PA-01,
  RP-01. Negatives: "all negative families." Evidence: "no unexplained high-severity
  finding; SLOs measured."
- **H-02** (docs, reviewer=security): "Define deferred extension capability grants and
  isolation without enabling them in Release 0." Depends H-01. Negatives: "extension
  escalation negative." Evidence: "extension contract is explicitly later scope."

## Deferred @release-0 concerns to CLOSE (exact spots)
1. **SSRF / private-egress** — `src/harness/mutation/guard.ts:45-53` `PRIVATE_HOST_TOKENS`
   = `["127.0.0.1","169.254.169.254","10.","172.16.","192.168.","localhost"]`, matched
   at `:114` via `token.includes(host)`. Bypass vectors NOT covered: IPv6 loopback
   (`::1`, `[::1]`), decimal IP (`2130706433`), hex (`0x7f000001`), octal (`0177.`),
   short forms (`127.1`), `172.17.`–`172.31.` (only `.16.` listed), `0.0.0.0`, CGNAT
   `100.64.`, case (`LOCALHOST` — `includes` is case-sensitive). Broaden ADDITIVELY.
2. **NaN-date fail-closed** — `src/harness/mutation/approval.ts`: `Approval.expiresAt:
   string`, `now: string` (times are STRINGS). An unparseable/NaN parse of either →
   comparison is fail-OPEN (NaN comparisons are false → not "expired"). Treat a NaN/
   unparseable time as INVALID → fail-closed deny (`ApprovalInvalidReason "expired"` or
   a new invalid reason — keep additive/backward-compatible).
3. **SC_R18_UNREGISTERED_EXTENSION_DENIED** (@R18 @R15 @release-0 @negative): "an
   extension attempts to register during discovery / lacks a pinned manifest and
   capability grant / rejected without discovery-time mutation or authority." No
   extension module exists in src/harness. Add `src/harness/extension/registry.ts` — a
   PURE fail-closed `registerExtension` (no pinned manifest OR no capability grant →
   deny; no discovery-time mutation/authority).
4. **SC_R16_BUDGET_RESERVATION** (@R16 @R12 @release-0 @positive): "a Release 0 run has a
   hard token and tool-call reservation / a provider attempt is persisted / planned,
   reserved, consumed, remaining, and reliability values reconcile." No budget
   reconciliation exists. Add `src/harness/budget/reconcile.ts` — planned/reserved/
   consumed/remaining reconcile with reliability (exact|estimated|unknown; reuse the
   W7 reliability vocabulary); fail-closed on over-consumption / negative remaining.

## Red-team / regression-lock targets (existing fail-closed invariants must hold)
- W10 mutation `src/harness/mutation/{guard,approval,fingerprint,execute}.ts` — fail-closed
  on traversal/symlink/shell/private-egress/credential + approval single-use/stale/expired.
- W12 child `src/harness/child/{isolation,spawn}.ts` — `inheritPolicy` per-capability
  containment (unconditional) + `inheritBudget` ⊆ parent; out-of-enum fail-closed.
- W13 scheduler `src/harness/parallel/scheduler.ts` — aggregate budget ceiling; cycle
  deny; degenerate maxConcurrency deny.
- W8 resume `src/harness/resume/{store,resume,recovery}.ts` — crash/torn-write; outcome-
  unknown blocks unsafe retry; immutable attempts.
- W7 replay `src/harness/replay.ts` — effect-free re-execution.
- migration — read-time schemaVersion migration deterministic (session/flow).

## Scope boundary (deferrals)
- **RP-01/W14:** H-01 depends on RP-01 (W14 real provider), but W14 is AFTER W15 (DAG).
  Provider/real-adapter negative families → DEFERRED to a post-W14 H-01 re-run. NOT here.
- `@release-2` extension scenarios (SC_R18_REGISTERED_EXTENSION_PROVENANCE @R18@R5,
  SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY @R8@R18@R15, SC_R18_EXTENSION_ESCALATION_
  REQUIRES_POLICY @R18@R5) — NOT gated; H-02 documents them as later scope.

## Build on (reuse — additive guards only; no rewrite of allow-paths)
- Additive edits: `guard.ts` (broaden private-egress detection), `approval.ts` (NaN
  fail-closed). NEW modules: `src/harness/extension/registry.ts`, `src/harness/budget/
  reconcile.ts`. Reuse W7 reliability vocab, W12 budget types if helpful.
- H-02 doc: NEW file `docs/decisions/keryx-harness/H-02-deferred-extension-capability-
  contract.md`. Do NOT edit frozen ADR-0001..0004.

## D-02 invariant (ADR-0002)
Harness/child/scheduler/extension/budget helpers NEVER write flow.json. Only the Task
Manager (`src/flow`) writes flow.json.

## Decisions (approved)
- New code under `src/harness/{extension,budget}/`; additive fail-closed guards in
  `guard.ts`/`approval.ts` (each test-covered; a guard only DENIES more, never changes an
  allow-path). H-02 = new doc under docs/decisions/keryx-harness/. Deterministic
  (injected clock/id; no Date.now/Math.random). No new dep/SDK/network (W14 real provider
  NOT here). RP-01/provider hardening families + @release-2 extension scenarios deferred.
- H-01 runs TDD (RED tests Sonnet → GREEN additive impl Opus/security → recovery/replay/
  migration/perf test suites Sonnet); H-02 docs Sonnet; review Opus/security.

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. fetch-mocks `as unknown as typeof fetch`; guard array indexing; immutability via `.toThrow()`.
- TDD order: security (T5→T6), recovery/replay/migration/perf (T7), H-02 docs (T8), review (T9).
