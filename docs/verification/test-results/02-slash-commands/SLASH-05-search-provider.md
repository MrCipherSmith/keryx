# SLASH-05 — /search-provider

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> | ID | Command | readline dispatch? | Expected in readline | TUI-only real behavior to check separately |
> |---|---|---|---|---|
> | SLASH-05 | `/search-provider` | confirmed real (`shell.ts:55167`) | Configure/test a web search provider — runs in readline | Same in TUI, richer picker |

Expected: Configure/test a web search provider — runs in readline.

## What was actually run

```bash
printf '/search-provider\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/SLASH-05-out.txt 2>&1
```

Session id: `1f95a7f3` (full: `7efe1fde-4acc-4321-a04d-7aa11f95a7f3`)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 1f95a7f3 · per-project (keryx shell -c to continue)
  [22m  [2mSearch providers (use /search-provider <id> [key=...]):
  searxng (SearXNG)
  brave (Brave Search API)
  tavily (Tavily)
  exa (Exa)
  [22m
```

## Cross-checks (if applicable)

Verified via CLI:

```bash
$ keryx sessions list
Project: /Users/tsaitler.aleksandr/goodea/keryx
Store:   /Users/tsaitler.aleksandr/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx

ID        UPDATED               MSGS  MODEL                   TITLE
1f95a7f3  2026-08-22 08:52:52   0     deepseek/deepseek-chat  New session
```

Session transcript shows no context entries (correct behavior for a slash command that displays info but does not create a message turn):

```bash
$ keryx sessions export 1f95a7f3
# New session
- id: `7efe1fde-4acc-4321-a04d-7aa11f95a7f3`
- project: `/Users/tsaitler.aleksandr/goodea/keryx`
- updated: 2026-08-22T08:52:52.667Z
- model: deepseek/deepseek-chat
- context: 0 · archive: 0 · compact×0
```

## Summary

The `/search-provider` command worked correctly in readline mode. It displayed the available search providers (searxng, brave, tavily, exa) with a usage hint showing how to select one. The session was created and persisted on disk as expected.

## Analysis

The command behaves exactly as documented in the test case. The slash command is correctly wired in readline mode (dispatched at `shell.ts:55167` as noted in the catalog), and it successfully enumerates the configured search provider options. The help text indicates users can invoke `/search-provider <id> [key=...]` to configure a specific provider. The command does not consume a model turn (0 messages in session), which is correct for an informational slash command.

## Improvement / fix suggestion

None — behaves as documented. The command is properly implemented and accessible via readline mode, consistent with the catalog's expectation.
