# Keryx Slate — Implementation Plan
Version: 2.0.0

## Delivery status

**Corrected 2026-08-21, twice in the same session.** This section originally
read "Design-only as of 2026-08-16. No phase below has landed" — stale. A
first correction pass then asserted SLATE-21 specifically was **not**
implemented, based on a `find`/`grep` pass that failed to locate
`src/sac/machine-wrap-up.ts` (the command returned no match; this was not
re-verified by reading the file directly before the claim was written) —
that correction was itself wrong and is retracted here, one revision later.

Verified against code on `main` (`c47e8f0`) by directly reading the source,
not by filename search: **all of Phases 1–5 (SLATE-1…15) and SLATE-16
through SLATE-21 are implemented.** `src/sac/machine-wrap-up.ts` (588 lines)
implements `resolveMachineWrapUp`/`runWrapUp` for `WrapUpSource === "flow"`
(SLATE-7); `src/sac/session-wrap-up.ts` imports `courseStatusLine`/
`dedupedAttributedSeeds`/`diffStatLine`/`gitDiff` from it and uses them as
`resolveSessionWrapUp`'s **primary** evidence (`evidence[0]`/`evidence[1]`),
with the full transcript export demoted to `evidence[2]`, a reference —
exactly SLATE-21's spec. This was confirmed merged via `gh pr view 314`
(state `MERGED`, `mergedAt: 2026-08-17T12:16:20Z`, title "feat(sac):
SLATE-20 review confirm-token + SLATE-21 machine wrap-up evidence") and
corroborated by flow 166's own journal
(`.metaproject/flows/166-2026-08-17-slate-v2-slate-16-21-auto-workspace-bind/journal.md`),
which recorded `AC2: SLATE-21 ... landed in PR #314` at the time. **v1/v2 of
this package (SLATE-1…21) are fully implemented; nothing here is a gap.**
Do not re-assert non-implementation for any of SLATE-1…21 without reading
the actual source file content first — a failed/empty search result is not
evidence of absence, only of a search that didn't find something (this
session's own error, twice: first "design-only" from a stale doc read,
then "SLATE-21 missing" from an unverified failed `find`).

This plan is derived from the dependency graph in
`docs/requirements/slate/specification.md` (every SLATE-N cross-reference
already states its own dependency in text — this plan does not invent new
ordering, it sequences what the spec already requires).

## Delivery rules

Every phase is a separate managed Flow with frozen acceptance criteria,
following the same discipline as the already-implemented `shared-agent-context`
package (`docs/requirements/shared-agent-context/implementation-plan.md`).
No phase may claim delivery before its AC pass. Phase 2's two halves
(SLATE-5 open/close and SLATE-8 unattended gate) are **one Flow, not two** —
the spec states explicitly that fixing one without the other removes the
last manual barrier before the other's automated trigger fires; splitting
them into separate Flows would ship an intermediate state worse than either
endpoint.

Phase 5 has an external prerequisite: [`sac-workspace-lifecycle`](../sac-workspace-lifecycle/implementation-plan.md)'s
WSL-1/WSL-2 must be merged first — SLATE-10/SLATE-13's `listVisibleProposedProposals`
depends on `WorkspaceService.archive()`/the archived-bypass `list()` variant
existing. `sac-workspace-lifecycle` has no dependency on slate in the other
direction and may run as a fully parallel track starting immediately,
alongside Phase 1.

## Phase 1 — Slate skeleton & bundled SAC hardening

- Implement `src/session/slate.ts`: `readSlate`/`writeSlate` under
  `withFileLock`, `slate.json` sibling file in `sessionDir()`, archive-on-close
  to `slate-archive/<attemptId>.json` (SLATE-1).
- Wire `detectSecrets`/`detectPii` into `proposal-lifecycle.ts`'s evidence
  path before persistence, replacing the hardcoded `security.gate: "pass"`
  (SLATE-12 — bundled SAC fix, not slate-exclusive).
- Fix the misleading "can never self-accept" comment on
  `createLocalProposalLifecycleService` (SLATE-14 — bundled SAC fix).
