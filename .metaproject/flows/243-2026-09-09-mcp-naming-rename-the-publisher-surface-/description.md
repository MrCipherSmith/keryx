# Problem

`keryx mcp` means "keryx is the MCP server": `serve` runs it, `install` writes
keryx into an editor's client config. The `keryx-mcp-servers` package needs the
same verb to mean the opposite — the third-party servers keryx *connects to* —
because `mcp add|list|remove` is what that phrase means in every other CLI.

MCP names a protocol, not a direction. keryx is on both sides of it, and the
name does not say which.

Decision taken 2026-09-09 (D-04, rewritten in
`docs/requirements/keryx-mcp-servers/decisions.md`): the consumer keeps `mcp`;
the publisher is renamed to say what it does.

# Expected outcome

| was | is |
|---|---|
| `keryx mcp serve` | `keryx serve-mcp` |
| `keryx mcp install --runtime <editor>` | `keryx integrate <editor>` |
| `keryx mcp uninstall --runtime <editor>` | `keryx integrate --remove <editor>` |
| `/mcp` (TUI installer view) | `/integrations` |

Every retired spelling keeps working and prints exactly one line naming its
replacement. Nothing is removed; no existing script breaks.

# Out of scope

- The consumer surface itself (`keryx mcp add|list|…`, the tool catalog,
  `search_tool` / `use_tool`, OAuth, compat import). That is the
  `keryx-mcp-servers` package and its own flows.
- Any behaviour change. This flow renames and aliases; it does not alter what
  serving or integrating actually does.
- Removing the retired spellings. They stay until a separate, later decision.

# The sequencing problem this flow has to solve

`/mcp` cannot become the consumer view here, because the consumer does not
exist yet. Flipping it now would leave a slash command pointing at nothing.

So: `/integrations` becomes the installer view's name, and `/mcp` stays a
working alias of it — deprecated in help text and documented as reserved for
the consumer. The consumer flow flips `/mcp` and drops the alias.

Recorded because the specification does not say it, and a reader who only read
the spec would expect `/mcp` to change meaning in this flow.

# Constraint carried in from memory

`keryx` on PATH is an installed build, not the working tree
(`.metaproject/memory/constraints/stale-installed-keryx-binary.md`). Any check
of this rename that runs the installed binary proves nothing about the change.
Verification must run the working tree — this bit the operator's own workflow
earlier today, when `keryx update` used the installed 0.2.84 and silently
ignored a template fix that was already in source.
