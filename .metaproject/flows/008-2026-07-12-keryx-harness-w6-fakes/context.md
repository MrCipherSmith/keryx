# Context — Flow 008 (W6 fakes)

Collected by `keryx flow init` and enriched for W6. (T1 context.)

## Baseline
- `bun test` = 677 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ d5fa7c0.

## W5 port surfaces to build on (reuse — do not rewrite)
- `src/harness/provider/types.ts`: `ProviderPort` (`describe()`, `stream(request, {signal?, attemptId}): AsyncIterable<NormalizedEvent>`), `NormalizedEvent` (8 kinds: model_start/text_delta/tool_call_start/tool_call_delta/tool_call_end/usage_update/model_end/provider_error; fields sequence/attemptId/text/toolCallId/toolName/inputDelta/input/usage/error/unknownExtensions), `NormalizedError` (taxonomy), `NormalizedRequest`, `Attempt` (id + complete/failed/cancelled/abandoned), `NormalizedUsage` (exact flag).
- `src/harness/provider/provider-port.ts`: `assertRequestValid`, `assertEventValid`, `toolCallExecutable`, `defaultRetryable`.
- `src/harness/tool/types.ts`: `ToolDefinition`, `ToolCall`, `ToolResult` (outputHash/status/redaction/…), `ToolExecutorPort.invoke(inv): Promise<ToolResult>` (ONLY invoke — no fs/shell), `ToolInvocation`, `ToolReplay{deterministic,recordedResultSupported}`, `ToolProvenance`, `CausalIds`, `ToolExecutionState`.
- `src/harness/tool/registry.ts`: `ToolRegistry` (register/get/has/list/snapshot), `definitionHash`.
- `src/harness/tool/tool-port.ts`: `validateToolCall(call, registry, schemaDir)` (envelope + registration + inline inputSchema).
- Validator (reuse): `src/contracts/validator.ts` `validateAgainstSchema`, `validateAgainstSchemaObject`.

## Transcript schema (fake-provider-transcript.schema.json)
required: schemaVersion, transcriptId, providerId (const `fake-provider`), providerRevision, requestHash (sha256), events[] (minItems 1). Each event: {sequence (int≥0), kind ∈ `text_delta|tool_call|finish|error`, payload? (object)}. `additionalProperties:false`.

## Raw→normalized mapping (FakeProvider replay)
Raw transcript kinds are provider-level; FakeProvider normalizes to the 8 NormalizedEvent kinds:
- prepend `model_start`; `text_delta`→`text_delta`; `tool_call`→`tool_call_start`(+optional `tool_call_delta`)+`tool_call_end`; `finish`→`model_end` (+ `usage_update` when usage present); `error`→`provider_error`.
- Deterministic: fixed attemptId, sequence from 0 within the attempt; NO Date.now/network/randomness.
- malformed event → typed `provider_error` (NormalizedError) preserving the partial event trail so far.
- unknown provider extension → preserved in `unknownExtensions` (namespaced/redacted), not dropped.
- cancellation → attempt outcome `cancelled`; retry boundary → representable per provider-protocol.

## Fixture / fake map
- F-01 transcripts: `src/harness/provider/fixtures/transcripts/*.json` — scenarios: text-deltas, tool_call, finish+usage, provider_error(taxonomy), malformed-event, unknown-extension, cancellation, retry-boundary. Each validates against `fake-provider-transcript.schema.json` (via src/contracts).
- F-01 `FakeProvider`: `src/harness/provider/fake-provider.ts` (implements ProviderPort, matches transcript by requestHash, replays → NormalizedEvents).
- F-02 `FakeReadOnlyTool`: `src/harness/tool/fake-tool.ts` — a read-only ToolDefinition (classification read-only, replay deterministic/recordedResultSupported) + a ToolExecutorPort impl returning a ToolResult with hash-bound `outputHash` (sha256 over canonical recorded output; same input→same hash). No net/mutation/fs.

## Decisions (approved)
- Fakes live in `src/harness/{provider,tool}/`; reuse W5 ports + src/contracts validator; NO new port/validator, NO new dependency, NO provider SDK, NO network, NO fs mutation.
- Determinism: fixed clock/ids in fixtures + fake code (no Date.now/Math.random/network).

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker must `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first and write ONLY under it (W4 incident). Verify file locations after each worker.
- TDD order: F-01 (T5 fixtures → T6 RED → T7 GREEN), F-02 (T8 RED → T9 GREEN), then T10 review.
