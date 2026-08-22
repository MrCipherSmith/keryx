# PERM-02 — `--trust` CLI flag sets permission mode for the session

**Area:** Permission modes · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> **ID:** PERM-02 · **Test:** `--trust` CLI flag sets it for the session
>
> **Command(s):** `keryx shell --trust --no-tui ...`
>
> **Expected:** Same as sending `/mode trust` as line 1
>
> **Verify:** `/mode` on the next line reports `trust`

## What was actually run

```bash
printf '/mode\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --trust --no-tui --provider deepseek
```

Session id: `42af2c52`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 42af2c52 · per-project (keryx shell -c to continue)
  Permission mode: trust (no project default set)
  Usage: /mode <ask|trust|auto> [save] · /mode clear
  ❯
```

## Cross-checks (if applicable)

The session identifier from the output confirms a fresh per-project session was created. The permission mode line directly reports the current mode as `trust`, confirming the `--trust` CLI flag set the correct mode for the session. No durable file state changes were tested for this case (the mode is per-session, not persisted to disk).

## Summary

The `--trust` CLI flag correctly sets the permission mode to `trust` for the session. The `/mode` command executed immediately after shell startup (piped as the first input line) reported the mode as `trust`, exactly as expected. This is equivalent to sending `/mode trust` as the first command in a normal session without the flag.

## Analysis

The test confirms that the `--trust` CLI flag parameter is properly wired into the session initialization code. When the shell starts with `--trust`, it pre-sets the permission mode to `trust` before the REPL begins, so the mode is immediately active without requiring an explicit `/mode trust` command. The `/mode` command (with no arguments) correctly reports the active mode, fulfilling the verification requirement. This behavior matches the documented intent: the flag provides a way to set a session-wide permission mode at shell startup time, which is essential for scripted/automated sessions that need approval gates pre-configured.

## Improvement / fix suggestion

None — behaves as documented.
