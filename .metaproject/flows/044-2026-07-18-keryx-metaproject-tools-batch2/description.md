# Flow 044 — metaproject tools batch 2

Status: formalized
Source: user direction ("продолжай" — more metaproject tools). Same additive
pattern as flow 043; new ops auto-surface via the flow-038/040 projections.

## Problem

The agent has 8 metaproject tools but still lacks symbol-level navigation and a
compact repo map, and semantic wiki lookup.

## Expected Outcome

New read-only metaproject operations added to the single METAPROJECT_OPERATIONS
source, each auto-surfaced to agent + harness + MCP:
- `graph_symbol` — resolve a symbol to its definitions / callers / callees (gdgraph
  symbol layer: querySymbol).
- `repomap` — a compact, budgeted repository map (gdgraph service repomap).
- `wiki_ask` — semantic wiki lookup (`keryx wiki ask`) IF cleanly backed; else
  dropped and documented.

`MetaprojectPort` gains these as OPTIONAL methods (existing full-port fakes compile
unchanged); createMetaprojectAdapter implements them over the module facades (or a
bounded argv-safe CLI where no in-process facade exists); each degrades to a
structured "unavailable" when its port method is absent. All read-only.

## Out of Scope

- No write/mutating tools. No change to the existing 8 operations, the projections,
  the chat core, or frozen policy. No new dependency. A tool without clean backing is
  DROPPED (documented) rather than faked. At least TWO delivered.
