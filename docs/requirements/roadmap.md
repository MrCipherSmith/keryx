# Requirements Roadmap
Version: 0.8.0

## Status

This roadmap tracks Metaproject requirements packages and their implementation
state. Runtime claims must be backed by source, tests, or a verification report.

## Packages

| Package | Status | Summary |
|---|---|---|
| [Managed Review Feedback Loop](managed-review-feedback-loop/README.md) | implemented (initial runtime slice) | Low-level managed review persistence supports standalone/attached packages, ingest, coverage, findings, decisions, learning, and structural completion. Target orchestration ownership moves to Flow Reviewer. |
| [Flow Reviewer](flow-reviewer/README.md) | specification ready (future) | Task Manager-aware review orchestrator above stateless Review Orchestrator, with one task and durable history per reviewer, adaptive model routing, compact shared context, resume, schemas, and Gherkin acceptance scenarios. |
| [gdgraph Java/Python Import Resolution](gdgraph-java-import-resolution/README.md) | implemented | Language-aware import resolver so Java (Maven/Gradle) and Python source produce real dependency edges instead of nodes-only graphs; fixes the `0/0 = 100%` resolution-metric bug and seeds Java/Python grammars. Verified on example-backend: 0 → 47,984 edges, 94% in-repo resolution. |
| [Keryx Execution Observability](keryx-execution-observability/README.md) | implemented (runtime capability; benchmark harness ready) | Provenance-aware execution metrics, active-time accounting, per-run evidence, baseline-aware CI, lightweight profiles, retry taxonomy, and paired Keryx/no-Keryx validation protocol. No performance claim has been made. |
| [Keryx Context Operations](keryx-context-operations/2026-07-12/README.md) | specification ready (future) | Git-native bounded context assembly with provenance, deterministic-first hybrid retrieval, policy gates, feedback lifecycle and corpus evaluation. It extends existing project sources; no new runtime is implemented yet. |
| [Keryx Telegram Companion Transport](keryx-telegram-transport/README.md) | specification ready (future) | Optional private-chat companion transport around the future Project Agent Harness: local long polling, explicit chat binding, bounded notifications, policy-constrained approvals, cancellation of own active operation, typed intents, and no remote control plane in Release 0. |
| [Keryx Metaproject-Native Harness](keryx-metaproject-native/README.md) | draft | A single typed `MetaprojectPort` + schemas so the harness, interactive agent, and MCP server reach graph/wiki/memory/context in-process from one source (replacing subprocess wrappers and hardcoded MCP adapters), plus a universal, schema-published Task Manager (`flow-state.schema.json` + `ManagedFlowPort`) any runtime can drive while preserving the D-02 invariant. Builds on existing gdgraph/memory/flow facades and SA-01; no new runtime implemented yet. |
| [Keryx Multi-Agent Engine](keryx-multi-agent-engine/README.md) | draft | Subagent orchestration over the Project Agent Harness: a fail-closed `resolveChildModel` resolver adding explicit-or-inherit model/provider selection (the axis budget/policy inheritance does not cover), a policy-gated provider allowlist with scoped credentials, subagent depth/count caps and a single shared budget ledger, a deterministic monitoring fold (`keryx agents`), child-output injection quarantine, and a documented A→B→C roadmap (adaptive model escalation, event-sourced fleet, worktree isolation, bounded peer messaging). Agent definitions ride on an optional `model` block of the existing `subagent-dispatch` contract. Cost/token budgeting is a deferred extension point; no new runtime implemented yet. |
