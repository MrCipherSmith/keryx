# Context — Flow 009 (W7 Release 0 slice)

Collected by `keryx flow init` and enriched for W7. (T1 context.) RELEASE BOUNDARY.

## Baseline
- `bun test` = 703 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ 3b06260.

## Reuse (do NOT rewrite)
- W4 validator: `src/contracts/{validator,resolver,keyword-coverage}.ts` (`validateAgainstSchema`, `validateAgainstSchemaObject`).
- W5 ports: `src/harness/provider/*` (`ProviderPort`, `NormalizedEvent`, `assertRequestValid/assertEventValid`, `toolCallExecutable`, `defaultRetryable`), `src/harness/tool/*` (`ToolDefinition`, `ToolRegistry`, `validateToolCall`, `ToolExecutorPort`, `ToolResult`).
- W6 fakes: `src/harness/provider/fake-provider.ts` (`FakeProvider`, `requestHashOf`, `FakeProviderTranscript`, fixtures under `provider/fixtures/transcripts/`), `src/harness/tool/fake-tool.ts` (`FAKE_READONLY_TOOL`, `FakeToolExecutor`, `recordedOutputHash`).

## Data flow (the slice)
`harness-run-input` → startup (config enabled? preconditions? else typed `environment_blocked`) → context-manifest (bounded, hashed, trusted) → run loop: `FakeProvider.stream` → NormalizedEvents → on tool_call_end: policy allow/ask/deny (`policy-profile`→`harness-policy-decision`) → allow: `FakeToolExecutor.invoke` → `ToolResult` (redacted+hashed) → append-only session (`session-manifest`/`session-entry`, currentLeaf) + evidence (`evidence-record`) → budget/loop → on model_end: completion-gate (`completion-gate-result`) → `harness-run-output`. Replay: `replay-fixture` hashes → effect-free re-run → `replay-mismatch`. Transports: CLI + JSONL/RPC (`rpc-jsonl-envelope`), policy invariant across transports.

## Schemas & required fields (validate via src/contracts)
- harness-config: enabled, defaultRole, policyProfile, limits.
- harness-run-input: request, projectRoot, role, policy, budget. harness-run-output: runId, status, startedAt, finishedAt, gate, artifacts, metrics, unresolvedBlockerIds.
- harness-context-manifest: contextHash, projectRoot, createdAt, scope, sources, limits.
- session-manifest: sessionId, runId, createdAt, appendCursor, currentLeafEntryId, policyFingerprint, contextManifestHash. session-entry: entryId, sequence, timestamp, causal, entry.
- harness-policy-decision: decisionId, toolCallId, decision, policyProfile, timestamp, matchedRules. policy-profile: profileId enums (read-only-review / monitored-trusted-local / unattended-untrusted) + allOf conditionals + deny constants.
- evidence-record: evidenceId, causal, kind, artifact, provenance, recordedAt.
- completion-gate-result: gateId, runId, status, checks, evaluatedAt, evidenceRefs.
- rpc-jsonl-envelope: messageId, correlationId, kind, payload.
- replay-fixture: fixtureId, mode, sessionManifestHash, eventLogHash, toolRegistryHash, transcriptHash, expectedStateHash, noSideEffects. replay-mismatch: mismatchId, fixtureId, kind, expectedHash, actualHash, detectedAt.

## Sub-slice → scenarios (acceptance.feature @task tags)
- S1 R0-01 (T5/T6): `@task-R0-01` (8) — SC_R01_OFFLINE_START/CAPABILITY_OFF_NO_LOAD, SC_R02_TRUSTED_STARTUP/MISSING_PRECONDITION, SC_R14_* (offline/deterministic-independent/context scope+fingerprints/unavailable-artifact/transient-retry/TUI-deferred).
- S2 session (T7/T8): SC_R06_APPEND_ONLY_SESSION/RESUME_NO_DUPLICATE/SCHEMA_MIGRATION.
- S3 policy (T9/T10): SC_R05_HARD_DENY/HEADLESS_ASK/STALE_APPROVAL, SC_R07_BOUNDED_CONTEXT/STALE_OR_UNTRUSTED_CONTEXT, SC_R08_ROLE_CANNOT_ESCALATE, SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED.
- S4 completion (T11/T12): SC_R10_EVIDENCE_FREE/VERIFIED/UNDISPOSED_BLOCKER, SC_R11_REDACTION_BEFORE_PERSISTENCE, metrics reliability, evidence-link.
- S5 run+transport+replay (T13/T14): SC_R04_READ_ONLY_TOOL/MALFORMED_TOOL_INPUT/TOOL_TIMEOUT/TOOL_OUTPUT_OVERFLOW, SC_R12_BUDGET_EXHAUSTION/LOOP_DETECTION/REPLAY_MISMATCH + replay-offline/reject-live-effect/persist-mismatch, SC_R13_CLI_RPC_PARITY/TRANSPORT_CANNOT_CHANGE_POLICY.

## Target modules (src/harness/)
`config.ts`/`startup.ts` (S1); `context/manifest.ts` (S1/S3); `session/*` (S2); `policy/*` (S3); `evidence/*` + `completion/*` (S4); `run/*` + `cli.ts`/`rpc.ts` + `replay/*` (S5). Co-locate near the W5/W6 code.

## Decisions (approved)
- Whole slice in one flow (flow 009), 5 sub-slices S1–S5, each TDD RED→GREEN, then review.
- Reuse W4/W5/W6; all payloads validated via src/contracts; NO new port/validator/dependency, NO network/fs-mutation/SDK; deterministic (fixed clock/ids — no Date.now/Math.random).

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker must `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first and write ONLY under it. Verify file locations after each worker. fetch-mocks: `as unknown as typeof fetch`; guard array indexing (noUncheckedIndexedAccess).
- TDD order: S1(T5→T6), S2(T7→T8), S3(T9→T10), S4(T11→T12), S5(T13→T14), review T15.
