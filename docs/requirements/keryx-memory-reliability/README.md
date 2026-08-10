# Keryx Memory Reliability Requirements Package
Version: 1.2.0

## Status

`implemented and verified (PR #261)` — Keryx
has a Markdown-first memory module with pure lexical and optional semantic search,
explicit reports, lifecycle transitions, accepted/current bounded automatic
recall, guarded writes, and coherent temporal/catalog/config semantics. This
package records the implementation and evidence; renumbered flows 135–141 are
linked to PR #261 and completed after all acceptance, health, and security gates.

## Purpose

Turn the existing memory module into a predictable project-memory subsystem with
one clear boundary:

- durable knowledge is versioned Markdown under `.metaproject/memory/`;
- recall is a side-effect-free read operation;
- report persistence is explicit and writes only disposable runtime data;
- only accepted, current memory may automatically influence an agent;
- every durable write follows one validated, security-gated lifecycle.

The package is written so implementation can be tracked phase by phase without
reinterpreting the findings that motivated it.

## Document Index

- [PRD](prd.md) — problem, goals, requirements, Gherkin acceptance criteria,
  success measures, risks, and recommendation.
- [Specification](specification.md) — target architecture, service and CLI
  contracts, state transitions, storage policy, integrations, migration, and
  traceable acceptance criteria.
- [Implementation Plan](implementation-plan.md) — ordered phases, task checklist,
  dependencies, proposed file changes, commits, and definition of done.
- [Artifact Lifecycle](artifact-lifecycle.md) — source-of-truth versus generated
  data, retention, Git policy, privacy bounds, concurrency, and migration.
- [Metrics and Validation](metrics-and-validation.md) — measurable gates, test
  matrix, verification commands, observability, and rollout evidence.
- [Memory Search Report Schema](schemas/memory-search-report.schema.json) —
  machine-readable bounded contract for explicitly persisted search reports.

## Scope

- `src/memory/**`: storage, search, service facade, reports, lifecycle,
  validation, ingest, reflection, supersession, embeddings, and configuration.
- `src/commands/memory.ts`: CLI behavior and lifecycle commands.
- `src/harness/tool/**`, `src/mcp/**`, and approval context: read-only tool
  semantics and accepted-only defaults.
- `src/flow/context.ts` and `src/gdskills/verify.ts`: automatic influence rules.
- init/update templates and `.gitignore`: generated memory-data policy.
- tests and user/module documentation required to prove and explain the new
  contracts.

## Non-Goals

- Replacing Markdown with a database or remote service.
- Adding cloud synchronization or shared multi-user memory.
- Making embeddings mandatory or adding a production embedding dependency.
- Automatically accepting generated memories.
- Injecting the complete memory store into every shell turn or system prompt.
- Replacing deterministic lexical ranking with a new relevance engine.
- Reworking unrelated health, testing, gdctx, wiki, or flow artifact systems.

## Delivery Tracking

The canonical progress checklist is [Implementation Plan](implementation-plan.md).
Each phase has entry criteria, tasks, verification, exit criteria, and a proposed
atomic commit. A phase may be marked complete only after its listed tests and
cross-surface checks pass.

## Related Modules and Requirements

- `src/memory/` — current implementation being corrected.
- `src/harness/tool/metaproject-adapter.ts` — in-process memory adapter.
- `src/harness/tool/metaproject-operations.ts` — unified `memory_search`
  descriptor currently declared `risk: "read"`.
- `src/mcp/tools.ts` and `src/mcp/metaproject-tools.ts` — MCP memory exposure.
- `src/commands/agent-approval-context.ts` — automatic recall before shell
  approval.
- `src/flow/context.ts` — related and procedural memory injection.
- [Keryx Metaproject-Native Harness](../keryx-metaproject-native/README.md) —
  requires `MetaprojectPort` reads to be deterministic and side-effect-free.
- [Requirements Roadmap](../roadmap.md) — package status across Keryx.

## Evidence Baseline

The requirements are grounded in the current implementation:

- `MemoryService.search()` writes `data/memory/artifacts/latest.{md,json}` on
  every invocation.
- harness and MCP classify that same operation as read-only.
- approval context invokes memory search automatically before approved shell
  execution.
- runtime search scans Markdown directly and does not consume
  `data/memory/index/index.json`.
- generated memory artifacts, catalog, and embeddings are not covered by the
  generated `.gitignore` policy.
- accepted-only selection exists for procedural injection and skill verification
  but not for every agent-facing recall path.
- lifecycle promotion to `accepted` has no dedicated CLI/service transition.

These statements describe the baseline, not the target state.
