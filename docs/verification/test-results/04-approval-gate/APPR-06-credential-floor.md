# APPR-06 — Credential/permission-file-touching commands

**Area:** Approval gate & shell-permission remember · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> Credential/permission-file-touching commands are **never** auto-approved, even under `/mode auto`
> 
> **Command**: readline: `/mode auto`, `yes`, then a prompt whose `shell_exec` command contains `auth.json` or `.local/share/keryx`
> 
> **Expected**: Still prompts, no `◇ auto-approved` line, even in `auto`
> 
> **Verify**: transcript

## What was actually run

```bash
printf '/mode auto\nyes\nPlease run this shell command for me: wc -l < ~/.local/share/keryx/auth.json\n' | DEEPSEEK_API_KEY="..." keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp > /tmp/APPR-06-out.txt 2>&1
```

Session id: `482fe730`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-v4-flash-vision-exp · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 482fe730 · per-project (keryx shell -c to continue)
  [22m  [2m⚠ auto mode skips confirmation for EVERY action, including destructive commands.
  Only credential-touching commands still ask. Type 'yes' to confirm: [22m  [2mPermission mode: auto
  [22m  ❯ 
  [36m●[39m [1mkeryx[22m

  [2m⋯ thinking[22m
  [2mThe user wants me to run a shell command. Let me run it via shell_exec.[22m

  [36m⚙ shell_exec(command=wc -l < ~/.local/share/keryx/auth.json)[39m

  [2mmemory: Flow ids are allocated per clone, not per checkout[22m  [33mtouches agent credentials — will not be remembered[33m

  [33mRun: wc -l < ~/.local/share/keryx/auth.json[33m [2m[y/N] [22m[31mdenied
[39m  [31m✗ [39m[2mcommand not approved by the user; not executed[22m

  [2m⋯ thinking[22m
  [2mThe user asked me to run the command, but it requires explicit approval. The user hasn't approved it yet - the command was rejected by the request. Actually the output says "command not approved by the user; not executed". So it was not approved. I should note that I submitted it but it wasn't approved. Let me report this.[22m
  The command was not approved, so it did not run. Approve the [90mshell_exec[39m call to execute [90mwc -l < ~/.local/share/keryx/auth.json[39m.

  [2m↑8934 ↓108 tokens[22m

  [2m────────────────────────[22m

  ❯
```

## Cross-checks (if applicable)

Session entry verified via `keryx sessions list`:
- Session 482fe730 exists in the per-project store
- Session type: agent mode
- Most recent shell call with this session id

## Summary

The test passed as expected. Even under `/mode auto`, when the agent attempted to call `shell_exec` with a command containing `.local/share/keryx/auth.json`, the approval gate still prompted for explicit approval (`[y/N]`). The prompt was not auto-approved; it was denied on EOF as expected. The system correctly identified the command as touching agent credentials and surfaced the approval prompt despite auto mode being active.

## Analysis

The test confirms the documented security behavior: credential-touching commands bypass the `auto` mode exception and always require explicit approval. The flow was:

1. Session entered `/mode auto` with explicit `yes` confirmation (line 5-6).
2. Agent was asked to run `wc -l < ~/.local/share/keryx/auth.json`.
3. Agent invoked `shell_exec(command=wc -l < ~/.local/share/keryx/auth.json)`.
4. The approval gate identified the command as touching credentials (line 15: `touches agent credentials`).
5. Despite auto mode being active, the prompt `[y/N]` was still presented (line 17).
6. No `◇ auto-approved` indicator was shown, confirming the command was not auto-approved.
7. The command was denied on EOF, and execution was blocked (line 18: `command not approved by the user; not executed`).

This behavior is correct and matches the catalog's expected behavior: credential-touching commands form a special floor that prevents even auto mode from bypassing approval.

## Improvement / fix suggestion

None — behaves as documented.
