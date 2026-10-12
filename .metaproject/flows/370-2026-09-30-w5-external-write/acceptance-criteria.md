# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The claude codec builds a write-mode argv (Edit and Write added to the allow-list, still no Bash/NotebookEdit/WebFetch/MCP, prompt not after a variadic flag) only when sandbox is worktree-write, and read-only argv is unchanged. [verify: exec `bun test src/harness/external/codec/claude-cli.test.ts`]
- AC2: `validateRuntimeBlock` accepts worktree-write for claude-cli and still refuses it for codex-cli and antigravity-cli with the release-gate code. [verify: exec `bun test src/harness/external/dispatch.test.ts`]
- AC3: A write run captures the worktree diff for a codec agent, redacts it, and stores it in the session dir; the run's tree is removed on every exit path (success, timeout, denial, crash). [verify: exec `bun test src/harness/external/write-run.test.ts`]
- AC4: Landing requires an explicit approval bound to the patch hash shown; a changed patch, a second approval or a non-TTY caller without an operator answer lands nothing; landing creates `external/<run-id>` and never touches the current branch or working tree. [verify: exec `bun test src/harness/external/write-land.test.ts`]
- AC5: `keryx agents external review|apply|discard <run-id>` prints the diff with stat, applies only after the confirmation of AC4, and is listed in group-subcommands and the CLI reference. [verify: exec `bun test src/commands/agents-external-write.test.ts src/cli-reference-coverage.test.ts`]
- AC6: The TUI shows the pending diff: `/external-diff` modal (files, stat, scrollable diff, apply / discard with confirmation) and one sidebar row only while a diff awaits review; the pty smoke still passes. [verify: exec `bun test src/tui/external-diff-modal.test.ts src/commands/shell-slash-registry.test.ts`]
- AC7: bun run check:doc-links
- AC8: Live smoke with the installed build: one real claude write run through the real CLI produces a diff, denial leaves nothing, approval yields the branch; main checkout untouched. Recorded with the claude version. [verify: judged]
- AC9: A stop: the report to the operator carries the live result, claude's real permission flag, and what remains for codex and agy. [verify: none — a stop is an absence of work; the operator report is the evidence]
