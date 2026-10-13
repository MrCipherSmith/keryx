# Mutation pass

Command: `bun test src/commands/agent-question-axis.test.ts src/lib/test-preload.test.ts src/harness/tool/builtin/ask-user-tool.test.ts src/decisions/interviewer-path.test.ts src/review/review-system.test.ts src/tui/foreground-operation.test.ts src/tui/ask-user-bridge.test.ts src/tui/ask-user-bridge-arbiter.test.ts src/commands/permission-mode.test.ts src/commands/trigger-dispatch.test.ts src/commands/review-arbiter.test.ts src/commands/agent-fewer-prompts.test.ts src/commands/shell-agent-repl.test.ts src/tui/tui-shell.test.ts` (baseline exit 0, 17240 ms). Run in a scratch copy; the worktree was not written.

Killed 13, survived 9, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-review-run-stand-aside-dropped | src/commands/agent.ts:2526 | `reviewRun !== undefined \|\| telegramTurn \|\| call.name !== "ask_user"` → `telegramTurn \|\| call.name !== "ask_user"` | killed |
| M02-telegram-stand-aside-dropped | src/commands/agent.ts:2526 | `reviewRun !== undefined \|\| telegramTurn \|\|` → `reviewRun !== undefined \|\|` | killed |
| M04-policy-stand-aside-review-auto-dropped | src/commands/agent.ts:2539 | `reviewAutoActive() \|\| process.env.KERYX_REVIEW_AUTO_ANSWER === "1"` → `process.env.KERYX_REVIEW_AUTO_ANSWER === "1"` | killed |
| M05-policy-stand-aside-env-answer-dropped | src/commands/agent.ts:2539 | `process.env.KERYX_REVIEW_AUTO_ANSWER === "1" \|\| ` → `` | killed |
| M06-policy-stand-aside-answers-file-dropped | src/commands/agent.ts:2539 | `(process.env[ENV_AUTONOMOUS_ANSWERS_FILE] ?? "").length > 0` → `false` | killed |
| M08-refusal-memory-never-read | src/commands/agent.ts:5608 | `if (reviewAuto && meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` → `if (false as boolean) {` | survived |
| M09-refusal-memory-read-in-every-mode | src/commands/agent.ts:5608 | `if (reviewAuto && meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` → `if (meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` | killed |
| M10-refusal-floor-never-learns-outside-review-auto | src/commands/agent.ts:5620 | `noteOperatorRefusal();` → `void 0;` | killed |
| M11-unattended-no-is-a-refusal | src/commands/agent.ts:5553 | `return attended !== false && signal?.aborted !== true && (current?.() ?? true);` → `return signal?.aborted !== true && (current?.() ?? true);` | killed |
| M13-stale-turn-no-is-a-refusal | src/commands/agent.ts:5553 | `return attended !== false && signal?.aborted !== true && (current?.() ?? true);` → `return attended !== false && signal?.aborted !== true;` | killed |
| M14-trigger-approver-not-marked-unattended | src/commands/trigger-dispatch.ts:535 | `return Object.assign(approver, { attended: false });` → `return approver;` | survived |
| M15-facade-approver-not-marked-current | src/tui/foreground-operation.ts:289 | `{ current: accepts },` → `{},` | survived |
| M16-facade-forwards-stale-turn-self-answer | src/tui/foreground-operation.ts:295 | `if (accepts()) io.onQuestionSelfAnswered?.(question, answerLabel);` → `io.onQuestionSelfAnswered?.(question, answerLabel);` | killed |
| M17-readline-self-answer-line-not-terminal-safe | src/commands/shell.ts:2262 | `const line = terminalSafe(`${shortQuestion} → ${answerLabel}`).text;` → `const line = `${shortQuestion} → ${answerLabel}`;` | survived |
| M18-tui-self-answer-line-not-terminal-safe | src/tui/tui-shell.ts:6192 | `const line = terminalSafe(`${shortQuestion} → ${answerLabel}`).text;` → `const line = `${shortQuestion} → ${answerLabel}`;` | survived |
| M19-self-answer-disclaimer-dropped | src/harness/tool/builtin/ask-user-tool.ts:162 | `. The user did not answer this question.` → `.` | killed |
| M20-second-preload-dropped | bunfig.toml:11 | `preload = ["./src/lib/test-preload.ts", "./src/lib/test-preload-hooks.ts"]` → `preload = ["./src/lib/test-preload.ts"]` | killed |
| M21-preload-reset-dropped | src/lib/test-preload-hooks.ts:12 | `beforeEach(() => resetOperatorDenials());` → `beforeEach(() => {});` | killed |
| M22-mode-change-keeps-refusals-readline | src/commands/shell.ts:3062 | `permissionMode = wanted;             resetOperatorDenials();` → `permissionMode = wanted;` | survived |
| M23-new-session-keeps-refusals-tui | src/tui/tui-shell.ts:6930 | `io.trustedMcpTools?.clear();       resetOperatorDenials();       stopRemoteForSessionSwitch();` → `io.trustedMcpTools?.clear();       stopRemoteForSessionSwitch();` | survived |
| M24-delegate-branch-refusal-read-in-every-mode | src/commands/agent.ts:5859 | `} else if (risk === "delegate") {     if (reviewAutoActive() && operatorDenied(` → `} else if (risk === "delegate") {     if (operatorDenied(` | survived |
| M25-write-branch-refusal-read-in-every-mode | src/commands/agent.ts:5906 | `} else if (risk === "write") {     if (reviewAutoActive() && operatorDenied(` → `} else if (risk === "write") {     if (operatorDenied(` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
