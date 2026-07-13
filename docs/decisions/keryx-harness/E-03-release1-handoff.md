# Keryx Project Agent Harness — Release 1 flow-orchestrator Handoff

**Status:** Complete (flow 019, dispatch 019-T8, task E-03)
**Date:** 2026-07-13
**Author:** Flow 019 documentation worker (T8 / E-03)
**Gate:** `implementation-plan.md` §E-03 — "Promote roadmap/package and create
handoff only if no BLOCKER/P0/P1 remains." **Met**: the E-02 independent
review ([E-02-release1-review-package.md](./E-02-release1-review-package.md))
reports **no BLOCKER/P0/P1**, a **GO** ship recommendation, 1×P2 advisory
(F-1, already disclosed in E-01's deferred list — see §6a), and two
found-and-resolved provider gaps (R-1/R-2, regression-locked). This handoff is
therefore created per that gate.
**Scope:** Documentation only. No source, test, ADR, frozen-requirements-
package, canonical schema, `src/contracts`, `flow.json`, or
`acceptance-criteria.md` file was modified to produce this handoff — only
this file was created. This document is the Release 1 counterpart to
[flow-orchestrator-handoff.md](./flow-orchestrator-handoff.md) (the Release 0
handoff), which it does not overwrite; it mirrors that document's structure
and covers only the Release 1 surface (W8–W15 + W14). Release 0 (W1–W7 +
W16(R0)) is reused unchanged and is not re-litigated here.

**Baseline at authoring time:** `bun test` **1160 pass / 0 fail**, 4287
`expect()` calls, 161 files; `tsc --noEmit` clean; `package.json`
`dependencies` — `{}`. Every figure below is cited from
[E-01-release1-evidence-matrix.md](./E-01-release1-evidence-matrix.md) and
[E-02-release1-review-package.md](./E-02-release1-review-package.md), both
verified against the working tree in this flow.

---

## 1. Status — Release 1 achieved

Per the frozen acceptance criteria
(`docs/requirements/keryx-project-agent-harness/acceptance.feature`, Release
1 = W8–W15 scope from `implementation-plan.md`), the Release 1 slice —
durable resume, append-only branching with typed compaction, guarded
mutation and approval, flow integration, child agents, parallel scheduling,
security/recovery hardening, and the first real provider adapter — is
**implemented, tested, and independently reviewed with no blocking finding**:

- **E-01** ([E-01-release1-evidence-matrix.md](./E-01-release1-evidence-matrix.md)):
  every Release 1 capability (RS-01/RS-02, B-01/B-02, M-01/M-02, FI-01/FI-02,
  CA-01/CA-02, PA-01, H-01/H-02, RP-01) mapped to status / real source file /
  real test / real commit hash, plus this flow's own H-01 provider red-team
  suite. Every row is `implemented`; seven `@release-2` scenarios and one
  partial (`SC_R04_SHELL_CONTAINMENT`, its runtime-execution-control half)
  are recorded `deferred`; four previously-deferred R0 scenarios are recorded
  `closed`.
- **E-02** ([E-02-release1-review-package.md](./E-02-release1-review-package.md)):
  independent review across architecture, contract, logic, security,
  testing/replay, performance, and Gherkin (S-01…S-12) lenses. Verdict: **no
  BLOCKER/P0/P1**; ship recommendation **GO**; 1×P2 (F-1, disclosed);
  two provider fail-closed gaps found-and-resolved in-flow (R-1/R-2).
- **E-03** (this document): the Release 1 → Release 2 handoff, created
  because the E-02 gate is met.

## 2. What is built (Release 1)

| Capability | Wave | Source | Test | Commit |
|---|---|---|---|---|
| RS-01 Durable resume (`runWithResume`, fingerprint-matched leaf, immutable attempts, bounded transient-retry) | W8 | `src/harness/resume/{fingerprint,store,resume}.ts` | `resume.test.ts` | `c279e3a` |
| RS-02 Crash/recovery decision (`recoverFrom` failpoint matrix) | W8 | `src/harness/resume/recovery.ts` | `recovery.test.ts`, `recovery.hardening.test.ts` | `c279e3a` |
| B-01 Append-only branching (fork/leaf/immutable-ancestor, no-merge-v1) | W9 | `src/harness/branch/branch.ts` | `branch.test.ts` | `33f8e8d` |
| B-02 Typed compaction (provenance, `assertEvidencePreserved`, `rebuildBoundedContext`) | W9 | `src/harness/branch/compaction.ts` | `compaction.test.ts` | `33f8e8d` |
| M-01 Guarded mutation preconditions (fingerprint, fail-closed `checkApproval`, `guardAction`) | W10 | `src/harness/mutation/{fingerprint,approval,guard}.ts` | `approval.test.ts`, `guard.test.ts` | `8ed5373` |
| M-02 Monitored mutation execution (fake adapter, execution receipt, `needs-reconciliation`) | W10 | `src/harness/mutation/execute.ts` | `execute.test.ts` | `8ed5373` |
| FI-01 `ManagedFlowPort` (harness → single `taskDone` call, D-02 upheld) | W11 | `src/harness/flow/managed-flow-port.ts`; additive `src/flow/service.ts` | `managed-flow-port.test.ts`; prior `src/flow` suite unmodified | `d2f8ca4` |
| FI-02 Completion parity (`isFailureDisposition`, single-coordinator invariant) | W11 | `src/harness/flow/parity.ts` | `parity.test.ts` | `d2f8ca4` |
| CA-01 Canonical child contract (`subagent-dispatch`/`subagent-result` + `harness-child-contract-extension`) | W12 | `src/harness/child/contract.ts` | `contract.test.ts` | `550f372` |
| CA-02 Fail-closed child isolation + spawn (budget ⊆ parent, three-layer policy containment) | W12 | `src/harness/child/{isolation,spawn}.ts` | `isolation.test.ts`, `spawn.test.ts` | `550f372` |
| PA-01 Bounded ready-set wave scheduler (`planWaves`) | W13 | `src/harness/parallel/scheduler.ts` | `scheduler.test.ts` | `8ec1016` |
| H-01 Security & recovery hardening (SSRF encoded-IPv4, NaN-date, extension deny, budget reconcile) | W15 | `src/harness/mutation/guard.ts`, `src/harness/mutation/approval.ts`, `src/harness/extension/registry.ts`, `src/harness/budget/reconcile.ts` | `guard.ssrf*.test.ts`, `approval.nan.test.ts`, `registry.test.ts`, `reconcile.test.ts`, `migration.hardening.test.ts` | `de46260` |
| H-02 Deferred extension capability contract (docs; no runtime enablement) | W15 | `docs/decisions/keryx-harness/H-02-deferred-extension-capability-contract.md` | n/a (docs artifact) | `de46260` |
| RP-01 First real provider (`AnthropicProvider`, thin fetch/SSE, no SDK, capability-gated egress) | W14 | `src/harness/provider/anthropic/{anthropic-provider,sse}.ts`; additive `guard.ts` `isPrivateEgressHost` | `anthropic-provider.test.ts`, `sse.test.ts` | `109c63c` |
| H-01 (this flow) Provider-negatives red-team suite + two fail-closed fixes (stalled-body → `cancelled`; empty-body → `malformed`) | W15 (flow 019, T5) | `src/harness/provider/anthropic/anthropic-provider.ts` (fix) | `anthropic-negatives.hardening.test.ts` (10 tests, 72 `expect()`) | uncommitted at authoring time (flow 019 T5; sole runtime-code change permitted by AC5) |

Full traceability (every claim spot-verified — `git log`, `git show --stat`,
`ls`, `bun test <path>` — against the working tree) is in
[E-01-release1-evidence-matrix.md](./E-01-release1-evidence-matrix.md); do
not re-derive it here. Release 0 (W1–W7 + W16(R0), commits `690b376`
through `ca57c56`) is reused unchanged; see
[flow-orchestrator-handoff.md](./flow-orchestrator-handoff.md) §2 for its DAG.

## 3. DAG — dependency order actually executed

| Wave | Boundary | Tasks | Release | Status | Commit |
|---|---|---|---|---|---|
| W1–W7 | prerequisites + Release 0 read-only slice | D-01…D-04, TM-01…TM-03, EV-01, C-01…C-03, P-01…P-02, F-01…F-02, R0-01…R0-03 | Release 0 | ✅ done (reused) | `690b376` … `ca57c56` |
| W16(R0) | Documentation and release evidence (Release 0 boundary) | E-01…E-03 | boundary | ✅ done (reused) | uncommitted at R0 authoring time |
| W8 | Durable resume | RS-01…RS-02 | Release 1 | ✅ done | `c279e3a` |
| W9 | Branching and compaction | B-01…B-02 | Release 1 | ✅ done | `33f8e8d` |
| W10 | Guarded mutation and approval | M-01…M-02 | Release 1 | ✅ done | `8ed5373` |
| W11 | Flow integration (needs W2, satisfied) | FI-01…FI-02 | Release 1 | ✅ done | `d2f8ca4` |
| W12 | Child agents | CA-01…CA-02 | Release 1 | ✅ done | `550f372` |
| W13 | Parallel scheduling | PA-01 | Release 1 | ✅ done | `8ec1016` |
| W15 | Security and recovery hardening | H-01…H-02 | Release 1/2+ | ✅ done | `de46260` |
| W14 | First real provider adapter (run last per runbook: "W14 — последней") | RP-01 | Release 1 | ✅ done | `109c63c` |
| W16(R1) | Documentation and release evidence (Release 1 boundary, this flow) | E-01…E-03 + H-01 provider-negative re-run | boundary | ✅ done (E-01 ✅, E-02 ✅, E-03 ✅ — this document) | uncommitted at authoring time |

Execution order matches the runbook's stated dependency plan: Release 0
(W1–W7) → its own W16 boundary → Release 1 W8→W13, W15, with **W14 last**
("W14 — последней" per `docs/plans/keryx-harness-implementation-runbook.md`)
because the real-provider wave reuses the W15-hardened `isPrivateEgressHost`
egress predicate — and **W16 (E-01…E-03) re-runs at each release boundary**,
per the runbook's standing instruction ("W16 (E-01…E-03) — запускать на
каждой границе релиза"). This flow (019) is that second W16 re-run,
including the deferred H-01 provider-negative red-team suite that W15
could not run before RP-01 (W14) existed.

## 4. Frozen-AC proposal for Release 2

The following `@release-2`-tagged scenarios (per
[E-01-release1-evidence-matrix.md](./E-01-release1-evidence-matrix.md)
"Deferred List" and
[H-02-deferred-extension-capability-contract.md](./H-02-deferred-extension-capability-contract.md))
are proposed as the frozen Release 2 acceptance baseline, grouped into a
proposed wave sequence. None of these scenarios has an implementing test in
`src` today (confirmed zero-match in the E-02 coverage cross-check); nothing
below is implemented by this flow.

- **AC-R2-1 (extension-execution wave — first):** a registered extension
  gains bounded, policy-governed execution authority for the first time.
  Covers:
  - `SC_R08_CHILD_DISPATCH_CANONICAL_RESULT` (`acceptance.feature:376`,
    `@R8 @R9 @release-2 @positive`) — extends CA-01's canonical-contract
    adapter to a registered-extension dispatch path, which does not exist
    yet.
  - `SC_R08_NEEDS_CONTEXT_ADAPTER` (`acceptance.feature:459`,
    `@R8 @R12 @release-2 @positive`).
  - `SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY`
    (`acceptance.feature:384`, `@R8 @R18 @R15 @release-2 @negative`, task
    `CA-01`) — the child-dispatch side of "escalation requires policy."
- **AC-R2-2 (registered-extension provenance):** builds on H-02's
  register-and-deny-only Release 1 baseline
  (`src/harness/extension/registry.ts`) to add provenance tracking for a
  *successfully registered* extension (registration today grants no
  capability, authority, or provenance beyond `{ ok: true, extensionId }`).
  Covers:
  - `SC_R18_REGISTERED_EXTENSION_PROVENANCE` (`acceptance.feature:333`,
    `@R18 @R5 @release-2 @positive`).
  - `SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY`
    (`acceptance.feature:576`, `@R18 @R5 @release-2 @negative`, task `H-02`)
    — the registry-side "escalation requires policy" invariant, distinct
    from AC-R2-1's CA-01-side scenario above (different task tag, same
    invariant re-asserted from the extension-registry side).
