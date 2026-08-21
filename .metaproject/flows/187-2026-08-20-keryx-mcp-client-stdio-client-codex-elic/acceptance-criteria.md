# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: `docs/requirements/keryx-mcp-client/specification.md` §10, carried
verbatim (numbering unchanged).

## Criteria

- AC1: keryx spawns `codex mcp-server` and completes the MCP handshake.
- AC2: A live `codex mcp-server` run that requires approval produces an `elicitation/create` request keryx receives and correctly parses (captured as a fixture from the live run, not authored from documentation).
- AC3: keryx answers that elicitation and the corresponding codex tool call proceeds (approve case) or is cleanly refused (deny case) — verified against the live process, not only the fixture replay.
- AC4: An elicitation left unanswered past the configured timeout resolves to a named refusal event, not a hang, verified with a fixture reproducing openai/codex#11816's condition.
- AC5: A malformed/empty-content elicitation is handled per PRD Requirement 4 (deny, not silent accept), verified with a fixture reproducing openai/codex#23383's condition.
- AC6: The new MCP supervisor calls `resolveApprovalDecision` for every received elicitation, with `"ask"` routed through the existing `requestApproval`/`AgentIO` prompt and `"auto"` answered without one — verified by a test asserting the call, not just that some response was sent.
- AC7: No credential of any kind is read, stored, or forwarded by this module (D-01 unchanged) — verified the same way `keryx-external-agent-runtime`'s own D-01 compliance is verified.
- AC8: The new MCP supervisor produces no `ExternalEvent` for the elicitation exchange itself (per §6's resolution) — `bridgeExternalEvent` and `reduceAgents` remain provably untouched, verified by the original package's own AC5 test suite continuing to pass unmodified.
- AC9: A per-action escalation classifier (the elicitation-payload analog of `classifyPatchRisk`) exists and is exercised by at least one fixture where it produces `destructive: true`/`credentials: true`, so `"trust"` mode's own escalation path (ADR-0010's shape) is provably reachable, not merely declared.
