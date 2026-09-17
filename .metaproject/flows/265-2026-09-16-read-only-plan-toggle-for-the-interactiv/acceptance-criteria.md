# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/commands/permission-mode.ts` exports `readOnly: boolean` as a field of `ApprovalGateInput`, independent of `PermissionMode` (not a 4th mode value), and `resolveApprovalDecision` returns the new `"deny"` member of `ApprovalGateDecision` whenever `readOnly === true` and `risk !== "read"`, for every mode (`ask`/`trust`/`auto`) — proven by unit tests in `permission-mode.test.ts` covering readOnly × all three modes × every `GatedToolRisk`.
- AC2: A `/plan` command exists in `src/commands/agent-commands.ts` with `modes: AGENT_ONLY` (agent-mode only, absent from chat-mode), described as `/plan [on|off]` — proven by `agent-commands.test.ts` and a clean run of `agent-commands.confusable.test.ts`.
- AC3: `src/commands/shell.ts` and `src/tui/tui-shell.ts` each hold their own in-memory `readOnly` state (mirroring the existing `permissionMode` closure pattern), independently settable from `permissionMode`, toggled by `/plan [on|off]` with a no-arg branch reporting current state — proven by `shell.test.ts` and `tui-shell.test.ts`.
- AC4: `src/tui/busy-dispatch.ts` classifies `/plan` as busy-dispatchable (new `"plan"` `BusyDispatchTarget`), and `tui-shell.ts`'s busy-branch switch handles it — proven by `busy-dispatch.test.ts`.
- AC5: `readOnly` is threaded into the real gate: `src/commands/agent.ts`'s `executeCall` (all three `resolveApprovalDecision` call sites — shell/destructive, delegate, write) consults a new `AgentIO.readOnly` getter (mirroring `permissionMode`), and both call sites of `executeCall` (`runAgentTurnCore`'s main loop and `runConcurrentSpawnBatch`) pass it through. A `"deny"` decision returns an immediate refusal with no `requestApproval` call — proven by an end-to-end test exercising `executeCall`/`runAgentTurn` under `readOnly: true` in a non-`ask` mode (e.g. `trust`), confirming the call is denied and `requestApproval` is never invoked.
- AC6: `readOnly` is never persisted — no new config file, no registry, no write to `permission-mode-config.ts` or any other disk-backed store; every session starts with `readOnly === false` regardless of any prior session's state — proven by code inspection (no new persistence call sites) plus a test asserting the default state.
- AC7: `bun run lint`, `bun run typecheck`, and the full set of touched test files (`permission-mode.test.ts`, `agent-commands.test.ts`, `agent-commands.confusable.test.ts`, `busy-dispatch.test.ts`, `shell.test.ts`, `tui-shell.test.ts`, and the new end-to-end readOnly-gate test) pass — proven by `code-verifier`'s run.
