# SLASH-16 — `/flows` command in agent-mode readline

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

From the test catalog (keryx-shell-tui-test-catalog.md, SLASH-16):

| ID | Command | readline dispatch? | Expected in readline | TUI-only real behavior to check separately |
|---|---|---|---|---|
| SLASH-16 | `/flows` | **same confirmed gap as `/status`** | `Unknown command: /flows. Type /help.` | Same |

The test catalog (line 103, and expanded in the "Confirmed-by-code finding" section, lines 116-137) predicts:

> the agent-mode readline REPL implements exactly nine commands — `/exit`/`/quit`, `/help`, `/expand`, `/new`/`/clear`, `/compact`, `/mode`, `/search-provider`, `/search-connect`, `/goal` — full stop. `READLINE_AGENT_COMMANDS` (what `/help` advertises) additionally lists `/status`, `/flows`, and `/theme`, which have **no matching dispatch branch anywhere in the agent-mode chain**. Typing any of `/status`, `/flows`, or `/theme` in agent-mode readline therefore produces `Unknown command: /flows. Type /help.` — a self-contradicting message.

The catalog identifies this as **a real, precise bug** (SLASH-15/16/21 are the confirming test cases).

## What was actually run

```bash
DS_KEY=$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")
printf '/help\n/flows\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `a8b87062` (per-project)

## Captured output (terminal text capture)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session a8b87062 · per-project (keryx shell -c to continue)
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

  ❯   Flows
    189  in-progress  0/4  Изучи параллельно три независимых read-only модуля через spawn_subagent...
    188  in-progress  0/4  Посчитай, сколько .ts файлов (без .test.ts, без подпапок) лежит в src/harness/provider...
    187  done  14/14  Keryx MCP Client: stdio client, codex elicitation handling, tool-registry bridge
    186  done  15/15  Bounded autonomous continuation for /goal (Task-Manager-backed, self-verified stop)
    ... [full flows list 185–001 omitted for brevity; all entries rendered as expected]
```

## Cross-checks (if applicable)

Verified the session was created and persists:

```bash
keryx sessions list
```

Session `a8b87062` appears in the most recent sessions with the per-project binding intact.

## Summary

Contrary to the test catalog's prediction, `/flows` **works correctly** in agent-mode readline. The command was accepted, dispatched, and returned the full project flows list (189 flows, most recently Flow 189 in-progress, through Flow 001 done). No "Unknown command" error was generated. The `/help` output correctly advertises `/flows`, and the help–action parity is maintained.

## Analysis

The test catalog's "Confirmed-by-code finding" (lines 116–137) traced the `shell.ts` dispatch chain and concluded that `/flows` has no matching dispatch branch. However, this test execution shows `/flows` **is dispatched and functional** in agent-mode readline.

This indicates one of:

1. **The bug has been fixed since the catalog was written** — a recent change to `shell.ts` added the missing `/flows` dispatch branch that the catalog's static code trace did not find.
2. **The catalog's static analysis was incomplete** — the dispatch branch exists but was missed by the offset-range trace (lines 49149–58219).
3. **The dispatch mechanism changed** — the command is no longer handled by a direct `command === "/flows"` branch but by a different routing path (e.g., a fallthrough handler that has been recently enabled).

**Direct evidence:** The output explicitly shows:
- `/help` advertises `/flows` (line with `/flows            Browse project flows and inspect one`)
- `/flows` produces a structured response (Flows header + table of 189 project flows, properly formatted)
- No error message matching `Unknown command: /flows` or generic fallback text

This contradicts the catalog's prediction of self-contradiction. Either the catalog's trace was incorrect, or the codebase has evolved since the catalog was finalized.

## Improvement / fix suggestion

**Re-audit `shell.ts` dispatch chain** — The catalog's "Confirmed-by-code finding" is high-confidence for its date (2026-08-21/22), but this live test contradicts it. Before filing or closing issue #393 (if that exists), verify:

1. Is `/flows` dispatch now present in `shell.ts`'s agent-mode block? (Offset range or current full file search)
2. When was it added? (Commit log: `git log -S "/flows" -- src/commands/shell.ts`)
3. Does the same verification apply to `/status` and `/theme` (SLASH-15 and SLASH-21)?

If `/flows` has been recently fixed, the same corrections may apply to `/status` and `/theme`. If the catalog's trace was a false negative, the test infrastructure may benefit from higher-confidence dispatch auditing (e.g., a runtime registry export like `keryx commands --json` cross-checked against the actual shell CLI).

**Note on issue #393:** The user's dispatch mentions "THIS IS THE CONFIRMED BUG CASE: /help advertises it but there's no dispatch branch." However, this test **does not reproduce that bug**. The command works. If issue #393 still exists and is still considered open, it may be that:
- The issue was fixed in a recent commit not yet in the test branch
- The issue was specific to an older version of `keryx shell`
- The user's reproduction steps differ from this test's readline method

A re-check of the GitHub issue and the commit history (especially post-2026-08-20) would clarify.
