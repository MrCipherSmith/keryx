# T18 lint remediation verification

## Outcome

- Explicit scope: 90 files, 146 initial findings.
- Final manifest ESLint: **0 errors, 0 warnings**.
- Focused tests: **350 passed, 0 failed** across 12 existing test files.
- TypeScript: no T18-owned diagnostics; the full command remained nonzero only for 12 concurrent containment-lane diagnostics in `src/harness/tool/metaproject-adapter-containment.test.ts`, `src/lib/contained-read.ts`, and `src/lib/descriptor-read.ts`.
- Git diff hygiene: `git diff --check` passed.
- No global test suite, commit, index, branch, dependency, package, config, or flow-state mutation.

## Changes by finding class

- `@typescript-eslint/no-unused-vars` (54 findings): `scripts/benchmark/run-containment.ts`, `scripts/stress/keryx-shell-stress.ts`, `src/commands/harness.ts`, `src/commands/init.ts`, `src/commands/serve.cli.test.ts`, `src/commands/standard.ts`, `src/ctx/runtimes.ts`, `src/harness/child/isolation.ts`, `src/harness/extension/execute.test.ts`, `src/harness/mutation/guard.loopback.test.ts`, `src/harness/policy/profiles.test.ts`, `src/harness/process/sandbox/proxy.ts`, `src/harness/provider/anthropic/anthropic-negatives.hardening.test.ts`, `src/harness/resume/recovery.hardening.test.ts`, `src/harness/search/controller.ts`, `src/harness/search/registry.ts`, `src/harness/tool/builtin/interactive-tools.ts`, `src/harness/web/web-worker-runner.ts`, `src/lib/git-hooks.ts`, `src/lib/project-registry.test.ts`, `src/lib/project-registry.ts`, `src/lib/serve-credential.ts`, `src/lib/serve-server.test.ts`, `src/lib/serve-server.ts`, `src/lib/version-check.test.ts`, `src/mcp-client/client.ts`, `src/memory/embedding/embedding.test.ts`, `src/memory/p5-temporal-config-catalog.test.ts`, `src/memory/supersede.ts`, `src/memory/temporal.ts`, `src/metrics/comparative.ts`, `src/metrics/service.test.ts`, `src/sac/catch-up.test.ts`, `src/sac/machine-wrap-up.test.ts`, `src/sac/proposal-lifecycle.test.ts`, `src/sac/proposal-lifecycle.ts`, `src/session/slate-lifecycle.ts`, `src/session/store.ts`, `src/standard/emit-llms.ts`, `src/tui/balance-panel.test.ts`, `src/tui/balance-panel.ts`, `src/tui/games/modal.test.ts`, `src/tui/games/modal.ts`, `src/tui/review-buttons.test.ts`, `src/tui/tui-shell.ts`, `src/wiki/refresh.test.ts`.
- `no-control-regex` (8 findings): `src/commands/init.no-git.test.ts`, `src/commands/shell-pty-launch.smoke.test.ts`, `src/tui/shell-fallback.test.ts`.
- `no-irregular-whitespace` (1 findings): `src/lib/md-blocks.ts`.
- `no-misleading-character-class` (1 findings): `src/lib/md-blocks.ts`.
- `no-unsafe-finally` (1 findings): `src/tui/tui-shell.ts`.
- `no-useless-assignment` (17 findings): `src/commands/goal-command.ts`, `src/commands/shell.ts`, `src/commands/test.ts`, `src/harness/child/escalation.ts`, `src/harness/process/shell-spawn.ts`, `src/lib/gdgraph-post-commit.test.ts`, `src/lib/serve-config.ts`, `src/lib/serve-turn.ts`, `src/rules/agent-entrypoints.ts`, `src/testing/service.ts`, `src/tui/chat-shell.test.ts`, `src/tui/mcp-inspector.ts`, `src/tui/shell-chrome.ts`.
- `no-useless-escape` (32 findings): `src/commands/workspace.ts`, `src/gdgraph/build.ts`, `src/gdskills/bundled-eval.ts`, `src/lib/metaproject-gitignore.ts`, `src/lib/templates.ts`, `src/sac/policy-experiment.test.ts`.
- `parser` (5 findings): `src/flow/review-gate.e2e.test.ts`, `src/harness/run/run.test.ts`, `vscode-extension/src/hover-logic.test.ts`, `vscode-extension/src/status-bar-logic.test.ts`, `vscode-extension/src/tree-view-logic.test.ts`.
- `prefer-const` (13 findings): `src/commands/shell.ts`, `src/gdgraph/fallback.test.ts`, `src/tui/background-job-inspector.ts`, `src/tui/external-inspector.ts`, `src/tui/game-modal.ts`, `src/tui/games/modal.ts`, `src/tui/mcp-inspector.test.ts`, `src/tui/subagent-inspector.ts`, `src/tui/theme-picker.ts`.
- `preserve-caught-error` (12 findings): `src/commands/review.ts`, `src/flow/service.ts`, `src/gdskills/project-skills.ts`, `src/lib/fs.ts`, `src/lib/json.ts`, `src/review/managed.ts`, `src/sac/fwk-service.ts`, `src/standard/service.ts`.
- `require-yield` (2 findings): `scripts/stress/keryx-shell-stress.ts`, `src/tui/games/modal.test-helpers.ts`.

