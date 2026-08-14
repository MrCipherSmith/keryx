# Shared Agent Context Runtime Truth
Version: 0.1.0

## Purpose

This package defines the corrective contract that makes the Shared Agent
Context (SAC) FWK read path tell the truth about what it selected, why it was
selected, how much it cost, how fresh it is, and what a progressive detail read
actually returned.

## Status

`specification ready (future)`. The repository contains an implemented SAC read
path, Context Operations assembly, receipts, CLI/MCP/shell adapters, and an
opt-in policy experiment. The requirements in this package are not claimed as
implemented. They correct verified semantic gaps described in the source
analysis.

## Documents

- [Package index](README.md)
- [PRD](prd.md) — problem, users, requirements, success criteria, and risks.
- [Specification](specification.md) — retrieval-plan, FWK, freshness, receipt,
  and public-surface contracts.
- [Metrics and validation](metrics-and-validation.md) — fixed corpus, metrics,
  falsifiers, and rollout gates.
- [Implementation plan](implementation-plan.md) — bounded delivery phases and
  rollback order.

## Scope

- An independently computed deterministic retrieval plan.
- Actual application of plan-selected IDs to Context Operations assembly.
- Explicit mandatory-core and ranked-optional semantics.
- Stable opaque item identity across resource reordering.
- Real bounded progressive detail reads.
- Revision-aware `fresh`, `changed`, `stale`, `expired`, and `untracked` states.
- Measured or explicitly unknown token, time, tool, and storage cost.
- Metadata-only explanation, replay, and drift inputs.
- Semantic parity across CLI, stdio MCP, and shell tools.

## Non-goals

- A learned ranking model or online policy update.
- New authorization, role, or security-gate authority.
- A second Flow tracker or SAC-owned durable knowledge store.
- Remote SAC transport, multi-tenant identity, or UI.
- Copying raw source bodies into receipts or traces.

## Related modules and packages

- [Shared Agent Context](../shared-agent-context/README.md)
- [Keryx Context Operations](../keryx-context-operations/2026-07-12/README.md)
- `src/sac/fwk-service.ts`
- `src/ctx/assembly.ts`
- `src/commands/workspace.ts`
- `src/mcp/tools.ts`
- `src/harness/tool/builtin/workspace-context-tool.ts`
- Future packages: source-owned FWK projections, lifecycle binding, receipt
  operability, and evaluation/orchestration.
