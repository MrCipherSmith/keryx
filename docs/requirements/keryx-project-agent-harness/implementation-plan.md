# Keryx Project Agent Harness Implementation Plan
Version: 0.2.0

## Purpose and authority

This plan is the handoff contract for a future `flow-orchestrator` implementation
flow. It is documentation only; no task below is implemented by this package.
Task Manager is the only owner of managed-flow task state, dependencies, retry
and review/fix lifecycle, and completion transitions. The harness supplies
execution primitives and typed evidence/gate artifacts and never edits
`flow.json` or runs a competing orchestration loop.

Every task has a stable id, kind, objective, dependencies, affected contracts,
acceptance scenarios, evidence, exit criteria, reviewer track, and release
boundary. The DAG and wave order below are normative.

## Global constraints

- No provider SDK is mandatory before the fake provider and provider port pass.
- Release 0 is offline/read-only and has no mutation, unrestricted shell,
  network, child agents, parallel tool calls, executable extensions, provider
  storage, or TUI.
- The existing corpus evaluator moves to `src/eval/` (with compatibility and
  corpus tests) before `src/harness/` is reserved for the runtime.
- Task Manager evolution is a prerequisite for any managed-flow integration.
- Workers use test-first slices and the canonical `subagent-dispatch` and
  `subagent-result` contracts. No task edits frozen acceptance criteria or
  `flow.json` directly.

## Dependency waves

| Wave | Boundary | Tasks | Release |
|---|---|---|---|
| W1 | Decisions and platform boundary | D-01…D-04 | prerequisite |
| W2 | Task Manager prerequisite and migration | TM-01…TM-03 | prerequisite |
| W3 | Existing corpus-harness relocation | EV-01 | prerequisite |
| W4 | Contract registry, validator, fixtures | C-01…C-03 | Release 0 |
| W5 | Provider and tool ports | P-01…P-02 | Release 0 |
| W6 | Fake provider and fake tools | F-01…F-02 | Release 0 |
| W7 | Release 0 read-only vertical slice | R0-01…R0-03 | Release 0 |
| W8 | Durable resume | RS-01…RS-02 | Release 1 |
| W9 | Branching and compaction | B-01…B-02 | Release 1 |
| W10 | Guarded mutation and approval | M-01…M-02 | Release 1 |
| W11 | Flow integration | FI-01…FI-02 | Release 1 |
| W12 | Child agents | CA-01…CA-02 | Release 1 |
| W13 | Parallel scheduling | PA-01 | Release 1 |
| W14 | Real provider adapters | RP-01 | Release 2+ |
| W15 | Security and recovery hardening | H-01…H-02 | Release 1/2+ |
| W16 | Documentation and release evidence | E-01…E-03 | each boundary |

## Task contract

### W1 — Decisions and platform boundary

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| D-01 | docs | Freeze D1 Release 0 scope and measurable success criteria | — | README, PRD, R0-01…R0-03 | ADR + signed decision table; no unresolved Release 0 boundary | architecture |
| D-02 | docs | Freeze D2 single coordinator, ownership matrix, and inward ports | D-01 | S-06, R1-03 | ownership/import matrix and contradiction check | architecture |
| D-03 | docs | Freeze D3 security profiles and required containment | D-01 | S-04, R1-01, M-02 | profile/isolation matrix and fail-closed decision | security |
| D-04 | docs | Freeze D4–D6 provider state, branch model, and child wire framing | D-01 | S-02, S-08, S-09 | decision records linked to schemas and research ledger | contract |

### W2 — Task Manager prerequisite and migration

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| TM-01 | docs | Specify additive Task Manager task/run-link fields: dependencies, attempts, dispositions, AC/evidence refs, budgets, session linkage | D-02 | R1-03, CA-01 | versioned migration proposal and backward-compatibility matrix | architecture |
| TM-02 | test | Define migration and status-transition fixtures for existing FlowTask values | TM-01 | migration negatives, R1-03 | old fixtures map deterministically; blocked/failed/skipped semantics explicit | testing |
| TM-03 | implement | Implement Task Manager service/CLI evolution and migration | TM-02 | R1-03 | Task Manager tests pass; harness remains an evidence producer only | logic |

### W3 — Existing corpus-harness relocation

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| EV-01 | implement | Move current fixture-corpus evaluator to `src/eval/`, update imports/docs, and preserve corpus gates | D-02 | R0-01, migration | compatibility map plus green existing corpus tests | architecture/testing |

### W4 — Contract registry, validator, and fixtures

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| C-01 | docs | Register every durable/public payload and shared envelope with stable `$id`, owner, persistence, and migration policy | D-04, TM-01, EV-01 | S-02/S-03/S-05/S-07/S-08/S-11 | `contract-inventory.md` has no missing rows | contract |
| C-02 | implement | Provide a Draft 2020-12-capable validator or prove every used keyword in the deterministic validator | C-01 | schema gate | keyword coverage and semantic-validator report pass | contract/testing |
| C-03 | test | Add positive, negative, mutation, migration, and fixture-hash matrices for every schema family | C-02 | all schema scenarios | all fixtures validate/reject as declared; deterministic IDs/clock | testing |

### W5 — Provider and tool ports

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| P-01 | implement | Implement provider-neutral request/event/error/capability ports with attempt-scoped streams and unknown extensions | C-02 | R0-02, R0-03, RP-01 | no provider SDK types cross the port | architecture/logic |
| P-02 | implement | Implement registered tool definition/registry/call ports with schema, budget, cancellation, provenance, and replay metadata | C-02 | R0-02, R1-01 | direct model filesystem/shell access is impossible | contract/security |

