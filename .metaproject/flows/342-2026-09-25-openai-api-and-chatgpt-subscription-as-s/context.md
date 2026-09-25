# Context
Version: 0.1.0

Root: /Users/Goodea/goodea/keryx-openai-subscription
Branch: codex/openai-subscription
Base: main at 0a5d23eb0

## Prior review evidence
- src/lib/oauth/openai-codex.ts obtains a device challenge, exchanges authorization_code with PKCE, saves OAuth through login.ts.
- make-provider.ts only accepts OPENAI_API_KEY for openai; grants.ts correctly excludes ChatGPT tokens from env.
- shell.ts oauthCredentialsFor uses compat registry which has no native openai entry.
- select.ts hides native openai without API key. TUI credential step depends on envKey, unsuitable for standalone OAuth providers.
- login.ts intentionally returns old OpenAI grant on refresh, and omits it from session refresh.
- Reproduction with synthetic login yielded active grant but FakeProvider; expired grant yielded zero refresh HTTP calls and no warning.
- 69 OAuth/provider-factory tests passed, but lacked subscription end-to-end coverage.

## Sources
- .metaproject/wiki/index.md and components/src-lib-oauth.md (draft; verify claims in source)
- .metaproject/data/testing/context.md: Bun co-located tests, eslint, tsc
- https://learn.chatgpt.com/docs/auth : device login requires ChatGPT security setting; subscription and API authentication separate.
- Upstream wire-protocol research is delegated to codex_transport_research; findings will be appended before provider implementation.

## Work isolation
node_modules symlink reuses installed dependencies; do not install/update shared dependencies. No edits in original checkout. No secrets/live auth. No release/merge.
