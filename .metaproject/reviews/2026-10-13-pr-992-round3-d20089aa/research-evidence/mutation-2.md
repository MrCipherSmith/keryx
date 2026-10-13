# Mutation pass

Command: `bun test src/commands/agent-question-axis.test.ts src/commands/shell-agent-repl.test.ts src/tui/tui-shell.test.ts src/tui/foreground-operation.test.ts src/commands/trigger-dispatch.test.ts src/lib/terminal-safe.test.ts src/commands/goal-command.test.ts src/harness/tool/builtin src/review` (baseline exit 0, 39401 ms). Run in a scratch copy; the worktree was not written.

Killed 25, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-review-run-stand-aside-dropped | src/commands/agent.ts:2528 | `reviewRun !== undefined \|\| telegramTurn \|\| call.name !== "ask_user"` → `telegramTurn \|\| call.name !== "ask_user"` | killed |
| M02-telegram-stand-aside-dropped | src/commands/agent.ts:2528 | `reviewRun !== undefined \|\| telegramTurn \|\|` → `reviewRun !== undefined \|\|` | killed |
| M04-policy-stand-aside-review-auto-dropped | src/commands/agent.ts:2541 | `reviewAutoActive() \|\| process.env.KERYX_REVIEW_AUTO_ANSWER === "1"` → `process.env.KERYX_REVIEW_AUTO_ANSWER === "1"` | killed |
| M05-policy-stand-aside-env-answer-dropped | src/commands/agent.ts:2541 | `process.env.KERYX_REVIEW_AUTO_ANSWER === "1" \|\| ` → `` | killed |
| M06-policy-stand-aside-answers-file-dropped | src/commands/agent.ts:2541 | `(process.env[ENV_AUTONOMOUS_ANSWERS_FILE] ?? "").length > 0` → `false` | killed |
| M08-refusal-memory-never-read | src/commands/agent.ts:5610 | `if (reviewAuto && meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` → `if (false as boolean) {` | killed |
| M09-refusal-memory-read-in-every-mode | src/commands/agent.ts:5610 | `if (reviewAuto && meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` → `if (meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` | killed |
| M10-refusal-floor-never-learns-outside-review-auto | src/commands/agent.ts:5622 | `noteOperatorRefusal();` → `void 0;` | killed |
| M11-unattended-no-is-a-refusal | src/commands/agent.ts:5555 | `return attended !== false && signal?.aborted !== true && (current?.() ?? true);` → `return signal?.aborted !== true && (current?.() ?? true);` | killed |
| M13-stale-turn-no-is-a-refusal | src/commands/agent.ts:5555 | `return attended !== false && signal?.aborted !== true && (current?.() ?? true);` → `return attended !== false && signal?.aborted !== true;` | killed |
| M14-trigger-approver-not-marked-unattended | src/commands/trigger-dispatch.ts:535 | `return Object.assign(approver, { attended: false });` → `return approver;` | killed |
| M15-facade-approver-not-marked-current | src/tui/foreground-operation.ts:303 | `{ current: accepts },` → `{},` | killed |
| M16-facade-forwards-stale-turn-self-answer | src/tui/foreground-operation.ts:309 | `if (accepts()) io.onQuestionSelfAnswered?.(question, answerLabel);` → `io.onQuestionSelfAnswered?.(question, answerLabel);` | killed |
| M19-self-answer-disclaimer-dropped | src/harness/tool/builtin/ask-user-tool.ts:162 | `. The user did not answer this question.` → `.` | killed |
| M20-second-preload-dropped | bunfig.toml:11 | `preload = ["./src/lib/test-preload.ts", "./src/lib/test-preload-hooks.ts"]` → `preload = ["./src/lib/test-preload.ts"]` | survived |
| M21-preload-reset-dropped | src/lib/test-preload-hooks.ts:12 | `beforeEach(() => resetOperatorDenials());` → `beforeEach(() => {});` | survived |
| M22-mode-change-keeps-refusals-readline | src/commands/shell.ts:3062 | `permissionMode = wanted;             resetOperatorDenials();` → `permissionMode = wanted;` | killed |
| M23-new-session-keeps-refusals-tui | src/tui/tui-shell.ts:6930 | `io.trustedMcpTools?.clear();       resetOperatorDenials();       stopRemoteForSessionSwitch();` → `io.trustedMcpTools?.clear();       stopRemoteForSessionSwitch();` | killed |
| M24-delegate-branch-refusal-read-in-every-mode | src/commands/agent.ts:5861 | `} else if (risk === "delegate") {     if (reviewAutoActive() && operatorDenied(` → `} else if (risk === "delegate") {     if (operatorDenied(` | killed |
| M25-write-branch-refusal-read-in-every-mode | src/commands/agent.ts:5908 | `} else if (risk === "write") {     if (reviewAutoActive() && operatorDenied(` → `} else if (risk === "write") {     if (operatorDenied(` | killed |
| M17-self-answer-line-not-terminal-safe | src/lib/terminal-safe.ts:124 | `return terminalSafe(`${shortQuestion} → ${answerLabel}`).text;` → `return `${shortQuestion} → ${answerLabel}`;` | killed |
| M17b-self-answer-line-cut-by-code-unit | src/lib/terminal-safe.ts:122 | `const points = Array.from(question);` → `const points = question.split("");` | killed |
| M17c-readline-bypasses-the-shared-line | src/commands/shell.ts:2261 | `const line = selfAnsweredLine(question, answerLabel);` → `const line = `${question} → ${answerLabel}`;` | killed |
| M18-tui-bypasses-the-shared-line | src/tui/tui-shell.ts:6192 | `const line = selfAnsweredLine(question, answerLabel);` → `const line = `${question} → ${answerLabel}`;` | killed |
| M26-aborted-turn-no-is-a-refusal | src/commands/agent.ts:5555 | `return attended !== false && signal?.aborted !== true && (current?.() ?? true);` → `return attended !== false && (current?.() ?? true);` | killed |
| M27-goal-turn-not-marked-telegram | src/tui/tui-shell.ts:8834 | `io: source === TG_SOURCE ? withTurnScopedIo(io, telegramTurnIo) : io,` → `io,` | killed |
| M28-turn-overlay-drops-hooks | src/tui/foreground-operation.ts:240 | `if (hook !== undefined) Object.defineProperty(scoped, key,` → `if (false as boolean) Object.defineProperty(scoped, key,` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
