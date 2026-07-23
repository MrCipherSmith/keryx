# Implement Keryx Execution Observability standard capability

Status: draft until the flow is frozen
Source: user requirements package `docs/requirements/keryx-execution-observability/`

## Problem

Keryx currently has an opt-in prose Execution Metrics rule but no runtime-owned
canonical run record, event accounting, provenance-aware evidence lifecycle, or
comparable baseline/benchmark contract. Existing testing and health latest
artifacts can be stale or belong to another worktree, hooks assume a directory
`.git`, generated guidance mentions an unavailable `keryx index refresh`, and
`standard validate` reports a baseline schema defect as though it were a PR
regression.

## Expected Outcome

Implement the package as an additive standard capability: validated canonical
JSON run records with exact/estimated/unknown labels, canonical Markdown views,
runtime event aggregation, immutable testing/health evidence and latest
pointers, worktree-safe hooks, consistent refresh guidance, baseline-aware
classification, bounded lightweight mode, and a reproducible paired benchmark
harness. Existing Markdown reports and flow/job/docpack artifacts remain
readable and direct-user metrics opt-in remains owned by the top-level caller.

## Out of Scope

- Fabricating token, cost, model, or unavailable timing values.
- Claiming Keryx is faster before comparable paired measurements exist.
- Replacing health, testing, graph, security, flow, or job systems with a
  parallel framework.
- Having dispatched subagents ask the opt-in question or publish root reports.
