# SLASH-22 — `/mode`

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> | SLASH-22 | `/mode` | confirmed real dispatch branch (`shell.ts:52913`) | See §3 — fully exercised live already | Same engine, TUI picker when called with no args |
>
> Specifically testing: `/mode` with no arguments in a fresh readline session should display the current permission mode and usage line (per PERM-01: `Permission mode: ask (no project default set)` + usage line).

## What was actually run

```bash
DS_KEY=$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")
printf '/mode\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `c956c03d`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession c956c03d · per-project (keryx shell -c to continue)
  [22m  [2mPermission mode: ask (no project default set)
  Usage: /mode <ask|trust|auto> [save] · /mode clear
  [22m  ❯
```

(ANSI color/dim codes preserved as they appeared; content is readable as: session id, permission mode with default status, and usage line.)

## Cross-checks (if applicable)

None — this is a pure CLI information query with no durable side effects on disk. The output is text-only.

## Summary

The `/mode` command with no arguments correctly displays the current permission mode (`ask`), confirms no project default is set, and provides the full usage line explaining available options (`ask|trust|auto`, `save`, and `clear`). Behavior matches the documented expectation exactly.

## Analysis

The dispatch to `/mode` succeeded (confirmed real dispatch branch per `shell.ts:52913`). The command is implemented as specified in section 3 (Permission modes) of the catalog: when called with no arguments in a fresh session, it reports the live session mode as `ask`, notes that there is no stored project default, and provides the usage syntax. This is consistent with PERM-01's expected output and confirms the feature works as documented.

## Improvement / fix suggestion

None — behaves as documented.
