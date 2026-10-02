# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: For sandbox worktree-write the codex codec argv carries `-s workspace-write`, `-c sandbox_workspace_write.exclude_slash_tmp=true`, `-c sandbox_workspace_write.exclude_tmpdir_env_var=true` and `-c sandbox_workspace_write.network_access=false`, keeps the prompt as the last single element, never contains danger-full-access or a bypass flag, and the read-only argv is byte-identical to before. [verify: exec `bun test src/harness/external/codec/codex-cli.test.ts`]
- AC2: `validateRuntimeBlock` accepts worktree-write for claude-cli and codex-cli only when the caller owns write capture, still refuses antigravity-cli with the release-gate code, and the refusal text no longer says write mode is claude-only but names the agents that have it. [verify: exec `bun test src/harness/external/dispatch.test.ts`]
- AC3: A codex write run is refused before any spawn unless the installed codex is in the measured window (0.159.2 up to, not including, 0.160.0): older, newer, pre-release and unreadable versions are refused, with a message naming the found version and the required range; a codex write run inside the window captures the diff through the same pipeline as claude (record, redacted patch, hash, worktree removed on every exit path). [verify: exec `bun test src/harness/external/write-run.test.ts src/harness/external/runtime.test.ts`]
- AC4: A resumed or follow-up codex turn of a worktree-write run re-asserts the same confinement flags in its argv (unit-tested; keryx itself starts no write-run resume). [verify: exec `bun test src/harness/external/codec/codex-cli.test.ts`]
- AC5: `keryx agents external run codex-cli --write` goes through the same CLI path as claude (review, apply, discard, flagged paths, hash typed by the operator); `--write` help, cli-reference and group-subcommands name both agents and the codex read-exposure difference; agy still refuses with a named reason. [verify: exec `bun test src/commands/agents-external-write.test.ts src/cli-reference-coverage.test.ts src/commands/agent-commands.confusable.test.ts`]
- AC6: The TUI external-diff modal and the sidebar row show the agent of a pending write run, and a codex run reads the same as a claude run. [verify: exec `bun test src/tui/external-diff-modal.test.ts src/tui/external-operator.test.ts`]
- AC7: The write guide, harness doc and README limitations row state that codex write runs are confined to the worktree for writes, have no network and a read-only .git, but keep a shell that can read any file the user can read, and that agy is refused because its edit tool writes outside the worktree. `mkdocs build --strict` passes. [verify: exec `bun run check:doc-links`]
- AC8: A live codex probe test script recorded in the flow journal shows, with the codex version, that through the keryx argv a write to /tmp, $HOME and a sibling directory fails and a write inside the worktree succeeds; the script reads no credential store. [verify: judged]
- AC9: Live smoke with the installed release: one real `codex-cli --write` run through the real CLI produces a diff for review, discard leaves nothing, approval yields the branch `external/<run-id>`, the main checkout is untouched; recorded with the codex version. [verify: judged]
- AC10: A stop: the report to the operator carries the live results and what remains (agy, read exposure, G1 on 2026-10-28). [verify: none — a stop is an absence of work; the operator report is the evidence]
