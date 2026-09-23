# ACP project tools: keryx's own tools, slash commands and model switching in the editor

## Why

Connecting Zed to `keryx acp` on 0.2.154 showed what an editor actually gets today, and it is
less than the reason for building the integration:

- **Five tools, none of them keryx's.** An ACP session offers `get_cwd`, `list_dir`,
  `read_file`, `shell_exec` and `apply_patch` (`src/acp/server.ts`, the roster block). The
  project brain — graph, wiki, memory, flow, skills, `search_code` — is missing, because
  `buildInteractiveAgentTools` needs ports the ACP server does not build (`spawnTool`,
  `searchController`). An editor user gets keryx's policy and durable sessions, but not the
  thing keryx exists to provide.
- **No commands.** keryx never sends `available_commands_update`, so Zed reports
  "Available commands for keryx: none" and refuses `/model` client-side before it reaches us.
- **No model switching.** Provider and model are fixed at process launch. The spec's mechanism —
  `configOptions` with category `model` and `session/set_config_option` — is refused, and this
  repo's transcription of it is untyped (`unknown[]`), with `config_option_update` carrying no
  payload at all.

Wire shapes are pinned against the published ACP documentation
(agentclientprotocol.com, "Slash Commands" and "Session Config Options"), not against the
repo's own transcription, which was silent on both.

## What this flow does

- Offer keryx's read-only project tools in every ACP session where `keryx shell` would offer
  them — same gate (`offersIndexTools`), same tool definitions, composed from the same primitives
  the shell factory uses rather than a second copy — and give each a meaningful ACP tool `kind`.
- Advertise the slash commands keryx actually handles over ACP, and handle them when they arrive
  as prompt text beginning with `/`.
- Expose model selection as a `configOptions` entry of category `model`, switchable through
  `session/set_config_option` and through `/model`, taking effect from the next turn.
- Correct the protocol transcription for the three shapes above.

## Out of scope

`web_fetch`, `web_search`, `spawn_subagent`, bus tools and keryx-side MCP `use_tool` stay out of
the ACP roster: web and MCP tool results carry `untrusted: true`, which activates the
approve-before-announce path that flow 285 fixed but that has no live ACP test, and delegation
needs a spawn port this server does not build. TUI-only commands (`/workspace`, `/review`,
`/integrations`, `/mcp`, `/game`) are not advertised.

## Release

One release after both flow 287 and this flow are done (operator decision, recorded in
journal.md).
