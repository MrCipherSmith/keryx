# Context

Collected deterministically by `keryx flow init` at 2026-08-18T07:03:21.384Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
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

Requirements package already exists and is the source of truth for this flow — no
context-collector/brainstorm/interviewer dispatch needed; ambiguity was already resolved
during PRD/TRD authoring (2026-08-18):

- `docs/requirements/keryx-wiki-enrich-rlm/README.md` — discovery notes/origin.
- `docs/requirements/keryx-wiki-enrich-rlm/prd.md` — FR-1..FR-9, NFR-1..NFR-4, Gherkin ACs.
- `docs/requirements/keryx-wiki-enrich-rlm/trd.md` — architecture, tech stack, data models,
  API/tool contracts, grounded against real code with exact file:line references.

### Files this flow will touch (from TRD §1, §3, §4, §6)

New:
- `src/wiki/classify.ts` — pure `classifyPage()`.
- `src/wiki/config.ts` — `WikiConfig` / `DEFAULT_WIKI_CONFIG` / `mergeWikiConfig` /
  `loadWikiConfig`, mirroring `src/gdgraph/config.ts`'s existing pattern exactly.

Modified:
- `src/wiki/enrich.ts` — `wikiEnrich()`'s per-page worker (currently `enrich.ts:688-776`)
  gains the classify branch, the `deep`-path child-turn call, and `light`-path batching;
  `ResumeState` (`enrich.ts:135-141`) gains `completedNodeHashes`.

Read-only reuse (no changes needed):
- `src/harness/child/orchestrate.ts` (`spawnSubagent`), `src/harness/child/ledger.ts`
  (`RemainingBudgetLedger`) — child admission/budget.
- `src/commands/agent.ts` (`runAgentTurn`) — child turn loop.
- `src/harness/tool/metaproject-operations.ts` (`METAPROJECT_OPERATIONS`,
  `toInteractiveTools`) — `deep`-path tool grant, filtered to
  `graph_query`/`graph_path`/`graph_symbol`/`graph_affected`/`repomap`/`read_wiki`.
- `src/gdgraph/repomap.ts` (`personalizedPageRank`) — classification PageRank signal.
- `src/gdgraph/staleness.ts` (`graphMaybeStale`) — cheap upfront repo-wide pre-check only.

### Explicitly NOT touched (PRD Non-Goals / Constraints)

`src/gdgraph/*` storage/query surface, `src/wiki/ask.ts`, `.metaproject/skills/gdwiki/SKILL.md`
(remains the manual-override escape hatch).
