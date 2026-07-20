# Acceptance Criteria — flow 077 (token counter estimate)

- AC1: When the provider reports EXACT usage (e.g. OpenRouter), the header + sidebar show the exact cumulative `↑in ↓out` / total tokens. A 0/0 usage report is ignored (not usable).
- AC2: When no exact usage is reported after a turn (e.g. local Ollama/gemma), the counter shows an ESTIMATE (`~N`, `~N tokens (est)`) from `estimateContextTokens(history)` (≈ 4 chars/token) — so the counter is never stuck at 0. A pure `estimateContextTokens` is unit-tested.
- AC3: `runAgentTurn`, the readline shell, chat mode, and `roleLabel` are unchanged; flow-067..076 behavior preserved; `--tui` opt-in.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1510). No new dependency.