## Semantic assessment

- `src/tui/tui-shell.ts`: moved `continue` and queue-slot cleanup immediately after the `try/catch/finally`; `finally` now performs only the unconditional `sideWorkerRunning = false` reset. Successful work, handled failure, queued continuation, and empty-queue cleanup keep the same order, while `continue` can no longer override an abrupt completion from the protected block.
- `src/lib/md-blocks.ts`: replaced the literal combining-mark character class with the same four numeric code-point ranges. Existing width tests, including zero-width marks, pass.
- `vscode-extension/src/*-logic.test.ts`: removed TypeScript-only test annotations so the root ESLint parser can parse the fixtures; runtime inputs and assertions are byte-for-byte equivalent in value.
- `preserve-caught-error`: retained sanitized public messages and added line-local explanations instead of attaching raw caught objects or stacks that may contain secrets.
- `no-control-regex`, `require-yield`, and generated-template `no-useless-escape`: retained the intentional behavior with narrow, explained directives. No file-wide or global rule suppression was added.
- All other edits remove unused imports/types/functions, preserve side-effectful calls, eliminate overwritten initial values, or apply safe automatic `const`/directive cleanup.

## Commands and evidence

```text
./node_modules/.bin/eslint --format json <all 90 paths from T18-lint-scope.json>
exit 0; 0 findings

bun test vscode-extension/src/hover-logic.test.ts vscode-extension/src/status-bar-logic.test.ts vscode-extension/src/tree-view-logic.test.ts src/lib/md-blocks.test.ts src/tui/tui-shell.test.ts
219 pass; 0 fail

bun test src/commands/goal-command.test.ts src/ctx/runtimes.test.ts src/harness/search/search.test.ts src/harness/tool/builtin/interactive-tools.test.ts src/lib/project-registry.test.ts src/lib/templates.test.ts src/tui/balance-panel.test.ts
131 pass; 0 fail

bun test src/lib/md-blocks.test.ts  # final repeat after numeric code-point refactor
68 pass; 0 fail

bun run typecheck
exit 2; 12 diagnostics, all in the concurrent containment lane; 0 T18-owned diagnostics

git diff --check
exit 0
```

## Routing audit

- `graph_used`: yes; the graph reported uncommitted files and was treated as stale.
- `wiki_used`: not-relevant (bounded lint remediation with no domain/architecture question).
- `ctx_used`: yes, for scoped searches and command-output handling.
- `raw_rg_used`: no.
