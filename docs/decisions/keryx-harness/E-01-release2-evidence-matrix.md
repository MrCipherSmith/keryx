# E-01: Release 2 Capability/Evidence Matrix

**Status:** Draft (flow 029, task T5)
**Date:** 2026-07-14
**Branch:** `feature/keryx-release2-evidence` (main tip)
**Baseline verified at matrix-authoring time:** `bun test` — **1338 pass / 2 skip / 0 fail**, 4774 `expect()` calls, 173 files; `tsc --noEmit` clean; `package.json` `dependencies` — `{}`.

This document is the Release 2 counterpart to
[E-01-release1-evidence-matrix.md](./E-01-release1-evidence-matrix.md), which
it does not overwrite. It mirrors that document's structure and covers only
the Release 2 waves (R2-1–R2-5) plus R2-postreview and R2-postreview-2
hardening. Release 1 (W8–W15, W14) is reused unchanged and is not
re-litigated here.

---

## Purpose

This document is the `E-01` deliverable required for Release 2 evidence closure
(flow 029): "E-01 Release 2 capability/evidence matrix — every Release 2 claim
marked implemented with real source file, real test, and real commit hash;
traceability to the frozen AC-R2-1…R2-5 proposal from E-03 Release 1 handoff."
Every path and commit cited below was checked against the working tree — `git
log --oneline -1 <hash>`, `git show --stat <hash>`, `ls`, and `bun test
<path>` — before being listed; no path or commit is asserted from memory.

---

## Capability / Evidence Matrix

| Scenario / Capability | Source (src/…) | Test (src/…test.ts) | Landed (commit / PR) | Notes |
|---|---|---|---|---|
| **SC_R08_CHILD_DISPATCH_CANONICAL_RESULT** + **SC_R08_NEEDS_CONTEXT_ADAPTER** + **EXTENSION_ESCALATION** (R2-1, AC-R2-1) | `src/harness/extension/execute.ts` | `src/harness/extension/execute.test.ts` | `5f75f4c` / PR #26 | R2-1 extension-execution wave: registered extension gains bounded, policy-governed execution authority. `dispatchExtension` composition of W12 contract/isolation + W15 registry + W10 approval + W8 immutable. `evaluateExtensionGrant` enforces three-layer security (policy+provenance+valid-approval). Test count: 23 new tests. |
| **SC_R18_REGISTERED_EXTENSION_PROVENANCE** (R2-2, AC-R2-2) | `src/harness/extension/provenance.ts` | `src/harness/extension/provenance.test.ts` | `aa16a0d` / PR #27 | R2-2 registered-extension provenance: persists provenance without widening authority. `registerExtensionWithProvenance` records `manifestHash`+`grantId`+`capabilities`. Reuse-only composition (0 prior-module changes). Test count: 22 new tests. |
| **SC_R08_BOUND_PARALLEL_WAVE** (R2-3, AC-R2-3) | `src/harness/extension/bound-wave.ts` | `src/harness/extension/bound-wave.test.ts` | `e06d555` / PR #28 | R2-3 bound-parallel-wave over registered extensions: `planExtensionWave` reuses W13 `planWaves`, R2-1 `dispatchExtension`, W12 `inheritBudget`, W15 registry. Pure deterministic function (no side-effects, injected id/clock). Test count: 11 new tests. Reuse-only. |
| **SC_R13_TUI_DEFERRED** (R2-4, AC-R2-4) | `src/commands/select.ts`, `src/commands/shell.ts` | `src/commands/select.test.ts`, `src/commands/shell.test.ts` | `b27bf23` / PR #25 | R2-4 interactive CLI adapter: `detectProviders` (ollama/anthropic/fake with fail-soft on network loss; no credential input/storage), `pickProviderModel` readline picker, slash commands `/models`/`provider`/`connect`. Variant A: CLI adapter (no TUI framework dep). Test count: 21 new tests. |
| **SC_R04_SHELL_CONTAINMENT** (runtime half / F-1, R2-5, AC-R2-5) | `src/harness/process/executor.ts`, `src/harness/process/real-process-adapter.ts` | `src/harness/process/executor.test.ts`, `src/harness/process/real-process-adapter.classify.test.ts`, `src/harness/process/real-process-adapter.smoke.test.ts` | `183d826` / PR #29 | R2-5 real-subprocess executor (closes F-1 / `SC_R04` live enforcement): W10 built structural half (allowlist/fingerprint/injection-deny/approval); R2-5 adds runtime executor via `runContainedProcess`. Composition of W10 `guardAction`/`actionFingerprint`/`ExecutionReceipt` + W12 `inheritBudget` + W7 evidence. Offline-only + smoke tests (real spawn behind capability flag, not in CI). Sync-only port (`spawnSync`, no orphan zombies). Test count: 18 offline + 3 smoke = 21 new tests. |

