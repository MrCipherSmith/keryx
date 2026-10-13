# Implementation Plan

Status: implemented on branch feat/auto-mode-round-limit

## Approach

One module, `src/commands/round-limit.ts`, owns the numbers (40 ask, 120 trust, 200 auto, env wins, ceiling 200) and
the one-line description every surface renders. `runAgentTurnCore` reads the live mode at the start of each turn
(`io.permissionMode`) and resolves the limit from it unless the caller passed an explicit `maxRounds` (subagents and
deep-enrich keep their contracts). In `auto` without an explicit budget the limit extends itself without `askUser`
and stops at 200; in `trust` and `ask` the question stays, with a mode-sized allotment.

Subagents (how review waves run) are sized from the mode the parent turn was in: the agent loop passes
`permissionMode` in the tool context and `spawn_subagent` resolves 10/24 or, in `auto`, 40/200.

## Steps

1. round-limit.ts and the agent loop (AC1-AC5).
2. Shell: drop the static `maxRounds`; readline `/mode`, TUI picker, `/help` text (AC6, AC7).
3. Subagent limits via the tool context (AC11).
4. README, permission-modes guide, CHANGELOG (AC8, AC9).

## Risks

- `help-groups.ts` is a core zone and cannot import the module, so its `/mode` text is a literal; a test compares it
  with `describeRoundLimitSplit`.
- A trust turn can now run 120 rounds before the first question; the per-hash attempt cap still stops repetition.
