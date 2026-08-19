# Context

Collected deterministically by `keryx flow init` at 2026-08-19T15:05:59.761Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-08T20:19:50.211Z)
- refresh: `keryx health run`

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

- Requirements package: `docs/requirements/keryx-tui-busy-mode-command/`
  (README.md discovery log, prd.md FR-1..FR-7/NFR-1..NFR-4, trd.md resolved
  design). Grounded via a direct Explore-agent investigation plus a fresh
  code re-read during TRD authoring.
- Key exact locations: busy branch `tui-shell.ts:3172-3296`,
  `classifyBusyDispatch`/`BusyDispatchTarget` (`src/tui/busy-dispatch.ts:12-55`),
  `/mode`'s current inline idle-path block (`tui-shell.ts:3569-3644`, to be
  hoisted verbatim into a new `runModeCommand(line)` const alongside
  `showWorkspace`/`showReview` at `tui-shell.ts:2447-2471`), permission-mode
  storage (`permissionMode` closure `let`, `tui-shell.ts:2262-2264`),
  approval-gate read (`agent.ts:1985`, inside `executeCall()`, called
  per-call from `agent.ts:1481`/`1851`) — confirmed already fresh-per-call,
  not per-turn cached, so no changes needed there.
- Base branch for this flow: `main` (feature branch:
  `feat/tui-busy-mode-command`).
- Known risk (per the memory constraint above, already hit once this
  session for flow 172/173/174): flow ids are allocated per clone, not
  globally — if a collision occurs at merge time, resolve the same way as
  before (`keryx flow renumber <dir> --to <free id> --reason "..."`), do
  not treat it as an error to avoid.
