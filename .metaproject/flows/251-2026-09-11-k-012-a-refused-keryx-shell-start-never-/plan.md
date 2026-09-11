# Implementation Plan

Status: ready

## Approach

Close the readline session's MCP runtime in the outer `finally` of the shell
command — the one that already runs `destroy()` and `rl.close()` for every exit.
`readlineMcp` is visible there (the SIGINT/SIGTERM handler already uses it). The
inner `finally` around the REPL stays: on the normal path it closes first, and the
outer call finds nothing left (`closeOnce`), so the second call is cheap.

Rejected:

- **Open the try right after `createMcpRuntime`.** Correct, but re-indents ~80
  lines of the agent branch, and the flow 173 AC7 source audit reads
  `sweepBackgroundJobs` from a fixed 4,200-character window from `if (agentMode) {`
  — the first CI round of PR #529 broke that exact audit by adding characters above
  it.
- **Validate `--deny-tools` before creating the runtime.** Avoids the spawn on this
  one refusal but leaves every other start failure hanging.

## Steps

1. Regression test first (`src/commands/shell-startup-exit.test.ts`): an isolated
   HOME whose `~/.claude.json` configures a user-scope server that COMPLETES its
   handshake (the `fixtures/mcp-servers/echo-server.ts` stdio server), a refused
   start, and assertions: exit code 1, under 10 s, no server process survives. It
   must fail on the unfixed code. (A server that never handshakes does not
   reproduce it: its own dial timeout kills it after ~15 s and the shell exits.)
2. Add the close to the outer `finally`, guarded like the signal handler.
3. Changelog `[Unreleased]` entry; record #524's late entry under 0.2.95; replace
   the high-entropy fake key body in the compat test.
4. Terminal client tests (`test:client:terminal`), typecheck, lint, full CI.

## Risks

- The regression test depends on a real child process and timing; bounded by a
  60 s test budget and cleaned up in `afterAll`.
- `close()` waits up to `KILL_GRACE_MS` (4.5 s) for an aborted dial's child; the
  exit bound in the test (10 s) allows for it.
