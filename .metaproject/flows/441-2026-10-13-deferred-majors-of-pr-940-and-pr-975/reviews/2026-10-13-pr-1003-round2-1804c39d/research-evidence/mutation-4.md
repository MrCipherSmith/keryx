# Mutation pass

Command: `bun test src/tui/turn-loop.test.ts src/tui/busy-dispatch.test.ts src/tui/main-queue.test.ts src/tui/main-queue-drain.test.ts src/tui/remote-queue-wiring.test.ts src/tui/tui-hold.test.ts src/tui/tui-bus.test.ts src/tui/tui-shell.test.ts` (baseline exit 0, 7557 ms). Run in a scratch copy; the worktree was not written.

Killed 7, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-shell-paint-noop | src/tui/tui-shell.ts:5017 | `paint: () => paintMainQueue(),` → `paint: () => undefined,` | killed |
| M02-shell-summarize-identity | src/tui/tui-shell.ts:5009 | `summarize: summarizeSubmittedLine,` → `summarize: (l: string) => l,` | killed |
| M03-shell-composer-setText-noop | src/tui/tui-shell.ts:5012 | `input.value = text;           },           focus: () => input.focus(),` → `void text;           },           focus: () => input.focus(),` | killed |
| M04-shell-composer-focus-noop | src/tui/tui-shell.ts:5014 | `focus: () => input.focus(),         },       },       paint` → `focus: () => undefined,         },       },       paint` | killed |
| M05-shell-failure-text | src/tui/tui-shell.ts:5024 | `◇ a slash command failed: ${terminalSafe(reason).text}` → `◇ a slash command failed: ${reason}` | killed |
| M06-shell-failure-reason-always-string | src/tui/tui-shell.ts:5023 | `const reason = error instanceof Error ? error.message : String(error);         io.onSystem?.(`◇ a slash command failed` → `const reason = String(error);         io.onSystem?.(`◇ a slash command failed` | killed |
| M07-shell-runLine-origin-dropped | src/tui/tui-shell.ts:5019 | `runLine: (line, origin, source) => runLine(line, origin, source),` → `runLine: (line, _origin, source) => runLine(line, "operator", source),` | killed |
| M08-shell-sessionState-mode | src/tui/tui-shell.ts:10163 | `sessionState: () => ({ queued: turnLoop.queue.length, mode: formatModeInForce(modeForTurn(true)) }),` → `sessionState: () => ({ queued: turnLoop.queue.length, mode: formatModeInForce(modeForTurn(false)) }),` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
