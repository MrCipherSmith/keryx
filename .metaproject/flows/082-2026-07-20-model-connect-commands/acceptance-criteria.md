# Acceptance Criteria — flow 082 (/model + /connect on the fly)

- AC1: `/model` and `/connect` are in the shared registry (tests updated). `/model` opens an in-TUI model picker for the CURRENT provider; `/connect` opens the full provider→model picker (with the OpenRouter key prompt when needed). Both are absolute-overlay pickers that cover the running shell and are removed on selection.
- AC2: Selecting rebuilds the agent deps mid-session (`deps` is mutable), persists the new provider/model (opencode-style config), refreshes the header/sidebar/footer model labels, refocuses the composer, and shows a `✓ Switched to <provider>/<model>` toast. Conversation history is preserved.
- AC3: `launchTuiAgentShell` takes a `redetect` callback (fresh `detectProviders`) used by `/model` and `/connect`. `runAgentTurn`, readline core, chat, `roleLabel` unchanged; flow-067..081 preserved.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1516); registry tests updated (/model, /connect + `/c` → [/connect,/clear], `/m` → [/model]). No new dependency. Interactive switching validated by the user on a real terminal.
