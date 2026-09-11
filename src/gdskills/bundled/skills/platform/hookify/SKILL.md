---
name: hookify
description: "Use when adding automated hook behavior to Claude Code or Cursor from a natural language description. NOT for: recording a convention or command as prose an agent reads (use claude-md-management)."
triggers:
  - "hookify"
  - "hook guidance"
  - "safe hooks"
  - "Create hook"
  - "Add hook"
  - "Run lint after edit"
  - "Notify when done"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "platform"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Hookify

Create agent hooks from natural language descriptions.

## Arguments

- `/hookify <description>` — create hook from description
- `/hookify --list` — show all current hooks
- `/hookify --remove <event>` — remove a hook

## Workflow

### Step 1: Parse Request
Understand from natural language:
- **When**: what event triggers it (before edit, after bash, on stop)
- **What**: what should happen (run command, check, notify)
- **Condition**: optional matcher (specific tool, file pattern)

Examples:
- "Run lint after every file edit" → PostToolUse + Edit matcher + lint command
- "Notify me when done" → Stop + notification command
- "Check types before committing" → PreToolUse + Bash(git commit) + tsc

### Step 2: Read Current Settings
Check for existing hooks to avoid conflicts.

### Step 3: Generate Hook Config

```json
{
  "hooks": {
    "<event>": [
      {
        "matcher": "<tool name or pattern>",
        "command": "<shell command>",
        "timeout": 60000
      }
    ]
  }
}
```

### Step 4: Validate
1. Verify command exists and is executable
2. Test standalone if safe
3. Check for conflicts with existing hooks

### Step 5: Preview & Apply
```
🔧 New hook:
  Event: PostToolUse (Edit)
  Command: npm run lint --fix
  Timeout: 30s

Add to settings.json? [confirm]
```

After confirmation, merge into settings.

## Hook Event Reference

| Event | When | Matcher |
|-------|------|---------|
| PreToolUse | Before tool runs | Tool name: Edit, Bash, Write |
| PostToolUse | After tool runs | Tool name |
| Notification | Agent notifies | — |
| Stop | Response complete | — |
| SubagentStop | Sub-agent done | — |

## Common Patterns

- **Auto-lint**: PostToolUse(Edit) → `eslint --fix $FILE`
- **Auto-format**: PostToolUse(Write) → `prettier --write $FILE`
- **Type-check gate**: PreToolUse(Bash:git commit) → `npx tsc --noEmit`
- **Notify on done**: Stop → notification command

## Rules

- ALWAYS preview before applying
- NEVER overwrite existing hooks — merge or ask
- Keep timeouts reasonable (10-60s)
- Warn if hook could slow down every tool call
- Test commands before adding as hooks

## Red Flags

Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "The JSON is valid, so the hook works." | Valid JSON says nothing about whether the binary is on PATH, the matcher spells the tool name the way the harness emits it, or the command exits non-zero on a clean run. Step 4 exists because a hook that fails silently is worse than no hook: it runs on every tool call and reports nothing. |
| "The user described what they want clearly, so I can skip the preview." | The preview is where a matcher mistake is caught — "after every edit" meaning `Edit` but not `Write`, or a `PreToolUse` hook that will block the tool instead of warning. Show the resolved event, matcher, command and timeout, and apply only after confirmation. |
| "There is already a hook on this event, so I'll replace it." | Overwriting is the one thing this skill forbids. Merge into the existing array, or ask which should win. A removed hook does not announce itself — the user finds out when the check it enforced stops running. |
| "It's only a lint run, so the timeout does not matter." | A `PostToolUse(Edit)` hook runs on every single edit. A 5-minute lint on a large repo turns every edit into a stall, and the user will disable hooks entirely rather than debug it. Keep it in the 10-60s band and say so when the command is likely to be slow. |
| "The command works in my shell, so it works as a hook." | Hooks run without the interactive shell's profile, aliases or cwd assumptions. Use an absolute or project-relative invocation, and test it the way the hook will run it. |

## Verification

Before reporting, all of these must hold:

- The command was run standalone (when safe to do so) and its exit code observed — not assumed.
- The event name and matcher were checked against the Hook Event Reference table, and the matcher matches the tool the user actually meant.
- Existing hooks on that event were read and preserved; the written config contains them plus the new one.
- The timeout is set explicitly and is within the 10-60s band, or the report explains why it is not.
- The user saw the preview block (event, matcher, command, timeout) and confirmed before the settings file was written.
- The report names the settings file that changed and the exact hook entry added; for `--remove`, it names the entry deleted.
