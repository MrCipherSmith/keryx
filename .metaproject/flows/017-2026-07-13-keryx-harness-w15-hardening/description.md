# Flow 017 — W15 Security & recovery hardening (H-01, H-02) — Release 1

Status: formalized
Source: user description (harness runbook, Phase 15 — Release 1)

## Problem

Release 1 built resume (W8), branching (W9), guarded mutation (W10), flow integration
(W11), child agents (W12), and parallel scheduling (W13) — each fail-closed in its own
wave. W15 runs the cross-cutting hardening suites (security, recovery, replay,
migration, performance, red-team) over that built surface and closes the concerns that
were explicitly DEFERRED to this wave, so no unexplained high-severity finding remains
before the Release 1 boundary.

## Expected Outcome

- **H-01 (test + minimal additive fail-closed guards)** — run the hardening/red-team
  suites and close the deferred @release-0 negative families:
  1. **SSRF / private-egress hardening** — `src/harness/mutation/guard.ts` currently
     denies a short substring list; broaden detection (additive, denies MORE) to cover
     IPv6 loopback (`::1`/`[::1]`), decimal/hex/octal-encoded IPs (`2130706433`,
     `0x7f000001`), the full `172.16`–`172.31` range, `0.0.0.0`, short forms
     (`127.1`), and case-insensitive `LOCALHOST`.
  2. **NaN-date fail-closed** — `src/harness/mutation/approval.ts` compares string
     `expiresAt`/`now`; an unparseable/NaN time must be treated as INVALID (fail-closed
     deny), never fail-open "unexpired".
  3. **SC_R18_UNREGISTERED_EXTENSION_DENIED** (@release-0) — no extension registry
     exists; add `src/harness/extension/registry.ts`: an extension lacking a pinned
     manifest + capability grant is rejected, with no discovery-time mutation or
     authority.
  4. **SC_R16_BUDGET_RESERVATION** (@release-0) — no budget reconciliation exists; add
     a small `src/harness/budget/reconcile.ts`: planned/reserved/consumed/remaining/
     reliability reconcile, fail-closed on over-consumption / negative remaining.
  Plus regression-lock red-team negatives proving the existing fail-closed invariants
  (W10 mutation, W12 child policy/budget, W13 scheduler) hold under adversarial inputs;
  recovery (W8) under crash/torn-write; replay (W7) effect-free; migration
  (schemaVersion) deterministic; performance/SLO = deterministic bounds (no unbounded
  event/context growth). Evidence: no unexplained high-severity finding; SLOs measured.
- **H-02 (docs)** — `docs/decisions/keryx-harness/H-02-deferred-extension-capability-
  contract.md`: define the deferred extension capability grants + isolation WITHOUT
  enabling them; the extension contract is explicitly later scope (cites
  `SC_R18_REGISTERED_EXTENSION_PROVENANCE` / `SC_R08_EXTENSION_ESCALATION_REQUIRES_
  POLICY`, both @release-2). Does NOT edit the frozen ADR-0001…0004.

## Scope boundary (deferrals)

- **RP-01/W14 dependency:** H-01 formally depends on RP-01 (W14 real provider), but the
  runbook DAG orders W14 AFTER W15. So the provider / real-adapter negative families of
  H-01 are DEFERRED to a post-W14 H-01 re-run (the same "re-run at the release boundary"
  pattern as W16). NOT gated here.
- The `@release-2` extension scenarios (`SC_R18_REGISTERED_EXTENSION_PROVENANCE`,
  `SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY`, `SC_R18_EXTENSION_ESCALATION_REQUIRES_
  POLICY`) are NOT gated here — H-02 documents them as later scope.

## Out of Scope (do NOT touch)

- W14 (real provider) — comes AFTER W15. No network/SDK/new dependency in W15.
- Rewriting W1–W13 behavior — the hardening ADDS tests + minimal ADDITIVE fail-closed
  guards (each test-covered) + two small new modules; a guard only ever DENIES more, it
  never changes an existing allow-path. Any large refactor → STOP and report.
- The frozen requirements package + frozen ADR-0001…0004 + canonical contract schemas +
  `src/eval/` + `src/contracts/` — read/cite only (H-02 is a NEW doc, not an ADR edit).
- No real fs mutation in tests (fake/injected adapters); the harness/child/scheduler
  NEVER writes flow.json (D-02); deterministic (no `Date.now`/`Math.random`).
