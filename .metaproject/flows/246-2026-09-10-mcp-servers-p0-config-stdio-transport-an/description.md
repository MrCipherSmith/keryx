# MCP servers P0: config, stdio, and search_tool/use_tool

Source: `docs/requirements/keryx-mcp-servers/`, phase P0 of its
implementation plan. Specification ready since roadmap 0.29.0; nothing of the
consumer implemented.

## Problem

keryx publishes itself over MCP and cannot consume anyone else's. An operator
who has an MCP server — filesystem, a tracker, an internal service — has no way
to let `keryx shell` use it. Every other agent shell in this class can.

Established against current code, not assumed:

- `src/mcp-client/` connects to exactly one thing: a keryx-spawned
  `codex mcp-server`, over stdio, for elicitation. It has `callTool` and
  `close`, does not read user config, does not speak HTTP, and does not
  register anything on the interactive agent.
- `src/tui/mcp-inspector.ts` still states that keryx does not consume MCP
  servers as a client.
- `InteractiveTool[]` in `src/commands/agent.ts` is a static list. There is no
  `search_tool` / `use_tool` pair.
- `GatedToolRisk` is `read | shell | destructive | delegate | write`. There is
  no MCP risk class.

## Why this phase is possible now

`keryx mcp` used to BE the publisher. The consumer verbs this package
specifies had no name to occupy. The rename shipped in 0.2.85 — `serve-mcp`
and `integrate` took the publisher's work, every retired spelling still runs
and prints one deprecation line, and `keryx mcp` is free.

Two of the package's own criteria are therefore already met and are NOT part of
this flow: spec AC8 (publisher renamed, nothing broken) and spec AC9 (`/mcps`
never registered, guarded and mutation-verified).

## Scope of P0

The narrowest slice that makes the feature real: a user or project JSON file
and one stdio server are enough for the shell to search and call an MCP tool.

Out of this phase, by the plan's own split: HTTP transport and its doctor
fields (P1), OAuth and compat import of Cursor/Claude/Grok configs (P3), the
consumer TUI modal and the Tools-tab caption (P2).

## The shape that is easy to get wrong

Grok Build exposes a STABLE pair — `search_tool` and `use_tool` — rather than
dumping every connected MCP tool onto the model's tool list, and this package
specifies that deliberately. The dump is what OpenCode does; it grows the
advertised surface with every server the operator adds, and the model pays for
all of it on every turn. spec AC5 is the guard: the advertised definitions must
contain the pair and none of the N qualified names.

## Out of scope

- Changing `keryx serve-mcp` / `keryx integrate`, or the Codex elicitation
  path in `src/harness/external/supervise-mcp.ts`.
- Adding a capability flag. spec AC18 pins that this package does not.
