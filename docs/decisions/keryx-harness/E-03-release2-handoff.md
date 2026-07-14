# Keryx Project Agent Harness — Release 2 flow-orchestrator Handoff

**Status:** Complete (flow 029, dispatch 029-T7, task E-03)
**Date:** 2026-07-14
**Author:** Flow 029 documentation worker (T7 / E-03)
**Gate:** `implementation-plan.md` §W16 and the Release 2 boundary closure rule —
"Promote Release 2 package and create handoff only if the E-02 independent review
confirms **no BLOCKER/P0/P1 remains**." **Met**: the E-02 independent review
([E-02-release2-review-package.md](./E-02-release2-review-package.md)) reports
**no BLOCKER/P0/P1**, a **GO** ship recommendation, **0 open P2**, and one
documented known-limitation (H, deferred as a runtime-enforcement concern). All
five frozen AC-R2-1…R2-5 (proposed at the Release 1 boundary in
[E-03-release1-handoff.md](./E-03-release1-handoff.md) §4) are implemented and
tested. This handoff is therefore created per that gate.

**Scope:** Documentation only. No source, test, ADR, frozen-requirements-package,
canonical schema, `src/contracts`, `flow.json`, or `acceptance-criteria.md` file
was modified to produce this handoff — only this file was created. This document
is the Release 2 counterpart to [E-03-release1-handoff.md](./E-03-release1-handoff.md)
(the Release 1 boundary handoff), which it does not overwrite; it mirrors that
document's structure and covers only the Release 2 surface (R2-1…R2-5 + hardening
waves). Release 0 (W1–W7 + W16(R0)) and Release 1 (W8–W15 + W14) are reused
unchanged and are not re-litigated here. **Release 2 is the last planned release
of the harness project** per the frozen roadmap.

**Baseline at authoring time:** `bun test` **1338 pass / 2 skip / 0 fail**, 4774
`expect()` calls, 173 files; `tsc --noEmit` clean; `package.json` `dependencies`
— `{}`. Every figure below is cited from
[E-01-release2-evidence-matrix.md](./E-01-release2-evidence-matrix.md) and
[E-02-release2-review-package.md](./E-02-release2-review-package.md), both
verified against the working tree in this flow.

---

## 1. Status — Release 2 achieved

Per the frozen acceptance criteria (`docs/requirements/keryx-project-agent-harness/acceptance.feature`,
Release 2 = the AC-R2-1…AC-R2-5 proposal from the Release 1 boundary) and the
runbook's Release 2 state table, all five frozen Release 2 acceptance criteria are
**implemented, tested, independently reviewed with no blocking finding, and the
suite is green**:

- **E-01** ([E-01-release2-evidence-matrix.md](./E-01-release2-evidence-matrix.md)):
  every Release 2 capability (R2-1…R2-5 plus the two post-review hardening waves)
  mapped to real source file / real test / real commit hash and PR, plus this flow's
  own Release 2 evidence closure. All five core rows are marked `implemented`; one
  previously-disclosed Research-Ledger item (F-1, `SC_R04_SHELL_CONTAINMENT` runtime
  half) is marked **CLOSED** by R2-5 (#29); one new documented known-limitation (H,
  cap-less child tool-call aggregate accounting) is recorded `deferred` with
  an evidence-based rationale (a subprocess makes 0 tool calls, so a cap-less
  sub-budget is legitimate, not "unlimited"; denying inheritance would fail-close
  the entire executor path).
- **E-02** ([E-02-release2-review-package.md](./E-02-release2-review-package.md)):
  independent 5-lens review (security / highload+logic / architecture / clean-code
  / testing) across the enumerated Release 2 scope. Verdict: **no BLOCKER/P0/P1**;
  ship recommendation **GO**; 5×MED findings found and closed TDD in flow 027 /
  PR #30; 7×LOW/INFO findings closed in flow 028 / PR #31; 1×H documented-deferred.
- **E-03** (this document): the Release 2 → end-of-roadmap handoff, created because
  the E-02 gate is met and Release 2 is the terminal release.

