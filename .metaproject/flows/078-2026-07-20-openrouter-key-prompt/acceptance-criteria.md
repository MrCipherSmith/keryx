# Acceptance Criteria — flow 078 (OpenRouter always offered + key prompt)

- AC1: `detectProviders` ALWAYS offers `openrouter` (curated cheap model list, static, no network probe) — not gated on `OPENROUTER_API_KEY`. The flow-047 test is updated to assert openrouter is always present.
- AC2: In the TUI picker, selecting openrouter WITHOUT a key shows a key-entry input ("Paste your OpenRouter API key"); on Enter the key is set into `process.env.OPENROUTER_API_KEY` (in-memory only — never persisted or logged) so the provider factory uses it. With a key already in env, no prompt.
- AC3: The model list for openrouter is the curated cheap set (gpt-4o-mini default). `runAgentTurn`, readline core, chat, `roleLabel` unchanged; `--tui` opt-in; flow-067..077 preserved. The readline path still fails closed with its existing no-key notice.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1511); select tests updated and green. No new dependency. Key entry validated by the user on a real terminal.
