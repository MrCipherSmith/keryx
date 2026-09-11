# K-012: a refused keryx shell start never exits when MCP servers are configured

Status: formalized
Source: arena defect log `arena/keryx-shell-defects.md` K-012 (branch `arena/measurement`)

## Problem

Under an operator's HOME with MCP servers configured, `keryx shell --provider
deepseek --model unused --no-tui --deny-tools web_serch -p x` prints
`unknown tool name(s) in --deny-tools` and then never exits — killed at 90 s in
measurement, against 1.3 s under an empty HOME. The readline path (`--no-tui`,
`--print`) creates the session's MCP runtime (`src/commands/shell.ts`, the
`createMcpRuntime` in the agent branch) before it builds the tool list; the
refusal is thrown while the list is built; and the only `mcpRuntime.close()` is in
a `finally` around the REPL call, which the refusal never reaches. A connected
server keeps its child process and pipe open, and the shell stays alive.

Any start failure after the runtime exists behaves the same; the unknown
`--deny-tools` name is the reproduced case. A script or CI step expecting exit 1
waits forever.

## Expected Outcome

- A start that fails after the MCP runtime is created exits with its error and exit
  code, promptly, and every server process it started is gone.
- The normal path is unchanged: the REPL's own close still runs, and closing twice
  costs nothing (`closeOnce` already guarantees it).

## Out of Scope

- Validating `--deny-tools` before the runtime starts (would avoid spawning servers
  at all on a refusal; a separate improvement, not needed for the exit guarantee).
- The TUI path, which already closes its runtime in a `finally`.
- Changing the source-text audits in `src/commands/shell.test.ts`: the fix goes in
  the outer `finally` so the audited agent branch is not moved.
