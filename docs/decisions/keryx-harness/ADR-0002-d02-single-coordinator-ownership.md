# ADR-0002: Single Coordinator, Ownership/Import Matrix, and Inward Ports

**Status**: Accepted / Frozen 2026-07-12

**Decision ID**: D-02
**Task**: implementation-plan.md §W1 row D-02
**Depends on**: ADR-0001 (D-01 Release 0 boundary)
**Reviewer Track**: architecture
**Acceptance scenarios**: S-06, R1-03
**Source of Truth**: docs/requirements/keryx-project-agent-harness/

---

## Context

ADR-0001 froze Release 0 as an offline, read-only vertical slice and, in its
signed decision table, recorded that "Child agent dispatch and budget isolation
are deferred; Release 0 is single-agent only" and that "Session state is local
and authoritative". D-01 fixed *what* the harness may do in Release 0. D-02 fixes
*who owns the loop* once managed-flow integration arrives: it freezes the
authority boundary between the harness and the existing Keryx Task Manager /
`flow-orchestrator`.

The remediation baseline D1–D7 in the frozen PRD already states the position:
"Task Manager is the sole managed-flow coordinator" (prd.md §Decisions and Open
Questions). Selected decision **D1** (brainstorm.md) makes the harness — not the
model provider — own flow state, acceptance criteria, budgets, retries,
evidence, and completion; selected decision **D2** implements the complete
single-agent path first; selected decision **D8** reuses the existing
`subagent-dispatch` / `subagent-result` / `agent-event` / `orchestrator-state` /
`review-finding` contracts as the inter-agent compatibility layer.

D-02 does not re-decide this. It **restates and structures** the already-selected
decision into an ownership/import matrix of inward ports, and verifies that the
structured claims contain **no contradiction** with the frozen specification
(scenario S-06 and Release 1 scenario R1-03) and the implementation-plan
"Purpose and authority" section. If a genuine contradiction had been found, this
ADR would BLOCK rather than invent a resolution. None was found.

The frozen requirements package is the source of truth and is cited, never
modified.

---

## Decision

**Task Manager (`flow-orchestrator` / `keryx flow`) is the single managed-flow
coordinator.** There is exactly one loop authority for any managed run.

The harness is an **execution-primitive and evidence/gate producer**. Within a
dispatched run it owns primitive execution decisions (turns, tool calls, policy
resolution, sessions, evidence). It never:

- runs a competing plan/execute/verify/review loop for a managed flow;
- writes `flow.json` or otherwise mutates managed-flow task state directly;
- declares or persists managed-flow completion itself.

This is the exact position of the frozen specification:

> "Only one loop authority may own a managed run:
> `flow-orchestrator`/Task Manager. The harness owns primitive execution
> decisions within a dispatched run but not managed task state, retry policy,
> review/fix workflow, or completion."
> — specification.md §Orchestration Model

> "A harness implementation must not recreate Task Manager planning, retries,
> review/fix lifecycle, or the completion transition."
> — specification.md §Canonical Ownership and Import Direction

### Ownership / Import Matrix

Dependencies point **inward**: adapters (harness services, provider, transport,
existing Keryx modules) depend on domain/application **ports**; the harness
depends on Task Manager's contract surface, never on `flow.json` internals, and
never the reverse. "Import direction" below reads *dependent → depended-upon*.

