# Keryx Slate — Specification
Version: 2.0.0

## Identity and ownership

| Concern | Owner | Slate responsibility |
|---|---|---|
| Task-local execution state (this session, right now) | `src/session/*` + harness | Anchors/Course-pointer/Seeds, read/write only within own session dir |
| Reviewed shared context | `src/sac` (workspace) | Consulted read-only at slate open; sole write target at wrap-up |
| Work status and acceptance criteria | Flow | Slate never writes; Course only re-projects |
| Knowledge acceptance | Existing SAC `propose`/`review` + guarded owner-writers | Unchanged; slate supplies only the wrap-up candidate's raw material |
| Session↔workspace↔Flow automatic binding | Slate v2 (SLATE-16…19) — see below | Slate v2 resolves/creates via model judgment (`workspace_list` + own assessment), no new ACL/binding-record service; RP-03 retains what v2 does not touch: `keryx shell --workspace <id>` explicit selection, `--session current` resolution, Flow/worktree derivation preview, accepted-target link-back — see [RP-03](../shared-agent-context-lifecycle-binding/README.md) |
| Evidence sealing/scanning/minimisation | [SAC RP-05](../shared-agent-context-secure-evidence/README.md) (future) | Slate v1 calls existing `detectSecrets`/`detectPii` as an interim gate |
| Execution identity / continuous authorization | [SAC RP-06](../shared-agent-context-identity-capabilities/README.md) (future) | Slate v1 reuses the existing `unattended-untrusted` harness profile as an interim gate |
| TTL reservations / "in review by" signal | [SAC RP-08](../shared-agent-context-collaboration-worktrees/README.md) (future) | Slate v1 catch-up (SLATE-10) does not build its own reservation mechanism |

## Future storage structure

```text
<sessionDir>/
  summary.json           # existing; gains two optional fields: runMode?, courseStatus?
  context.jsonl           # existing
  archive.jsonl            # existing
  slate.json               # new — workspaceId?, anchors { root, tree, runtime, touched, fence },
                            #       course { flowRef },
                            #       seeds [ { id, text, ts } ],
                            #       childDispatches { [dispatchId]: { anchors, course, seeds, status: completed|incomplete } }
  slate-archive/<attemptId>.json   # written on close, before a new slate opens in the same session dir
```

No new lock mechanism beyond reuse: `slate.json` is written under `withFileLock`
(`src/lib/fs.ts`), not bare `writeFileAtomic` — two writers exist per turn
(harness writes Anchors, model writes Seeds). Slate is deleted with the
session; nothing here is ever copied into `.metaproject/`.

`keryx sessions fork` (`src/session/store.ts` `forkSession()`) creates no
`slate.json` for the new session — the fork opens with a fresh, empty slate,
exactly as a brand-new session would. This mirrors `forkSession()`'s existing
convention of copying only raw transcript (`context`/`archive`) plus explicit
identity fields (`title`/`provider`/`model`), never derived/computed session
state (`messageCount` etc. are recomputed, not copied) — the same principle
AC-1 already states for Anchors. No code path may special-case fork to carry
`slate.json` across.

## Functional surface