### W6 — Fake provider and fake tools

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| F-01 | test | Build deterministic fake-provider transcript fixtures for deltas, malformed/unknown events, errors, cancellation, usage, and retry | P-01 | R0-02, R0-03, negatives | expected normalized event snapshots pass offline | testing |
| F-02 | implement | Add one registered read-only fake tool and hash-bound recorded results | P-02, F-01 | R0-02, R0-03 | no network or mutation in fixture execution | security/testing |

### W7 — Release 0 read-only vertical slice

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| R0-01 | implement | Implement disabled capability floor and explicit enabled-startup preconditions | F-02 | R0-01, startup negatives | disabled overhead SLO and typed `environment_blocked` results pass | logic/performance |
| R0-02 | implement | Implement minimal append-only session, context manifest, evidence-linked output, and completion gate artifact | R0-01 | R0-02, R0-03, R1-03 | valid read-only run has reconstructable evidence and no hidden reasoning | contract |
| R0-03 | implement | Expose CLI and JSONL/RPC semantic parity plus effect-free offline replay | R0-02 | R0-03, R1-04 | parity and replay mismatch fixtures pass; no provider/network/tool effect | testing/performance |

### W8 — Durable resume

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| RS-01 | implement | Reconstruct current leaf with same-worktree/toolchain fingerprints and immutable attempts | R0-02 | R1-01, R1-02 | stale result creates a new attempt; accepted evidence never duplicates | logic |
| RS-02 | test | Exercise crash/torn-write/cancellation cut points and ambiguous side-effect reconciliation | RS-01 | recovery negatives | outcome-unknown blocks unsafe retry; failpoint matrix passes | security/testing |

### W9 — Branching and compaction

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| B-01 | implement | Implement append-only branch metadata, fork/current leaf, immutable ancestors, and no-merge-v1 rule | RS-01 | branch negatives | branch switch is atomic and ancestry is preserved | logic |
| B-02 | implement | Implement typed compaction entry with provenance and evidence-preservation validation | B-01 | compaction negatives | compaction never deletes history/evidence or promotes untrusted summary | contract |

### W10 — Guarded mutation and approval

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| M-01 | implement | Implement policy profiles, canonical action fingerprints, single-use approvals, path/argv/env rules, and fail-closed scan state | RS-02, D-03 | R1-01, R1-02 | stale/denied/headless approvals never execute; symlink/shell negatives pass | security |
| M-02 | implement | Add monitored trusted-local mutation and execution receipt/reconciliation; keep unattended untrusted blocked without isolation | M-01 | R1-02, recovery negatives | receipt/evidence persisted; unknown side effects require reconciliation | security/logic |

### W11 — Flow integration

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| FI-01 | implement | Consume harness evidence/gate artifacts through the evolved Task Manager API | TM-03, R0-02 | R1-03 | no direct `flow.json` writes and no duplicate coordinator | architecture |
| FI-02 | test | Verify one coordinator owns retries, review/fix, and completion transitions | FI-01 | R1-03 | flow/harness completion parity and failure disposition tests pass | logic |

### W12–W15 — Deferred capabilities

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| CA-01 | implement | Adapt canonical `subagent-dispatch`/`subagent-result` with parent/session/attempt extensions and STATUS framing | FI-01 | R1-04 | round-trip and transport parity fixtures pass | contract |
| CA-02 | implement | Add child isolation, context budget, provenance, NEEDS_CONTEXT, blocked/failed dispositions | CA-01 | child negatives | parent owns status and completion; prior attempts immutable | security/logic |
| PA-01 | implement | Add bounded ready-set waves, aggregate reservations, cancellation, and loop detection | CA-02 | budget/loop negatives | concurrency and budget ceilings are enforced | highload |
| RP-01 | implement | Add first real provider adapter behind an explicit capability and privacy/retention contract | R0-03, D-04 | provider negatives | pinned research and provider fixtures pass; storage off by default | provider/contract |
| H-01 | test | Run security, recovery, replay, migration, performance, and red-team hardening suites | M-02, PA-01, RP-01 | all negative families | no unexplained high-severity finding; SLOs measured | security/testing/performance |
| H-02 | docs | Define deferred extension capability grants and isolation without enabling them in Release 0 | H-01 | extension escalation negative | extension contract is explicitly later scope | security |

### W16 — Documentation and release evidence

| ID | Kind | Objective | Depends | Contracts / scenarios | Evidence and exit | Reviewer |
|---|---|---|---|---|---|---|
| E-01 | docs | Update package index, research ledger, migration notes, and capability/evidence matrix | H-01 | traceability gate | every claim marked implemented/planned/deferred | documentation |
| E-02 | review | Run independent architecture, contract, logic, security, testing/replay, performance, and Gherkin reviews | E-01 | S-01…S-12 | normalized managed review package created; source review untouched | review-orchestrator |
| E-03 | docs | Promote roadmap/package and create `flow-orchestrator-handoff.md` only if no BLOCKER/P0/P1 remains | E-02 | completion policy | handoff includes DAG, frozen AC proposal, gates, constraints, and out-of-scope | strict |

## Verification gates

Before Release 0: package files and versions, JSON parse, validator keyword
coverage, positive/negative fixtures, valid Gherkin parse, requirements→scenario
→schema→task coverage, and disabled-floor SLO must pass. Before Release 1:
resume/recovery, approval/security, Task Manager migration, and coordinator
parity gates must pass. Later provider/network/extension gates are independent.

The implementation flow must record evidence paths for every task and must not
promote a capability from planned/deferred without source and test evidence.
