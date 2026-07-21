# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A mode-agnostic `ShellChrome` exists in `src/tui/shell-chrome.ts`, mounted by a headless `createTestRenderer` test — the first test ever to mount this shell's chrome. It asserts a frame containing header, transcript, composer and footer with the composer focused; the test fails against the pre-extraction code.
- AC2: The five forward-declared mutable bindings in the old closure are gone from the extracted chrome: no placeholder no-op is later rebound for `showToast`, `clearBusyTimer` or `setBusyPhase`, and the block nav controller no longer closes over bindings declared after it. Where a genuine cycle remains it is an explicit setter on the chrome object, and the code says why.
- AC3: `/`-menu behaviour is pinned by headless tests on the chrome: `/` opens it, printable keys filter it, `Esc` closes it and returns focus to the composer, and `overlayActive()` being true suppresses the menu key router.
- AC4: `showToast` renders and auto-clears, and `setBusyPhase` is reflected in the footer — both asserted on captured frames, not on internal state alone.
- AC5: `resize()` after mounting leaves the composer and footer visible (the flow-075 layout guard), asserted at more than one terminal size.
- AC6: `launchTuiAgentShell` is re-landed on the chrome and retains only agent-specific concerns (approval, ask-user, worker fleet, side workers, wiki-enrich router, block registry and nav, the `runAgentTurn` call site). Agent behaviour is unchanged: the full suite stays green and `src/tui` loses no assertion. Any behavioural change found during extraction is reported in the journal rather than made silently.
- AC7: The slash-command registry is mode-aware: `AgentSlashCommand` carries `modes`, and `filterCommands` / `findAgentCommand` take a mode. `/expand`, `/think` and `/copy` are agent-only; `/models` and `/provider` are chat-mode entries reconciled with `/model` and `/connect` and carry per-mode descriptions rather than one flattened entry. Unit-tested per mode.
- AC8: Typing an agent-only command in chat fails cleanly with an explanatory message — proven by a test, not merely absent from the menu.
- AC9: Both readline surfaces consult the shared registry — chat's inline branch and `runAgentRepl`'s — so the registry has three consumers rather than one. Proven by a test asserting a command's presence in a readline surface is derived from the registry, not from a duplicated literal.
- AC10: `src/tui/chat-shell.ts` renders `ShellIO` through the shared chrome, driven by the real `runShell`. A headless test drives a chat turn end to end with a fake provider and asserts the streamed reply appears in the captured frame.
- AC11: The push/pull adapter is unit-tested: composer submissions become `ShellIO.lines` in order, the iterator ends cleanly on exit, and the `"\n\n"` turn separator emitted by `runShell` does not produce an empty trailing message block.
- AC12: `keryx shell --chat` on a TTY reaches the TUI — the guard at `src/commands/shell.ts:1094` no longer excludes chat — and chat now applies `loadShellConfig()` / `applySavedApiKeys()`, so a provider key added via `/connect` is usable from `--chat`. The credential path is covered by a test.
- AC13: Chat renders fenced code and unified diffs through the flow-109 helpers (`createStreamSegmenter`, `createSegmentView`, `markdownToChunks`), asserted on a captured frame — a `ts` fence shows its language tag and a diff shows distinct add/remove colouring.
- AC14: No `onUsage` hook is added to `ShellIO` and no new npm dependency is introduced; chat's token display uses the existing estimator. `package.json` dependency lists are unchanged and `@opentui/core` is still reached only via dynamic import / `typeof import(...)`.
- AC15: `runShell`, `ShellIO` and the readline chat path still work: every existing test in `src/commands/shell.test.ts` passes unmodified, and the readline fallback still runs chat when there is no TTY or the optional dependency is absent.
- AC16: `bun run typecheck` is clean and `bun test` passes with no fewer tests than the 2024-pass / 11-skip / 0-fail baseline; `keryx health run` reports a gate no worse than baseline; `review-orchestrator` findings are resolved or given an explicit disposition in `journal.md`, with the reviewer told that T3/T4 moved untested code.
- AC17: The docpack is updated: O-1 and O-2 are closed in `specification.md` §10 with evidence, the status line no longer says the chat renderer is outstanding, §1's component diagram is true now that a real `ShellIO` implementation exists, and decisions D-A1..D-A4 are recorded in §9. Items deferred by this flow — assistant replies as blocks (D-A3), O-3, O-4, O-5 — remain listed as open rather than quietly dropped.
