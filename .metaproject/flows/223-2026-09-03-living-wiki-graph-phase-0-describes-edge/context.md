# Context

Collected deterministically by `keryx flow init` at 2026-09-03T20:55:59.713Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] Theme switch repaints already-rendered chrome via old-slot value matching - `.metaproject/memory/lessons/theme-switch-repaint.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`
- [accepted/task-note] SAC: Напиши мне скрипт на питоне цикла от 1 до 10 с промежутка… - `.metaproject/memory/task-notes/sac-proposal-d820f7ae5c4b43af.md`
- [accepted/task-note] SAC: найди все не завершенные flow - `.metaproject/memory/task-notes/sac-proposal-7854a304859a4170.md`
- [accepted/task-note] SAC: Anchors: root: /Users/tsaitler.aleksandr/goodea/keryx tre… - `.metaproject/memory/task-notes/sac-proposal-b051e66aebd74f37.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-22T15:31:16.004Z)
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

_(flow-init skill appends here)_

## Grounding (verified against `main` at `be70279e` / `45f00257`)

The auto-collected memory rows above matched on generic terms and are not
relevant to this flow. The real context is the requirements package
`docs/requirements/keryx-living-wiki-graph/` (README 1.2.0, PRD 1.2.0,
specification 1.4.0, plan 1.2.0) and these code anchors:

### Types this flow extends
- `src/gdgraph/types.ts:1-6` — `GraphNode` today: `{id, kind, path, language}`.
  No hash, no mtime. `GraphEdge.kind` is `imports | asset | unresolved`.
- `src/gdgraph/types.ts` — `SymbolNode.signature` exists; the symbol layer is
  the precedent for additive-optional extension (`GraphData.symbols` comment).

### Machinery that must be reused, not rewritten
- `src/wiki/service.ts:358` — `validModuleNames()`; returns `undefined` (not an
  empty set) when the graph is unbuilt, with an explicit comment that an empty
  set would make everything look orphaned. Extracted under RP-13 FR3+FR4
  (flow 168) so a second consumer never re-derives module grouping.
- `src/wiki/service.ts:1213` — `moduleNameFromProjectPath()`; a module is the
  directory that directly owns a file.
- `src/wiki/service.ts:306` — `wikiPruneOrphans()`; already the orphan signal.
- `src/sac/lifecycle-flag.ts` — the second consumer of that same signal,
  report-only. This flow adds the third.
- `src/wiki/staleness.ts:51-77` — `computePageNodeHash()`; `VerifiedScope`
  generalises it from top-6 key files to the whole describe-set.
- `src/wiki/collect.ts` — `computeModuleKeyFiles`, the `key-files` source.

### Measured baseline (this repository, `45f00257`)
`docs/requirements/keryx-living-wiki-graph/probe-wiki-drift.py`:
28 of 42 component pages drifted, 530 commits total, median 6, max 228
(`src/commands`). All 42 last touched in one month. Zero orphans and zero
unmapped pages — slug-to-module resolution held for all 42, which is prior
evidence that the `key-files` describe source works.

### Corpus shape that constrains the design
42 pages in `components/`, plus 11 in `architecture/`, `testing/`,
`templates/`, `decisions/` — one page in five has no module and therefore no
derivable describe-set. `testing/` and `templates/` are not in
`WIKI_PAGE_TYPES` (`src/wiki/types.ts`) at all.

### Why no worker dispatch during init
The flow-init skill decomposes non-trivial initialization to `context-collector`
/ `brainstorm` / `interviewer` workers. Here that context, the option
comparison and the requirements already exist, reviewed and committed, in the
requirements package — re-deriving them would be duplicated work, not
diligence. Filled inline instead, per the skill's own allowance for flows
whose context is already collected.
