# Implementation Plan

Status: formalized

## Approach

Follow `docs/requirements/slate/specification.md`'s v3 section exactly —
this flow implements an already-written, already-reviewed spec, not a new
design. Reuse existing patterns rather than inventing new ones:
`sac.workspaceCreate`'s stateless-MCP-tool-with-storage-side-effect shape
for the new `slate.*` tools, `src/session/slate.ts`'s `readSlate`/
`writeSlate` under `withFileLock` for the new `external-slate.ts` storage,
and `resolveMachineWrapUp`'s existing `"flow"`-source branch shape
(`src/sac/machine-wrap-up.ts`) for the new `"external-slate"` branch.

## Steps

1. **Storage.** `src/session/external-slate.ts`: `ExternalSlate` type
   (`externalSessionId`, `workspaceId?`, `anchors: { root, touched?, note? }`,
   `seeds: SlateSeed[]`, `lastWriteAt`), `readExternalSlate`/
   `writeExternalSlate` under `withFileLock`, path
   `.keryx/external-slates/<externalSessionId>.json` (project-scoped,
   non-`.metaproject/`, non-git-tracked — add to `.gitignore` if not already
   covered by an existing `.keryx/` ignore rule).
2. **Seed provenance type.** `SlateSeed` (`src/session/slate.ts`) gains
   optional `origin?: { harness: string; sessionRef?: string }` and
   `trust?: "external-unverified"`. `slate_write_seed` (SLATE-3a,
   `src/harness/tool/builtin/slate-tool.ts`) auto-fills
   `origin: { harness: "keryx" }`, no `trust` field — existing keryx-native
   behavior otherwise unchanged.
3. **Idle-TTL reclaim.** A helper (reuse `withFileLock`'s existing
   stale-lock threshold constant from `src/lib/fs.ts` — do not invent a new
   one) that checks `lastWriteAt` on every external slate under a `cwd` and
   auto-closes (via step 5's dispatch path) any that are stale, invoked at
   the top of all three `slate.*` MCP handlers before the requested
   operation proceeds.
4. **MCP tools.** `src/mcp/tools.ts`: `slate.open` (`externalSessionId`,
   `workspaceId?`, `anchors?`), `slate.writeSeed` (`externalSessionId`,
   `text`, `kind?`), `slate.close` (`externalSessionId`) — module `slate`,
   local-stdio only (`context?.transport === "http"` denied, matching
   `sac.*`). `slate.open` is idempotent per id. Omitted `workspaceId` calls
   the existing SLATE-16 resolve-or-create procedure
   (`src/sac/workspace-resolve.ts`) — do not reimplement it.
5. **Wrap-up dispatch.** `WrapUpSource` (`src/sac/trusted-wrap-up.ts`) gains
   `"external-slate"`. `src/sac/machine-wrap-up.ts`'s `resolveMachineWrapUp`
   gains a branch reading `ExternalSlate.anchors`/`.seeds` (step 1) instead
   of a keryx `sessionDir()`. `slate.close` calls this branch when
   `workspaceId` is bound (mirrors SLATE-18's autonomous `workspace_propose`
   call exactly), else writes an `unbound-candidate` artifact via the
   existing SLATE-1/SLATE-10 path.
6. **Review UI.** CLI `workspace review` (`src/commands/workspace.ts`) and
   the TUI review modal render `origin.harness` next to each Seed in a
   proposal's evidence, when present.
7. **Tests** (written before step 2-6's implementation per
   `tdd-workflow.mdc` — see tasks.md T1 before T2): cross-hand isolation
   (AC-34 — direct filesystem assertion, not only tool-response inference),
   `slate.open` idempotency (AC-35), Anchors never enriched (AC-36), Seed
   provenance always present (AC-37), no `propose` without bound
   `workspaceId` (AC-38), idle-TTL reclaim without a daemon (AC-39), non-goal
   preservation (AC-40).

## Risks

- **Prompt injection via external Seeds** — mitigated by the existing
  human-gated `workspace review` (unchanged) plus visible `origin.harness`;
  not eliminated (see PRD v3 Risks — explicit non-goal to build a trust
  model here).
- **Cross-hand isolation must be tested against the real filesystem**, not
  only against tool call responses — a bug that only manifests as a shared
  file path would pass a response-only test.
- **`.keryx/external-slates/` must never be git-tracked** — verify
  `.gitignore` coverage as part of step 1, not an afterthought.
