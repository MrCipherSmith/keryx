# Decision Registry — Keryx Harness Package Index

**Version**: 0.2.0
**Frozen**: 2026-07-12 (D-01…D-04); extended 2026-07-13 (W2–W16 artifact index)
**Flow**: 003 (W1 decisions); extended by flow 010 (W16 E-01)
**Index of**: D-01, D-02, D-03, D-04 (W1 decisions) plus the full W2–W16
artifact package (TM-01, EV-01, contract-inventory, research-ledger, and the
E-01 evidence matrix). This file is the single package index for
`docs/decisions/keryx-harness/`.

---

## Overview

This registry indexes all four W1 decisions from implementation-plan.md §W1 Task Contract. Each decision freezes a distinct architectural boundary or capability contract required before Release 0 or Release 1 implementation can proceed. Decisions are signed sequentially: D-01 must pass before D-02, D-03, and D-04 can begin.

---

## Registry Table

| ID | Title | ADR File | Acceptance Criterion | Reviewer Track | Status | Frozen Date |
|---|---|---|---|---|---|---|
| **D-01** | Release 0 Boundary and Measurable Success Criteria | [ADR-0001-d01-release0-boundary.md](./ADR-0001-d01-release0-boundary.md) | AC1 | architecture | **SIGNED** | 2026-07-12 |
| **D-02** | Single Coordinator, Ownership Matrix, and Inward Ports | [ADR-0002-d02-single-coordinator-ownership.md](./ADR-0002-d02-single-coordinator-ownership.md) | AC2 | architecture | **SIGNED** | 2026-07-12 |
| **D-03** | Security Profiles and Required Containment | [ADR-0003-d03-security-profiles-containment.md](./ADR-0003-d03-security-profiles-containment.md) | AC3 | security | **SIGNED** | 2026-07-12 |
| **D-04** | Provider State, Branch Model, and Child Wire Framing | [ADR-0004-d04-provider-branch-child.md](./ADR-0004-d04-provider-branch-child.md) | AC4 | contract | **SIGNED** | 2026-07-12 |

---

## Decision Dependencies

```
D-01 (Release 0 boundary, success criteria, startup gates)
  ↓
  +── D-02 (Single coordinator, ownership, inward ports; depends on D-01)
  +── D-03 (Security profiles, containment; depends on D-01)
  +── D-04 (Provider state, branch, child; depends on D-01)
```

No implementation work in W2–W7 (Task Manager, corpus relocation, contracts, provider ports, fake provider, Release 0 slice) may proceed until D-01 is SIGNED.

D-02, D-03, D-04 may proceed in parallel after D-01 is SIGNED, provided each respects the Release 0 boundary frozen in D-01.

---

## Status and Gate Reference

### D-01: SIGNED

**Decision**: Release 0 is an offline, read-only slice with explicit inclusions (fake provider, one read-only tool, provider-neutral event loop, append-only session, context manifest, evidence linking, CLI/JSONL/RPC parity, offline replay) and explicit exclusions (no mutation, shell, network, child agents, parallel tools, extensions, provider storage, or TUI).

**Evidence**: ADR-0001 with 24 signed decision items, 10 measurable success criteria traced to PRD and R0-01/R0-02/R0-03, traceability to all normative sources (README, PRD, specification, brainstorm, acceptance.feature, schemas).

**Gate Status**: ✓ AC1 satisfied  
- Release 0 boundary explicitly enumerated
- Measurable success criteria table with PRD and scenario traceability
- Signed decision table with no unresolved Release 0 items
- Open questions explicitly recorded as OPEN, not guessed

---

### D-02: SIGNED

**Decision**: Single coordinator ownership — Task Manager / `flow-orchestrator` is the sole managed-flow task/run/completion writer; the harness is an evidence/gate producer only, with exactly one loop authority and no direct `flow.json` mutations.

**Evidence**: ADR-0002 with a 14-row ownership/import matrix, named inward ports (`ManagedFlowPort`, `CompletionGatePort`, plus supporting adapter→port boundaries), and a contradiction-check table (verdict: NO-CONTRADICTION).

**Reviewer Track**: architecture · **Acceptance Criterion**: AC2  
**Gate Status**: ✓ AC2 satisfied — contradiction check finds no contradiction with frozen spec.

---

### D-03: SIGNED

