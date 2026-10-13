# MCP servers in the shell

`keryx mcp` manages the third-party MCP servers that `keryx shell` connects out to, so the model can use their tools. It keeps those servers' commands, credentials and approvals under rules you can read, instead of leaving them as unreviewed entries in a config file.

This is the opposite direction from [Connect your agents](integrations.md), where Keryx is the MCP server and an editor is the client.

## When to use it

- You want the shell's model to read a filesystem, a docs index or an issue tracker through an MCP server.
- Your team wants to commit a shared server list in the repository, and each person to approve it before it runs.
- A remote server needs a bearer token or an OAuth login and you want Keryx to keep that credential out of files you commit.
- A server fails to connect and you need to know whether the config, the credential or the server is at fault.

## Quick example

```bash
keryx mcp add notes -- npx -y @modelcontextprotocol/server-filesystem ~/notes
keryx mcp add docs --scope project -- npx -y some-docs-mcp
keryx mcp list
keryx mcp trust docs
keryx mcp disable notes
```

```text
docs (project) (needs approval) stdio — npx -y some-docs-mcp
notes (user) stdio — npx -y @modelcontextprotocol/server-filesystem …/notes

1 server(s) from committed config are not started until approved — a committed config is code someone else wrote.
Read what it launches above, then: keryx mcp trust <name>

Approved "docs" from …/.keryx/mcp-servers.json:
  npx -y some-docs-mcp
It will start with the next shell. Editing that command revokes this approval.
Disabled "notes" for this account (…/mcp-servers-disabled.json).
```

The stdio form needs `--` before the server's command, so Keryx can tell its own flags from the server's.

## How it works

**What the model sees.** The model gets two tools, `search_tool` and `use_tool`, however many servers you connect. It searches for a tool by description and calls it by qualified name (`server__tool`). The tool surface therefore costs the same with one server or ten. The trade-off is that the model cannot see a tool it has not searched for. Every call goes through the same approval prompt as `shell_exec`, and a server starts without Keryx's own credentials in its environment.

**Scope.** `--scope user` (the default) writes `mcp-servers.json` in your Keryx config directory, readable only by you. `--scope project` writes `.keryx/mcp-servers.json` in the repository, meant to be committed, and it wins over the user file for the same name. `keryx mcp disable` and `enable` are a personal overlay in your config directory, never an edit to the committed file, so disabling a project server produces no diff for your colleagues. In `--trust` mode you can trust one exact tool for a session, never a tool its server marks `destructiveHint`. In the shell, `/mcp trust list` and `/mcp trust revoke <server__tool>|all` show and remove those grants.

**Trust.** A project server is a command someone else wrote the moment you clone the repository, so Keryx will not start one until you run `keryx mcp trust <name>`. The approval is bound to the exact command: a later commit that changes it needs approving again. It is stored in your config directory, never in the repository. Your own `user` servers need no approval.

**Servers from other tools.** Keryx also reads MCP servers configured for other tools, as a layer below its own files: a name defined in `.keryx/mcp-servers.json` or your user file wins over the same name from these. The sources are `~/.claude.json`, `~/.cursor/mcp.json`, `./.cursor/mcp.json`, `./.mcp.json` and `~/.grok/config.toml` and `./.grok/config.toml`; where two of them define the same name, Claude's wins over Cursor's, then `.mcp.json`, then Grok's. `keryx mcp list` shows each one with the tool it came from, for example `foo (cursor) stdio`, so you know which file to edit. Trust follows where the file lives, not which tool wrote it: a server from a file inside the repository (`./.cursor/mcp.json`, `./.mcp.json`, `./.grok/config.toml`) is a project server and needs `keryx mcp trust <name>` before it starts, while one from your home directory is yours and needs no approval.

**Credentials.** Remote servers use `--transport http <url>`. Credentials come from the environment, for example `--header 'Authorization: Bearer ${TRACKER_TOKEN}'`. If the variable is unset Keryx refuses to dial, rather than sending an empty bearer and letting the server answer 401. `keryx mcp doctor` then names the cause:

```text
tracker [user] http: needs_auth — header "Authorization" needs TRACKER_TOKEN, which is unset
  unset: Authorization
```

Keryx also refuses to follow a redirect, because a custom credential header would follow it; refuses a username or password written into the URL; and refuses an unset `${VAR}` in the URL. `keryx mcp auth <name>` runs a remote server's OAuth flow in your browser. It is the only command that opens a browser, it exits non-zero without a terminal, and it stores tokens owner-only in `mcp-credentials.json`, keyed by server name and URL. `keryx mcp logout <name>` forgets them. The full rules are in [the CLI reference](../cli-reference.md#mcp-consumer-connecting-keryx-to-other-mcp-servers).

## Common tasks

| I want to… | Command or page |
|---|---|
| Add a local server | `keryx mcp add <name> -- <command…>` |
| Add a remote server | `keryx mcp add <name> --transport http <url> --header 'K: V'` |
| Share a server with my team | `keryx mcp add <name> --scope project -- <command…>`, then commit `.keryx/mcp-servers.json` |
| Approve a committed server | `keryx mcp trust <name>`; withdraw with `keryx mcp untrust <name>` |
| See what is configured and from where | `keryx mcp list [--json]` |
| Find out why a server fails | `keryx mcp doctor [name]` |
| Log in to a remote server | `keryx mcp auth <name>`; forget with `keryx mcp logout <name>` |
| Turn a server off for me only | `keryx mcp disable <name>` |
| Remove a server | `keryx mcp remove <name> [--scope user\|project]` |
| Check the list from inside a session | `/mcp` in the shell |

## Status

<!-- retired-spellings-ok: line — the retired spelling is named here on purpose, to say it is retired -->

Stable for stdio and remote HTTP servers, project and user scope, trust, `doctor` and OAuth login. There is no import step: servers you already configured for other tools are read automatically (see "Servers from other tools"). The retired `keryx mcp serve`, `install` and `uninstall` spellings still work but print a deprecation line and point at [`serve-mcp` and `integrate`](integrations.md).

## Reference

- [CLI reference: mcp (consumer)](../cli-reference.md#mcp-consumer-connecting-keryx-to-other-mcp-servers) for every flag, config file, `oauth` field and refusal
- [Connect your agents](integrations.md): Keryx as an MCP server
- [Choose an approval mode](../guides/permission-modes.md): the gate every MCP call passes through
- [Security model](../concepts/security-model.md)
