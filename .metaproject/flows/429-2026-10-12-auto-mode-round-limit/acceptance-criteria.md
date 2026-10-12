# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With `KERYX_AGENT_MAX_ROUNDS` unset, the round limit of a turn resolved for the `auto` permission mode is 200, for `trust` it is 120 and for `ask` it is 40; a unit test asserts all three values. [verify: exec `bun test src/commands/agent.test.ts`]
- AC2: `KERYX_AGENT_MAX_ROUNDS` wins in every mode (a value of 50 gives 50 in `auto`), and a value above 200 is clamped to 200; a unit test asserts both. [verify: exec `bun test src/commands/agent.test.ts`]
- AC3: In `auto` mode, reaching the limit never calls `askUser`: with the env limit at 3, a scripted turn extends itself in allotments of 3, capped at 200, prints the `[budget]` line each time, and continues; a test asserts `askUser` was not called. [verify: exec `bun test src/commands/agent.test.ts`]
- AC4: In `auto` mode, a turn that reaches 200 rounds stops with `finishReason: "budget"` and a `[budget]` message naming 200 as the ceiling and `KERYX_AGENT_MAX_ROUNDS`; no further provider request is made after it. A test asserts the reason, the text and the request count. [verify: exec `bun test src/commands/agent.test.ts`]
- AC5: `ask` and `trust` keep the question: at the limit "Increase limit and continue / Cancel" is still asked, a reset grants one more allotment of the mode (40 in `ask`, 120 in `trust`), and without a wired `askUser` the turn still stops; the existing round-limit tests pass unmodified. [verify: exec `bun test src/commands/agent.test.ts`]
- AC6: The shell reads the permission mode at the start of each turn: after `/mode auto` the next turn runs with 200, after `/mode trust` with 120, after `/mode ask` with 40, without restarting the session; a shell test asserts the round limit applied to a turn in each mode. [verify: exec `bun test src/commands/shell`]
- AC7: Every surface that shows the mode also shows the effective round limit: the readline `/mode` output, the TUI mode indicator or its modal, and `/help` for `/mode`; the numbers come from one function, so the three cannot disagree. A test asserts the text on the readline and TUI paths. [verify: exec `bun test src/tui/ src/commands/shell`]
- AC8: README and the docs site page that describes permission modes say that `auto` allows 200 rounds per turn without a question, that `trust` allows 120 and `ask` 40 and both still ask before extending, and that `KERYX_AGENT_MAX_ROUNDS` overrides all three up to 200; both are updated in the same change, and the doc-link check passes. [verify: exec `bun run check:doc-links`]
- AC9: `bun run typecheck` and `bun run lint` pass, and a CHANGELOG entry under the next version states the change and the 40/120/200 split. [verify: exec `bun run typecheck && bun run lint`]
- AC10: In a live `keryx shell` in `auto` mode a scripted prompt that needs more than 40 tool rounds runs through without the round-limit question appearing; the operator sees the run end normally. [verify: judged]
- AC11: Subagents, which is how review waves run, do not go through the shell turn limit, so they get the same split: in `auto` a child's omitted `max_rounds` resolves to 40 and a requested `max_rounds` is honored up to 200; in `ask` and `trust` the 10 default and the 24 cap stay as they are. The mode is read live at each dispatch, a child still makes at most `max_rounds + 1` provider requests, and a test asserts the three mode cases and the request ceiling. [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-tool.test.ts`]
