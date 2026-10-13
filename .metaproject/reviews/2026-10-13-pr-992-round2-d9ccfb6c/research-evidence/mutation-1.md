# Mutation pass

Command: `bun test src/commands/agent-question-axis.test.ts src/commands/permission-mode.test.ts src/harness/tool/builtin/ask-user-tool.test.ts src/tui/ask-user-bridge.test.ts src/tui/foreground-operation.test.ts src/review/review-system.test.ts src/commands/review-arbiter.test.ts src/commands/agent-fewer-prompts.test.ts src/commands/agent.test.ts src/lib/test-preload.test.ts` (baseline exit 0, 1389 ms). Run in a scratch copy; the worktree was not written.

Killed 22, survived 4, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-review-run-stand-aside-dropped | src/commands/agent.ts:2511 | `if (reviewRun !== undefined \|\| call.name !== "ask_user" \|\| resolveQuestionAnswerer(mode) !== "model") {` → `if (call.name !== "ask_user" \|\| resolveQuestionAnswerer(mode) !== "model") {` | killed |
| M02-schema-validation-dropped | src/commands/agent.ts:2517 | `if (!validateAgainstSchemaObject(tool.definition.inputSchema, input).valid) return undefined;` → `if (false as boolean) return undefined;` | killed |
| M03-parse-failure-ignored | src/commands/agent.ts:2519 | `if (!parsed.ok) return undefined;` → `if (false as boolean) return undefined;` | killed |
| M04-untrusted-latch-ignored | src/commands/agent.ts:2520 | `const request = untrustedContentSeen ? { ...parsed.request, untrustedContent: true } : parsed.request;` → `const request = parsed.request;` | killed |
| M05-floor-disabled | src/commands/agent.ts:2521 | `if (askFloor(request) !== undefined) return undefined;` → `if (false as boolean) return undefined;` | killed |
| M06-self-answer-remembered-as-operator-answer | src/commands/agent.ts:4447 | `if (precomputedResult === undefined && storedAnswer === undefined && selfAnswered === undefined) {` → `if (precomputedResult === undefined && storedAnswer === undefined) {` | killed |
| M07-missing-mode-defaults-to-auto | src/commands/agent.ts:4393 | `io.permissionMode?.() ?? DEFAULT_PERMISSION_MODE, untrustedContentSeen, reviewRun)` → `io.permissionMode?.() ?? "auto", untrustedContentSeen, reviewRun)` | killed |
| M08-display-callback-swapped-args | src/commands/agent.ts:4401 | `io.onQuestionSelfAnswered?.(selfAnswered.question, selfAnswered.label);` → `io.onQuestionSelfAnswered?.(selfAnswered.label, selfAnswered.question);` | killed |
| M09-display-callback-dropped | src/commands/agent.ts:4401 | `io.onQuestionSelfAnswered?.(selfAnswered.question, selfAnswered.label);` → `void selfAnswered;` | killed |
| M10-denial-fingerprint-not-recorded | src/commands/agent.ts:5581 | `recordOperatorDenial(meta.fingerprint);` → `void 0;` | survived |
| M11-denial-spelled-not-recorded | src/commands/agent.ts:5582 | `recordOperatorDenial(spelled!);` → `void 0;` | killed |
| M12-denial-guard-always-records | src/commands/agent.ts:5580 | `if (meta !== undefined && !isApprovalFor(response, meta.fingerprint)) {` → `if (meta !== undefined) {` | killed |
| M13-denial-guard-never-records | src/commands/agent.ts:5580 | `if (meta !== undefined && !isApprovalFor(response, meta.fingerprint)) {` → `if (meta !== undefined && (false as boolean)) {` | killed |
| M14-refusal-memory-read-in-every-mode | src/commands/agent.ts:5574 | `if (reviewAuto && meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` → `if (meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` | killed |
| M15-refusal-memory-never-read | src/commands/agent.ts:5574 | `if (reviewAuto && meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` → `if (false as boolean) {` | killed |
| M16-question-axis-trust-answers-as-model | src/commands/permission-mode.ts:161 | `return mode === "auto" ? "model" : "human";` → `return mode !== "ask" ? "model" : "human";` | killed |
| M17-recommended-ignored | src/harness/tool/builtin/ask-user-tool.ts:157 | `const option = request.options.find((o) => o.recommended === true) ?? request.options[0]!;` → `const option = request.options[0]!;` | killed |
| M18-self-answer-says-user-answered | src/harness/tool/builtin/ask-user-tool.ts:162 | `. The user did not answer this question.` → `.` | survived |
| M19-no-host-branch-dead | src/harness/tool/builtin/ask-user-tool.ts:245 | `if (chosen === ASK_USER_NO_HOST) {` → `if (chosen === ASK_USER_NO_HOST && (false as boolean)) {` | killed |
| M20-no-host-returns-cancel | src/tui/ask-user-bridge.ts:24 | `return ASK_USER_NO_HOST;` → `return "__cancel__";` | killed |
| M21-facade-forwards-stale-turn | src/tui/foreground-operation.ts:287 | `if (accepts()) io.onQuestionSelfAnswered?.(question, answerLabel);` → `io.onQuestionSelfAnswered?.(question, answerLabel);` | killed |
| M22-floor-operator-denial-dropped | src/review/arbiter-floor.ts:32 | `if (!reviewAutoMayAnswer(request)) return "operator-denial";` → `` | killed |
| M23-floor-untrusted-dropped | src/review/arbiter-floor.ts:31 | `if (request.untrustedContent === true) return "untrusted-content";` → `` | killed |
| M24-floor-action-dropped | src/review/arbiter-floor.ts:30 | `if (typeof request.action === "string" && request.action.trim().length > 0) return "action";` → `` | killed |
| M25-second-preload-dropped | bunfig.toml:9 | `preload = ["./src/lib/test-preload.ts", "./src/lib/test-preload-hooks.ts"]` → `preload = ["./src/lib/test-preload.ts"]` | survived |
| M26-preload-reset-dropped | src/lib/test-preload-hooks.ts:11 | `beforeEach(() => resetOperatorDenials());` → `beforeEach(() => {});` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