**All seven frozen `@release-2` scenarios plus the one disclosed Release 1 gap (F-1)
are now closed.** No `@release-2` scenario remains unimplemented.

## 2. What is built (Release 2)

| Capability | Wave | Source | Test | Commit / PR |
|---|---|---|---|---|
| **R2-1 extension-execution:** registered extension gains bounded, policy-governed execution authority for the first time (composition of W12 canonical child contract + W15 registry + W10 approval + W8 immutable attempts) | flow 023 / R2-1 | `src/harness/extension/execute.ts` | `src/harness/extension/execute.test.ts` | `5f75f4c` / PR #26 |
| **R2-2 registered-extension provenance:** persistence of provenance for a successfully registered extension without widening authority (pure composition of W15 registry + R2-1 `evaluateExtensionGrant` + W12 child-provenance + W7 `Provenance`, zero prior-module edits) | flow 024 / R2-2 | `src/harness/extension/provenance.ts` | `src/harness/extension/provenance.test.ts` | `aa16a0d` / PR #27 |
| **R2-3 bound-parallel-wave:** scheduler extension accepting a registered-extension-bound wave, composing W13 `planWaves` + R2-1 `dispatchExtension` + W12 `inheritBudget` + W15 registry (pure deterministic reuse-only) | flow 025 / R2-3 | `src/harness/extension/bound-wave.ts` | `src/harness/extension/bound-wave.test.ts` | `e06d555` / PR #28 |
| **R2-4 interactive CLI / provider-model selection:** CLI adapter over the stable Release 0 CLI/JSONL-RPC runtime ports, enabling interactive provider/model detection and selection without credential input/storage or runtime-contract change (stdlib `node:readline` only, zero new dependency) | flow 022 / R2-4 | `src/commands/select.ts`, `src/commands/shell.ts` | `src/commands/select.test.ts`, `src/commands/shell.test.ts` | `b27bf23` / PR #25 |
| **R2-5 real-subprocess executor (closes F-1 / `SC_R04_SHELL_CONTAINMENT` runtime half):** runtime enforcement of shell containment via a real-process synchronous adapter, composing W10 `guardAction`/`actionFingerprint`/`ExecutionReceipt` + W12 `inheritBudget` + W7 evidence; gate-order fail-closed (argv/env allowlist → budget → spawn); offline tests only, real spawn behind capability flag (not in CI) | flow 026 / R2-5 | `src/harness/process/executor.ts`, `src/harness/process/real-process-adapter.ts` | `src/harness/process/executor.test.ts`, `src/harness/process/real-process-adapter.classify.test.ts`, `src/harness/process/real-process-adapter.smoke.test.ts` | `183d826` / PR #29 |
| **R2-postreview:** hardening of Release 2 following the full 5-lens independent review; closure of 5×MED findings (SSRF guard in `select.ts`, `executor.ts` `exitCode` surfacing, crash-signal classification, two mutation-proof branches, `buildExt` dedup) | flow 027 / R2-postreview | `src/harness/extension/execute.ts`, `src/harness/process/executor.ts`, `src/harness/process/real-process-adapter.ts` | comprehensive hardening test matrix + 2 mutation-proof branch-coverage pins | `bfa009b` / PR #30 |
| **R2-postreview-2:** polish of Release 2 following the hardening review; closure of 7×LOW/INFO findings (causal evidence ids, provider-factory consolidation, DRY refactors, test coverage additions, planning-evidence isolation, outcome `evidenceRefs` normalization, smoke-guard observability); one item (H, cap-less child accounting) deferred with documented rationale | flow 028 / R2-postreview-2 | `src/harness/extension/execute.ts`, `src/harness/process/executor.ts`, `src/harness/provider/make-provider.ts`, multiple | integration/causal-evidence tests + evidence propagation fixtures | `c6d65bc` / PR #31 |

