# Unified Hub chat

The browser uses the same assistant-ui conversation for a Hub-started session
and a locally shared Keryx shell. The composer exposes slash commands, model
selection, turn and session statistics, and active approval choices. At phone
width the same controls fit without horizontal scrolling.

The live shell is authoritative for its command allowlist, available models,
usage and active question. Its transport accepts typed actions from the current
Hub controller and applies each action at most once. Ordinary message text
stays literal. A remote tool approval is a one-time decision for the exact
current question. Local-only questions stay visible with an instruction to
answer at the terminal. Older peers keep their existing chat capabilities.

Headless statistics use machine-reported usage. Historic runs without complete
usage show that the reported totals are partial. No usage is estimated from
conversation text.
