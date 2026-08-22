# SLASH-21 — `/theme` advertised but unreachable in agent-mode readline

**Area:** Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS (bug confirmed)

## Test case (from the catalog)

> SLASH-21: `/theme` is **advertised by `/help` but the only `/theme` dispatch branch found is in the CHAT-mode block (`shell.ts:12517`), not the agent-mode block** — same confirmed gap as `/status`/`/flows`.
>
> Expected in readline: `Unknown command: /theme. Type /help.` in agent-mode readline
>
> TUI-only real behavior to check separately: TUI: visual theme picker

This is a confirmed self-contradicting bug case (same family as SLASH-15/16): the command registry advertises `/theme` in the help output, but the agent-mode readline REPL has no dispatch branch for it.

## What was actually run

```bash
DS_KEY=$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")
printf '/help\n/theme\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `01b43d57` (per-project, fresh session)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 01b43d57 · per-project (keryx shell -c to continue)
  [22m  [2mAgent mode — describe a task; tools: get_cwd, list_dir, read_file, search_code, graph_affected, memory_search, web_fetch, web_search, shell_exec (approval).
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
  [22m  ❯   [2mUnknown command: /theme. Type /help.
  [22m  ❯
```

## Cross-checks (if applicable)

Session exists on disk:
```bash
keryx sessions list | head -5
```

The session `01b43d57` was created successfully and can be exported to verify the transcript.

## Summary

The test confirms the self-contradicting bug: `/help` displays `/theme` as an available command (line 16 of output: `/theme            Open the theme picker — /theme [name] applies immediately`), but when a user tries to execute `/theme` in agent-mode readline, they receive `Unknown command: /theme. Type /help.` (line 21). This is unhelpful because the help message that just displayed explicitly lists `/theme` as available.

## Analysis

The bug occurs because:

1. The `/help` command renders the list from `READLINE_AGENT_COMMANDS` (`shell.ts:143-157`), which includes `/theme` in its array.
2. However, in the agent-mode REPL's command dispatch chain (`shell.ts:49149-58219`), the only dispatch handler for `/theme` is in the separate CHAT-mode block (`shell.ts:12517`), not in the agent-mode chain.
3. When `/theme` is typed in agent-mode readline, it falls through to the generic "Unknown command" handler (`shell.ts:1482-1489`) instead of matching any dispatch branch.
4. The registry's `modes` dimension only encodes chat-vs-agent, not TUI-vs-readline, so even though `/theme` is tagged as `agent`-mode in the registry (matching the current shell mode), no readline dispatch branch exists for it.

This is a structurally precise bug: the `READLINE_AGENT_COMMANDS` whitelist (what `/help` advertises) and the actual `else if (command === "/theme")` dispatch chain have silently drifted apart. The catalog's "Confirmed-by-code finding" section (lines 116–137) traces the exact discrepancy.

This bug directly relates to GitHub issue #393: https://github.com/MrCipherSmith/keryx/issues/393 — the same self-contradicting message issue that affects `/status` (SLASH-15) and `/flows` (SLASH-16).

## Improvement / fix suggestion

Fix the registry whitelist and agent-mode dispatch mismatch by either:

1. **Remove `/theme` from `READLINE_AGENT_COMMANDS`** if `/theme` is intentionally TUI-only and should not be advertised in agent-mode help.
2. **Add `/theme` dispatch to the agent-mode REPL chain** if `/theme` should work in readline (likely with degraded UX compared to TUI, similar to how `/mode`, `/search-provider`, etc. are handled in readline).

This is one of three identical bugs in the same registry (SLASH-15, SLASH-16, SLASH-21 all require the same fix). Addressing the root cause — keeping `READLINE_AGENT_COMMANDS` in sync with the actual dispatch chain — will resolve all three.