**Decision**: Three security profiles (`read-only-review`, `monitored-trusted-local`, `unattended-untrusted`), required containment for higher-risk profiles, explicit fail-closed isolation boundary; Release 0 permits only `read-only-review`.

**Evidence**: ADR-0003 with a profile/isolation matrix mapped to `policy-profile.schema.json` (incl. `read-only-review`/`unattended-untrusted` conditionals and `redactionFailure`/`networkBrokerFailure` deny constants), S-04/R1-01/M-02, and an explicit fail-closed decision (missing containment → typed `environment_blocked`/`policy_denied`, never silent allow).

**Reviewer Track**: security · **Acceptance Criterion**: AC3  
**Gate Status**: ✓ AC3 satisfied — isolation requirement mapped to schema; fail-closed decision explicit.

---

### D-04: SIGNED

**Decision**: Provider-neutral event-sourced provider state (no SDK type crosses the port; provider storage/retention off), append-only branch model (immutable ancestors, no-merge-v1, evidence-preserving compaction), and child-wire framing that reuses canonical `subagent-dispatch`/`subagent-result` with only additive parent/session/attempt extensions.

**Evidence**: ADR-0004 (records D4/D5/D6) with owning-schema links by real `$id` — `provider-descriptor` (+model-request/response/error) → S-02, `branch-metadata` (+checkpoint/compaction-entry) → S-08, `harness-child-contract-extension` → S-09 — plus [research-ledger.md](./research-ledger.md) (RL-01…RL-06 frozen; OPEN-1…OPEN-4 deferred).

**Reviewer Track**: contract · **Acceptance Criterion**: AC4  
**Gate Status**: ✓ AC4 satisfied — decision records linked to schemas; every deferred question marked OPEN; no silent resolution.

---

## Traceability note (scenario-tag mapping)

The tokens `S-02/S-04/S-06/S-08/S-09` and `R1-01/R1-03` are the **implementation-plan §W1 abstract scenario references**; they are not literal labels inside `specification.md`. All three D-02/D-03/D-04 workers independently verified this (`ctx rg` → zero literal hits) and mapped each token to its concrete realization: the owning `specification.md` section plus the matching `acceptance.feature` tag (e.g. D-02 → `@SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED` / `@SC_R09_SINGLE_COORDINATOR`; D-03 → `@SC_R04` / `@SC_R05_HARD_DENY`). Each ADR documents its own mapping so the trace is auditable. This is a labeling convention, not a spec contradiction.

---

## Mutual Consistency Gate (AC5)

Planned for T9 review (implementation-plan.md W16 task E-02):

> ADRs D-01…D-04 are mutually consistent and consistent with frozen requirements package (README/PRD/specification/acceptance.feature/schemas); verified by independent review with no unresolved contradiction; frozen requirements package is unmodified.

---

## Normative Source Reference

All decisions reference and cite (never modify) the frozen requirements package:

- [README.md](../../../requirements/keryx-project-agent-harness/README.md) — Release boundaries, startup/resume preconditions, SLOs.
- [prd.md](../../../requirements/keryx-project-agent-harness/prd.md) — Problem, thesis, functional requirements, success criteria, deferred questions.
- [specification.md](../../../requirements/keryx-project-agent-harness/specification.md) — Architecture, runtime lifecycle, storage, manifest/config schemas, CLI, tool/policy, orchestration.
- [brainstorm.md](../../../requirements/keryx-project-agent-harness/brainstorm.md) — Selected decisions D1–D8, critical questions, research basis.
- [implementation-plan.md](../../../requirements/keryx-project-agent-harness/implementation-plan.md) — Wave structure, task contract, global constraints, verification gates.
- [acceptance.feature](../../../requirements/keryx-project-agent-harness/acceptance.feature) — 80+ executable scenarios, Release 0–Release 2+, R1–R18 mappings.
- [schemas/](../../../requirements/keryx-project-agent-harness/schemas/) — 35+ JSON schemas (Draft 2020-12), fixtures, version registry.

---

## W2–W16 Package Index (extended 2026-07-13, flow 010 / W16 E-01)

This section extends the registry beyond the W1 decisions (D-01…D-04 above,
unchanged) to index every subsequent wave's documentation artifact under
`docs/decisions/keryx-harness/`, so this file is a complete package index.

