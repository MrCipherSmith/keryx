# Mutation pass

Command: `sh /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/run-tests.sh` (baseline exit 0, 382 ms). Run in a scratch copy; the worktree was not written.

Killed 0, survived 5, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| bunfigState-preload-regex-alts | src/lib/trust-routine-command.ts:145 | `[\s.[,{])"?preload"?\s*=` → `[\s.[])"?preload"?\s*=` | survived |
| bunTestArgsAllowed-eq-isCount-lengthonly | src/lib/trust-routine-command.ts:168 | `&& isCount(arg.slice(eq + 1))) continue;` → `&& arg.slice(eq + 1).length > 0) continue;` | survived |
| bunTestArgsAllowed-eq-flag-timeout-only | src/lib/trust-routine-command.ts:168 | `BUN_TEST_COUNT_FLAGS.has(arg.slice(0, eq))` → `arg.slice(0, eq) === "--timeout"` | survived |
| agent-latch-untrusted-dropped | src/commands/agent.ts:5674 | `isTrustRoutineCommand(command, { untrustedContent: untrustedOrigin }) &&` → `isTrustRoutineCommand(command) &&` | survived |
| agent-review-auto-untrusted-dropped | src/commands/agent.ts:5642 | `!isTrustRoutineCommand(command, { untrustedContent: untrustedOrigin })) {` → `!isTrustRoutineCommand(command)) {` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
