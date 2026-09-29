# Implementation Plan

Status: ready

## Approach

Harden commit d5b9fb11 in place. In `executeCall` (src/commands/agent.ts) add `!untrustedOrigin` to the
trusted-MCP bypass and stop sending `mcpTrustAvailable` while the floor is on. Change the session set from
`Set<string>` to `Map<string, string>` (FQN -> definition fingerprint). A host-supplied resolver returns the
current fingerprint for an FQN from the MCP catalog; a mismatch drops the grant and asks again. Keep the
readline prompt (`approval-render.ts`) and the TUI dock (`tui-shell.ts`) consistent, with a line saying why the
option is missing.

## Steps

1. T1 read the commit and its tests.
2. T2 floor: bypass and offer, with tests (AC1, AC2).
3. T3 definition fingerprint and Map (AC3, AC4).
4. T4 prompt/dock text, docs, README, CHANGELOG (AC5).
5. T5 verify and review; record the follow-ups (AC6).

## Risks

- The fingerprint must be stable across reconnects that do not change the tool: hash a canonical JSON of name, description and input schema only.
- Do not persist anything to disk.