| Concern | Owner (Task Manager vs Harness) | Direction of dependency (inward port: who imports whom) | Rule / Constraint |
|---|---|---|---|
| Managed-flow task state (`flow.json`) | **Task Manager** | Harness → `ManagedFlowPort` → Task Manager API adapter; harness never imports `flow.json` | Harness supplies typed evidence only; direct `flow.json` write is forbidden and policy-denied. |
| Task lifecycle (create/add/transition tasks) | **Task Manager** | Harness → `ManagedFlowPort`; Task Manager does not import harness runtime types | "Add or transition tasks through Task Manager only" (agent-protocol.md Phase 2). Harness must not recreate a plan/execute/verify loop. |
| Task dependencies & wave scheduling | **Task Manager** | Harness → `ManagedFlowPort` | The Task Manager model owns the DAG; harness reserves budget/dispatch through the coordinator. |
| Retries / attempts | **Task Manager** | Harness → `ManagedFlowPort` (records attempt evidence); coordinator decides retry | Harness may persist its own runtime attempt evidence but must not own managed retry policy. |
| Review / fix loop | **Task Manager** | Harness → `ManagedFlowPort`; review workers → `review-finding` contract | "Review/fix loop — owned by the selected coordinator; the harness only records the evidence it produces" (spec §Orchestration Model). Fix *tasks*, not silent edits. |
| Completion transition (managed flow) | **Task Manager** | Harness → `CompletionGatePort` produces a typed gate result Task Manager *consumes* | "Task Manager consumes one typed harness completion-gate artifact" (agent-protocol.md). Harness must not declare/persist managed-flow completion. |
| Gate evaluation (produce the typed gate object) | **Harness** | `CompletionGatePort` ← evidence/gate evaluator (adapter → port) | Harness evaluates gates and emits a typed, persisted gate result; consumption/finalization is Task Manager's. |
| Evidence production (model req, tool call, policy decision, metrics) | **Harness** | `SessionStorePort` / evidence store ← harness services | Harness creates/validates/persists its own runtime records; it may not advance Task Manager state from them. |
| Session records / event log | **Harness** | `SessionStorePort` ← local append-only persistence adapter | Session state is local and authoritative (ADR-0001; brainstorm D3). Not stored provider-side, not a Task Manager concern. |
| Tool execution | **Harness** | `ToolExecutorPort` ← registered tool adapters | Model affects the project only through typed tools (brainstorm D4). |
| Permission / policy decision | **Harness** | `PolicyPort` ← policy-profile / approval / security adapters | Deterministic policy; model output never overrides user/project policy (agent-protocol.md Phase 0/3). |
| Model / provider interaction | **Harness** | `ProviderPort` ← fake provider (Release 0); future real-provider adapter | SDK/wire types must not leak into domain contracts. |
| Project brain (graph, wiki, memory, testing, health, security, flow docs) | **Existing Keryx modules** | `ContextProvider` ← module adapters; harness consumes through the port | Harness must not copy or replace module ownership. |
| Child task status (when child agents arrive, Release 1+) | **Task Manager** for a managed flow | Harness → `subagent-dispatch`/`subagent-result` contracts; child result normalized before persistence | "Child task status → Task Manager for a managed flow; harness only persists execution evidence" (agent-protocol.md). No worker self-accepts a parent flow. |

**Two invariants made explicit by the matrix:**

1. **Exactly one loop authority.** For any managed run the sole coordinator is
   `flow-orchestrator` / Task Manager. The harness `execution/turn-control`
   module may sequence a single harness turn but "is deliberately not a second
   orchestrator" (specification.md §Planned Module Map).
2. **Dependencies point inward, never toward `flow.json`.** Harness → contracts
   / ports (e.g. `ManagedFlowPort`, `CompletionGatePort`), never harness →
   `flow.json` writes. Any implementation that introduces `orchestration/`,
   `plan/execute/verify` ownership, or a second completion loop fails the
   architecture gate.

### Inward Ports

The frozen specification (§Canonical Ownership and Import Direction) names the
port boundaries; every adapter depends on the port (adapter → port), and the
port is defined in the harness domain/application layer. The two coordinator-
boundary ports are load-bearing for D-02:

| Domain/application port | Inbound consumer | Adapter implementation(s) | Direction | D-02 role |
|---|---|---|---|---|
| `ManagedFlowPort` | flow bridge | Task Manager API adapter | adapter → port | The **only** channel by which the harness touches managed-flow state. Replaces any direct `flow.json` access. |
| `CompletionGatePort` | completion service | evidence / gate evaluator | adapter → port | The harness produces a typed completion-gate result *through* this port for Task Manager to consume; it is not a completion transition. |
| `ContextProvider` | harness context service | graph, ctx, wiki, memory, testing, health adapters | adapter → port | Project brain stays owned by existing modules; harness consumes read-only. |
| `ProviderPort` | model loop | fake provider (R0); future real provider | adapter → port | Provider SDK isolated from domain. |
| `ToolExecutorPort` | tool runtime | registered read-only tool (R0); later fs/shell/network | adapter → port | Only typed tools mutate the project (deferred past R0). |
| `SessionStorePort` | session service | local append-only persistence adapter | adapter → port | Session/evidence records are harness-owned and local. |
| `PolicyPort` | policy service | policy-profile, approval, security adapters | adapter → port | Deterministic permission decisions, transport-independent. |

Port boundary rule (frozen): "The runtime must not make domain types depend on a
provider SDK, terminal UI, MCP SDK, or a specific subprocess implementation.
Provider, transport, and existing-Keryx service adapters depend inward on runtime
ports." (specification.md §Architectural Position)

### Contradiction Check

Each ownership claim above is checked against the frozen scenario **S-06**
(single-coordinator), the frozen Release 1 scenario **R1-03** (flow integration
under one coordinator), and the implementation-plan **"Purpose and authority"**
section. S-06 is realized in the frozen package by specification.md
§Orchestration Model + §Canonical Ownership and Import Direction and by
acceptance.feature `@SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED` (@release-0) and
`@SC_R09_SINGLE_COORDINATOR` (@release-1). R1-03 is the Release 1 flow-
integration scenario carried by implementation-plan rows FI-01, FI-02, TM-01,
TM-02, TM-03 and by acceptance.feature `@SC_R09_SINGLE_COORDINATOR`.

