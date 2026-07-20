# Acceptance Criteria — flow 074 (sidebar + reasoning expand + timestamps + tokens)

- AC1: The TUI has an opencode-style right sidebar (a row layout: main chat column + a fixed-width sidebar with a left divider) showing keryx, Model (provider/model), Context (cumulative tokens, updated on usage), and Tools (count).
- AC2: Reasoning is expandable — the collapsed `◆ thought (N lines) · /think to expand` marker plus a `/think` command that prints the last full reasoning. `/think` is in the shared registry (its unit tests updated).
- AC3: Timestamps — the assistant header shows `● keryx  h:mm AM/PM`. The header token counter starts visible (`↑0 ↓0`) and updates on usage (mirrored in the sidebar Context).
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1507). No new dependency; `runAgentTurn`, readline, chat, `roleLabel` unchanged; flow-067..073 preserved. NOTE: the look is validated by the user on a real terminal.