| Wave | Task(s) | Artifact | Commit | Summary |
|---|---|---|---|---|
| W1 | D-01…D-04 | [ADR-0001](./ADR-0001-d01-release0-boundary.md), [ADR-0002](./ADR-0002-d02-single-coordinator-ownership.md), [ADR-0003](./ADR-0003-d03-security-profiles-containment.md), [ADR-0004](./ADR-0004-d04-provider-branch-child.md) | `690b376` | Release 0 boundary, single-coordinator ownership, security profiles, provider/branch/child framing. |
| W1 | D-04 | [research-ledger.md](./research-ledger.md) | `690b376` | RL-01…RL-06 frozen provenance; OPEN-1…OPEN-4 deferred questions. |
| W2 | TM-01…TM-03 | [TM-01-task-manager-evolution.md](./TM-01-task-manager-evolution.md) | `99952a5` | Additive Task Manager task/run-link fields; schemaVersion 1→2 read-time migration; backward-compatibility matrix. |
| W3 | EV-01 | [EV-01-corpus-relocation.md](./EV-01-corpus-relocation.md) | `39a884b` | Fixture-corpus evaluator relocation `src/harness/` → `src/eval/`; resolves ADR-0001 OPEN-4. |
| W4 | C-01…C-03 | [contract-inventory.md](./contract-inventory.md) | `2b92515` | Registry of every durable/public payload schema; validator keyword-coverage and fixture-matrix evidence. |
| W5 | P-01, P-02 | (no standalone doc artifact; evidence in flow 007 journal and E-01 matrix) | `d5fa7c0` | Provider-neutral and tool ports. |
| W6 | F-01, F-02 | (no standalone doc artifact; evidence in flow 008 journal and E-01 matrix) | `3b06260` | Deterministic fake provider and fake read-only tool. |
| W7 | R0-01…R0-03 | (no standalone doc artifact; evidence in flow 009 journal and E-01 matrix) | `ca57c56` | Release 0 offline read-only vertical slice: startup, session, policy, completion, run/CLI/RPC/replay. |
| W16 | E-01 | [E-01-release0-evidence-matrix.md](./E-01-release0-evidence-matrix.md) | (this task; docs only, uncommitted at authoring time) | Capability/evidence matrix mapping every Release 0 capability to status/source/test/commit; migration notes; 2 deferred scenarios marked. |

W8–W15 (durable resume, branching, guarded mutation, flow integration, child
agents, parallel scheduling, real provider adapters, hardening) are Release
1/2+ scope and have not started; no artifact exists yet for those waves.

**Release 0 roadmap note (2026-07-13, flow 010 / W16 E-03):** E-02
([E-02-release0-review-package.md](./E-02-release0-review-package.md))
completed with verdict **no BLOCKER/P0/P1, GO**. E-03
([flow-orchestrator-handoff.md](./flow-orchestrator-handoff.md)) is the
resulting Release 0 implementation handoff — DAG/wave status, frozen AC
proposal, gates, constraints, and out-of-scope/deferred (now three scenarios,
per E-02 finding F-1 disclosed in the updated
[E-01 matrix](./E-01-release0-evidence-matrix.md)). All three W16 tasks
(E-01, E-02, E-03) are now complete.

---

## Workflow

1. **D-01**: ✓ SIGNED and delivered (this flow task T5).
2. **D-02, D-03, D-04**: Dispatched to independent docs workers (T6, T7, T8) after D-01 passes review.
3. **ADR mutual consistency review** (T9, W16 task E-02): Independent reviewer checks all ADRs against each other and against frozen spec; reports contradictions or approves.
4. **Registry update** (after T6–T9): Status flipped to SIGNED for D-02, D-03, D-04 as each completes; research-ledger added for D-04.
5. **Flow completion** (after T9 passes): Orchestrator advances to W2–W4 implementation tasks (Task Manager, corpus relocation, contracts).

---

**Last updated**: 2026-07-13
**Updated by**: Flow 003 orchestrator (post D-02/D-03/D-04 + T9 review); extended by flow 010 documentation worker (T5 / W16 E-01)
**Status**: All four W1 decisions SIGNED (D-01…D-04); T9 consistency/contradiction review passed (AC1–AC5 satisfied, frozen requirements package unmodified). Package index extended to W2–W16 artifacts (TM-01, EV-01, contract-inventory, research-ledger, E-01 evidence matrix); D-01…D-04 rows unchanged.
