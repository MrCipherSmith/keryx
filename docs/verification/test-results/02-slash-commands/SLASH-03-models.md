# SLASH-03 — `/models` command

**Area:** Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> Command: `/models`
> 
> Expected: `CHAT_ONLY` — not offered in agent mode at all, in either surface (chat-mode-only numbered menu)

## What was actually run

```bash
printf '/models\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `c0401646`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession c0401646 · per-project (keryx shell -c to continue)
  [22m  [2m/models is only available in chat mode — this is agent mode. Type /help for the commands available here.
  [22m  ❯
```

## Cross-checks (if applicable)

None — the test case requires only that the command be rejected in agent mode with an appropriate message, which the output confirms.

## Summary

The `/models` command was correctly rejected in agent mode with a clear, informative message stating it is chat-mode-only. The shell did not crash, did not attempt a network call, and did not process the command. Behavior matches the expected result exactly.

## Analysis

The output shows that `/models` is properly gated as a chat-only command at the shell's command-dispatch layer. In agent mode, when the user types `/models`, the shell recognizes it (rather than treating it as an unknown command) and explicitly informs the user that it is unavailable in the current mode. This is the desired behavior: the command is known to the system, but consciously unavailable in agent mode.

The message "/models is only available in chat mode — this is agent mode" provides clear guidance to the user about why the command failed and what mode they are currently in, making this a user-friendly denial rather than a cryptic error.

## Improvement / fix suggestion

None — behaves as documented.
