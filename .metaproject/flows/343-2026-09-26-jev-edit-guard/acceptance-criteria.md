# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review jev-edit-guard --hook claude` reads a Claude Code `PostToolUse` payload from stdin, diffs the named `Edit`/`Write`/`MultiEdit` file against `HEAD`, and — only when Jev scores a finding at/above `review.jev.edit_guard_threshold` (default 0.5) — prints exactly one line of JSON on stdout shaped `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}` whose `additionalContext` contains `"Rule check flagged:"`, the file, and the line. It prints nothing when no finding reaches threshold.
- AC2: The hook always exits `0` and never throws past its own boundary on: `review.jev.edit_guard` disabled, no Jev/OpenRouter credential, malformed stdin JSON, an unsupported `tool_name`, no changed region against `HEAD`, any Jev-call error, and the hard ~4s wall-clock timeout (verified by aborting an in-flight call, not merely racing a promise) — each case produces no stdout and is logged to `.metaproject/data/jev/edit-guard.jsonl`.
- AC3: `review.jev.edit_guard`, `review.jev.edit_guard_threshold`, and `review.jev.edit_guard_max_calls` are read from `.metaproject/tasks.config.json`, fail-closed (absent/unparsable reads as disabled/default, never throws).
- AC4: `keryx review jev-edit-guard install` writes a merge-safe `PostToolUse` hook entry into `.claude/settings.json` (idempotent — running it twice yields exactly one entry, and pre-existing unrelated hooks/settings are preserved byte-for-byte); `uninstall` removes only that entry; `status [--json]` reports enabled/threshold/max-calls and today's calls/flags/cost from the log.
- AC5: The TUI exposes a `/editguard` modal (on/off, threshold, recent flags with file/clause/probability, today's counts, an in-modal toggle) and a sidebar indicator that renders only while the guard is on, registered in `AGENT_SLASH_COMMANDS` and `HELP_GROUPS`.
- AC6: `src/core-package.test.ts` stays green (the feature's client/harness code never reaches the published core entry point); no test sends a real Jev/network call or a real OpenRouter key.
