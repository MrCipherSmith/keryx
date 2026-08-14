# Context

Collected deterministically by `keryx flow init` at 2026-08-14T20:17:17.635Z
and enriched by flow-orchestrator after reading wiki, graph, memory, SAC
source, and the reinstalled 0.2.34 CLI.

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive review-fix rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`

**Applied:** PATH `keryx` was 0.2.28 and hid `workspace`. Reinstalled from this
working tree (`bun run build && npm install -g .`) so PATH is **0.2.34**.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`
- SAC lives in `src/sac/` (not yet a wiki component page).
- Wiki collect reads graph `nodes.jsonl`/`edges.jsonl` (`src/wiki/service.ts`).
- FWK know-how kinds are only `wiki | memory | skill` (`src/sac/fwk-service.ts`).
  Graph is **not** a SAC knowledge owner.

## Wiki pages used

- `.metaproject/wiki/index.md`
- `.metaproject/wiki/components/src-wiki.md`
- `.metaproject/wiki/components/src-memory.md`
- `.metaproject/wiki/components/src-gdgraph.md`
- No `src/sac` component page and no architecture page for the split.

## SAC contracts

- `docs/requirements/shared-agent-context/README.md` — FWK model, non-goals
- `docs/requirements/shared-agent-context/specification.md` — owner table
- `docs/requirements/shared-agent-context/agent-protocol.md` — read/wrap-up
- `docs/docs/guides/shared-agent-context.md` — operator guide (propose flags stale)

## Runtime surfaces (verified in 0.2.34 source)

| Surface | What exists |
|---|---|
| CLI | `keryx workspace create\|list\|show\|add-resource\|overview\|read\|propose\|review\|collaboration\|policy-readiness` (`src/commands/workspace.ts`) |
| Agent tools | `workspace_overview`, `workspace_read` plus metaproject `search_code`, `graph_affected`, `memory_search`, `wiki_ask`, `graph_path`, `graph_symbol`, `repomap`, `test_related`, `health_status` (`src/commands/shell.ts`) |
| MCP | `sac.overview`, `sac.read`, `sac.propose`, `sac.review`, `sac.collaboration` (`src/mcp/tools.ts`); HTTP denied |
| Owner writes | `wiki-update` → wiki decision page; `memory-entry` → memory; other kinds → skill (`ownerFor` in `proposal-lifecycle.ts`) |
| Module | `sac` opt-in, currently **disabled** (10/11 modules) |

## Fallback (verified in source, to be re-run)

- `keryx wiki enrich` / `runModelTurn`: **fail-closed** without credentials. No silent FakeProvider (`src/wiki/enrich.ts`, `src/harness/provider/single-turn.ts`).
- `makeProvider("anthropic")` without key → offline `FakeProvider` (shell/harness construction only).
- `ollama` is treated as always credentialed (loopback). It is **not** auto-selected.
- Graph build/query, wiki collect/ask, memory lexical search, SAC FWK read do not need a model.

## Enabled Metaproject Modules

gdgraph, gdctx, gdwiki, gdskills, memory, tasks, health, testing, security, mcp.
`sac` is present in the module table and MCP expose list but default-off.

## Agent Findings

- No existing workspace in this clone (`keryx workspace list` → `[]`).
- Sessions exist; wrap-up requires ≥2 archived messages (`session-wrap-up.ts`).
- Policy experiment is kill-switched (`policy-readiness.integrityReady: false`).
- SAC never writes Flow state; Work is a projection of `flow.json`.
