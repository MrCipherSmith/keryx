# Tasks

Definitions only. Statuses and dependency changes are CLI-owned in flow.json. Runtime tasks cannot start before explicit freeze/start, even when a dependency is done.

| ID | Kind | Owner | Scope | Depends on |
|---|---|---|---|---|
| T1 | context | Orchestrator | Initial source/context/decisions and baseline | none |
| T2 | implement | superseded | Skipped: bounded T7–T12 replace scaffold | none |
| T3 | test | superseded | Skipped: TDD per task and T13 replace scaffold | none |
| T4 | review | Orchestrator | Independent managed review; no implicit PR | T13,T14 |
| T5 | docs | agent-1 | Correct existing docpack and validate contracts | none |
| T6 | verify | agent-2 | Independent docpack/schema/example/decision check | T5 |
| T7 | implement | agent-1 | Pure scoring, intervals, exhaustive verdict precedence | T6 |
| T8 | implement | agent-1 | Evidence schemas, config, immutable plan/checkpoint types | T6 |
| T9 | implement | agent-1 | Core identity, durable checkpoints, evidence recovery, retention | T7,T8 |
| T10 | implement | agent-2 | Isolated runner, gold, usage, signals, cleanup | T9 |
| T11 | implement | agent-2 | CLI gates, budget, dry-run, JSON, outcomes | T10 |
| T12 | implement | agent-1 | Router/prune integration and decision regression guards | T11 |
| T13 | verify | Orchestrator | Independent integration, lint/type/tests/import/failure gates | T12 |
| T14 | docs | agents + Orchestrator | Implementation docs and verified handoff report | T13 |

Shared-file ownership: agent-1 alone edits learning shared modules, shipped/documented learned-pattern schemas and learn.ts. agent-2 alone edits harness/probe and commands/learn-probe. Tests stay with their lane. No worker commits or touches flow state/frozen AC. Orchestrator owns task-boundary verification and commits.
