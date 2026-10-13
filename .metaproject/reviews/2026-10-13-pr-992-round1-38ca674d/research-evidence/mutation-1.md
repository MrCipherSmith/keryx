# Mutation pass

Command: `bun test src/commands/agent-question-axis.test.ts src/commands/permission-mode.test.ts src/harness/tool/builtin/ask-user-tool.test.ts src/tui/ask-user-bridge.test.ts src/tui/foreground-operation.test.ts` (baseline exit 0, 251 ms). Run in a scratch copy; the worktree was not written.

Killed 10, survived 5, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-trust-answers-as-model | src/commands/permission-mode.ts:161 | `return mode === "auto" ? "model" : "human";` → `return mode !== "ask" ? "model" : "human";` | killed |
| M03-roster-check-dropped | src/commands/agent.ts:2508 | `if (call.name !== "ask_user" \|\| !toolByName.has("ask_user") \|\| resolveQuestionAnswerer(mode) !== "model") {` → `if (call.name !== "ask_user" \|\| resolveQuestionAnswerer(mode) !== "model") {` | killed |
| M04-untrusted-latch-ignored | src/commands/agent.ts:2513 | `const request = untrustedContentSeen ? { ...parsed.request, untrustedContent: true } : parsed.request;` → `const request = parsed.request;` | killed |
| M05-floor-disabled | src/commands/agent.ts:2514 | `if (askFloor(request) !== undefined) return undefined;` → `if (false as boolean) return undefined;` | killed |
| M06-self-answer-remembered-as-operator-answer | src/commands/agent.ts:4440 | `if (precomputedResult === undefined && storedAnswer === undefined && selfAnswered === undefined) {` → `if (precomputedResult === undefined && storedAnswer === undefined) {` | survived |
| M07-missing-mode-defaults-to-auto | src/commands/agent.ts:4386 | `? selfAnsweredQuestion(call, toolByName, io.permissionMode?.() ?? DEFAULT_PERMISSION_MODE, untrustedContentSeen)` → `? selfAnsweredQuestion(call, toolByName, io.permissionMode?.() ?? "auto", untrustedContentSeen)` | survived |
| M08-display-callback-swapped-args | src/commands/agent.ts:4394 | `io.onQuestionSelfAnswered?.(selfAnswered.question, selfAnswered.label);` → `io.onQuestionSelfAnswered?.(selfAnswered.label, selfAnswered.question);` | killed |
| M10-recommended-ignored | src/harness/tool/builtin/ask-user-tool.ts:157 | `const option = request.options.find((o) => o.recommended === true) ?? request.options[0]!;` → `const option = request.options[0]!;` | killed |
| M11-recommended-tag-dropped-from-model-text | src/harness/tool/builtin/ask-user-tool.ts:162 | `${option.recommended === true ? " (recommended)" : ""}` → `` | survived |
| M12-min-options-lowered | src/harness/tool/builtin/ask-user-tool.ts:92 | `export const MIN_ASK_USER_OPTIONS = 2;` → `export const MIN_ASK_USER_OPTIONS = 1;` | killed |
| M13-two-recommended-allowed | src/harness/tool/builtin/ask-user-tool.ts:114 | `if (flagged.length > 1) {` → `if (flagged.length > 2) {` | survived |
| M14-no-host-branch-dead | src/harness/tool/builtin/ask-user-tool.ts:245 | `if (chosen === ASK_USER_NO_HOST) {` → `if (chosen === ASK_USER_NO_HOST && false as boolean) {` | killed |
| M15-cancel-branch-dead | src/harness/tool/builtin/ask-user-tool.ts:253 | `if (chosen === ASK_USER_CANCEL) {` → `if (chosen === ASK_USER_CANCEL && false as boolean) {` | killed |
| M16-no-host-returns-cancel | src/tui/ask-user-bridge.ts:24 | `return ASK_USER_NO_HOST;` → `return "__cancel__";` | killed |
| M17-facade-forwards-stale-turn | src/tui/foreground-operation.ts:287 | `if (accepts()) io.onQuestionSelfAnswered?.(question, answerLabel);` → `io.onQuestionSelfAnswered?.(question, answerLabel);` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
