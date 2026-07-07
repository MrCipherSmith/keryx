# Context

Enriched by flow-orchestrator (Phase 1) from the spec + code.

## Spec

- docs/requirements/security/specification.md §6a (service contract), §7a (gate),
  §11 (integration points — the seams), §16 Phase 3.
- Security is now the 9th enabled module (flow 003, merged). Engine:
  `src/security/service.ts` `createSecurityService(cwd)` → `check(input)` /
  `redact(content, opts)`; `src/security/config.ts` `loadSecurityConfig(cwd)`
  gives `mode` (advisory|enforced|ci) + enabled state.

## Write seams (exact call sites)

- **memory** — `src/memory/ingest.ts`: accepted entries written at ~line 95 (and
  137). Guard with `check-output --target memory` before the write.
- **gdwiki** — `src/wiki/service.ts`: draft page written at ~line 92 (and 174 for
  new). Guard `collect` writes with `check-output --target wiki`.
- **testing** — `src/testing/service.ts`: `writeRawLog` (~117) / `writeReport`
  (~176) / `writeContext` (~90). Guard raw/normalized publish.
- **gdctx** — `src/commands/ctx.ts`: `writeArtifact({ raw: result.raw })` ~line
  122. Redact raw before persisting/summarizing.
- **flow** — `src/flow/service.ts`: completion gates array (~line 275). Add a
  `security` gate mirroring the existing `health` gate shape (GateOutcome).

## Design

- **Shared helper** in `src/security/` (e.g. `guard.ts`): `guardOutput({ cwd,
  content, target, source, path })` → `{ allowed: boolean, decision, redacted?,
  reason? }`. It: returns `allowed:true` immediately if security disabled;
  otherwise runs `createSecurityService(cwd).check(...)`; in advisory logs a
  concise warning + returns allowed:true (+ optional redacted content); in
  enforced/ci returns allowed:false on gate fail/needs-approval with reason. One
  helper → uniform semantics + one place to test the advisory invariant.
- Consumers import `src/security/*` (one-directional; security imports nothing
  from them — no cycles). gdgraph module-map confirms security has no inbound deps.

## Critical invariant

**Advisory mode (the default) must not change any existing behavior or output of
memory/wiki/testing/gdctx/flow.** All current tests must still pass unchanged.
Blocking only happens in enforced/ci mode. This is the #1 review focus.

## Baseline

- main @ 67a14ac; `bun run check` green (118 tests). Health gate: warn.
- Patterns: flow `health` gate (`src/flow/service.ts`) for the flow seam; existing
  module service style for the others.