| ID | Function | Implementation proposal |
|---|---|---|
| SLATE-1 | Storage & lifecycle | `src/session/slate.ts`: `readSlate`/`writeSlate` under `withFileLock`; archive-on-close to `slate-archive/<attemptId>.json` |
| SLATE-2 | Anchors | Populate from existing `resolveProjectRoot()` + worktree-resolve at spawn/tool-exec time; harness-write-only |
| SLATE-2a | Anchors auto-inject | `renderAnchorsBlock(slate.anchors)` in `src/session/slate.ts`, bounded via the existing `assembleContext` (`src/ctx/assembly.ts`, the same budget primitive `FwkReadService.overview()` already uses) with an explicit `maxTokens`; delivered as a harness-injected `role:"user", provenance:"project"` history message (the pattern already used for the repeated-failure hint and budget-exhausted wrap-up, `src/commands/agent.ts:718-724`/`905-914`), pushed immediately after a harness effect that changes `anchors.touched`/`tree`/`runtime` (tool call completed, worktree resolved, `/model` switch, subagent spawn/return) — **not** baked into the static `systemInstruction`/`orient` block (`src/ctx/orient.ts`, `src/commands/shell.ts:1404-1406`), which is computed once per session and never updates |
| SLATE-3 | Course | Store `flowRef` only; render via existing `FwkWork` builder (`src/sac/fwk-service.ts`) / `keryx flow status`; wrap flow-read in try/catch — any failure (deleted/archived flow) → deterministic `unbound`, never an uncaught throw. **Bundled SAC fix**: this try/catch belongs in `createLocalFwkReadService` itself, fixing a pre-existing crash risk in today's `workspace overview`/`workspace read`, not only Course's read path |
| SLATE-3a | Course/Seeds explicit read | `slate_read`/`slate_write_seed` harness tools mirrored on `workspace-context-tool.ts:31-81` (`workspace_overview`/`workspace_read`'s shape) — explicit agent-pulled, **not** auto-injected: Course is a projection needed at consult/pre-wrap-up, not every round; Seeds is write-mostly (model appends, no round-by-round read-back need) |
| SLATE-4 | Seeds | Append-only; dedupe pass before wrap-up; optional per-Seed `kind` tag (`ProposalKind`), untagged defaults to `follow-up` at wrap-up grouping time |
| SLATE-5 | Open/close | Extend `isActionRequest` (`src/commands/agent.ts:228`) token set; close on flow done/explicit phrase/`/new`/shell exit |
| SLATE-6 | Subagent ephemeral slate (full, two-channel) | Work-result channel unchanged (`foldChildSummary`/`quarantineChildSummary`); new slate-state channel appends a tagged, non-merged snapshot to `parent.slate.childDispatches[dispatchId]`; child's own `slate.json` destroyed immediately after handoff. Gap found: today the child's system prompt (`spawn-subagent-tool.ts:255-258`) is a hardcoded minimal string with no Anchors-equivalent at all — the parent's `orient` block is not inherited either — so child Anchors must be assembled fresh at this exact call site, not adapted from an existing child-context mechanism (none exists) |
| SLATE-7 | Wrap-up composer | `resolveMachineWrapUp` under the currently-throwing `WrapUpSource === "flow"` branch (`src/sac/proposal-lifecycle.ts:244`, `src/sac/trusted-wrap-up.ts`); model summary via `runModelTurn` (`src/harness/provider/single-turn.ts`); evidence written attempt-scoped; triggers on flow-complete, explicit human command, **or one-shot `keryx harness run`/`--goal` process termination** (the only reliable trigger when no Flow exists and no human is present); Seeds grouped by `kind`, one `propose` call per non-empty group |
| SLATE-8 | Human checkpoint / unattended gate | Wire the existing `interactive: boolean` context field into `authorizeSacUse`/`ProposalLifecycleService.review()` (`src/sac/workspace-service.ts`, `src/sac/proposal-lifecycle.ts`), mirroring `checkApproval` rule (h) (`src/harness/mutation/approval.ts:148-149`); add the missing `--unattended` boolean flag (not a `--profile <name>` selector — deliberately one flag, forcing `interactive: false` for that invocation, kept separate from `PolicyProfile` naming to avoid re-conflating the two axes this AC exists to separate) to `src/commands/harness.ts` as a prerequisite for local scheduled runs — `keryx serve` needs no new flag, its sessions are already unconditionally `interactive: false` |
| SLATE-9 | No new review authority | No slate-owned code path calls `workspace review` |
| SLATE-10 | Catch-up review flow | New `listProposedProposals(workspaceId)` in `proposal-lifecycle.ts` (readdir `proposals/`, subtract terminal ids from `activity.jsonl`) + `listVisibleProposedProposals(actor)` over `WorkspaceService.list()`; new `isLockHeld` read-only helper next to `withFileLock`; two new optional `SessionSummary` fields (`runMode`, `courseStatus`); new `keryx workspace catch-up` command, **`cwd`-scoped for v1** (matches every existing `workspace` subcommand's `service()` factory, bound to `process.cwd()`) — cross-project aggregation over `src/lib/project-registry.ts` is a clearly-scoped, additive `--all-projects` follow-up (effort M: per-project `WorkspaceService`/lock/authorization-server instantiation, workspace-id collision across projects, AC-13's archived-workspace exclusion becomes harder to hold cross-project), not a v1 requirement |
| SLATE-11 | Course.blocked / ask_user unattended default | Structured terminal-state emission in place of `finishWithBudgetSummary`'s free-text (`src/commands/agent.ts:855-930`), modeled on `KERYX_INSTALLATION_RESULT` |
| SLATE-12 | Interim evidence scan | Call `detectSecrets`/`detectPii` (`src/security/detect/*`) on evidence before persistence in `proposal-lifecycle.ts`/`session-wrap-up.ts`; replace the hardcoded `security.gate: "pass"` (`proposal-lifecycle.ts:59`) with a real scan result. **Bundled SAC fix, not slate-exclusive** — this is a defect in today's `keryx workspace propose --session` regardless of slate |
| SLATE-13 | General-purpose proposal listing | Expose SLATE-10's `listProposedProposals`/`listVisibleProposedProposals` helpers as a standalone `keryx workspace list-proposals [<workspace-id>]` command, independent of catch-up. **Cross-package requirement** (see `docs/requirements/sac-workspace-lifecycle/` WSL-2): `listVisibleProposedProposals` must enumerate workspaces via a variant of `list()` that never applies an archived-status filter — pending-proposal discovery is a safety property, not a declutter default; archival must never silently remove a pending proposal from this or SLATE-10's discovery path |
| SLATE-14 | Correct misleading self-accept comment | Fix or remove the "Local CLI/stdin MCP composition ... can never self-accept" comment in `createLocalProposalLifecycleService` (`src/sac/proposal-lifecycle.ts`) — it describes a composition the real CLI/MCP handlers (`src/commands/workspace.ts`, `src/mcp/tools.ts`) never actually use, so it misrepresents a real protection that isn't there |
| SLATE-15 | Explicit `/goal` trigger | New `/goal <text> [--workspace <id>]` shell command (deterministic alternative to `isActionRequest`): opens slate immediately, validates `--workspace <id>` visibility via existing `WorkspaceService` role-check and sets `slate.workspaceId` if given. **Superseded by SLATE-16 for the omitted-`--workspace` case** (see below) — `/goal` without `--workspace` no longer leaves `workspaceId` unset; it triggers SLATE-16's resolve-or-create instead. Mirrored as `keryx harness run --goal "<text>" --workspace <id> [--unattended]` CLI flags for scheduled/unattended invocations, composing with SLATE-8's needed `--unattended` flag |
| SLATE-16 | Workspace resolve-or-create (v2) | New procedure, called from (a) flow creation, (b) slate-open without an explicit `--workspace` (default action-intent trigger or bare `/goal`). Calls `workspace_list` (SLATE-19), lets the model judge topic match against existing titles/components (no new similarity/embedding service — same tool-calling judgment pattern as `ask_user`/`spawn_subagent`). Match → binds existing id. No match → `workspace_create` (SLATE-19) → binds new id. Writes `flow.workspaceId` (new optional field on the flow record) when a flow exists, else `slate.workspaceId` directly (same field SLATE-1 already defines) |
| SLATE-17 | Mid-session re-evaluation (v2) | The existing "unrelated new question = new slate" close-trigger heuristic (SLATE-5) additionally re-runs SLATE-16 when it fires without `/clear`/`/new` — not a new detection mechanism, an extra effect on an existing one |
| SLATE-18 | Autonomous wrap-up dispatch (v2) | SLATE-7's existing triggers unchanged; the wrap-up composer itself calls `workspace_propose` (SLATE-19) at a propose-worthy moment when `workspaceId` is bound, instead of waiting for a separate human command |
| SLATE-19 | Cross-runtime agent-tool parity (v2) | Four new keryx-shell interactive tools in `src/commands/interactive-agent-tools.ts`, mirroring the existing MCP `sac.*` set, `risk: "read"` (same tier as `slate_write_seed` — draft/discovery, self-accept structurally impossible): `workspace_create` `{title, component?}`, `workspace_list` `{includeArchived?}`, `workspace_show` `{workspaceId}`, `workspace_propose` `{workspaceId, kind, sessionId?, note?}` (`sessionId` defaults to the current session). `workspace_review` is added to none of CLI/MCP/keryx-shell as an agent tool |
| SLATE-20 | Review confirm-token (v2) | New `keryx workspace confirm-review <workspace-id> <proposal-id>` prints a short-lived (2 min), single-use token — requires a real terminal or an approval-gated `shell_exec`. `decision: "accepted"` on both the CLI `workspace review` handler (`src/commands/workspace.ts`) and the MCP `sac.review` handler (`src/mcp/tools.ts`) requires this token as an additional parameter; `"rejected"`/`"dismissed"` do not (they promote nothing) |
| SLATE-21 | Finish SLATE-7's machine evidence (gap, not new design) | `resolveSessionWrapUp` (`src/sac/session-wrap-up.ts`) is replaced/wrapped so the evidence candidate is built from `anchors.touched` + git diff on those paths + `course.flowRef`/flow status + `seeds[]` as the primary text; `exportSessionMarkdown`'s full transcript is retained as a linked reference attachment, not the sole or embedded evidence |
| SLATE-22 | Bounded autonomous continuation for `/goal` (flow 186) | `/goal <text> [--workspace <id>] --auto [N]` (`src/commands/goal-command.ts`). Auto-provisions a Task Manager flow (`flow init`/`freeze`/`start` via `createFlowService`, `src/flow/service.ts`) when the slate's course has none bound, with one acceptance criterion tied to the goal text (`keryx flow plan`'s model-suggested breakdown turned out to be advisory-only — writes no flow state — so v1 uses `flow init`'s default 4-task scaffold instead). Re-drives `runAgentTurn` in a round-capped loop; the stop condition is the SAME `isCourseDone`/`courseFromSlate` check `closeSlateOnFlowDone` already runs (observed via `slateSession.opened`, not a second call). Before the loop's final stop, one `spawn_subagent` (`mode: "read_only"`) verifier call independently checks the stated goal against live repo state; on a rejected verdict with round budget remaining, reopens the slate (rebinding the same flow/workspace) for exactly one more round. The armed round budget (`SlateSessionRef.autoGoalRounds`) is process-local/in-memory only — never written to `slate.json` — so a resumed or forked session never silently inherits it |

## Anchors / Course / Seeds semantics

**Anchors.** Valid only for the life of the slate; always rebuilt (not
restored) on crash/resume from live repo state. Harness-write-only; model
output is never a source. `touched` is append-only within the session. Never
an authorization input — access is never inferred from checkout/worktree
proximity (consistent with RP-08's explicit non-goal on the same point).

**Course.** A pure projection, never a second tracker. Absent `flowRef`,
Course is a plain local checklist with no Flow semantics. No slate/agent code
may call `flow complete`; Course only reflects an already-committed
transition. Re-derived at every consult and immediately before wrap-up so it
cannot go stale inside a session turn.

**Seeds.** Draft hypotheses, task-local. Never Know-how until the existing
workspace review path accepts them. Deduplicated before being handed to the
wrap-up composer. A subagent's full slate (Anchors/Course/Seeds) is never
merged into the parent's own fields — it lands only as a separate, tagged
`childDispatches[dispatchId]` entry, `status: completed | incomplete`,
readable at wrap-up as attributed evidence, never re-authored by the parent
as if it were the parent's own Seed. A Seed's optional `kind` tag is the
model's own best guess at the eventual proposal category — it is advisory,
not binding: the wrap-up composer still groups by it (untagged → `follow-up`)
and a reviewer can still reclassify or reject at accept time; a wrong tag
only costs re-review, never a silent wrong-subsystem write, because
acceptance still goes through the existing guarded owner-writer path.

## Data contracts

`Slate` (informal, non-normative until implemented):
```ts
type Slate = {
  workspaceId?: string;   // see below — not nested under anchors/course, its own axis
  anchors: { root: string; tree?: string; runtime?: { provider: string; model: string }; touched: string[]; fence?: string[] };
  course: { flowRef?: string };
  seeds: Array<{ id: string; text: string; ts: string; kind?: ProposalKind }>;
  childDispatches?: Record<string, {
    anchors: Slate["anchors"];
    course: Slate["course"];
    seeds: Slate["seeds"];
    status: "completed" | "incomplete";
  }>;
};
```

**`workspaceId` is a real, previously-missing requirement, not an optional
nicety.** SLATE-7's wrap-up composer calls `workspace propose
<workspace-id>` — nothing in `Course.flowRef` resolves to a workspace id
today (no reverse lookup from flow to the workspace(s) that reference it as
a resource exists in `WorkspaceService`, and such a lookup would be
ambiguous — a flow can be referenced by zero or several workspaces, and
SLATE-16 does not change that: the new `flow.workspaceId` field is a
forward reference the flow itself carries, not a reverse index).

**v1 behavior (still valid as a path, no longer the only one):** set
`slate.workspaceId` the first time any `workspace_overview`/`workspace_read`/
`slate_read` consult succeeds with an explicit id during the slate's life,
or explicitly via `/goal --workspace <id>` (SLATE-15) at slate-open time.

**v2 (SLATE-16, supersedes the "human-supplied only" framing below):** when
neither of the above already bound an id, slate-open (default action-intent
trigger, or `/goal` without `--workspace`) and flow-creation both trigger
SLATE-16's resolve-or-create instead of leaving `workspaceId` unset — the id
is no longer required to be human-supplied; the agent may resolve an
existing match (via `workspace_list` + its own judgment) or create a new
workspace via `workspace_create` (SLATE-19) and bind that. The v1 text this
replaces read: *"the id itself is still human-supplied — slate v1 does not
solve automatic binding, see RP-03 in Non-goals — slate only captures and
persists what was already explicitly supplied"* — that constraint is
explicitly lifted in v2, by a documented user decision (see PRD's Problem v2
addendum), not by an implementation drift; RP-03's Non-goal reference is
correspondingly narrowed in README.md to the subset SLATE-16 does not cover.

If `workspaceId` is still unset when wrap-up fires — now only reachable if
SLATE-16's resolve-or-create itself failed (e.g. `workspace_create` denied,
no credential for the model judgment call) — `propose` cannot be attempted:
the machine-collected
evidence and summary are still preserved as a local-only artifact (written
under the session's `slate-archive/`, never inside a `.metaproject/workspaces/`
that doesn't apply here) rather than silently discarded, and surface at the
next `workspace catch-up` as a fourth, distinct catalog category (see
SLATE-10 below) — not proposed, not blocked, not crashed, just unbound.

**`kind` selection is a second, previously-missing requirement for automated
wrap-up.** Today's real `workspace propose --kind <kind>` requires a human to
type the kind by hand; nothing decides it for an unattended, harness-
triggered wrap-up. `kind` is not cosmetic — `ownerFor(kind)` in
`proposal-lifecycle.ts` determines which guarded owner-writer (wiki/memory/
skill) actually handles acceptance, so a wrong default risks a correct
finding landing in the wrong subsystem. Fix: `slate_write_seed` (SLATE-3a)
accepts an optional `kind` tag per Seed. The wrap-up composer groups Seeds by
`kind` and issues one `propose` call per non-empty kind-group — a single
wrap-up may legitimately produce more than one proposal (e.g. one
`wiki-update` and one `risk` from the same session). Untagged Seeds fall into
a single `kind: "follow-up"` group — the least-presumptuous bucket, since a
misfiled follow-up costs a reviewer a re-read, while a misfiled `wiki-update`/
`memory-entry` costs a wrong subsystem write.

`SessionSummary` gains two optional fields (backward-compatible — existing
`readSummaryFile` type-guards every field as optional already):
```ts
runMode?: "interactive" | "unattended";
courseStatus?: "unbound" | "active" | "blocked" | "done";
```

Wrap-up candidate handed to the existing `workspace propose` must include
(gap found during validation against the real CLI/writers — an earlier draft
contract omitted these, both required today):
- `kind`: one of `decision | wiki-update | memory-entry | follow-up |
  contract-change | risk` (required by `workspace propose --kind`).
- `note`: short one-line gist (rendered by owner-writers as the page/entry
  Summary heading, see `sidecarNote` in `wiki-owner-writer.ts`/
  `memory-owner-writer.ts`).
- `machine.diff`, `machine.flowSnapshot`, `seeds[]` (including tagged
  `childDispatches` entries) as evidence.
- `summary`: model-authored, must not contradict `machine.*`.

**SLATE-11's terminal state** (the structured, machine-readable output that
replaces today's free-text `finishWithBudgetSummary`, modeled on
`KERYX_INSTALLATION_RESULT`):
```ts
type TerminalState = {
  status: "blocked";
  reason: "ask_user_unanswerable" | "budget_exhausted" | "other";
  courseSnapshot: Slate["course"];
  anchorsSnapshot: Slate["anchors"];
  occurredAt: string;
};
```
Emitted by the harness in place of any free-text history message whenever an
unattended session hits `ask_user`/budget exhaustion with fail-closed
safe-stop (SLATE-11) — never pushed into shared session `history` as a
persistent instruction the way today's `Do NOT call tools.` text is.

SLATE-10 catalog item (four hard-separated categories, never interleaved):
```ts
type CatchUpItem =
  | { type: "proposal"; workspaceId: string; proposalId: string; fresh: boolean; ... }
  | { type: "blocked"; sessionId: string; workspaceId?: string; terminalState: TerminalState; ... }
  | { type: "unbound-candidate"; sessionId: string; evidencePath: string; summary: string; ... }
  | { type: "unknown"; sessionId: string; workspaceId?: string; lastSeenAt: string; ... };
```
`unbound-candidate` is distinct from `blocked`/`unknown`: the work completed
and wrap-up ran successfully, but `slate.workspaceId` was never set, so there
was nowhere to `propose` into. It is not a proposal (no workspace ACL applies
to it) and not a crash — it is presented to the human with an explicit
prompt to either bind it to a workspace now (triggering a real `propose`) or
discard it.

**`unknown` classification**: a session counts as `unknown` (not `blocked`,
which requires an explicit `TerminalState`) when catch-up finds no proposal,
no `unbound-candidate`, and no `TerminalState` for it, **and** `isLockHeld`
on its `slate.json` lock path returns false (not currently held by a live
process) with the lock's last-modified time older than the same `staleMs`
threshold `withFileLock`'s own stale-lock reclaim already uses (`src/lib/
fs.ts`) — reusing that existing threshold rather than inventing a new one.
A session whose lock is still held, or younger than that threshold, is
still-running and must not appear in catch-up at all yet.

## Future CLI and MCP surface

No new top-level SAC command beyond one extension and one new command:
```text
keryx workspace propose <workspace-id> --kind <kind> --source machine --note <note>
```
(`--source machine` fills the currently-unimplemented `"flow"` branch of
`WrapUpSource` — `trusted-wrap-up.ts`/`proposal-lifecycle.ts` throw for any
source other than `"session"` today.)

```text
keryx workspace catch-up [--workspace <id>]
```
(new; SLATE-10 — pull-based, no push/webhook infrastructure exists natively
in keryx, none is added here.)

**v2 (SLATE-20):**
```text
keryx workspace confirm-review <workspace-id> <proposal-id>
```
Prints a short-lived (2 min), single-use token to stdout — nothing else.
Takes no `--decision`; it does not itself review anything, only mints the
token `workspace review --decision accepted` (and `sac.review` with
`decision: "accepted"`) then requires as an additional parameter.

**v2 (SLATE-19) — new keryx-shell interactive agent tools**, mirrored in
`src/commands/interactive-agent-tools.ts`'s `buildInteractiveAgentTools`,
`risk: "read"`:
```text
workspace_create  { title: string, component?: string }
workspace_list    { includeArchived?: boolean }
workspace_show    { workspaceId: string }
workspace_propose { workspaceId: string, kind: ProposalKind, sessionId?: string, note?: string }
```
`workspace_propose`'s `sessionId` defaults to the calling session's own id
when omitted — SLATE-18 needs the composer to propose without re-supplying
an id it already knows. No `workspace_review` tool is added anywhere.

## Permission model and security invariants

Slate introduces no new `ActorContext`, no new role, no new write authority.
It is subject to the same pre-existing gap as today's SAC:
`localWorkspaceAuthorizationServer` derives `subject` from the OS user only
and does not distinguish a human at the terminal from an agent invoking the
same command via `shell_exec` — the real CLI/MCP `propose`/`review` handlers
both use `createHarnessProposalLifecycleService`, not the fail-closed local
composition; `authorityFor()` never compares reviewer subject to proposal
author; only the `http` MCP transport is blocked (`stdio`/`in-process` —
exactly what an unattended agent would use — are unrestricted).

**Unattended mode makes this the structural default, not an edge case.**
SLATE-8 mitigates by gating `accept` (and Course-close) on the already-
existing `interactive: boolean` context field, not on `PolicyProfile`/
`compareProfiles` and not on actor. These are deliberately different axes:
profile answers "what may this turn's tools/network/writes do" (a capability
ceiling — `src/harness/policy/profiles.ts`'s `LocalProfileName`, checked via
`compareProfiles`), `interactive` answers "can a human currently answer/
confirm" (`src/harness/policy/engine.ts`, `src/harness/mutation/approval.ts`'s
rule (h): `interactive === false → deny`). Conflating them would silently
import `keryx-remote-entry`'s capability semantics into a control that has
nothing to do with capability.

Concretely: `keryx serve`-originated sessions have `interactive` hardcoded to
`false` in `runRemoteTurn` regardless of the configured `remote-restricted`/
`remote-read-only` profile (`src/lib/serve-turn.ts`) — SSE event streaming
(`GET /v1/turns/{turnId}/events`) is replay-only, structurally incapable of
making a remote turn "interactive" in the approval sense. So **any** `keryx
serve` session is unattended for SLATE-8 purposes without inspecting its
profile at all. For local scheduled runs, `keryx harness run` has **no
`--profile` flag today** (`src/commands/harness.ts` resolves only
`read-only-review` or, behind `--exec`, `monitored-trusted-local`) — this is
a genuine, separately-scoped prerequisite: add an operator-set flag that
forces `interactive: false` for that invocation, set by a human ahead of
time (cron/systemd/CI), never self-declared by the agent at run time.
Deferred-queue model: `propose` proceeds normally in either case; `accept`
waits for the next session where `interactive` is honestly `true`.
[SAC RP-06](../shared-agent-context-identity-capabilities/README.md) is the
eventual proper replacement for OS-UID-only identity; this is a smaller
interim measure that does not block on RP-06 landing.

SLATE-12 wires the already-existing `detectSecrets`/`detectPii` into the
evidence path before persistence — an interim measure pending [SAC RP-05](../shared-agent-context-secure-evidence/README.md),
which owns the full sealed/scanned/schema-closed evidence model.

**v2 (SLATE-20) closes the specific self-accept gap described above, for the
`decision: "accepted"` path only.** `keryx workspace confirm-review
<workspace-id> <proposal-id>` mints a token (2 min TTL, single-use, bound to
that exact `workspaceId`+`proposalId` pair) that both the CLI `workspace
review` handler and the MCP `sac.review` handler must additionally validate
before honoring `decision: "accepted"`; `"rejected"`/`"dismissed"` are
unaffected (they accept/promote nothing, so the self-accept concern does not
apply to them). Minting the token itself requires either a real terminal
(the command reads/writes nothing that a headless MCP stdio process can
reach on its own) or a `shell_exec` call that already goes through the
existing approval gate — so a caller with *only* MCP tool access (no shell)
cannot mint one at all, and a caller that also has `shell_exec` still needs
a human to approve that specific call, same as any other mutating command.
This is a real, verifiable barrier, not a renamed `interactive: true` flag:
unlike `interactive`, which is set once per session and trusted for the
whole session, the token is minted per-proposal, expires quickly, and is
consumed on first use — replaying an old approval, or a session that was
`interactive: true` at session-start but has since gone unattended, no
longer suffices. [SAC RP-06](../shared-agent-context-identity-capabilities/README.md)
remains the eventual proper replacement for OS-UID-only identity; SLATE-20
is a smaller, concrete interim measure that does not block on RP-06 landing
and does not claim to solve execution identity in general.

## Integrations and dependencies

- `src/session/*`: sessionDir, atomic write patterns — slate's storage
  substrate; `listSessions()` reused for SLATE-10.
- `src/sac/fwk-service.ts`: existing Flow projection — Course's read path.
- `src/sac/trusted-wrap-up.ts`, `src/sac/proposal-lifecycle.ts`: existing
  `"flow"` `WrapUpSource` stub — wrap-up composer's target; new
  `listProposedProposals` for SLATE-10.
- `src/harness/child/*` (worktree resolve, budget ledger): subagent Anchors
  source; `spawn-subagent-tool.ts` is the real lifecycle-wiring point (not
  `harness/child/*`, which is deliberately kept pure — no fs/clock/RNG).
- `src/ctx/assembly.ts` (`assembleContext`, the same bounded-pack primitive
  `FwkReadService.overview()`/`.read()` already use): SLATE-2a's Anchors
  auto-inject budget. `src/ctx/orient.ts` is the explicit anti-pattern to not
  follow — a once-per-session, char/line-capped, non-token-aware block that
  never updates mid-session.
- `src/harness/policy/engine.ts`, `src/harness/mutation/approval.ts`: SLATE-8's
  `interactive: boolean` gate primitive. `src/harness/policy/profiles.ts`,
  `src/lib/serve-turn.ts`: confirm `keryx serve` sessions are unconditionally
  `interactive: false`; `src/commands/harness.ts` is where the missing local
  `--unattended` boolean flag must be added (one flag, not a `--profile`
  selector — see SLATE-8's Permission model section for why).
- `src/security/detect/secrets.ts`, `pii.ts`: SLATE-12's interim scan.
- `src/lib/project-registry.ts`: the primitive a future `--all-projects`
  follow-up to SLATE-10 would loop over; not used by v1.
- `src/session/store.ts` `forkSession()`: confirms fork copies only raw
  transcript + identity fields, never derived state — the precedent SLATE-1's
  fork behavior follows.
- `docs/docs/agent-installation-playbook.md`: `KERYX_INSTALLATION_RESULT`
  structured terminal-state pattern reused for SLATE-11.
- `src/commands/agent.ts` `isActionRequest`: SLATE-5's open/close classifier,
  extended not replaced.
- `src/commands/workspace.ts`, `src/mcp/tools.ts`, `src/sac/workspace-service.ts`:
  **v2** — `propose`/`review`/`create`/`list`/`show` handlers SLATE-16/18/19/20
  extend directly; `localWorkspaceAuthorizationServer`'s OS-UID-only subject
  resolution is where SLATE-20's token check is added, not a new module.
- `src/flow/*`: **v2** — SLATE-16 adds an optional `workspaceId` field to the
  flow record; native Flow commands remain the sole work-state channel
  otherwise, unchanged.
- **Explicitly not integrated with (see Non-goals in README.md):**
  [SAC RP-03](../shared-agent-context-lifecycle-binding/README.md) — **v1
  scope only** (session↔workspace↔Flow binding is now SLATE-16…19, not
  RP-03; RP-03 retains `keryx shell --workspace <id>` explicit selection,
  `--session current` resolution, Flow/worktree derivation preview, and
  accepted-target link-back, none of which v2 touches),
  [RP-05](../shared-agent-context-secure-evidence/README.md),
  [RP-06](../shared-agent-context-identity-capabilities/README.md),
  [RP-08](../shared-agent-context-collaboration-worktrees/README.md) — slate
  uses smaller existing primitives as interim measures and does not build a
  competing architecture in any of their scopes.

## Acceptance criteria

- **AC-1:** After harness restart/resume, Anchors/fence values equal a fresh
  computation from live repo state, never a value carried over from a prior
  slate file. This also holds for `keryx sessions fork`: the forked session
  opens with a fresh, empty slate — no `slate.json` is copied or inherited
  from the source session, matching `forkSession()`'s existing convention of
  copying only raw transcript and identity fields, never derived state.
- **AC-2:** Course output equals the live Flow projection at every `consult`
  and immediately before wrap-up; a flow-read failure (ENOENT, malformed,
  permission) deterministically yields `unbound`, never an uncaught throw
  that breaks the whole Facts+Work+Know-how assembly.
- **AC-3:** No slate-owned code path calls `flow complete`, `workspace
  propose`, or `workspace review` on behalf of a subagent.
- **AC-4:** Two wrap-up triggers occurring within the same session for the
  same flow transition produce at most one accepted evidence set, not two
  independently-reviewed overlapping proposals.
- **AC-5:** Every wrap-up-produced proposal's evidence set contains zero
  `session-evidence/*.md` full-archive references; all evidence is
  git-diff/flow-snapshot/seed-derived.
- **AC-6:** A wrap-up cannot be invoked without a preceding surfaced
  statement of intent or explicit human command recorded in the session
  (interactive mode), or without a session profile set by a human at
  schedule-config time authorizing `propose` (unattended mode).
- **AC-7:** Subagent Seeds/Anchors/Course content never appear verbatim in
  the parent's own `slate.anchors`/`slate.course`/`slate.seeds` fields — only
  within `parent.slate.childDispatches[dispatchId]`, structurally, not as a
  behavioral/prompt-only expectation.
- **AC-8:** Wrap-up composer fails closed (returns a typed error, creates no
  proposal) when no model credential is available at generation time; on a
  bounded-timeout with a valid credential, falls back to a mechanical
  template summary rather than blocking indefinitely or failing.
- **AC-9:** A subagent's slate (Anchors/Course/Seeds) is unreachable by any
  code path after the dispatch returns, except via the immutable
  `childDispatches[dispatchId]` snapshot in the parent's own slate.
- **AC-10:** `workspace review --decision accepted` is technically denied for
  any session whose `interactive` context field is `false` (including every
  `keryx serve`-originated session unconditionally, and any local session
  launched with an operator-set unattended flag); `propose` remains available
  in that mode. Denial never depends on inspecting `PolicyProfile` identity.
- **AC-11:** SLATE-10 catch-up presents proposals, blocked-runs,
  unbound-candidates (wrap-up succeeded but no `workspaceId` was ever set),
  and unknown/crashed-runs in four hard-separated sections, never
  interleaved, and re-checks evidence freshness before display (not only at
  accept), marking stale items explicitly.
- **AC-12:** Every SAC proposal created via the slate wrap-up path has a
  `security.gate` value computed from a real `detectSecrets`/`detectPii` scan
  of its evidence, never the literal `"pass"` with no scan behind it.
- **AC-13:** SLATE-10 builds no archive command/enforcement of its own —
  that is [`sac-workspace-lifecycle`](../sac-workspace-lifecycle/README.md)'s
  WSL-1/WSL-2 responsibility, not slate's. This does **not** mean archived
  workspaces are ignorable by SLATE-10: once WSL-1/WSL-2 land, SLATE-10's
  discovery must still surface pending proposals from archived workspaces
  exactly as WSL's AC-5 requires — AC-13 only scopes *who builds archive
  itself* (not slate), never *whether SLATE-10 must see through it* (it
  must). Superseded stale reading: an earlier draft of this AC, written
  before `sac-workspace-lifecycle` existed, read as "archived workspaces are
  out of scope for SLATE-10 entirely" — that reading is wrong and must not
  be implemented.
- **AC-14:** `keryx workspace catch-up` v1 operates strictly on the invoking
  `cwd`'s workspaces/sessions, matching every other `workspace` subcommand;
  no cross-project aggregation exists in v1, and this is a stated scope
  boundary (see Functional surface, SLATE-10), not an oversight.
- **AC-15:** A wrap-up composer invocation never attempts `workspace
  propose` without a `workspaceId` captured earlier in the slate's life —
  via v1's explicit-consult/`/goal --workspace` paths, **or v2's SLATE-16
  resolve-or-create** (an id it captured is captured, regardless of which
  path bound it); when none was captured (SLATE-16 itself failed or was
  never reached), the composer still writes its machine-collected evidence
  and summary to a local artifact (never discarded, never silently attempted
  against a guessed/default workspace id) and that artifact is visible at
  the next `workspace catch-up` as `unbound-candidate`.
- **AC-16:** `keryx workspace list-proposals [<workspace-id>]` returns every
  non-terminal proposal visible to the calling actor's role, without
  requiring the caller to already know a proposal id — usable standalone,
  not only as a SLATE-10 internal helper.
- **AC-17:** No comment or docstring in `src/sac/proposal-lifecycle.ts`
  claims a self-accept protection that the real CLI/MCP `propose`/`review`
  code paths do not actually provide; `createLocalProposalLifecycleService`'s
  documented behavior matches what `src/commands/workspace.ts`/`src/mcp/
  tools.ts` actually invoke.
- **AC-18:** `/goal --workspace <id>` rejects an invalid or actor-invisible
  workspace id explicitly (fail closed, no silent unbound fallback) rather
  than opening a slate that only discovers the problem at wrap-up.
  **Superseded (v2):** this AC's original second clause read *"`/goal`
  without `--workspace` never creates a workspace on the agent's behalf"* —
  that is no longer true by design: `/goal` without `--workspace` now
  triggers SLATE-16's resolve-or-create, which may create one. The first
  clause (explicit `--workspace <id>` still fails closed on an invalid id)
  is unchanged and still holds.
- **AC-19:** A one-shot `keryx harness run`/`--goal` invocation with no Flow
  ever bound and no explicit human "done" command still reaches wrap-up on
  natural process termination; this trigger is never available to a `keryx
  shell` REPL session (where the process outlives many turns and premature
  wrap-up would be wrong).
- **AC-20:** A wrap-up never calls `workspace propose` with a `kind` that no
  Seed actually requested; untagged Seeds are proposed under `follow-up`,
  never silently defaulted to `wiki-update`/`memory-entry`/any kind whose
  owner-writer performs a real subsystem write on accept.
- **AC-21:** An unattended session that hits `ask_user`/budget exhaustion
  emits a `TerminalState` record (not a free-text history message) and stops
  cleanly; no instruction derived from that stop persists into the shared
  session `history` beyond the terminal-state record itself, and no later
  turn in the same session sees a `Do NOT call tools.`-style leaked
  instruction the way `finishWithBudgetSummary` produces today.
- **AC-22:** A second `/goal`/action-intent open in the same session dir,
  while a prior slate from that dir was never explicitly closed, always
  archives the prior `slate.json` to `slate-archive/<attemptId>.json` before
  the new slate's first write — a second open can never silently overwrite
  an unclosed prior slate's Anchors/Course/Seeds.
- **AC-23:** Seed dedup before wrap-up uses exact-text-match only for v1 (no
  embedding/similarity model) — two Seeds are deduplicated only when their
  `text` fields are identical after trimming whitespace; near-duplicate
  detection is explicitly deferred, not silently attempted with an
  unspecified threshold.

### v2 acceptance criteria (SLATE-16…20)

- **AC-24:** SLATE-16's resolve-or-create never binds a workspace id without
  a preceding `workspace_list` tool call in the same decision — no code path
  may bind an id the model asserted without evidence of having listed
  existing workspaces first.
- **AC-25:** SLATE-16 fires at exactly two points — flow creation, and
  slate-open without an already-bound `workspaceId` (default action-intent
  trigger or bare `/goal`) — and nowhere else; a slate that already has
  `workspaceId` set (v1 explicit-consult, `/goal --workspace`, or an earlier
  SLATE-16 run this session) is not re-resolved merely because a new turn
  started.
- **AC-26:** SLATE-17's mid-session re-evaluation only fires at the same
  point SLATE-5's existing close-trigger heuristic already fires (unrelated
  new question, no `/clear`); it introduces no new topic-shift detector of
  its own.
- **AC-27:** SLATE-18's autonomous `workspace_propose` call never fires
  without SLATE-7's existing trigger conditions (flow complete / explicit
  human command / one-shot process termination) also having fired — SLATE-18
  changes *who* calls `propose` at those triggers, not *when* wrap-up is
  triggered.
- **AC-28:** `workspace_create`, `workspace_list`, `workspace_show`,
  `workspace_propose` are reachable from keryx-shell's interactive agent
  without `shell_exec` and without any human approval prompt (`risk: "read"`
  auto-allows, matching `slate_write_seed`'s existing tier) — and produce
  outcomes visible to `keryx workspace list`/`keryx workspace show`
  afterward identical to the CLI-driven equivalent (same records, same
  `WorkspaceService` writes, no shadow state).
- **AC-29:** No agent tool named `workspace_review` (or equivalent) exists in
  keryx-shell's interactive tool set or in the MCP `sac.*` set; `decision:
  "accepted"` is reachable only through the CLI `workspace review` command
  and the MCP `sac.review` tool, both gated by AC-30.
- **AC-30:** `keryx workspace review --decision accepted` and MCP
  `sac.review` with `decision: "accepted"` both fail with a typed
  `token_required`/`token_invalid` result — never silently proceed — when no
  valid, unexpired, unused confirm-token for that exact `(workspaceId,
  proposalId)` pair is supplied. A token is single-use: replaying the same
  token against the same or a different proposal after one successful accept
  fails the same way. `decision: "rejected"`/`"dismissed"` require no token.
- **AC-31:** `keryx workspace confirm-review <workspace-id> <proposal-id>`
  itself is `risk: "shell"` when reached via `shell_exec` (subject to the
  existing approval gate, never auto-allowed) and is not exposed as any
  agent-native tool (MCP or keryx-shell) — the only path to mint a token is
  a real terminal invocation or an approved `shell_exec`.
- **AC-32:** No subagent (dispatched via `spawn_subagent`) resolves, creates,
  reads, or proposes into a workspace, whether directly or through
  `workspace_list`/`workspace_create`/`workspace_show`/`workspace_propose` —
  those four tools are present only in the parent's own tool set, never
  threaded into a child's ephemeral tool list (`spawn-subagent-tool.ts`'s
  `read_only`/`general` mode tool construction). Unchanged from AC-3/AC-9's
  existing "subagent never proposes/completes on its own" invariant, restated
  for the four new tools specifically.
- **AC-33:** Every proposal produced by the wrap-up path has zero
  `session-evidence/*.md` full-archive content embedded in its primary
  evidence text — evidence is git-diff/flow-snapshot/seed-derived, matching
  AC-5's original intent — with the full transcript export still reachable
  as a separate linked reference, not deleted and not the primary candidate.
