# Separate OpenAI API and ChatGPT subscription providers
Version: 0.1.0

## Request
Complete the existing unfinished subscription implementation in an isolated worktree. Offer two distinct Shell providers: OpenAI API (API key) and ChatGPT / Codex (subscription device-code sign-in completed in a browser). The user will try their Pro account after a later release.

## Scope
Native Keryx provider integration, streaming/tool calls, login, token refresh, provider picker and connection status/test/disconnect, regression tests, documentation. Preserve API-key behavior and existing credentials. No release, merge, live account login, or unrelated changes in this task.

## Authorization
User explicitly authorized worktree creation and completion of this feature. Routine implementation choices and tests are included. Release is a subsequent step.
