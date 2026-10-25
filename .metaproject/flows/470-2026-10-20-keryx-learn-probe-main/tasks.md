# Tasks

Definitions below mirror registered tasks; statuses and dependencies live in flow.json and change only through CLI. No runtime work before explicit freeze. T2/T3 are superseded; T5/T6 evidence is inherited, not re-executed.

| ID | Kind | Task | Depends on |
|---|---|---|---|
| T1 | context | Collect remaining context | none |
| T2 | implement | Implement per plan | none |
| T3 | test | Add/adjust tests and make them pass | none |
| T4 | review | Self-review and prepare draft PR | T13, T14 |
| T5 | docs | Inherited docpack correction from flow 469 T5; no new execution | none |
| T6 | verify | Inherited independent docpack verification from flow 469 T6; no new execution | T5 |
| T7 | implement | Lane A: pure scoring, intervals and verdict precedence | T1, T6 |
| T8 | implement | Lane A: evidence schemas, config and plan/checkpoint contracts | T1, T6 |
| T9 | implement | Lane A: identity, durable recovery, evidence finalization and retention | T7, T8 |
| T10 | implement | Lane B: isolated runner, gold checks, usage, signals and cleanup | T9 |
| T11 | implement | Lane B: CLI gates, budget, dry-run, JSON and recovery outcomes | T10 |
| T12 | implement | Lane A: router/prune integration and decision regression guards | T11 |
| T13 | verify | Independent integration quality gate and AC verification | T12 |
| T14 | docs | Implementation documentation and verified handoff report | T13 |

## Ownership and verification

Agent-1 owns T7/T8/T9/T12 and shared src/learning/{types,schema,config,store,paths,prune}.ts plus learned-pattern schemas. Agent-2 owns T10/T11 runner and CLI adapter; consumes the agreed core API and does not edit shared learning files. Orchestrator verifies T1/T13 and directs T14/T4 independently.

AC mapping: T7→AC10; T8→AC5,13,21; T9→AC5–7,11–16,19; T10→AC8–9,11,17–18; T11→AC1–5,12,15–17,22; T12→AC19–20; T13→AC1–23; T14→AC24.

Each implementation task returns exact changed paths, schema-valid result with project_context_applied, RED/GREEN evidence and failure-scenario evidence. No AC confirmation from self-report alone. Pin absolute checkout, avoid stash/reset/broad staging and unrelated edits. Commit verified exact task paths at task boundaries.

## Prefreeze review obligations

T9 covers crash injection at every plan/checkpoint/comparison/record/marker write boundary and concurrent invocations, including preservation of unrelated record writes (AC14). T10 covers resume reconciliation of stale owned worktrees after uncatchable death before creating new ones, never deleting unrelated worktrees (AC18).

T12 additionally owns the minimal probes-root managed-ignore entry and guard in src/lib/metaproject-gitignore.ts and src/learning/gitignore-guard.test.ts, plus relevant init/update regression tests. Use git-common-dir/info/exclude; never change tracked .gitignore (AC19). These paths are reserved for agent-1; agent-2 must not edit them.

T7/T8 dependencies were repaired through the CLI and independently verified as T1,T6; this table does not itself change flow.json. Workers do not commit; orchestrator commits only verified exact changed paths at task boundaries.
