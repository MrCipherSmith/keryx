# Connect your agents

Keryx installs small, tagged hooks and instruction files into the coding agents you already use, and can serve the project's knowledge to them over MCP. Every agent you drive then follows the same routing, security checks and orientation, instead of each one needing its own setup.

## When to use it

- You use an editor or agent other than `keryx shell` and want it to read `.metaproject/` and call `keryx` the same way.
- You want an agent's shell and search calls routed through compact output, and its prompts and tool results screened for secrets.
- You want an editor to call Keryx tools (graph, wiki, memory) over MCP.
- You want an editor to drive the Keryx harness itself over the Agent Client Protocol (ACP).
- You need to know whether an install is still intact after an agent rewrote its own settings.

## Quick example

Run this in a scratch repository after `keryx init --yes`. The commands write only inside that repository.

```bash
keryx integrations install --runtime claude --dry-run
keryx integrations install --runtime gemini-cli
keryx integrations doctor --runtime gemini-cli
keryx integrate claude --dry-run
```

```text
keryx integrations install (dry run)
  claude
  · ctx-guard (block) -> .claude/settings.local.json would-install
  · orient (inject-context) -> .claude/settings.local.json would-install
  · security-check-input (prompt-gate) -> .claude/settings.local.json would-install
  · security-check-output (block) -> .claude/settings.local.json would-install

keryx integrations install
  gemini-cli
  ✓ ctx-guard (block) -> .gemini/settings.json installed
      experimental — verify on a live install
  ✓ instructions (instructions) -> GEMINI.md installed
      experimental — verify on a live install

keryx integrations doctor
  gemini-cli ok
  ✓ ctx-guard (block) — valid
  ✓ instructions (instructions) — valid

keryx integrate (dry run)
  → claude → would write .mcp.json:
…
  would set modules.mcp.enabled=true in .metaproject/metaproject.json
```

## How it works

There are four separate ways to connect an agent. They do not depend on each other.

| Path | What it does | Command |
|---|---|---|
| Hooks and instructions | Writes tagged hook entries and instruction files into the agent's own config | `keryx integrations install` |
| Global bootstrap | Writes one standing instruction block into the agent's user-level instruction file | `keryx agents bootstrap install` |
| MCP server | Lets an editor call Keryx tools; `integrate` writes the editor's MCP client config | `keryx integrate`, `keryx serve-mcp` |
| ACP server | Lets an editor drive a Keryx harness turn over stdio | `keryx acp` |

**Integrations** come from one registry. Each agent is described once, as capability flags on named surfaces: `block` (guard shell and search calls), `prompt-gate` (screen prompts), `inject-context` (add orientation at turn start), `instructions`, `agents`, `rules`, and a few surfaces only the Keryx shell has. `install` applies each surface in a fixed order and records what it wrote. `doctor` compares that record with the live file and names the drift. `uninstall` removes only the entries Keryx tagged and leaves yours alone. Use `--surface` to act on one surface and `--dry-run` to preview. See [Integrations and adapters](../integrations.md) for install state and the generated capability matrix.

<!-- retired-spellings-ok: line — the retired spelling is named here on purpose, to say it is retired -->

**`integrate`** registers Keryx as an MCP server in a project-local client config (`cursor`, `claude`, `opencode`, `vscode`, `generic`, or `all`) and sets `modules.mcp.enabled=true`. `vscode` is opt-in and not part of `all`. **`serve-mcp`** is the server it points at: stdio by default, `--http` for a localhost-only HTTP/SSE transport, and `--read-only` to hide every tool that changes something. Both need the optional MCP SDK, and the module stays off until you integrate. The old `keryx mcp serve` spelling is retired.

**`agents bootstrap`** writes a standing instruction block into a runtime's user-level file, outside any project. The runtimes are `claude`, `opencode`, `zcode`, `codex` and `antigravity`. Run `status` first and `install --dry-run` before you write.

**`keryx acp`** speaks ACP v1 over stdio. The editor launches it as a subprocess, opens a session for a project and receives streamed turns. Gated tool calls go back to the editor as permission requests. For the opposite direction, where Keryx drives another agent, see [Delegation](delegation.md).

### Compatibility

Output of `keryx integrations matrix`. `native` is a verified host-hook adapter; `adapter` is a bridge or an experimental adapter.

| Runtime id | State | Confidence | Supported surfaces |
|---|---|---|---|
| `claude` | native | verified | block, prompt-gate, inject-context, observe, agents, rules |
| `codex` | native | verified | block, inject-context, agents, rules |
| `cursor` | native | verified | block, prompt-gate, inject-context, rules |
| `windsurf` | native | verified | block, prompt-gate, rules |
| `keryx-shell` | adapter | verified | block, prompt-gate, inject-context, pre-tool-context, observe, post-tool, session-start, stop |
| `antigravity` | adapter | experimental | block |
| `opencode` | adapter | experimental | block, agents |
| `zed` | adapter | experimental | block, instructions |
| `generic-mcp` | adapter | experimental | block, prompt-gate |
| `gemini-cli` | adapter | experimental | block, instructions, rules |
| `kiro` | adapter | experimental | block, agents, instructions, rules |
| `github-copilot-agent` | adapter | experimental | block, instructions, rules |

`--runtime` takes one id, a comma-separated list, or `all`.

## Common tasks

| I want to… | Command or page |
|---|---|
| See every runtime and surface | `keryx integrations matrix` |
| Preview an install | `keryx integrations install --runtime <id> --dry-run` |
| Install one surface only | `keryx integrations install --runtime <id> --surface block` |
| Check an install for drift | `keryx integrations doctor --runtime all` |
| Remove what Keryx installed | `keryx integrations uninstall --runtime <id>` |
| Give an editor Keryx tools over MCP | `keryx integrate <editor>` |
| Expose only read-only tools | `keryx serve-mcp --read-only` |
| Add the standing block to a user-level file | `keryx agents bootstrap install --runtime <id> --dry-run` |
| Let an editor drive a Keryx turn | `keryx acp` |
| Wire an agent by hand | [Agent installation playbook](../agent-installation-playbook.md) |

## Status

Hook integrations are stable for the verified adapters and experimental for every adapter marked experimental above; verify those on a live install. The MCP server and `integrate` are opt-in (module `mcp`, off by default). The ACP server has no authentication on its wire and no HTTP transport; it has been driven by hand from one editor and is otherwise covered by a scripted test client.

## Reference

- CLI reference: [integrations](../cli-reference.md#integrations), [integrate](../cli-reference.md#integrate), [serve-mcp](../cli-reference.md#serve-mcp), [acp](../cli-reference.md#acp), [agents](../cli-reference.md#agents)
- [Integrations and adapters](../integrations.md): install state, drift reports and the generated matrix
- [Give an agent context](../guides/give-an-agent-context.md)
- [MCP servers in the shell](mcp-servers.md): the opposite direction, Keryx as an MCP client
