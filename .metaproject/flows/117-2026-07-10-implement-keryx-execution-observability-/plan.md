# Implementation Plan — Keryx Execution Observability

Date: 2026-07-10
Agent: flow-orchestrator v1.2.0

## What

Add an additive `metrics` capability to Keryx with a runtime-validated
execution-run contract, provenance, event aggregation, canonical JSON/Markdown
rendering, immutable evidence pointers, reliability helpers, bounded lightweight
profile selection, and benchmark validation utilities. Integrate it with
existing testing/health reports and hook/template/standard behavior without
breaking legacy readers.

## Why

The requirements package defines observability as a standard capability and
explicitly requires claims to be verified against source and tests. Current
metrics are prose-only and cannot distinguish exact values from reconstruction,
stale artifacts, baseline failures, or environment pauses.

## Scope

**In scope:**

- Phases 1–5 from `implementation-plan.md`.
- TDD tests for schema/provenance, accounting, lifecycle/latest, hooks,
  baseline classification, lightweight mode, and benchmark validation.
- Additive compatibility readers for existing testing/health Markdown/JSON.
- Requirements package updates only where implementation establishes a changed
  contract or verification status.

**Out of scope:**

- Invented model/token/cost measurements.
- External CI/GitHub execution or a speed claim.
- Product choice of the benchmark task corpus; retain a flow blocker/question
  if the repository cannot determine representative tasks.

## Approach

1. Create a focused `src/metrics` module containing types, schema validation,
   provenance collection, event accounting, stable serialization, renderers,
   lifecycle storage, latest-pointer validation, lightweight planning, and
   paired benchmark validation.
2. Expose the capability through `keryx metrics` and update the CLI/module
   guidance. Keep top-level ownership explicit; child runs only link to the
   parent and never prompt or write a competing root report.
3. Extend testing and health writers with optional run-scoped provenance and
   immutable `runs/` records; make loaders understand both pointer and legacy
   full-report `latest.json` shapes.
4. Make managed hook paths resolve the Git common directory and remove the
   unsupported generated `keryx index refresh` instruction.
5. Fix the manifest capability schema mismatch and add pure baseline/pr
   classification so CI can distinguish baseline-red from PR-introduced.
6. Add a reproducible benchmark harness that validates paired run manifests but
   does not infer a performance winner.

## Test Strategy

Use Bun tests first (RED), then minimal implementation (GREEN), then refactor.
Cover pure module contracts with unit tests and existing init/testing/health
integration seams with temporary Git worktrees and fixture artifacts. Run
focused tests, full `bun test`, typecheck, build, standard validation, health,
security, documentation/package checks, and a final diff review.

## Execution Tracking

- [ ] Context and affected set recorded
- [ ] Provenance/schema/accounting implemented test-first
- [ ] Artifact lifecycle and integration implemented test-first
- [ ] Hooks/index/baseline reliability implemented test-first
- [ ] Lightweight and benchmark readiness implemented test-first
- [ ] Full verification and review complete