### Release 2 hardening waves (post-evidence closure)

| Wave | Scenarios / Issues closed | Source | Test | Commit / PR | Notes |
|---|---|---|---|---|---|
| **R2-postreview** (flow 027, hardening gate) | 5 MED review findings closed TDD | `src/harness/extension/execute.ts`, `src/harness/process/executor.ts`, `src/harness/process/real-process-adapter.ts` | hardening test matrix + 2 mutation-proof | `bfa009b` / PR #30 | SSRF-guard in select.ts `probeOllamaModels`, `exitCode` handling in executor, crash-signal classification, two mutation-proof tests, dedup `buildExt`. 0 new fail-open, reuse-only prior-modules. Test count growth: +49 (1323 total). |
| **R2-postreview-2** (flow 028, polish gate) | 8 LOW/INFO items: 7 closed TDD + 1 deferred (H) | `src/harness/extension/execute.ts`, `src/harness/process/executor.ts`, `src/harness/provider/make-provider.ts`, multiple | integration/causal-evidence tests | `c6d65bc` / PR #31 | Evidence causal-ids propagated, unified `makeProvider`, DRY refactors, default-root provenance, `bound-wave.ts` planning-evidence isolation, `evidenceRefs` normalization, smoke-guard observability. H (cap-less child under capped-parent) deferred as documented known-limitation (bounding multi-tool-call children is runtime-enforcement concern, not a primitive-level deny; `inheritBudget` remains correct). 0 new fail-open, reuse-only. Test count growth: +15 (1338 total). |

All `implemented` rows above were spot-verified against the working tree in
this session: `git log --oneline -1 <hash>` resolved every cited commit to
the expected subject line; `git show --stat <hash>` listed the cited source
paths; `ls` confirmed every test file exists on disk; `bun test` returned
**1338 pass / 2 skip / 0 fail**; `tsc --noEmit` returned clean.

---

## Deferred List (status update)

### Closed in Release 2 (previously deferred in Release 1)

