# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With an isolated HOME whose `~/.claude.json` configures a user-scope MCP server that completes its handshake, `keryx shell --provider deepseek --model unused --no-tui --deny-tools web_serch -p x` prints the refusal, exits with code 1 in under 10 seconds, and leaves no process of that server running; a test proves it and fails on the code before the fix.
- AC2: The readline session's MCP runtime is closed on every exit from the shell command, including a start-up error thrown before the REPL runs, without moving the agent branch that the SLATE-3a and flow 173 AC7 source audits read.
- AC3: `bun run test:client:terminal`, `bun run typecheck` and `bun run lint` pass, and CI on the pull request is green.
- AC4: The changelog records the fix under `[Unreleased]`, the 0.2.95 section records #524's changes as shipped in 0.2.94, and the compat test's fake key no longer trips the pre-push high-entropy rule while its redaction assertion still holds.
