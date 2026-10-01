# Implementation Plan

Status: ready

## Approach

Add one resolver on `AgentIO`, `mcpToolDestructive?: (fqn: string) => boolean`, beside `mcpToolFingerprint`, wired in `src/tui/tui-shell.ts` from the live catalog (`entry.annotations?.destructiveHint === true`). It is consulted at call time, in `executeCall` (`src/commands/agent.ts`, near lines 4492-4497) so a stale grant is dropped and `mcpTrustEligible` is false, and in `mcpTrustOffered` (`src/mcp-servers/approval-render.ts`) so neither the TUI dock (`tui-shell.ts` ~5220) nor the readline prompt offers trust. `mcpTrustWithheld` gets a `destructive` reason. Absent annotations mean "not destructive" (stated in the docs).

The list and revoke commands live under `/mcp` as a subcommand (`/mcp trust list|revoke`), parsed in `src/tui/mcp-consumer.ts` (which today matches only the first token), with the registry entry in `AGENT_SLASH_COMMANDS` extended so the dropdown, `/help` and the help modal show it. The trusted marker is added in `describeUseToolApproval` / `renderUseToolApprovalLines`, `formatConsumerModalRow` and `io.onAutoApproved`. The `/new` fix clears the map in `startNewSession` and `resetSessionSurface`.

## Steps

1. Resolver, withheld reason, call-time drop of stale grants, tests (AC1, AC2, AC7).
2. `/new` and `/clear` clear the map; failing-first test (AC6).
3. `/mcp trust list|revoke`, registry entry, help, pins (AC3, AC4).
4. Trusted marker on every surface, auto-approve line names the tool (AC5).
5. Docs, module page, CHANGELOG 0.3.34, version (AC8).
6. Review, CI, merge, release, install, smoke, stop (AC7, AC9).

## Risks

- `tui-shell.test.ts` audits source text: a moved line can fail a pin that is not about the feature.
- The `/mcp` first-token matcher and the busy-dispatch classifier both have to learn the subcommand, or `/mcp trust revoke` mid-turn is mishandled.
- Revoke by name must accept the full `server__tool` name; ambiguity between servers must not revoke the wrong tool.
- The import-policy ratchet counts facade bypasses; do not add new ones.
- The readline REPL wiring in `src/commands/shell.ts` was not verified by the explorer; check it before claiming AC1 for the readline prompt.
