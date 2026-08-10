# Keryx Memory Reliability P1 — Pure Recall and Explicit Reports

Status: ready to freeze
Source: user description

## Problem

`MemoryService.search()` currently returns a legacy result containing report paths
and implicitly overwrites global `latest` artifacts. That violates the read-only
contract exposed by the CLI, harness, MCP, flow, and approval context. P0 froze
the defect as an opt-in failing purity gate.

## Expected Outcome

Default search is a side-effect-free ranked recall operation. Explicit report
publication is separately requested, bounded, schema-valid, unique per run, and
atomically published under the runtime memory root. All current consumers use the
pure result contract, while semantic reranking remains offline and fail-soft.

## Out of Scope

- P2 generated-data/Git migration and legacy artifact removal.
- P3 automatic-recall authority changes.
- P4 lifecycle/guarded canonical-entry write seam.
- P5 temporal/catalog consistency work and P6 documentation/final rollout.
