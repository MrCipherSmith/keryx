# Context — Flow 007 (W5 ports)

Collected by `keryx flow init` and enriched for W5. (T1 context.)

## Baseline
- `bun test` = 633 pass / 0 fail; `tsc --noEmit` clean. Branch @ 2b92515.
- `src/harness/` empty (reserved for the runtime). `src/contracts/validateAgainstSchema` (W4) available.

## Design sources (frozen — read/cite, never edit)
- `docs/requirements/keryx-project-agent-harness/provider-protocol.md` — P-01 contract (adapter responsibilities, normalized request, 8 normalized events, error taxonomy, capability matrix, credentials, unknown-extension preservation, partial-tool-call rule).
- `specification.md` §Core Runtime Contracts (Model Provider; Tool Definition — the fs/shell boundary: "the model must not receive direct filesystem or shell access outside registered tools"; Policy Decision) and the inward-ports table (`ProviderPort`, `ToolExecutorPort`, `PolicyPort`, `SessionStorePort`; all adapter → port).
- ADR-0002 (single coordinator), ADR-0004 (provider/branch/child), ADR-0003 (policy profiles).

## Schemas (validate port payloads against these via src/contracts)
- P-01: `model-request`, `model-response`, `model-error`, `harness-event`, `harness-run-input`, `harness-run-output`, `provider-descriptor`, `harness-policy-decision`.
- P-02: `tool-definition` (req: schemaVersion,toolId,version,inputSchema,outputSchema,risk,capabilities,limits,replay), `tool-registry-snapshot` (req: schemaVersion,snapshotId,createdAt,registryHash,tools), `harness-tool-call` (req: schemaVersion,toolCallId,toolName,input,runId,sessionId,risk), `tool-result` (req: schemaVersion,toolResultId,executionId,toolCallId,causal,status,outputHash,redaction,createdAt), `tool-execution-state` (req: schemaVersion,executionId,toolCallId,causal,toolRegistryHash,inputHash,idempotencyKey,state,updatedAt), `policy-profile`.

## Port map (target — src/harness/)
### P-01 `src/harness/provider/`
- `ProviderPort`: `describe(): ProviderDescriptor`; `stream(request, {signal, attemptId}): AsyncIterable<NormalizedEvent>`.
- `NormalizedRequest` (provider/model id, system+messages w/ provenance class, tool definitions, options-if-supported, budget+reservation, stream+cancel, requestId/parentRunId).
- `NormalizedEvent` union (8): model_start, text_delta, tool_call_start, tool_call_delta, tool_call_end, usage_update, model_end, provider_error; sequence-numbered per request.
- `NormalizedError` taxonomy: authentication, invalid-request, rate-limit, overloaded, context-overflow, unavailable, cancelled, malformed, unknown (+ retry hints).
- `Attempt`: stable id; complete/fail/cancel/abandon. Unknown provider extensions → namespaced redacted field. Partial tool-call deltas never authorize execution. NO provider-SDK type in signatures.

### P-02 `src/harness/tool/`
- `ToolDefinition` (tool-definition schema): id/version/desc, inputSchema+outputContract, classification read|write|network|subprocess|credential, required-capability+risk, limits (timeout/byte/token/concurrency/cancel), injected impl adapter, provenance (projectRoot/worktree/session/turn/toolCall), deterministic/replay flag.
- `ToolRegistry`: register/get/`snapshot(): ToolRegistrySnapshot` (registryHash).
- `ToolExecutorPort`: `invoke(call): ToolResult` — validate `harness-tool-call` input against the tool's inputSchema (via src/contracts) BEFORE execution; budget/cancellation/provenance/replay metadata; `ToolExecutionState` tracking (executionId/idempotencyKey/state).
- Boundary: model → only ToolCall → registry+policy → executor; no fs/shell method on the port; unregistered/invalid call rejected. Release 0 tools read-only (actual tools are W6).

## Decisions (approved)
- Layout: `src/harness/provider/` + `src/harness/tool/` subdirs (+ shared envelope types if needed).
- Reuse `src/contracts/validateAgainstSchema` — NO new validator, NO new dependency, NO provider SDK.
- Port-only: no real/fake provider, no real tools, no CLI wiring in W5.

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker must `cd ~/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first and write ONLY under it (W4 incident). Verify file locations after each worker.
- TDD order: P-01 (T5 RED → T6 GREEN), P-02 (T7 RED → T8 GREEN), then T9 review.