Full traceability (every claim spot-verified — `git log`, `git show --stat`,
`ls`, `bun test <path>` — against the working tree) is in
[E-01-release2-evidence-matrix.md](./E-01-release2-evidence-matrix.md); do not
re-derive it here. Release 0 (W1–W7 + W16(R0)) and Release 1 (W8–W15 + W14) are
reused unchanged; see [flow-orchestrator-handoff.md](./flow-orchestrator-handoff.md)
§2 and [E-03-release1-handoff.md](./E-03-release1-handoff.md) §2 for their DAGs.

## 3. DAG — dependency order actually executed

| Boundary | Waves | Status | Commits | PRs |
|---|---|---|---|---|
| **Release 0 (reused)** | W1–W7 + W16(R0) | ✅ done | `690b376` … `ca57c56` | not applicable (docs-only phase) |
| **Release 1 (reused)** | W8–W13, W15, W14 (last per runbook) + W16(R1) | ✅ done | `c279e3a` … `109c63c` | not applicable (prior release) |
| **Release 2, capability wave** | R2-4 CLI (#25) & R2-1 extension-execution (#26) in parallel → R2-2 provenance (#27) & R2-3 bound-wave (#28) in parallel (both depend on R2-1) → R2-5 subprocess executor (#29) (independent of R2-1…R2-3) | ✅ done | `b27bf23`, `5f75f4c`, `aa16a0d`, `e06d555`, `183d826` | #25, #26, #27, #28, #29 |
| **Release 2, post-capability review** | 5-lens independent review → hardening (#30) → polish (#31) | ✅ done | `bfa009b`, `c6d65bc` | #30, #31 |

**Wave parallelization**: R2-4 (CLI adapter) is independent of the extension
execution, authorization, and process-control surfaces, so it landed as PR #25
ahead of R2-1. R2-1 must land before R2-2 and R2-3 (both depend on its
`dispatchExtension` contract). R2-5 (subprocess executor) reuses W10/W12/W7
primitives and is independent of the extension waves, so it landed in parallel.
The full 5-lens review ran against the assembled R2-1…R2-5 snapshot, found and
closed all findings TDD (hardening #30 → polish #31).

---

## 4. Gates (standing, verified at the Release 2 boundary)

Cited from [E-02-release2-review-package.md](./E-02-release2-review-package.md)
§"Gate evidence" (verified directly against the working tree at review time):

| Gate | Command | Result |
|---|---|---|
| Type check | `bun run typecheck` (`tsc --noEmit`) | clean — no errors |
| Test suite | `bun test` | **1338 pass / 2 skip / 0 fail**, 4774 `expect()` calls, 173 files, ~6.1s |
| Runtime dependencies | `package.json` `dependencies` | `{}` — no runtime dep added across any Release 2 wave; R2-4 CLI uses stdlib `node:readline`, R2-5 uses stdlib `node:child_process` |
| D-02 (harness never writes `flow.json`) | `keryx ctx rg 'writeFlow\|flow\.json' src/harness/extension src/harness/process` | only comments (3 matches, all documentation asserting the invariant); no write call |
| Egress guard reused in Release 2 CLI | `keryx ctx rg 'isPrivateEgressHost\|isLoopbackHost' src/commands/select.ts` | reused verbatim from W15; applied before R2-4 provider probe |
| Offline / deterministic runtime | every Release 2 offline test injects clocks/ids and mocked/recorded-fixture `fetch`; no `Date.now`/`Math.random` calls | upheld (the 2 skips are real-subprocess smoke tests, CI-inert by design) |
| Fail-closed on every new authority boundary | R2-1 three-gate extension escalation AND; R2-2 provenance alias-immunity; R2-3 registered-only deny-first; R2-5 executor gate-order (argv/env → budget → spawn); R2-4 CLI SSRF guard before fetch | upheld (see E-02 §"Logic"/"Security" for per-boundary evidence) |

These are the standing gates carried forward as binding for any future work: any
new capability-bearing wave must keep `tsc --noEmit` clean, the full `bun test`
suite green, `dependencies` `{}` unless explicitly reopened, D-02 unconditional,
offline determinism, and fail-closed behavior on every new authority boundary.

---

## 5. Constraints carried forward (still binding, now frozen without future waves)

- **Reuse-only**: no Release 2 wave rewrites a prior module; each wave composes
  reused primitives instead (bound-wave scheduler reuses W13 `planWaves`;
  extension-execution reuses W12 contract/isolation + W10 approval + W8 immutable;
  the CLI adapter reuses Release 0 CLI/JSONL-RPC runtime ports; the subprocess
  executor reuses W10 guard/receipt/W12 budget/W7 evidence).
- **Frozen requirements package + ADR-0001…0004 + canonical contract schemas +
  `src/eval/` + `src/contracts/` never edited**: verified via `git show --stat` on
  every Release 2 commit (the five core commits plus #30–#31) — none touches those
  paths beyond each wave's own additive source and its own flow package under
  `.metaproject/flows/`.
- **Harness never writes `flow.json` (D-02)**: `ManagedFlowPort` (W11) remains
  the sole bridge; the Release 2 extension/process adapters are pure functions or
  reach only their injected side-effecting boundaries, never flow-state.
- **Injected clock/id determinism**: every source of non-determinism (clock, id
  sequence, `fetch`) is injected via `deps`; no real `Date.now`/`Math.random`/live
  network in any Release 2 offline runtime module.
- **Storage-off default for providers**: the frozen `provider-descriptor.schema.json`
  and Release 0's `AnthropicProvider` (W14) already declared `remoteState.storage
  /retention/continuation = false` by default.
- **No provider SDK / no new runtime dependency**: `package.json` `dependencies`
  stays `{}` through Release 2 (R2-4 uses stdlib `node:readline`, R2-5 uses stdlib
  `node:child_process`).
- **Fail-closed on every authority boundary**: structurally enforced and
  test-proven at each new boundary Release 2 introduced (extension escalation
  three-gate AND, registered-only deny-first, executor gate-order, CLI SSRF guard)
  — see E-02 §"Logic"/"Security" for the per-boundary evidence.

---

## 6. Out of scope / future OPTIONS (Release 2 is terminal, following represent optional future directions)

Release 2 closes the five frozen AC-R2-1…R2-5 and represents the end of the
planned harness roadmap. The following are **not commitments** but represent
optional future enhancements the user may choose to undertake:

### 6a. Live end-to-end CLI wiring

The Release 2 extension-execution, provenance, and bound-wave surfaces are pure
functions over in-memory decision objects; the subprocess executor's real-process
adapter (R2-5) is gated behind a capability flag and runs only offline with
mocked-fixture transcripts in the test suite. A future effort may wire the
interactive CLI (R2-4) through a complete run-loop using the real extension and
process adapters, exercising the full R2-1…R2-5 surface against live decision
records and actual process-group execution. This would require production-grade
logging, observability, and user-facing error recovery UX not defined in the frozen
requirements.

### 6b. Real-model live runs

The CLI can instantiate Anthropic (with a real `ANTHROPIC_API_KEY` in the environment)
and Ollama (with a real local server), but the harness suite does not exercise live
API calls in CI — all tests use offline recorded-fixture transcripts. A future effort
may enable opt-in live-model CLI runs (e.g., via an explicit flag or environment
variable) for exploratory / integration testing outside of the CI gate, subject to
credential and rate-limit hygiene.

### 6c. Subprocess child-agent budget accounting refinement

The documented known-limitation (H, deferred) notes that a cap-less child's
tool-call aggregate accounting is a runtime-enforcement concern outside the
primitive-level deny scope. A future runtime layer may add policies governing
how many tool calls a child may make across its delegation, independent of the
subprocess-specific budget containment that R2-5 provides. This would be a
scheduling / policy layer, not a change to `inheritBudget` or the executor
primitives.

---

## 7. Open items

### 7a. F-1 disclosure (Release 1) — **CLOSED by R2-5**

`SC_R04_SHELL_CONTAINMENT`'s runtime execution-control half (a running
process-group command enforcing timeout / output-limit / cwd / cancellation) was
deferred at the Release 1 boundary as a disclosed P2 item. **R2-5 (flow 026,
`183d826`, PR #29) closes this item**: the `src/harness/process/executor.ts` and
`real-process-adapter.ts` implement the gate-order fail-closed subprocess
execution, with the disclosed design constraint (deadline-kill leader-only;
full process-group zombie cleanup a documented async follow-up). The offline
test suite models the full no-orphan contract via the fake adapter; the real
adapter is smoke-tested offline with the capability flag.

### 7b. H known-limitation (Release 2 postreview-2) — **DOCUMENTED DEFERRED**

The independent review identified a question around cap-less child tool-call
aggregate accounting under a capped parent. Implementation evidence revealed that
a subprocess makes 0 tool calls (so a cap-less sub-budget is legitimate, not
"unlimited"), and a blanket inheritance-level deny would fail-close the entire
R2-5 executor path. The proper bounding of *genuinely unbounded multi-tool-call*
children is a runtime-enforcement concern (e.g., rejecting policy decisions with
unbounded grants on capped paths), not a primitive-level deny. `inheritBudget`
and `scheduler.ts` remain unchanged and correct. This item is documented as a
known-limitation with evidence-based rationale in the E-01 Deferred List; the
test suite locks the current correct behavior (#31/H tests).

### 7c. Research-ledger OPEN items (updated)

- **OPEN-1** (concrete first real provider and credential shape) — **RESOLVED**
  by W14 / Release 1: Anthropic Messages API, thin `fetch` + SSE, no SDK.
- **OPEN-2** (per-role budget values) — **still open**: W15's budget reconcile
  shapes are implemented, but concrete per-role values remain undecided. No
  Release 2 scenario requires them; they remain an open research item.
- **OPEN-3** (artifact retention windows per class, team vs. solo policy) —
  **still open**: W11's `ManagedFlowPort` passes `evidenceRefs` / `runLink`
  through to Task Manager but does not define a retention-window policy. No
  Release 2 scenario requires it.

Neither OPEN-2 nor OPEN-3 blocks the Release 2 closure or any frozen acceptance
criterion. Both are recorded here for historical reference should the user choose
to revisit harness extensions in the future.

---

## Evidence links

- [E-01-release2-evidence-matrix.md](./E-01-release2-evidence-matrix.md) —
  Release 2 capability/evidence matrix, deferred-list update, traceability to
  AC-R2-1…R2-5.
- [E-02-release2-review-package.md](./E-02-release2-review-package.md) —
  independent 5-lens review package (GO, no BLOCKER/P0/P1; 5 MED closed in #30;
  7 LOW/INFO closed in #31; H documented-deferred).
- [E-03-release1-handoff.md](./E-03-release1-handoff.md) — the Release 1
  boundary handoff; frozen AC-R2-1…R2-5 proposal in §4.
- [H-02-deferred-extension-capability-contract.md](./H-02-deferred-extension-capability-contract.md)
  — the deferred extension capability/isolation model Release 2 builds on.
- `docs/requirements/keryx-project-agent-harness/implementation-plan.md` —
  normative DAG, wave order, verification gates.
- `docs/requirements/keryx-project-agent-harness/acceptance.feature` —
  authoritative scenario definitions for all `@release-2` tags and the `@release-1`
  `SC_R04_SHELL_CONTAINMENT` runtime half.
- `docs/plans/keryx-harness-implementation-runbook.md` — Стейт (progress tracker)
  confirming all Release 2 waves (R2-1…R2-5 + hardening) as ✅, and the model
  policy governing this work.
- `flow-orchestrator-handoff.md` — Release 0 boundary handoff (mirrored structure).

---

**Last updated:** 2026-07-14
**Updated by:** Flow 029 documentation worker (T7 / E-03)
**Status:** Handoff complete — Release 2 ready to merge and archive; **all planned
harness release work is now complete**. Releases 0, 1, and 2 are built, evidenced,
independently reviewed, and merged. Any future harness enhancements are outside
the frozen roadmap and are optional (see §6).
