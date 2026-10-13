# Mutation pass

Command: `bun test src/commands/agent-question-axis.test.ts src/lib/test-preload.test.ts src/harness/tool/builtin/ask-user-tool.test.ts src/decisions/interviewer-path.test.ts src/review/review-system.test.ts` (baseline exit 0, 434 ms). Run in a scratch copy; the worktree was not written.

Killed 19, survived 3, timeout 0, invalid 4.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-review-run-stand-aside-dropped | src/commands/agent.ts | `if (reviewRun !== undefined \|\| call.name !== "ask_user" \|\| resolveQuestionAnswerer(mode) !== "model") {` → `if (call.name !== "ask_user" \|\| resolveQuestionAnswerer(mode) !== "model") {` | invalid (anchor not found) |
| M02-schema-validation-dropped | src/commands/agent.ts:2532 | `if (!validateAgainstSchemaObject(tool.definition.inputSchema, input).valid) return undefined;` → `if (false as boolean) return undefined;` | killed |
| M03-parse-failure-ignored | src/commands/agent.ts:2534 | `if (!parsed.ok) return undefined;` → `if (false as boolean) return undefined;` | killed |
| M04-untrusted-latch-ignored | src/commands/agent.ts:2535 | `const request = untrustedContentSeen ? { ...parsed.request, untrustedContent: true } : parsed.request;` → `const request = parsed.request;` | killed |
| M05-floor-disabled | src/commands/agent.ts:2536 | `if (askFloor(request) !== undefined) return undefined;` → `if (false as boolean) return undefined;` | killed |
| M06-self-answer-remembered-as-operator-answer | src/commands/agent.ts:4476 | `if (precomputedResult === undefined && storedAnswer === undefined && selfAnswered === undefined) {` → `if (precomputedResult === undefined && storedAnswer === undefined) {` | killed |
| M07-missing-mode-defaults-to-auto | src/commands/agent.ts | `io.permissionMode?.() ?? DEFAULT_PERMISSION_MODE, untrustedContentSeen, reviewRun)` → `io.permissionMode?.() ?? "auto", untrustedContentSeen, reviewRun)` | invalid (anchor not found) |
| M08-display-callback-swapped-args | src/commands/agent.ts:4430 | `io.onQuestionSelfAnswered?.(selfAnswered.question, selfAnswered.label);` → `io.onQuestionSelfAnswered?.(selfAnswered.label, selfAnswered.question);` | killed |
| M09-display-callback-dropped | src/commands/agent.ts:4430 | `io.onQuestionSelfAnswered?.(selfAnswered.question, selfAnswered.label);` → `void selfAnswered;` | killed |
| M10-denial-fingerprint-not-recorded | src/commands/agent.ts:5617 | `recordOperatorDenial(meta.fingerprint);` → `void 0;` | killed |
| M11-denial-spelled-not-recorded | src/commands/agent.ts:5618 | `recordOperatorDenial(spelled!);` → `void 0;` | killed |
| M12-denial-guard-always-records | src/commands/agent.ts | `if (meta !== undefined && !isApprovalFor(response, meta.fingerprint)) {` → `if (meta !== undefined) {` | invalid (anchor not found) |
| M13-denial-guard-never-records | src/commands/agent.ts | `if (meta !== undefined && !isApprovalFor(response, meta.fingerprint)) {` → `if (meta !== undefined && (false as boolean)) {` | invalid (anchor not found) |
| M14-refusal-memory-read-in-every-mode | src/commands/agent.ts:5608 | `if (reviewAuto && meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` → `if (meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` | survived |
| M15-refusal-memory-never-read | src/commands/agent.ts:5608 | `if (reviewAuto && meta !== undefined && (operatorDenied(meta.fingerprint) \|\| operatorDenied(spelled!))) {` → `if (false as boolean) {` | survived |
| M16-question-axis-trust-answers-as-model | src/commands/permission-mode.ts:161 | `return mode === "auto" ? "model" : "human";` → `return mode !== "ask" ? "model" : "human";` | killed |
| M17-recommended-ignored | src/harness/tool/builtin/ask-user-tool.ts:157 | `const option = request.options.find((o) => o.recommended === true) ?? request.options[0]!;` → `const option = request.options[0]!;` | killed |
| M18-self-answer-says-user-answered | src/harness/tool/builtin/ask-user-tool.ts:162 | `. The user did not answer this question.` → `.` | killed |
| M19-no-host-branch-dead | src/harness/tool/builtin/ask-user-tool.ts:245 | `if (chosen === ASK_USER_NO_HOST) {` → `if (chosen === ASK_USER_NO_HOST && (false as boolean)) {` | killed |
| M20-no-host-returns-cancel | src/tui/ask-user-bridge.ts:24 | `return ASK_USER_NO_HOST;` → `return "__cancel__";` | killed |
| M21-facade-forwards-stale-turn | src/tui/foreground-operation.ts:291 | `if (accepts()) io.onQuestionSelfAnswered?.(question, answerLabel);` → `io.onQuestionSelfAnswered?.(question, answerLabel);` | survived |
| M22-floor-operator-denial-dropped | src/review/arbiter-floor.ts:32 | `if (!reviewAutoMayAnswer(request)) return "operator-denial";` → `` | killed |
| M23-floor-untrusted-dropped | src/review/arbiter-floor.ts:31 | `if (request.untrustedContent === true) return "untrusted-content";` → `` | killed |
| M24-floor-action-dropped | src/review/arbiter-floor.ts:30 | `if (typeof request.action === "string" && request.action.trim().length > 0) return "action";` → `` | killed |
| M25-second-preload-dropped | bunfig.toml:11 | `preload = ["./src/lib/test-preload.ts", "./src/lib/test-preload-hooks.ts"]` → `preload = ["./src/lib/test-preload.ts"]` | killed |
| M26-preload-reset-dropped | src/lib/test-preload-hooks.ts:12 | `beforeEach(() => resetOperatorDenials());` → `beforeEach(() => {});` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
