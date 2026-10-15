# Flow 068 — conventional TUI layout

Polish the OpenTUI agent shell toward a conventional terminal-agent look:
a header bar with a right-aligned token counter, a bordered rounded composer, a
dim footer hint line, and user messages in bordered boxes — via OpenTUI flexbox
(Box border/justifyContent/padding). runAgentTurn + the readline shell are
unchanged; the flow-067 clean launch is preserved. User validates via --tui.