| Scenario | Previously deferred at | Closed by | Evidence |
|---|---|---|---|
| `SC_R04_SHELL_CONTAINMENT` (runtime process-group enforcement half) | Release 1 (E-01 deferred as F-1, §8d; E-03 §4 AC-R2-5) | R2-5 (flow 026, `183d826`, PR #29) — `src/harness/process/{executor,real-process-adapter}.ts` | `src/harness/process/{executor,classify,smoke}.test.ts` |

### New documented known-limitation (Release 2 postreview-2)

| Scenario | Status | Notes | Rationale |
|---|---|---|---|
| **H** (cap-less child tool-call aggregate accounting) | documented deferred | flow 028, PR #31; `inheritBudget` is a shared primitive across R2-1…R2-5 and W13 scheduler. | A subprocess makes 0 tool calls; cap-less budget under a capped parent is legitimate, not "unlimited." Proper bounding of *multi-tool-call* children is a runtime-enforcement concern (e.g., reject policy decisions with unbounded grant on a capped path), not a primitive-level deny. `inheritBudget` and `scheduler.ts` remain unchanged and correct. |

---

## Invariants Held Across Release 2

- **D-02 (harness never writes `flow.json`)**: Extension-execution (R2-1),
  provenance (R2-2), bound-wave scheduler (R2-3), subprocess executor (R2-5)
  are all pure functions or adapters that call only `FlowService.taskDone(...)`
  through the reused W11 `ManagedFlowPort`; they write no flow.json.
- **Fail-closed across every new authority boundary**: R2-1 `evaluateExtensionGrant`
  (three sequential AND-gates: policy+provenance+valid-approval), R2-2 provenance
  aliasing and grant-widening immunity (tested adversarially), R2-3 registered-only
  deny-first, per-attempt evidence isolation, R2-5 executor gate-order
  (argv/env-allowlist → budget → spawn, adapter unreachable on deny). SSRF guard
  in R2-4 CLI (loopback/metadata fail-soft on probe, no fetch on private host).
- **Offline / deterministic tests**: All Release 2 offline tests use injected
  clocks/ids, mocked/recorded-fixture `fetch`, no `Date.now`/`Math.random` calls.
  R2-5 smoke tests (real `spawnSync` via capability flag) are 2 skip-gated.
- **`package.json` `dependencies`: `{}`** — unchanged across all Release 2 waves;
  R2-4 CLI in particular adds interactive provider selection (ollama/anthropic/fake)
  with zero new runtime dependency (stdlib `node:readline` only).
- **Frozen requirements package, ADR-0001…0004, `src/eval/`, `src/contracts/`,
  and canonical schemas**: not modified by any Release 2 wave commit beyond
  R2-1 additive export of `isKnownCapability` in `isolation.ts` (no behavior
  change to prior modules).

---

## Traceability to the frozen AC-R2-1…R2-5 (from E-03-release1-handoff §4)

**AC-R2-1 (extension-execution wave)** — R2-1 (flow 023, PR #26, `5f75f4c`)
- `SC_R08_CHILD_DISPATCH_CANONICAL_RESULT`: ✅ `execute.ts` `dispatchExtension` maps registered extension + coordinator reserved budget → canonical `subagent-dispatch` (schema-validated, `allowed_actions` = grant, bounded) + STATUS-first → canonical `subagent-result` before persist.
- `SC_R08_NEEDS_CONTEXT_ADAPTER`: ✅ `execute.ts` `retryWithContext` handles NEEDS_CONTEXT → same dispatch id, add-only artifact, immutable prior attempt (reuse W8).
- `SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY`: ✅ `execute.ts` `evaluateExtensionGrant` enforces requested ⊆ granted; broader tools/provider requires all three: policy allow ∧ provenance ∧ valid W10 approval; fail-closed deny without any.

**AC-R2-2 (registered-extension provenance)** — R2-2 (flow 024, PR #27, `aa16a0d`)
- `SC_R18_REGISTERED_EXTENSION_PROVENANCE`: ✅ `provenance.ts` `registerExtensionWithProvenance` persists `ExtensionProvenanceRecord` (manifestHash + grantId + fresh capability copy + Provenance taint-links).
- `SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY`: ✅ `provenance.ts` `evaluateRegisteredExtensionCapability` enforces registry-side escalation check (verbatim R2-1 `evaluateExtensionGrant` delegation).

**AC-R2-3 (bound-parallel-wave over registered extensions)** — R2-3 (flow 025, PR #28, `e06d555`)
- `SC_R08_BOUND_PARALLEL_WAVE`: ✅ `bound-wave.ts` `planExtensionWave` — registered-only deny-first, reuses W13 `planWaves` (concurrency ceiling, budget aggregation, cycle/degenerate deny), per-attempt evidence isolation.

**AC-R2-4 (TUI adapter)** — R2-4 (flow 022, PR #25, `b27bf23`)
- `SC_R13_TUI_DEFERRED`: ✅ CLI adapter (variant A per R2-4 note): `select.ts` provider/model detection + picker; `shell.ts` additive slash commands. No TUI framework dep (stdlib readline). Bare `keryx` → interactive selection; flag-first (e.g., `keryx shell …`) → skip picker.

**AC-R2-5 (real-subprocess executor — closes F-1 / SC_R04 live)** — R2-5 (flow 026, PR #29, `183d826`)
- `SC_R04_SHELL_CONTAINMENT` (runtime half): ✅ `executor.ts` `runContainedProcess` — gate-order fail-closed (argv/env allowlist → budget → spawn); `real-process-adapter.ts` `spawnSync`-based sync-only port, deadline-kill leader-only, no-orphan zombies.

---

## Traceability table: AC-R2-1…R2-5 → Confirmed-implemented flows

| AC | Flow | Wave | Commit | PR | Status | Test count |
|---|---|---|---|---|---|---|
| AC-R2-1 (extension-execution) | 023 | R2-1 | `5f75f4c` | #26 | implemented | +23 |
| AC-R2-2 (registered-extension provenance) | 024 | R2-2 | `aa16a0d` | #27 | implemented | +22 |
| AC-R2-3 (bound-parallel-wave) | 025 | R2-3 | `e06d555` | #28 | implemented | +11 |
| AC-R2-4 (TUI adapter) | 022 | R2-4 | `b27bf23` | #25 | implemented | +21 |
| AC-R2-5 (real-subprocess executor, closes F-1) | 026 | R2-5 | `183d826` | #29 | implemented | +21 |
| Release 2 hardening (5 MED findings) | 027 | R2-postreview | `bfa009b` | #30 | hardened / closed | +49 |
| Release 2 polish (7 LOW/INFO + 1 defer H) | 028 | R2-postreview-2 | `c6d65bc` | #31 | hardened / documented | +15 |

**Final baseline:** `bun test` **1338 pass / 2 skip / 0 fail**, `tsc --noEmit` clean, `deps {}`.

---

**Last updated**: 2026-07-14
**Updated by**: Flow 029 documentation worker (T5 / E-01)
**Status**: Draft — pending independent review.
