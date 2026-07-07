# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `gd-metapro flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `gd-metapro flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A shared guard helper in `src/security/` exposes an in-process seam (e.g. `guardOutput`/`redactRaw`) over `SecurityService`; it short-circuits to allow with zero side effects when the `security` module is disabled, and never prints raw sensitive content (only categories/counts/masked summaries).
- AC2: Mode semantics hold at the seam: in `advisory` mode the guard logs findings and returns allowed (never blocks); in `enforced`/`ci` mode a gate `fail`/`needs-approval` returns not-allowed with a reason.
- AC3: `memory ingest` calls the guard with target `memory` before writing accepted entries; a planted secret is blocked in enforced mode and allowed (with a warning) in advisory mode.
- AC4: `wiki collect` calls the guard with target `wiki` before writing a draft page; same advisory-vs-enforced behavior.
- AC5: `test` publish path runs a security check before writing raw/normalized logs; and `gdctx` redacts raw command output before persisting it so a secret in raw output does not land in a ctx artifact.
- AC6: In every seam, `advisory` mode (the default) does NOT change existing behavior or output — no write is skipped, reordered, or altered, and no additional file is created; blocking occurs only in `enforced`/`ci`.
- AC7: `flow complete` includes a `security` gate (mirroring the `health` gate): advisory → pass with an informational note; enforced/ci → may fail completion; the gate is skipped/omitted when security is disabled and does not block a normal advisory-mode `flow complete`.
- AC8: New integration tests cover, per seam, (a) advisory no-op (existing behavior + output unchanged), (b) enforced blocks a planted secret, (c) disabled = no-op; and the full pre-existing suite still passes unchanged. `bun run check` (typecheck + all tests) passes.
- AC9: Docs updated: `docs/requirements/security/{specification.md,README.md}` mark Phase 3 implemented (Phase 4 still future), `roadmap.md` reflects it, and `docs/docs` (modules/architecture) note the write-seam integrations; no doc↔code drift; nothing claims Phase 4 backends/gateway as done.