| Ownership claim (this ADR) | S-06 — single coordinator (spec §Orchestration Model; `@SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED`, `@SC_R09_SINGLE_COORDINATOR`) | R1-03 — flow integration (impl-plan FI-01/FI-02, TM-01…03) | "Purpose and authority" (impl-plan §) | Verdict |
|---|---|---|---|---|
| Task Manager is the single managed-flow coordinator | "Only one loop authority may own a managed run: `flow-orchestrator`/Task Manager." | FI-01: "no direct `flow.json` writes and **no duplicate coordinator**." | "Task Manager is the only owner of managed-flow task state … and completion transitions." | **NO-CONTRADICTION** |
| Harness never writes `flow.json` | `@SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED`: "the request is denied / And Task Manager remains the only flow-state writer." | FI-01 exit: "no direct `flow.json` writes." | "never edits `flow.json` … a competing orchestration loop." | **NO-CONTRADICTION** |
| Harness owns execution primitives (session/tool/policy/provider/evidence) | Spec: "The harness owns primitive execution decisions within a dispatched run." | TM-03 exit: "harness remains an evidence producer only." | "The harness supplies execution primitives and typed evidence/gate artifacts." | **NO-CONTRADICTION** |
| Task Manager owns retries, review/fix, completion transitions | Spec: "not managed task state, retry policy, review/fix workflow, or completion." | FI-02: "Verify one coordinator owns retries, review/fix, and completion transitions." | "…dependencies, retry and review/fix lifecycle, and completion transitions." | **NO-CONTRADICTION** |
| Harness produces a typed gate artifact that TM consumes (no self-completion) | `@SC_R09_SINGLE_COORDINATOR`: "the harness emits a typed gate artifact / Then flow-orchestrator/Task Manager alone advances task and completion state." | FI-01: consume harness evidence/gate artifacts **through the evolved Task Manager API**. | "typed evidence/gate artifacts." | **NO-CONTRADICTION** |
| Dependencies point inward via `ManagedFlowPort` / `CompletionGatePort` | Spec §Canonical Ownership: `ManagedFlowPort` and `CompletionGatePort` listed as adapter → port. | R1-03 realized by consuming through the Task Manager API adapter (`ManagedFlowPort`). | Plan is a "handoff contract"; harness integrates through the evolved Task Manager API, not internals. | **NO-CONTRADICTION** |
| Task Manager evolution is a prerequisite to managed-flow integration | Spec §Planned Module Map: `turn-control` "is deliberately not a second orchestrator." | Global constraint: "Task Manager evolution is a prerequisite for any managed-flow integration"; FI-01 depends on TM-03. | "…never runs a competing orchestration loop." | **NO-CONTRADICTION** |
| Child task status owned by Task Manager for managed flow (Release 1+) | Spec: child dispatch/result deferred; ADR-0001 "Release 0 is single-agent only." | CA-01 depends on FI-01; "No worker may self-accept a parent flow" (agent-protocol.md). | Single-agent path first (brainstorm D2). | **NO-CONTRADICTION** |

**Overall contradiction-check verdict: NO-CONTRADICTION.** Every ownership claim
is directly supported by S-06, R1-03, and the "Purpose and authority" section.
No claim was reconciled by invention; no BLOCK condition arose.

---

## Consequences

### W11 — Flow integration (FI-01, FI-02)