- **AC-R2-3 (bound-parallel-wave over registered extensions):** extends
  PA-01's `planWaves` scheduler to accept a registered-extension-bound wave,
  which is not yet in scope. Covers `SC_R08_BOUND_PARALLEL_WAVE`
  (`acceptance.feature:467`, `@R8 @R12 @release-2 @positive`). Depends on
  AC-R2-1 (a registered extension must be dispatchable before a wave can be
  bound to one).
- **AC-R2-4 (TUI adapter):** a later adapter over the stable CLI/JSONL-RPC
  runtime ports established in Release 0 (R0-03); no runtime-contract change
  is required to add it. Covers `SC_R13_TUI_DEFERRED`
  (`acceptance.feature:520`, `@R13 @release-2 @positive`, task `R0-03`).
  Independent of AC-R2-1…3; can be scheduled in parallel.
- **AC-R2-5 (real-subprocess executor — closes F-1 / SC_R04 live
  enforcement):** Release 1 built only the *structural* half of
  `SC_R04_SHELL_CONTAINMENT` (argv/env-allowlist fingerprint, shell-injection
  denial, approval-gating, fail-closed isolation — `8ed5373`); its *runtime*
  half (a running process-group command enforcing timeout / output-limit /
  cwd / cancellation) has no implementing executor because Release 1 ships
  no real subprocess adapter (mutation runs through a fake/injected
  `MutationAdapter`, per D-04/W10 posture). This is the E-02 finding **F-1**
  (P2, disclosed in E-01's deferred list, §8d there / §6a below). Covers the
  execution-control half of `SC_R04_SHELL_CONTAINMENT`
  (`acceptance.feature`, `@R4 @R15 @release-1 @positive`, task `M-01`) — note
  this scenario is tagged `@release-1`, not `@release-2`; it is carried
  forward as Release 1's one disclosed structural gap rather than a new
  Release 2 scope item, and should be the first item closed in the Release 2
  track.

Proposed sequencing: **AC-R2-5 first** (closes a disclosed Release 1 gap,
no new authority surface), then **AC-R2-1** (extension-execution wave, the
prerequisite for AC-R2-2 and AC-R2-3), then **AC-R2-2** and **AC-R2-3** (may
run in parallel once AC-R2-1 lands), with **AC-R2-4** (TUI) schedulable at
any point independent of the others. This mirrors the Release 0 → Release 1
transition's own precedent of running the highest-risk security/authority
wave (there: W10 guarded mutation) before dependent extension surfaces.

This baseline is a **proposal** for flow-orchestrator/Task Manager freezing;
it summarizes (does not replace) the authoritative scenario definitions in
`acceptance.feature`.

## 5. Gates (standing, verified at Release 1 boundary)

Cited from
[E-02-release1-review-package.md](./E-02-release1-review-package.md) §"Gate
evidence" (verified directly against the working tree at review time):

| Gate | Command | Result |
|---|---|---|
| Type check | `bun run typecheck` (`tsc --noEmit`) | clean — no errors |
| Test suite | `bun test` | **1160 pass / 0 fail**, 4287 `expect()` calls, 161 files, ~6.3s |
| Runtime dependencies | `package.json` `dependencies` | `{}` — no runtime dep added across any Release 1 wave, **including W14's real provider integration** (thin hand-written `fetch` + SSE parsing, no SDK — kept `deps` `{}` per RP-01/`109c63c`) |
| Network in non-provider Release-1 runtime | `keryx ctx rg` for `fetch(`/`WebSocket`/`net.connect`/`https?.request`/`dgram`/`tls.` over `resume,branch,mutation,flow,child,parallel,extension,budget` | 0 matches |
| Non-determinism in Release-1 runtime | `Date.now`/`Math.random` over all eight modules plus `provider/anthropic` (non-test) | 0 real calls (clock/id injected via `deps`) |
| Provider egress | sole network call is the injected `this.deps.fetch` in `anthropic-provider.ts:279` | single, capability-gated, SSRF-guarded egress boundary |
| D-02 (harness never writes `flow.json`) | `ManagedFlowPort` is the sole harness→Task-Manager bridge, calls only `service.taskDone(...)`; `FI-02`'s parity suite asserts exactly one `taskDone` call per completion | upheld |
| Offline-determinism | every Release 1 test file uses injected clocks/ids and mocked/recorded-fixture `fetch` (`as unknown as typeof fetch`); no live network in any test | upheld |
| Fail-closed on every new authority boundary | mutation guard/approval, child policy/budget inheritance, scheduler budget aggregation, extension registration, provider capability-gate + egress | upheld (see E-02 §"Logic"/"Security") |

These are the standing gates carried forward as binding for Release 2: any
new wave must keep `tsc --noEmit` clean, the full `bun test` suite green with
no regression to a prior-green test, `dependencies` `{}` unless a Release
2-scoped decision explicitly reopens it, D-02 unconditional, offline
determinism, and fail-closed behavior on every new authority boundary the
wave introduces.

## 6. Constraints carried forward (still binding for Release 2)

- **Reuse-only**: no wave rewrites a prior module; each Release 1 wave
  composed reused primitives instead (scheduler folds W12's `inheritBudget`
  rather than re-implementing budget math; the provider adapter reuses the
  W15 `isPrivateEgressHost` predicate rather than forking it).
- **Frozen requirements package + ADR-0001…0004 + canonical contract
  schemas + `src/eval/` + `src/contracts/` never edited**: verified via
  `git show --stat` on every Release 1 commit (`c279e3a`, `33f8e8d`,
  `8ed5373`, `d2f8ca4`, `550f372`, `8ec1016`, `de46260`, `109c63c`) — none
  touches those paths beyond each wave's own additive source and its own
  flow package under `.metaproject/flows/`.
- **Harness never writes `flow.json` (D-02)**: `ManagedFlowPort` (W11) is
  the sole bridge; child agents (W12) never write `flow.json` either — a
  child's `NEEDS_CONTEXT`/blocked/failed disposition returns to the parent
  as an `EvidenceRecord`, and the parent alone owns completion. The parallel
  scheduler (W13) is a pure function returning a plan; it writes nothing.
- **Injected clock/id determinism**: every source of non-determinism
  (clock, id sequence, `fetch`) is injected via `deps`; no real
  `Date.now`/`Math.random`/live network in any Release 1 runtime module.
- **Storage-off default for providers**: `RP-01`'s `descriptorDocument()`
  declares `remoteState.storage/retention/continuation = false` by default,
  validated against the frozen `provider-descriptor.schema.json`; no
  server-side conversation storage or continuation is enabled.
- **No provider SDK / no new runtime dependency**: `package.json`
  `dependencies` stays `{}` through Release 1, including the real-provider
  wave (thin `fetch` + hand-written SSE parser).
- **Fail-closed on every authority boundary**: this is not merely a
  convention but structurally enforced and test-proven at each new boundary
  Release 1 introduced (mutation guard, child inheritance, scheduler budget
  ceilings, extension registration, provider capability gate) — see E-02
  §"Logic"/"Security" for the per-boundary evidence.

## 7. Out of scope (Release 2 track)

### 7a. Everything named in §4 (`AC-R2-1`…`AC-R2-5`)

The seven `@release-2` scenarios plus the one disclosed `@release-1` gap
(F-1 / `SC_R04_SHELL_CONTAINMENT` execution-control half) enumerated in §4
are **not implemented** by Release 1 and are the explicit next track.
Confirmed zero implementing tests in `src` for every `@release-2` scenario
(E-02 coverage cross-check).

### 7b. Live-network CI

The Release 1 real-provider adapter's live fetch path exists but fires only
behind an explicit capability grant and **never runs in CI** — this remains
true for Release 2; no wave proposed above reopens live-network testing in
CI. All fixtures stay recorded/offline.

## 8. Open items

### 8a. E-02 P2 finding — F-1 (disclosed)

`SC_R04_SHELL_CONTAINMENT`'s runtime execution-control half (a running
process-group command enforcing timeout / output / cwd / cancellation) is
not test-evidenced in Release 1; its structural half (argv/env-allowlist
fingerprint, shell-injection denial, approval-gating, fail-closed isolation)
is. This is disclosed in
[E-01-release1-evidence-matrix.md](./E-01-release1-evidence-matrix.md)
"Deferred List" and carried forward here as **AC-R2-5** (§4) — no fail-closed
breach; structural containment holds today.

