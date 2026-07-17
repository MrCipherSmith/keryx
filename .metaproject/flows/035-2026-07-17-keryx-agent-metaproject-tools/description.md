# Flow 035 — keryx agent metaproject tools (Flow B of SA-01)

Status: formalized
Source: RFC SA-01 §8 Flow B + user decision "subprocess to keryx CLI, classified
constrained-read". Follows flow 033 (agent mode, read-only builtin tools).

## Problem

Agent mode (flow 033) gives the model generic read-only file tools but NOT keryx's
differentiator: navigating the codebase through the graph, wiki, compact search,
and memory. Without these the agent greps blindly and misses project knowledge.

## Expected Outcome

Three read-only metaproject tools, added to the agent registry, each backed by a
FIXED keryx read-only subcommand run as a subprocess with an argv array (no shell
string → no injection); the model supplies only arguments, never a command:

- `search_code` → `keryx ctx rg <pattern> [path]` (compact code/text search).
- `graph_affected` → `keryx gdgraph affected <file>` (blast radius of a file).
- `memory_search` → `keryx memory search "<query>"` (recall decisions/lessons).

Classified risk `read` (constrained-read, auto-allowed by the flow-033 gate): the
command (`keryx`) and subcommand are fixed, args are passed as an argv array, and
the subcommands are read-only. Output is captured, bounded, and returned as the
tool result; failures return an error result without throwing.

## Out of Scope

- No `shell_exec`/arbitrary command, no writes, no approval UX (Flow C).
- No new dependency; no change to the flow-033 driver or the chat core.
