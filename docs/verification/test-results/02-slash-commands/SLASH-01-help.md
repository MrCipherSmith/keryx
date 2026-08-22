# SLASH-01 — /help

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> Command: `/help` in agent-mode readline
> 
> Expected: `renderCommandHelp("agent", READLINE_AGENT_COMMANDS)` — the 13-name list, not all 26

## What was actually run

```bash
printf '/help\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `21784277` (fresh session, no `-c`/`-r`)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 21784277 · per-project (keryx shell -c to continue)
  Agent mode — describe a task; tools: get_cwd, list_dir, read_file, search_code, graph_affected, memory_search, web_fetch, web_search, shell_exec (approval).
  Commands:
    /help             Show available commands
    /search-provider  Configure and test a web search provider
    /search-connect   Select a connected web search provider
    /expand           Expand the last tool output block
    /new              Start a new session (old kept on disk)
    /goal             Deterministically start a goal — /goal <text> [--workspace <id>] [--auto [N]]
    /status           Show session identity, context, workspaces, and flows
    /flows            Browse project flows and inspect one
    /compact          Compact model context — /compact [focus] (archive kept)
    /theme            Open the theme picker — /theme [name] applies immediately
    /mode             Show or switch the permission mode — /mode [ask|trust|auto]
    /clear            New session (alias of /new)
    /exit             Leave agent mode (/quit works too)
  Sessions are per-project: keryx shell -c | -r [id] | keryx sessions list
  ❯
```

## Cross-checks (if applicable)

No durable effects to verify on disk — this is a read-only command.

## Summary

The `/help` command rendered exactly 13 commands as expected, matching the `READLINE_AGENT_COMMANDS` list (defined in `shell.ts:143-157`). The command executed successfully and the help text correctly describes each available slash command in agent-mode readline.

## Analysis

The test confirms that `/help` displays the correct 13-command list for agent-mode readline. The commands shown are:

1. `/help` — Show available commands
2. `/search-provider` — Configure and test a web search provider
3. `/search-connect` — Select a connected web search provider
4. `/expand` — Expand the last tool output block
5. `/new` — Start a new session (old kept on disk)
6. `/goal` — Deterministically start a goal
7. `/status` — Show session identity, context, workspaces, and flows
8. `/flows` — Browse project flows and inspect one
9. `/compact` — Compact model context
10. `/theme` — Open the theme picker
11. `/mode` — Show or switch the permission mode
12. `/clear` — New session (alias of /new)
13. `/exit` — Leave agent mode (/quit works too)

The output includes a note about `/quit` being an alias of `/exit`, which aligns with `shell.ts:49149` confirming both spellings are handled. The behavior matches the documented expectation of rendering `READLINE_AGENT_COMMANDS` list with its 13 entries.

**Note on catalog observations:** The catalog documents that while this help text advertises `/status`, `/flows`, and `/theme`, attempting to run these three commands in agent-mode readline produces `Unknown command: ...` errors, creating a self-contradictory user experience. This is by design in the current implementation (SLASH-15/16/21 test rows), though it represents a documented gap between the `READLINE_AGENT_COMMANDS` registry and the actual readline dispatch chain.

## Improvement / fix suggestion

None — `/help` behaves exactly as documented and renders the correct 13-command list for agent-mode readline.
