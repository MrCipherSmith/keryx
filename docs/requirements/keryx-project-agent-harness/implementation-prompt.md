# Flow-Orchestrator Implementation Prompt
Version: 1.0.0

Use this prompt to start the managed implementation flow for this package.

```text
Run a managed implementation flow for:

/Users/tsaitler.aleksandr/goodea/goodpro-manager/docs/requirements/keryx-project-agent-harness/

Project root:
/Users/tsaitler.aleksandr/goodea/goodpro-manager/

Before searching or changing anything, read:
- .metaproject/index.md
- .metaproject/jobs/requirements-remediation--keryx-project-agent-harness/flow-orchestrator-handoff.md
- docs/requirements/keryx-project-agent-harness/implementation-plan.md
- docs/requirements/keryx-project-agent-harness/acceptance.feature
- docs/requirements/keryx-project-agent-harness/schemas/

Use the local Metaproject flow, testing, gdctx, gdgraph, and gdwiki guidance.
Keep the source review immutable:
.metaproject/reviews/2026-07-10-review-flow-users-tsaitler-aleksandr-goodea-goodpro-/

Implement Release 0 first: offline fake provider, one read-only registered tool,
provider-neutral turn control, append-only session, bounded context manifest,
evidence-linked output, CLI/JSONL-RPC parity, and deterministic effect-free
replay.

Task Manager/flow-orchestrator is the sole owner of managed-flow tasks, DAG
dependencies, retries, review/fix lifecycle, and completion. Do not create a
second coordinator, edit flow.json directly, or use execution/turn-control as
managed-flow orchestration. Harness code may emit typed run, session, tool,
policy, evidence, and completion-gate artifacts only through the declared ports.

Start in this order:
1. Task Manager evolution prerequisite (TM-01..TM-03).
2. Move the existing corpus evaluator from src/harness to src/eval (EV-01).
3. Contract registry, Draft 2020-12 validator, schemas, fixtures, and semantic checks.
4. Provider/tool ports, fake provider, read-only loop, session, context, evidence,
   transports, and replay.
5. Stop at Release 0 until every Release 0 gate passes.

Do not enable production providers, mutation, unrestricted shell, network,
child agents, parallel execution, or extensions before their release gates.
Treat harness-agent-task as migration-reader-only; new child transport and
persistence use canonical subagent-dispatch/subagent-result contracts.

Every wave must add tests and evidence, update Task Manager state through its
API/CLI, and preserve the deterministic Keryx floor when harness.enabled=false.
Completion requires passing schema, fixture, semantic, security, replay,
deterministic-floor, acceptance, and review gates. Do not create a PR without
separate confirmation.
```
