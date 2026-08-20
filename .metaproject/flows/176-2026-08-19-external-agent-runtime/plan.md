# Implementation Plan
Status: formalized

## Approach

Add a **second child runtime** behind the already-shipped `spawnChild` rather
than a provider adapter, a standalone tool, or a parallel spawn path. An
external child spawns a vendor CLI subprocess and its event stream is folded
onto the existing `agent-event` contract, so the budget ledger, depth caps,
worktree assignment, quarantine, `reduceAgents`/`reduceState` and
`SubagentCompletionStatus` all apply unchanged.

Rejected alternatives and their reasons are recorded in
`docs/requirements/keryx-external-agent-runtime/decisions.md` (D-01..D-11) and
the full option history in that package's `brainstorm.md`. The three that shape
the code most:

- **Not a `ProviderPort`** (D-02): these CLIs are whole agents with their own
  tool loops, not completion endpoints. Fitting one into the port either breaks
  its contract or suppresses the loop being paid for.
- **Containment is the disposable worktree, not the deny-list** (D-08): a tool
  deny-list cannot be shown complete and loses ground on every CLI update, so it
  reduces noise while the throwaway checkout is the guarantee.
- **The parent reads a fold, the operator sees everything** (D-10): a parent
  consuming the raw stream would spend more of its own budget than the
  subscription saves; rendering costs nothing, so operator visibility is not
  reduced.

**Discovery precedes construction.** T1 exists because three load-bearing facts
are unverified (context.md, "Open unknowns"). If the `spawnChild` seam turns out
not to exist, the shape of T9 changes materially and the plan is revised before
code is written — not after.

## Steps

1. **T1 — discovery.** Read the bodies of `SpawnChildRequest` / `SpawnChildInput`
   / `SpawnChildDeps` and establish whether execution strategy is substitutable.
   Open `src/capability/` and confirm the opt-in gate's actual shape. Run
   `claude -p --output-format stream-json` and `codex exec --json` on a throwaway
   prompt to confirm the flag combinations compose and to see real event shapes.
   Journal the answers; revise this plan if the seam is absent.
2. **T5 — fixtures.** Record JSONL transcripts for both CLIs covering: success,
   not-logged-in, usage limit, rejected argv, empty output, resume, and a
   successful exploration whose output contains the word `error`. Commit under
   `fixtures/external/<agent>/`. Everything downstream is tested against these.
3. **T6 — foundations.** `src/harness/external/{types,registry,env}.ts`: the
   codec port, the registry with both entries, and the environment builder with
   its deny lists and prefix sweeps.
4. **T10 — contract.** Extend `subagent-dispatch.schema.json` with the `runtime`
   block; implement the pure validator (agent resolves, sandbox in
   `sandboxModes`, read-only versus `allowed_actions`, `worktree-write` refused
   with a distinguishable reason).
5. **T7 / T8 — codecs.** `codec/codex-cli.ts` and `codec/claude-cli.ts`: argv,
   parser, failure classifier, resume argv. Independent of each other; both
   depend on fixtures and foundations.
6. **T9 — runtime.** `supervise.ts` (spawn, stream pump, timeout, raced kill)
   and `runtime.ts` (integration into `spawnChild`, worktree lifecycle, ledger
   reservation, event emission, result extraction and validation).
7. **T11 — gate and surface.** Capability gate, config shape, transport/CI hard
   disable, `keryx agents external list|probe`.
8. **T12 — TUI.** External session kind in the subagent store, modal tabs
   (Work / Meta / Command), per-addressee queue built on the generalised
   `main-queue.ts` helpers, `force` as kill-plus-resume.
9. **T13 — docs.** README and the docs site updated alongside the code, and the
   package status line moved off "specification ready" only for what actually
   shipped.
10. **T3 / T4 — tests and review.** Gate, self-review, draft PR.

## Ordering constraint with a sibling package

`keryx-tui-queue-dock` (PRD drafted, unimplemented) plans to rework
`paintMainQueue` in `tui-shell.ts`. T12 here generalises the pure helpers in
`main-queue.ts` from one queue to a queue per addressee but does **not** touch
`paintMainQueue`. That split is deliberate and keeps the two packages
non-colliding: this flow owns the logic layer, queue-dock owns the presentation.
If queue-dock lands first, T12 renders into its dock instead of adding its own —
check before starting T12.

## Risks

- **The `spawnChild` seam may not exist.** Mitigated by T1 running first and by
  this plan being revisable before T9 begins. Highest-impact unknown.
- **Fixture capture spends real subscription quota** and cannot be redone
  cheaply. Record deliberately, one pass, with the failure cases planned in
  advance rather than provoked by trial and error.
- **Event schemas are unstable and undocumented.** Parsing is fixture-pinned and
  version-probed; a parse failure must degrade to an `Error` status, never a
  crash. A high skip rate is a drift signal to surface, not swallow.
- **The deny-list will leak.** Accepted by design (D-08); the worktree is what
  makes it survivable, so AC on containment must test the worktree, not the list.
- **`--permission-mode plan` and similar "obvious" safety flags are traps.**
  Every flag choice is justified in specification §5 against a measured failure;
  do not simplify them without reading that section.
- **The `keryx` on PATH is a stale build** (memory constraint
  `stale-installed-keryx-binary`), so verification must run a locally built
  binary or it proves nothing about this branch.
- **Flow id collision across clones** (memory constraint
  `flow-ids-allocated-per-clone`) — re-check id 176 before opening the PR.
