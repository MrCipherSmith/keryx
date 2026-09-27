---
Title: "Wiki, Graph, and Shared Agent Context"
Version: 1.1.0
Type: architecture
Status: accepted
Summary: ""
---
```markdown
---
Title: "Wiki, Graph, and Shared Agent Context"
Version: 1.1.0
Type: architecture
Status: accepted
Summary: "Three-layer knowledge architecture where the code graph answers structural questions, the wiki stores curated long-lived understanding, and Shared Agent Context (SAC) provides a reviewed collaboration entry point that references both owners without duplicating them."
---
# Wiki, Graph, and Shared Agent Context

VerifiedAt: 7d38dba02fad6f8f81d8f244f76b08d0b2f59682
VerifiedScope: sha256:64757f1576d6f43b5e5dc3b0c435d7f45b54d9b4af846a1d7658c19f54b7aff5

## Summary

The project wiki, the code graph, and Shared Agent Context (SAC) form a unified knowledge stack with three distinct owners. Each layer has a clear responsibility:

- **Graph** answers structural questions: location, dependencies, and impact analysis.
- **Wiki** stores curated, long-lived understanding: how things work, why decisions were made, and domain context.
- **SAC** is a reviewed collaboration entry point that references these owners, projects Flow as Work, and explicitly avoids becoming a second wiki.

This separation prevents knowledge fragmentation while enabling agents and humans to navigate from high-level context to precise structural details and back.

## Details

### What each layer owns

The following table maps each knowledge layer to its primary question, source of truth, and permitted write paths.

| Layer | Question it answers | Source of truth | Writes |
|---|---|---|---|
| Graph (`src/gdgraph`) | Where is this, what depends on it, what breaks? | `.metaproject/data/gdgraph/storage/` | `keryx gdgraph build` only |
| Wiki (`src/wiki`) | How does this work, why, what is the domain? | `.metaproject/wiki/**` pages with Version/Status | `wiki collect/index/enrich` and accepted SAC `wiki-update` |
| Memory (`src/memory`) | What did we learn, decide, constrain? | `.metaproject/memory/**` accepted entries | `memory new/ingest` and accepted SAC `memory-entry` |
| Flow (`src/flow`) | What is the current work state? | `.metaproject/flows/<id>/flow.json` | `keryx flow` CLI only |
| Session (harness) | What happened in this conversation? | user-global session store | harness; not knowledge |
| SAC (`src/sac`) | What is the bounded Facts/Work/Know-how view of *this* workspace, and which proposal is waiting? | `.metaproject/workspaces/<id>/workspace.json`; access receipts at `.metaproject/context-operations/access-receipts.jsonl` | references + proposals; knowledge writes go through owner writers |

#### SAC Know-how and Graph exclusion

SAC know-how kinds are limited to `wiki`, `memory`, and `skill`. These correspond to the knowledge owners that can receive writes through the SAC review process. The graph is explicitly excluded from this list because it is a structural index, not a knowledge store. Agents can consult the graph for navigation, but the graph does not participate in the review-to-write pipeline.

#### Wiki collect and graph scaffolding

Wiki collect *reads* the graph to scaffold new pages. This is a one-way read operation: graph data structures are used to generate initial page content, but graph rows are never persisted as wiki prose. The wiki remains the authoritative source for conceptual documentation.

### Runtime cycle

The following sequence describes how an agent moves through the knowledge stack during a typical session.

1. **Orient**: The agent loads the wiki index and optionally the graph map using `keryx orient`. This establishes a baseline of available documentation and structural context.

2. **Navigate**: During exploration, the agent uses graph tools (`graph_affected`, `graph_symbol`, `search_code`) to trace dependencies and locate code.

3. **Conceptualize**: For understanding how and why, the agent reads wiki pages (`wiki_ask` / page reads) and searches accepted memory entries.

4. **Track work**: Current work state lives in Flow, not in SAC. Agents update flow state to reflect progress.

5. **Propose**: On wrap-up, the agent may call `keryx workspace propose` or the MCP `sac.propose` tool from a completed session. This requires an explicit `workspaceId`; there is no automatic session-to-workspace binding. Shell reads use `workspace_overview` / `workspace_read`.

6. **Review**: A reviewer runs `keryx workspace review --decision accepted` or uses the MCP `sac.review` tool. Only after acceptance does the matching owner writer land a draft wiki decision, memory entry, or skill. MCP SAC tools explicitly refuse HTTP requests to prevent unintended side effects.

7. **Audit**: All state changes record workspace id, proposal id/revision, access-receipt id, owner `targetRef`/`receiptRef`, and the target page Version for traceability.

### Fallback

Model-backed commands such as `wiki enrich`, narrate, suggest, and plan are fail-closed when credentials are unavailable. These operations require external API access and cannot proceed safely without it.

In contrast, graph queries, wiki collect/ask, memory search, and SAC overview/read continue to function. These operations read from local stores and do not depend on external services.

There is no silent fallback chain (hosted → local → cache) that could mask credential failures or produce unexpected results.

## Related Code

- `src/sac/fwk-service.ts` — Assembles the Facts, Work, and Know-how view for a workspace
- `src/sac/proposal-lifecycle.ts` — Manages propose/review transitions and owner routing
- `src/sac/wiki-owner-writer.ts` — Lands accepted wiki updates to the wiki owner
- `src/wiki/service.ts` — Collects and indexes wiki content, reads graph for scaffolding
- `src/gdgraph/build.ts` — Persists graph data from code analysis
- `src/harness/tool/builtin/workspace-context-tool.ts` — Provides shell FWK tools to the harness
- `src/commands/workspace.ts` — CLI adapter for workspace operations
- `src/mcp/tools.ts` — Exposes `sac.*` tools via the Model Context Protocol
- `src/harness/provider/single-turn.ts` — Enforces fail-closed behavior for model turns
- `docs/docs/guides/shared-agent-context.md` — Operator guide for current behavior
- `docs/verification/wiki-graph-sac-proof.md` — Reproducible runbook for verification

## Related Wiki

- [Wiki Index](../index.md)
- [Project Map](project-map.md)
- [Module src/wiki](../components/src-wiki.md)
- [Module src/gdgraph](../components/src-gdgraph.md)
- [Module src/memory](../components/src-memory.md)

## Changelog

- **1.1.0** - Current CLI/MCP/harness names and access-receipt ledger path.
- **1.0.0** - Architecture page for the complementary wiki/graph/SAC split (flow 153).
- **0.1.0** - Initial scaffold.
```
