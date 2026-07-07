# Implementation Plan

Status: ready

## Approach

Add one shared guard helper in `src/security/` and call it at each write seam.
Consumers depend on security (one-directional; no import cycle). The guard is a
thin wrapper over the existing `SecurityService.check`/`redact` so the engine
contract (Phase 1+2) is untouched. Advisory mode is a strict no-op on behavior —
it only logs and continues; enforced/ci mode blocks. If the module is disabled the
guard short-circuits to allow with zero cost.

## Steps

1. **T2 — Shared guard (`src/security/guard.ts`).** `guardOutput({cwd, content,
   target, source, path})` and `redactRaw({cwd, content, source})`. Reads config
   (disabled → allow immediately). advisory → run check, emit a concise warning
   line on findings, return `allowed:true` (+ `redacted`); enforced → `allowed:
   false` on gate fail/needs-approval with reason; ci → same as enforced for
   in-process callers (CLI exit codes already handled by the command layer).
2. **T3 — memory + gdwiki seams.** memory `ingest.ts`: guard accepted-entry writes
   with target `memory`; on block in enforced mode skip/annotate the entry and
   report the reason. wiki `service.ts`: guard `collect` draft writes with target
   `wiki`.
3. **T5 — testing + gdctx seams.** testing: guard raw/normalized publish before
   `writeRawLog`/`writeReport`. gdctx: `redactRaw` the raw output before it is
   persisted/summarized so secrets never land in ctx artifacts.
4. **T6 — flow completion gate.** Add a `security` GateOutcome to `flow complete`
   (mirror the `health` gate): run `security gate` over the flow's touched
   artifacts; advisory → informational pass; enforced/ci → can fail completion.
   Off unless security enabled.
5. **T3(test) — Integration tests.** Per seam: advisory does NOT block and output
   is unchanged (regression); enforced blocks a planted secret; disabled = no-op.
   `bun run check` green (existing 118 tests must stay green unchanged).
6. **T7 — Docs.** Update `docs/requirements/security/{specification.md,README.md}`
   (Phase 3 shipped), roadmap, docs/docs (modules/architecture note the seams),
   cli-reference where behavior changes are user-visible.
7. **T4 — Review + PR.** Review focus: (a) advisory never changes behavior; (b) no
   import cycles; (c) no new leak surface (guard must not print raw content); (d)
   enforced blocking is correct and reversible. Then draft PR → CI → complete.

## Risks

- **Behavior regression (top risk):** any seam that alters output/flow in advisory
  mode is a bug. Mitigation: advisory strictly logs+continues; run the full
  existing suite unchanged; add explicit "advisory does not block" tests.
- **Performance:** `check` on every write; keep it lazy (skip when disabled) and
  avoid re-reading config per call where a seam loops.
- **Leak via guard logging:** the warning line must reference categories/counts,
  never raw content (reuse the engine's masked summaries).
- **Flow gate coupling:** the security gate must be advisory-pass by default so it
  never blocks normal `flow complete` (only sensitive/enforced flows gate on it).
- **Scope creep:** no engine/detector changes; no Phase 4 backends.
