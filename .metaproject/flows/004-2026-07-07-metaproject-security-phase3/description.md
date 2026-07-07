# Metaproject Security Phase 3: write-seam integrations (advisory-by-default gates)

Status: formalized
Source: docs/requirements/security/specification.md §11 + §16 Phase 3

## Problem

Metaproject Security v0.1 (Phase 1+2) shipped the engine + `gd-metapro security`
command, but the spec's real enforcement value is §11: the `SecurityService.check`
call at each **write seam**. Today no consuming module calls security before a
side-effecting write, so `enforced`/`ci` mode cannot actually stop a risky write.
Phase 3 wires those seams.

## Expected Outcome (spec §16 Phase 3)

In-process `createSecurityService(cwd).check(...)` (or `.redact(...)`) at the
write seams named in §11, with a single shared helper so behavior is uniform:

- **memory** — `memory ingest` runs `check-output --target memory` before writing
  accepted entries.
- **gdwiki** — `wiki collect` runs `check-output --target wiki` before writing a
  draft page.
- **testing** — `test run`/`analyze` runs a security check before publishing
  raw/normalized logs.
- **gdctx** — `ctx` runs security redaction before persisting/summarizing raw
  command output.
- **flow** — a `security` gate is added to `flow complete` (and available before
  `implemented`) so a sensitive flow can require a clean security gate.

Mode semantics (spec §6a/§7a):
- **advisory (default)** — check, log/annotate, and CONTINUE. Existing behavior is
  unchanged; nothing is blocked. This is the critical invariant.
- **enforced** — a `fail`/`needs-approval` decision stops the controlled write with
  the reason.
- **ci** — a `fail` decision makes the command exit non-zero.

If the `security` module is disabled, every seam is a no-op (zero overhead, no
behavior change).

## Out of Scope

- **Phase 4** — optional model/API detection backends, `gateway` mode, the CI
  workflow gate wiring beyond exit codes.
- Changing detector rules or the engine's public contract (Phase 1+2 is frozen).
- gdskills learning-signal integration (§11 gdskills) — optional, deferred.
- Any redesign of the memory/wiki/testing/gdctx/flow modules beyond the minimal
  guard call at their existing write points.
