# Wiki, Graph, and Shared Agent Context

Version: 1.1.0
Type: architecture
Status: accepted
VerifiedAt: 7d38dba02fad6f8f81d8f244f76b08d0b2f59682
VerifiedScope: sha256:64757f1576d6f43b5e5dc3b0c435d7f45b54d9b4af846a1d7658c19f54b7aff5

## Summary

The project wiki, the code graph, and Shared Agent Context (SAC) are one
connected stack with three owners. Graph answers structural questions. Wiki
stores curated long-lived understanding. SAC is a reviewed collaboration
entry point: it references those owners, projects Flow as Work, and never
becomes a second wiki.

## Details

### What each layer owns

| Layer | Question it answers | Source of truth | Writes |
|---|---|---|---|
| Graph (`src/gdgraph`) | Where is this, what depends on it, what breaks? | `.metaproject/data/gdgraph/storage/` | `keryx gdgraph build` only |
| Wiki (`src/wiki`) | How does this work, why, what is the domain? | `.metaproject/wiki/**` pages with Version/Status | `wiki collect/index/enrich` and accepted SAC `wiki-update` |
| Memory (`src/memory`) | What did we learn, decide, constrain? | `.metaproject/memory/**` accepted entries | `memory new/ingest` and accepted SAC `memory-entry` |
| Flow (`src/flow`) | What is the current work state? | `.metaproject/flows/<id>/flow.json` | `keryx flow` CLI only |
| Session (harness) | What happened in this conversation? | user-global session store | harness; not knowledge |
| SAC (`src/sac`) | What is the bounded Facts/Work/Know-how view of *this* workspace, and which proposal is waiting? | `.metaproject/workspaces/<id>/workspace.json`; access receipts at `.metaproject/context-operations/access-receipts.jsonl` | references + proposals; knowledge writes go through owner writers |

SAC know-how kinds are only `wiki | memory | skill`. Graph is not a knowledge
owner. Wiki collect *reads* the graph to scaffold pages; it does not store
graph rows as wiki prose.

### Runtime cycle

1. Agent orients: wiki index + graph map (optional `keryx orient`).
2. Navigation uses graph tools (`graph_affected`, `graph_symbol`, `search_code`).
3. Conceptual answers use wiki (`wiki_ask` / page reads) and accepted memory.
4. Work state is Flow, not SAC.
5. On wrap-up the agent may `keryx workspace propose` / MCP `sac.propose`
   from a completed session (explicit `workspaceId`; no session auto-bind).
   Shell reads use `workspace_overview` / `workspace_read`.
6. A reviewer `keryx workspace review --decision accepted` (or `sac.review`).
   Only then does the matching owner writer land a draft wiki decision,
   memory entry, or skill. MCP SAC tools refuse HTTP.
7. Audit ids: workspace id, proposal id/revision, access-receipt id, owner
   `targetRef`/`receiptRef`, and the target page Version.

### Fallback

Model-backed commands (`wiki enrich`, narrate/suggest/plan) are fail-closed
without a credential. Graph query, wiki collect/ask, memory search, and SAC
overview/read keep working. There is no silent hosted → local → cache hop.

## Related Code

- `src/sac/fwk-service.ts` — Facts / Work / Know-how assembly
- `src/sac/proposal-lifecycle.ts` — propose/review + ownerFor
- `src/sac/wiki-owner-writer.ts` — accepted wiki-update
- `src/wiki/service.ts` — collect from graph
- `src/gdgraph/build.ts` — graph persistence
- `src/harness/tool/builtin/workspace-context-tool.ts` — shell FWK tools
- `src/commands/workspace.ts` — CLI adapter
- `src/mcp/tools.ts` — `sac.*` tools
- `src/harness/provider/single-turn.ts` — fail-closed model turns
- `docs/docs/guides/shared-agent-context.md` — current-behavior operator guide
- `docs/verification/wiki-graph-sac-proof.md` — reproducible runbook

## Related Wiki

- [Wiki Index](../index.md)
- [Project Map](project-map.md)
- [Module src/wiki](../components/src-wiki.md)
- [Module src/gdgraph](../components/src-gdgraph.md)
- [Module src/memory](../components/src-memory.md)

## Changelog

- 1.1.0 - Current CLI/MCP/harness names and access-receipt ledger path.
- 1.0.0 - Architecture page for the complementary wiki/graph/SAC split (flow 153).
- 0.1.0 - Initial scaffold.