- **FI-01** ("Consume harness evidence/gate artifacts through the evolved Task
  Manager API") must integrate strictly through `ManagedFlowPort` /
  `CompletionGatePort`. Its frozen exit — "no direct `flow.json` writes and no
  duplicate coordinator" — is the enforcement of this ADR. FI-01 depends on
  TM-03 and R0-02; it may not proceed until Task Manager evolution lands.
- **FI-02** ("Verify one coordinator owns retries, review/fix, and completion
  transitions") is the test gate for the single-coordinator invariant:
  flow/harness completion parity and failure-disposition tests.
- The `execution/turn-control` module must remain a single-turn sequencer, not a
  second orchestrator. Introducing `orchestration/` or a second completion loop
  fails the architecture gate.

### TM-* — Task Manager evolution (TM-01, TM-02, TM-03)

- **TM-01** specifies additive task/run-link fields (dependencies, attempts,
  dispositions, AC/evidence refs, budgets, session linkage) — the surface the
  harness consumes through `ManagedFlowPort`, keeping the harness on contracts
  rather than `flow.json` internals.
- **TM-02** defines migration and status-transition fixtures for existing
  `FlowTask` values (old fixtures must map deterministically).
- **TM-03** implements the service/CLI evolution and migration; its exit —
  "harness remains an evidence producer only" — restates this ADR's ownership
  boundary. TM-01 depends on D-02 (this ADR).

### Downstream (Release 1+)

- Child-agent work (CA-01, CA-02) reuses canonical `subagent-dispatch` /
  `subagent-result` (brainstorm D8) and inherits the invariant that no worker
  self-accepts a parent flow or changes parent completion state.

---

## Traceability

**Normative sources** (frozen, cited, never modified):

- [specification.md](../../requirements/keryx-project-agent-harness/specification.md)
  — §Architectural Position, §Canonical Ownership and Import Direction (ports),
  §Planned Module Map (`turn-control` is not a second orchestrator),
  §Orchestration Model ("only one loop authority"), §Completion Gates.
- [agent-protocol.md](../../requirements/keryx-project-agent-harness/agent-protocol.md)
  — §Ownership Model, Phase 2 ("`flow-orchestrator`/Task Manager is the only
  coordinator"), Phase 4/§Child Status Handling ("No worker may self-accept a
  parent flow"), Phase 6.
- [implementation-plan.md](../../requirements/keryx-project-agent-harness/implementation-plan.md)
  — §Purpose and authority, §Global constraints, §W1 row D-02 (contracts S-06,
  R1-03), §W2 TM-01…TM-03, §W11 FI-01/FI-02.
- [acceptance.feature](../../requirements/keryx-project-agent-harness/acceptance.feature)
  — `@SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED` (@release-0),
  `@SC_R09_SINGLE_COORDINATOR` (@release-1), Feature preamble ("Managed-flow
  state and completion remain owned by Task Manager").
- [prd.md](../../requirements/keryx-project-agent-harness/prd.md)
  — §Decisions and Open Questions ("Task Manager is the sole managed-flow
  coordinator"), R1 Independent Runtime.
- [brainstorm.md](../../requirements/keryx-project-agent-harness/brainstorm.md)
  — §Selected Decisions D1 (Keryx owns the project lifecycle), D2 (single-agent
  first), D8 (existing contracts reused).

**Builds on**: [ADR-0001](./ADR-0001-d01-release0-boundary.md) — Release 0
boundary and single-agent-only signed position.

**Scenario realization**:

- **S-06** (single coordinator) → specification.md §Orchestration Model +
  §Canonical Ownership; acceptance.feature `@SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED`,
  `@SC_R09_SINGLE_COORDINATOR`.
- **R1-03** (Release 1 flow integration under one coordinator) →
  implementation-plan FI-01, FI-02, TM-01, TM-02, TM-03; acceptance.feature
  `@SC_R09_SINGLE_COORDINATOR`.

---

## Acceptance Gate

This ADR satisfies acceptance criterion **AC2** from flow 003:

> D-02 — `docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md`
> freezes Task Manager as the single managed-flow coordinator, provides an
> ownership/import matrix of inward ports (harness = evidence/gate producer,
> never a competing loop; no direct `flow.json` writes), and records a
> contradiction check against S-06 and R1-03 that finds no contradiction with the
> frozen spec.

- ✓ Task Manager frozen as the single managed-flow coordinator (exactly one loop
  authority).
- ✓ Ownership/import matrix with columns Concern | Owner | Direction of
  dependency (inward port) | Rule/Constraint; harness = evidence/gate producer,
  no `flow.json` writes, no competing loop.
- ✓ Inward-ports subsection naming the port boundaries (`ManagedFlowPort`,
  `CompletionGatePort`, and the supporting ports), all adapter → port.
- ✓ Contradiction check against S-06, R1-03, and "Purpose and authority" — every
  claim verdict NO-CONTRADICTION; overall NO-CONTRADICTION.
- ✓ Consequences for W11 (FI-01/FI-02) and TM-* recorded.
- ✓ Frozen requirements package cited, never modified; decision restated, not
  re-decided.

---

## Open Items

No D-02 ownership boundary item is OPEN. The single-coordinator decision, the
ownership/import matrix, and the inward-port boundaries are all SIGNED and frozen.

Cross-references to deferred questions owned by other tasks (recorded OPEN in
ADR-0001 and flow context, not resolved here):

| Item | Question | Owner task | Status |
|---|---|---|---|
| OPEN-2 (ref) | Per-role budget values beneath global SLO ceilings that Task Manager reserves through the coordinator | TM-01 / P-01 (Release 1) | OPEN — not a D-02 concern |
| OPEN-3 (ref) | Artifact retention windows per class under team vs solo policy | FI-01 (Release 1) | OPEN — not a D-02 concern |

These are listed for traceability only; D-02 neither resolves nor guesses them.

---

**Decision made by**: Flow 003 (W1 decisions) documentation worker
**Date frozen**: 2026-07-12
**Approver**: Architecture (deferred to T9 review workflow / AC5)