### 8b. Research-ledger OPEN items (per E-01 "Research Ledger Update")

- **OPEN-1** (concrete first real provider and credential shape) —
  **resolved** by RP-01/W14: Anthropic Messages API, thin `fetch` + SSE, no
  SDK.
- **OPEN-2** (per-role budget values) — **narrowed, still open**: W15's
  `src/harness/budget/reconcile.ts` reconciles planned/reserved/consumed/
  remaining *shapes*, but concrete per-role budget *values* remain
  undecided.
- **OPEN-3** (artifact retention windows per class, team vs. solo policy) —
  **still open**: W11's `ManagedFlowPort` passes `evidenceRefs`/`runLink`
  through to Task Manager but does not define a retention-window policy.

Neither OPEN-2 nor OPEN-3 blocks the Release 1 → Release 2 handoff (neither
is a frozen Release 1 acceptance criterion); both are recorded here so the
Release 2 track inherits them rather than rediscovering them.

## Evidence links

- [E-01-release1-evidence-matrix.md](./E-01-release1-evidence-matrix.md) —
  Release 1 capability/evidence matrix, deferred list, research-ledger
  update, migration notes.
- [E-02-release1-review-package.md](./E-02-release1-review-package.md) —
  independent review package (GO, no BLOCKER/P0/P1; F-1 P2; R-1/R-2
  found-and-resolved).
- [flow-orchestrator-handoff.md](./flow-orchestrator-handoff.md) — the
  Release 0 boundary handoff (mirrored structure; not overwritten by this
  document).
- [H-02-deferred-extension-capability-contract.md](./H-02-deferred-extension-capability-contract.md) —
  the deferred extension capability/isolation model this handoff's AC-R2-1/
  AC-R2-2 proposal builds on.
- `docs/requirements/keryx-project-agent-harness/implementation-plan.md` —
  normative DAG, wave order, and verification gates.
- `docs/requirements/keryx-project-agent-harness/acceptance.feature` —
  authoritative scenario definitions for every `@release-2` tag cited above.
- `docs/plans/keryx-harness-implementation-runbook.md` — Стейт (progress
  tracker) table confirming every Release 1 wave (W8–W15, W14) as ✅.

---

**Last updated:** 2026-07-13
**Updated by:** Flow 019 documentation worker (T8 / E-03)
**Status:** Handoff complete — Release 1 ready to promote; Release 2 planning
should begin with AC-R2-5 (closing the disclosed F-1 gap) followed by
AC-R2-1 (extension-execution wave).
