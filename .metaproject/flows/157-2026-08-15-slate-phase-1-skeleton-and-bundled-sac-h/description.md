# Slate Phase 1: Skeleton and bundled SAC hardening

Status: frozen
Source: approved roadmap — `docs/requirements/slate/phase-execution-prompts.md` §1,
`docs/requirements/slate/specification.md` (SLATE-1, SLATE-3 bundled fix,
SLATE-12, SLATE-14), `docs/requirements/slate/agent-protocol.md`.

## Problem

The Slate feature (task-local Anchors/Course/Seeds execution state layered in
front of the existing Shared Agent Context workspace) has no storage skeleton
yet. Separately, three defects exist in today's real SAC code paths that
Slate's design calls out as pre-existing and worth fixing now, independent of
Slate's own feature work:

1. `keryx workspace propose` always records `security.gate: "pass"` on a
   newly created proposal (`src/sac/proposal-lifecycle.ts:59`) with no scan
   ever run — `detectSecrets`/`detectPii` exist (`src/security/detect/*`) but
   are never called from this path.
2. `createLocalFwkReadService`'s flow-read (`src/sac/fwk-service.ts`, the
   `work` IIFE inside its `source` composition) has no try/catch: a deleted,
   archived, malformed, or permission-denied flow file throws uncaught and
   breaks the whole Facts+Work+Know-how assembly for `workspace
   overview`/`workspace read` today, not just Slate's future Course reads.
3. The comment on `createLocalProposalLifecycleService`
   (`src/sac/proposal-lifecycle.ts:205-206`) claims this composition is what
   lets "Local CLI/stdin MCP" record proposals but "can never self-accept" —
   but `src/commands/workspace.ts` and `src/mcp/tools.ts` never call
   `createLocalProposalLifecycleService` at all; both exclusively use
   `createHarnessProposalLifecycleService`. The comment misrepresents a
   protection that isn't actually in the real request path.

## Expected Outcome

- `src/session/slate.ts` exists: a lock-protected storage skeleton for the
  future `Slate` data contract — `readSlate`/`writeSlate` (read-modify-write
  under a single `withFileLock` hold, so two same-turn writers never lose
  data to a race) over a `slate.json` sibling file inside the existing
  `sessionDir()`, plus an archive-on-close primitive that moves a prior
  unclosed `slate.json` to `slate-archive/<attemptId>.json` before any new
  attempt's first write — never a silent overwrite. This phase builds and
  tests the storage primitive only; wiring it into the agent loop's
  open/close lifecycle is Phase 2 (SLATE-5).
- Every SAC proposal created via `ProposalLifecycleService.create()` carries
  a `security.gate` computed from a real `detectSecrets`/`detectPii` scan of
  its evidence content, never the hardcoded `"pass"` literal.
- `createLocalFwkReadService`'s flow-read failure path is fixed at the
  source (`fwk-service.ts`), not only for Slate's future Course read: any
  failure resolving/parsing the flow resource yields `unbound` `work`,
  never an uncaught exception.
- The misleading self-accept comment on `createLocalProposalLifecycleService`
  is corrected to state what the code actually guarantees and who actually
  calls it.

## Out of Scope

- Populating `Slate.anchors`/`course`/`seeds` with real content, `/goal`,
  `slate_read`/`slate_write_seed` tools, subagent ephemeral slate, wrap-up
  composer, unattended `interactive` gating (`--unattended` flag) — all later
  phases (2–5) per `docs/requirements/slate/phase-execution-prompts.md`.
- Any change to `security.gate` literals elsewhere in
  `proposal-lifecycle.ts` (the acceptance-transition/write-intent/
  review-decision `security` blocks at lines ~140/170/183) — those record a
  policy-gate decision, not an evidence-content scan, and are not named by
  SLATE-12/AC-12 (which target the proposal's own `security.gate` set at
  `create()`, `proposal-lifecycle.ts:59`).
- Anything in `sac-workspace-lifecycle`'s parallel PR #296
  (`archive`/`removeResource`/`rename` guards, `guard_denied` on `create()`)
  — that branch is not merged into `main` yet and this worktree was created
  from `main` before it; any eventual merge conflict is resolved by a human,
  not this flow.
