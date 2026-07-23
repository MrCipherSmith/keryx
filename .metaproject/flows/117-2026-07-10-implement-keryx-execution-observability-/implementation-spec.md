# Implementation Spec — Keryx Execution Observability

Date: 2026-07-10
Agent: flow-orchestrator v1.2.0

## What

Implement the requirements package as a standard, additive runtime capability
owned by a top-level execution run. The canonical run record is validated JSON;
Markdown, testing evidence, health evidence, and latest pointers are derived
views with explicit provenance and reliability.

## Why

The current repository has no runtime implementation behind the requirements
package, and its baseline already demonstrates a schema mismatch. The feature
must make observability trustworthy before it is used for Keryx/no-Keryx
comparison.

## Scope

In scope: provenance, event accounting, active/wall time, retry taxonomy,
immutable run artifacts, pointer freshness/mismatch checks, compatibility
readers, linked-worktree hooks, index guidance, baseline classification,
lightweight phase selection, and paired benchmark validation.

Out of scope: external CI execution, fabricated unavailable metrics, and a
performance conclusion.

## Acceptance Criteria

- [ ] A valid run record validates and renders from canonical JSON.
- [ ] Exact/estimated/unknown reliability is preserved for all metrics.
- [ ] Testing/health evidence is immutable per run and pointer-aware.
- [ ] Linked worktrees and baseline classification are regression-tested.
- [ ] Lightweight mode and benchmark readiness are bounded and honest.

## Approach

Build pure functions first in `src/metrics`, integrate through a thin CLI and
existing testing/health seams, then update templates/schema/docs. Legacy
reports remain readable by detecting both full-report and pointer JSON shapes.

## Test Strategy

Write Bun tests before each implementation slice, confirm RED for the intended
behavior, implement the minimum GREEN behavior, and run the full suite after
refactoring. No task is complete with failing tests.
