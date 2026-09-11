# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `refreshSavedGrants` refreshes an expired, refreshable grok grant and saves it, leaves a still-valid grant untouched without calling the token endpoint, and on a failed refresh returns a warning naming the provider, the reason and `keryx auth login <provider>` with no token in it; the shell command awaits it before `chooseShellSurface`, and `resolveTuiStartup` no longer swallows a refresh failure (tests: `src/lib/oauth/refresh-saved-grants.test.ts`, `src/commands/shell-grant-refresh.test.ts`).
- AC2: `resolveShellEnv` omits every env key set from the saved config by `applySavedApiKeys` or `applyOAuthAccessToEnv`, keeps a key the operator exported, no longer loads saved keys into `process.env` as a side effect, and with `KERYX_SHELL_PASS_SAVED_KEYS=1` includes the saved keys; the restricted-network mask resolution receives the saved values (test: `src/harness/process/shell-env.test.ts`).
- AC3: a `memory_search` miss in a project with no deletion trail returns `removalTrail.verdict` `trail-absent` with a summary under 200 characters that contains neither the project path nor `journal.jsonl` and still states "never existed"; other verdicts' summaries have the project path made relative (test: `src/harness/tool/metaproject-adapter.test.ts`).
- AC4: the changelog records all three under `[Unreleased]` (the `shell_exec` change under Changed), and `bun run typecheck`, `bun run lint`, `bun run test:client:terminal` pass locally and CI on the pull request is green.
