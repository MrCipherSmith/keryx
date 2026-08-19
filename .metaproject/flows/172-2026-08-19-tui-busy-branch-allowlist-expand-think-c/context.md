# Context

Collected deterministically by `keryx flow init` at 2026-08-19T04:56:34.938Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

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

- Requirements package: `docs/requirements/keryx-tui-busy-command-allowlist/`
  (README.md discovery log, prd.md FR-1..FR-8/NFR-1..NFR-4, trd.md resolved
  edit shape + test-coverage finding). Grounded via a prior Explore-agent
  investigation and a direct re-read of `tui-shell.ts` during TRD authoring.
- Exact edit location: `runLine` (`src/tui/tui-shell.ts:3006`), busy branch
  `tui-shell.ts:3019-3097`. Insert three `command?.name === "/x"` arms for
  `/think`/`/expand`/`/copy` right after the existing `/queue` arm (ends
  3076), extend the `isBusyReadonlyCommand` const at 3014 to also OR in
  `isWorkspaceCommand(line) || isReviewCommand(line)`, then add two more arms
  for `/workspace`/`/review` mirroring the existing `/status`/`/flows` arms
  at 3077-3084. Bodies copied verbatim from the idle-path arms (`/think`
  3304-3309, `/expand` 3310-3315, `/copy` 3332-3341, `/workspace` 3324-3327,
  `/review` 3328-3331). All called functions (`toggleNewestBlock`,
  `newestBlock`, `copyBlock`, `showWorkspace`, `showReview`) are already in
  lexical scope inside `runLine` — zero new plumbing.
- Base branch for this flow: `main` (feature branch:
  `fix/tui-busy-command-allowlist`).
- Relevant memory constraint above ("stale installed keryx binary — review
  pipeline does not exercise code under review") — not directly applicable
  here (no keryx-CLI-facing change in this fix, pure TUI dispatch), but keep
  in mind for the eventual release-tooling step after merge.
