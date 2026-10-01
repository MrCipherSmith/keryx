# Implementation Plan

Status: formalized

## Approach

Reuse flow 370's pipeline unchanged (worktree at base commit, diff capture, redacted patch, hash, review, landing) and widen only the agent gate. Confinement for codex comes from its OS sandbox with the two `/tmp` exclusions, measured live; the version gate makes the measured behaviour a precondition instead of a hope. agy stays refused.

## Steps

1. Codec: `buildCodexArgv` adds the confinement `-c` flags for worktree-write; the resume argv re-asserts them or refuses (`codec/codex-cli.ts`).
2. Gate: replace the single `CODEC_WRITE_AGENT_ID` with a set of write-capable codec agents (claude-cli, codex-cli) in `dispatch.ts`; update the refusal wording; update users (`agents-external.ts:554`, `write-run.ts`, `runtime.ts`).
3. Version gate: before spawning a codex write run read `codex --version` through the existing probe/spawn port; refuse below 0.159.0 or when unreadable.
4. CLI and TUI: `--write` help, cli-reference, group-subcommands, agent name in the modal and the sidebar row.
5. Docs: write guide, harness.md, README limitations row, CHANGELOG, version 0.3.42 (0.3.41 is already released by another change).
6. Live probe script and live smoke with the installed build.

## Risks

- codex changes the meaning of the sandbox keys: the version gate and the live probe record bound it.
- The resume path weakening the sandbox: AC4.
- Shell read exposure: stated in docs and help, not removed.
- The codex usage limit on the operator's account can block the live smoke: the new account is logged in now.