- Wrap the flow-read in `createLocalFwkReadService` in try/catch, yielding
  deterministic `unbound` on any read failure instead of an uncaught throw
  (SLATE-3's bundled fix — independent of the rest of Course).

**Exit:** AC-5, AC-12 (SLATE-12's scan is real, not asserted); a fork/restart
never sees a carried-over `slate.json` (AC-1, partial — Anchors don't exist
yet, but the storage/lock skeleton and archive-on-fork behavior are
testable); `unbound` is returned, not thrown, on any flow-read failure.

## Phase W (parallel) — SAC Workspace Lifecycle Completion

Not a phase of this package — see
[`sac-workspace-lifecycle/implementation-plan.md`](../sac-workspace-lifecycle/implementation-plan.md).
Runs as an independent Flow from day one; must merge before Phase 5 starts
here.

## Phase 2 — Anchors, Course, Seeds & the unattended checkpoint

- Anchors: harness-owned root/tree/runtime/touched/fence, populated from
  `resolveProjectRoot()` + worktree-resolve, always rebuilt (never restored)
  on crash/resume/fork (SLATE-2).
- Course: `flowRef`-pointer only, live `FwkWork` projection, no stored
  content (SLATE-3, feature half).
- Seeds: append-only, optional `kind` tag, exact-text dedup only (SLATE-4,
  AC-23).
- Open/close lifecycle: extended `isActionRequest`, attempt-scoped archive
  on re-open in the same session dir (SLATE-5, AC-22).
- **Same Flow, not a follow-up:** wire the existing `interactive: boolean`
  context field into `authorizeSacUse`/`ProposalLifecycleService.review()`;
  deny `accept` whenever `interactive === false`; add the `--unattended`
  boolean flag to `src/commands/harness.ts` (SLATE-8).

**Exit:** AC-1 (full — Anchors now exist), AC-2, AC-22, AC-23; AC-10
(`accept` denied for any `interactive: false` session, including every
`keryx serve` turn unconditionally); a session cannot flip its own
`interactive` field at runtime (agent-protocol required test).

## Phase 3 — Consult surface & deterministic entry

- Anchors auto-inject: `renderAnchorsBlock`, bounded via `assembleContext`,
  delivered as a harness-injected history message on harness effects — not
  baked into the static `orient` block (SLATE-2a).
- `slate_read`/`slate_write_seed` explicit tools, mirrored on
  `workspace-context-tool.ts`'s shape (SLATE-3a).
- `/goal <text> [--workspace <id>]` shell command + `keryx harness run
  --goal ... --workspace ... [--unattended]` CLI flags; explicit
  `--workspace <id>` validation, never auto-creates a workspace (SLATE-15).
- Structured `TerminalState` emission on `ask_user`/budget exhaustion in
  place of `finishWithBudgetSummary`'s free-text history push (SLATE-11,
  AC-21).

**Exit:** AC-18 (`/goal --workspace` fails closed on an invalid/invisible
id); AC-21 (no leaked `Do NOT call tools.`-style instruction persists into
later turns); Anchors visibly update mid-session without a `slate_read`
call; Course/Seeds are reachable only via the explicit tool.

## Phase 4 — Ephemeral subagent slate & wrap-up composer

- Full child slate (Anchors+Course+Seeds) scoped to dispatch; two
  independent handoff channels on return — work-result unchanged
  (`foldChildSummary`), slate-state as a tagged, non-merged
  `parent.slate.childDispatches[dispatchId]` entry (SLATE-6).
- `resolveMachineWrapUp` under the `WrapUpSource === "flow"` branch; model
  summary via `runModelTurn`, fail-closed on missing credential,
  bounded-timeout mechanical fallback on a slow-but-present credential;
  evidence attempt-scoped; Seeds grouped by `kind`, one `propose` per
  non-empty group; triggers on Flow-complete, explicit human command, or
  one-shot `keryx harness run`/`--goal` process termination (never REPL)
  (SLATE-7).

**Exit:** AC-3, AC-4, AC-6, AC-7, AC-8, AC-9, AC-15, AC-19, AC-20 — this
phase is where most of the package's acceptance criteria converge, since
SLATE-7 consumes nearly everything built in Phases 1–3.

## Phase 5 — Catch-up review & general-purpose listing (implemented)

**Was blocked on Phase W (`sac-workspace-lifecycle` WSL-1/WSL-2) merging
first; both have since merged** — `keryx workspace catch-up`/`list-proposals`
exist in `src/commands/workspace.ts`, backed by `src/sac/catch-up.ts`.

- `listProposedProposals(workspaceId)` + ACL-wrapped
  `listVisibleProposedProposals(actor)` (built on WSL-2's archived-bypass
  `list()` variant), `isLockHeld` read-only helper, two new optional
  `SessionSummary` fields (`runMode`, `courseStatus`), `keryx workspace
  catch-up` command with four hard-separated categories (SLATE-10).
- `keryx workspace list-proposals [<workspace-id>]` standalone command
  (SLATE-13).

**Exit:** AC-5 (SAC's) / WSL's AC-5 (archived workspaces never silently drop
out of discovery); AC-11 (four-category separation, freshness re-check
before display); AC-13 (corrected reading — SLATE-10 doesn't build archive
itself but must see through it); AC-14 (cwd-scoped v1, cross-project
explicitly deferred).

## Phase 5b — Finish SLATE-7's machine evidence (SLATE-21) — already done

**Retracted as a phase.** SLATE-21 is implemented (`src/sac/
machine-wrap-up.ts`, `src/sac/session-wrap-up.ts` — see Delivery status
above). No work remains here; this heading is kept only so a reader
following this plan's history understands why Phase 6 no longer lists a
dependency on it.

## Phase 6 — External-hand slate MCP exposure (v3, SLATE-22…26)

**Depends on:** nothing external — `resolveMachineWrapUp`
(`src/sac/machine-wrap-up.ts`, SLATE-7/21) already exists and is already the
target SLATE-25 adds an `"external-slate"` branch to. All of SLATE-22…26 can
be built as one Flow with no landed-elsewhere prerequisite.

- `src/session/external-slate.ts`: `ExternalSlate` storage under
  `.keryx/external-slates/<externalSessionId>.json`, `withFileLock`-guarded,
  same lock/archive discipline as `src/session/slate.ts` (SLATE-22).
- `src/mcp/tools.ts`: `slate.open`/`slate.writeSeed`/`slate.close`, module
  `slate`, local-stdio only, mirroring `sac.workspaceCreate`'s registration
  shape exactly (SLATE-22). `slate.open`'s no-`workspaceId` path calls
  SLATE-16's existing resolve-or-create procedure, not a new one.
  `slate.writeSeed` server-sets `origin`/`trust`, never caller-suppliable
  (SLATE-24).
- `anchors` param on `slate.open`/`slate.writeSeed`: stored verbatim by
  `external-slate.ts`, no harness-side computation (SLATE-23).
- `SlateSeed` type gains `origin`/`trust` fields (`src/session/slate.ts`);
  `slate_write_seed` (SLATE-3a, keryx-native) auto-fills
  `origin: { harness: "keryx" }`, no `trust` field (SLATE-24). CLI
  `workspace review` / TUI review modal render `origin.harness` per Seed.
- Idle-TTL check (reusing `withFileLock`'s existing stale threshold,
  `src/lib/fs.ts`) invoked at the top of all three `slate.*` handlers before
  the requested operation proceeds (SLATE-26).
- `WrapUpSource` (`src/sac/trusted-wrap-up.ts`) gains `"external-slate"`;
  `resolveMachineWrapUp` (Phase 5b) gains a branch reading
  `ExternalSlate.anchors`/`.seeds` instead of a keryx `sessionDir()`;
  `slate.close` invokes it exactly like SLATE-18's autonomous
  `workspace_propose` when `workspaceId` is bound, else writes an
  `unbound-candidate` artifact via the same SLATE-1/SLATE-10 path (SLATE-25).

**Exit:** AC-34 through AC-40 — cross-hand isolation verified directly
against the filesystem (not only tool responses), idempotent `slate.open`,
caller-supplied Anchors never enriched, every dispatched external Seed
carries `origin`/`trust`, no `propose` without a bound `workspaceId`, idle
external slates reclaimed without a daemon, and the pre-v3 non-goal
verified still holding (AC-40 — a dedicated cross-hand-isolation test, not
an inference from the other AC's passing).

## Definition of done

AC-1 through AC-33 (v1/v2 scope) already pass per this document's verified
Delivery status. For v3, the package is done only when AC-34 through AC-40
all pass; `sac-workspace-lifecycle` is merged (already the case); and no
phase's exit criteria were claimed before its tests and the target modules'
own test suites (`src/sac/*.test.ts`, `src/session/*.test.ts`,
`src/harness/**/*.test.ts`, new `src/mcp/sac-tools.test.ts`/equivalent
coverage for `slate.*`) pass green.
