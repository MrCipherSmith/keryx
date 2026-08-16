# Context

Collected deterministically by `keryx flow init` at 2026-08-16T21:35:31.866Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

- **Base branch**: worktree `keryx-wt-slate-phase5` branched from
  `origin/main` (HEAD == origin/main at flow start,
  `4f354123ecdb93a31c9b2a87b387423432809cd9`). Main already contains
  `sac-workspace-lifecycle` (WSL-1/WSL-2) and Slate Phases 1-4 merged. PR for
  this flow targets `main`, same as PRs #297/#301/#304/#306.
- **WSL-2 confirmed shipped**: `WorkspaceService.list(input: { request,
  requestCorrelationId, includeArchived?: boolean })`
  (`src/sac/workspace-service.ts:84-99`) already supports the
  archived-bypass variant via `includeArchived: true` — exact real
  signature, not assumed from the spec doc.
- **`withFileLock`/staleness** (`src/lib/fs.ts:41-136`): lock is a
  `mkdir`-based directory lock with an `owner.json` (`{pid, token}`)
  sidecar; `removeStaleLock` treats a lock as reclaimable only when its
  mtime is older than `staleMs` (default `30000`, currently an inline
  literal, no exported constant yet) AND the owner pid is not alive.
  `isLockHeld` must mirror this exact rule and reuse the extracted
  constant, not invent a new threshold.
- **`slateLockPath(dir)`** already exported from `src/session/slate.ts` —
  `${dir}/slate.json.lock` — this is the exact path `isLockHeld` checks per
  session dir in the catch-up classifier.
- **Real gap found (not previously documented)**: `TerminalState`
  (SLATE-11) is built and emitted via `io.onTerminalState?.(state)` in
  `emitTerminalState` (`src/commands/agent.ts:699-721`) but is **never
  written to disk anywhere** in the current codebase — confirmed by
  grepping `slate-terminal-state.ts` and `agent.ts` for any `writeFile`/
  `writeFileAtomic` call touching a `TerminalState`. Without persistence,
  catch-up's "blocked" category has no real backing data. Folded into this
  flow's scope as a new `writeTerminalState` primitive wired at the
  existing `emitTerminalState` call site (see plan.md Track A item 4).
- **Proposal storage shape** (`src/sac/proposal-lifecycle.ts:359-369`):
  `proposals/<id>.json` (real proposal, `recordType: "proposal-created"`)
  plus sidecars `<id>.<hash>.decision.json` / `.approval.json` /
  `.write-result.json` / `.write-intent.json` in the same dir; terminal
  transitions recorded in `activity.jsonl` as `proposal-transition` records
  with `toStatus` in `accepted | rejected | dismissed | stale`.
  `listProposedProposals` must filter by parsed `recordType`, not filename
  regex, to avoid misidentifying sidecars.
- **`unbound-candidate` artifact shape** (`src/sac/machine-wrap-up.ts:353-374`,
  already shipped by Phase 4): written to
  `<sessionDir>/slate-archive/<iso-ts>-unbound-candidate.json` as
  `{ recordType: "unbound-candidate", trigger, generatedAt, groups: [{kind,
  seeds: [{text, source}]}] }`.
- **CLI conventions confirmed** from `src/commands/workspace.ts`: every
  subcommand builds its own `WorkspaceService`/`ProposalLifecycleService`
  scoped to `process.cwd()` (never a cached/shared instance), uses
  `rejectUnknownOptions`/`optionValue`/`booleanFlag` for arg parsing, and
  prints `JSON.stringify(result, null, 2)` to stdout with errors caught at
  the top-level `workspaceCommand` try/catch. The two new subcommands
  (`catch-up`, `list-proposals`) must follow this exact shape.
- Memory: "The keryx on PATH is a stale build; the review pipeline does not
  exercise the code under review" — relevant only if `keryx review ingest`
  is used later; use `bun run keryx -- review ingest ...` for anything that
  must exercise this branch's own code, not the installed nvm binary.
