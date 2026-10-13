# Mutation pass

Command: `bun test src/commands/agent-fewer-prompts.test.ts src/commands/agent-trust-orchestration.test.ts src/commands/agent.test.ts src/harness/tool/builtin` (baseline exit 0, 20735 ms). Run in a scratch copy; the worktree was not written.

Killed 9, survived 3, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| ag-baseline-process | src/commands/agent.ts:2250 | `  recordBunfigBaseline(); ` → `` | killed |
| ag-baseline-tool | src/commands/agent.ts:2252 | `if (tool.workingDirectory !== undefined) recordBunfigBaseline(tool.workingDirectory);` → `` | killed |
| ag-baseline-tool-guard | src/commands/agent.ts:2252 | `if (tool.workingDirectory !== undefined) recordBunfigBaseline(` → `if (true) recordBunfigBaseline(` | survived |
| ag-latch-cwd | src/commands/agent.ts:5647 | `      ...(tool.workingDirectory === undefined ? {} : { cwd: tool.workingDirectory }), ` → `` | killed |
| ag-latch-untrusted | src/commands/agent.ts:5646 | `untrustedContent: untrustedOrigin,` → `untrustedContent: false,` | killed |
| ag-gate-mode | src/commands/agent.ts:5685 | `((mode === "trust" && gated.decision === "auto") \|\| reviewAutoActive())` → `(mode === "trust" \|\| reviewAutoActive())` | survived |
| ag-gate-reviewauto | src/commands/agent.ts:5685 | `((mode === "trust" && gated.decision === "auto") \|\| reviewAutoActive())` → `(mode === "trust" && gated.decision === "auto")` | killed |
| sh-workdir | src/harness/tool/builtin/shell-exec-tool.ts:422 | `    workingDirectory: root, ` → `` | killed |
| agent-routine-memo | src/commands/agent.ts:5650 | `(routineVerdict ??= isTrustRoutineCommand(command, routineContext))` → `isTrustRoutineCommand(command, { untrustedContent: untrustedOrigin })` | killed |
| ag-refusal-off | src/commands/agent.ts:5652 | `if (reviewAutoActive() && command.length > 0 && !isRoutine()) {` → `if (false) {` | killed |
| ag-gate-routine-dropped | src/commands/agent.ts:5684 | `        isRoutine() && ` → `        true && ` | killed |
| ag-gate-hook | src/commands/agent.ts:5683 | `        !gated.hookAsked &&         isRoutine() &&` → `        isRoutine() &&` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
