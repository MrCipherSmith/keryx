# Slate v3 (SLATE-22..26): private MCP slate lifecycle for external hands

Status: formalized
Source: `docs/requirements/slate/prd.md`/`specification.md`/`agent-protocol.md`/
`implementation-plan.md` v3 sections (this repo's own requirements package,
already committed on branch `slate-v3-external-hand-mcp`, PRs pending).

## Problem

keryx + Metaproject are meant to be a shared "core" that keryx TUI, keryx
CLI, Claude Code, Codex, and other agent harnesses use identically as
"hands". SAC workspace already works this way today (`sac.workspaceList/
Show/Create`, `sac.propose`, `sac.review` — stateless MCP tools, no keryx
session required). Slate (Anchors/Course/Seeds) does not: it only exists as
keryx's own in-process session state (`src/session/slate.ts`), opened only
by `commands/agent.ts`/`tui-shell.ts`/`spawn-subagent-tool.ts`. An external
MCP client (Claude Code, Codex) has no way to keep its own task-local
working memory (what it's done, what it's doing, draft hypotheses) the way
keryx's own runtime does for itself, and no way to dispatch that memory into
the already-shared SAC workspace on task completion.

## Expected Outcome

- Three new MCP tools, `slate.open`/`slate.writeSeed`/`slate.close`
  (module `slate`), let any MCP-connected external hand open its own
  private, task-local slate, write draft Seeds into it, and close it.
- Each external hand's slate is scoped to `(cwd, externalSessionId)` and is
  never readable/writable by a different `externalSessionId` — the
  project's existing recorded non-goal ("no shared open slate between
  clients", `docs/requirements/slate/README.md`) is preserved exactly, not
  narrowed or reversed (this is a hard acceptance criterion, AC-40).
- Anchors on an external-hand slate are exactly what the calling hand
  self-reports (`root`/`touched`/`note`) — keryx never computes/enriches
  them for a process it doesn't control (distinct from SLATE-2's
  keryx-native Anchors, which are unchanged).
- Every Seed written via `slate.writeSeed` carries a server-set
  `origin: { harness, sessionRef }` and `trust: "external-unverified"` —
  the caller cannot override either field — visible to a reviewer in the
  eventual proposal's evidence.
- `slate.close` with a bound `workspaceId` dispatches into the existing SAC
  `propose`/`review` pipeline via a new `WrapUpSource === "external-slate"`
  branch on the already-implemented `resolveMachineWrapUp`
  (`src/sac/machine-wrap-up.ts`) — no new review authority, same
  human-gated accept path (SLATE-9/SLATE-20, unchanged). Without a bound
  `workspaceId`, evidence is preserved as a local `unbound-candidate`
  artifact (existing SLATE-1/SLATE-10 path), never silently discarded.
  `slate.open` with no explicit `workspaceId` triggers the existing
  SLATE-16 resolve-or-create procedure — not a new one.
- An external-hand slate whose `lastWriteAt` exceeds the existing
  `withFileLock` stale-lock threshold is auto-closed (dispatched or
  `unbound-candidate`) on the next `slate.*` call touching that project —
  no background timer/daemon.

Full requirement text: `docs/requirements/slate/prd.md` v3 addendum
(SLATE-22..26), `specification.md` v3 functional surface / data contracts /
MCP surface / AC-34..40, `agent-protocol.md` "External-hand protocol".

## Out of Scope

- SLATE-21 (machine-evidence wrap-up) — already implemented
  (`src/sac/machine-wrap-up.ts`, PR #314). Nothing to do here.
- Any change to keryx-native Slate (SLATE-1..21) behavior — this flow is
  strictly additive.
- Trust *scoring* or auto-rejection of external Seeds (`trust:
  "external-unverified"` is informational only, per spec's Permission model
  section) — explicit non-goal, owned by a future RP-06 if ever built.
- A `slate.list`/`slate.read` endpoint spanning multiple
  `externalSessionId`s — never added, structurally enforces AC-40.
