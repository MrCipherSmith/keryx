# Mutation pass

Command: `bun test src/commands/agent-fewer-prompts.test.ts src/commands/agent-trust-orchestration.test.ts src/commands/agent.test.ts src/harness/tool/builtin` (baseline exit 0, 24399 ms). Run in a scratch copy; the worktree was not written.

Killed 4, survived 8, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| ag-baseline-process | src/commands/agent.ts:2250 | `  recordBunfigBaseline(); ` → `` | survived |
| ag-baseline-tool | src/commands/agent.ts:2252 | `if (tool.workingDirectory !== undefined) recordBunfigBaseline(tool.workingDirectory);` → `` | killed |
| ag-baseline-tool-guard | src/commands/agent.ts:2252 | `if (tool.workingDirectory !== undefined) recordBunfigBaseline(` → `if (true) recordBunfigBaseline(` | survived |
| ag-latch-cwd | src/commands/agent.ts:5647 | `      ...(tool.workingDirectory === undefined ? {} : { cwd: tool.workingDirectory }), ` → `` | survived |
| ag-latch-untrusted | src/commands/agent.ts:5646 | `untrustedContent: untrustedOrigin,` → `untrustedContent: false,` | killed |
| ag-refusal-ctx | src/commands/agent.ts:5650 | `!isTrustRoutineCommand(command, routineContext)) {       const key` → `!isTrustRoutineCommand(command)) {       const key` | survived |
| ag-refusal-off | src/commands/agent.ts:5650 | `if (reviewAutoActive() && command.length > 0 && !isTrustRoutineCommand(command, routineContext)) {` → `if (false) {` | killed |
| ag-gate-ctx | src/commands/agent.ts:5682 | `isTrustRoutineCommand(command, routineContext) &&         ((mode` → `isTrustRoutineCommand(command) &&         ((mode` | survived |
| ag-gate-mode | src/commands/agent.ts:5683 | `((mode === "trust" && gated.decision === "auto") \|\| reviewAutoActive())` → `(mode === "trust" \|\| reviewAutoActive())` | survived |
| ag-gate-reviewauto | src/commands/agent.ts:5683 | `((mode === "trust" && gated.decision === "auto") \|\| reviewAutoActive())` → `(mode === "trust" && gated.decision === "auto")` | killed |
| ag-gate-hook | src/commands/agent.ts:5681 | `!gated.hookAsked &&         isTrustRoutineCommand` → `isTrustRoutineCommand` | survived |
| sh-workdir | src/harness/tool/builtin/shell-exec-tool.ts:422 | `    workingDirectory: root, ` → `` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
