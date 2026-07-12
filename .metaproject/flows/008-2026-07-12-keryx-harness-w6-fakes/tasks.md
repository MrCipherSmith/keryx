# Tasks — Flow 008 (W6 fakes)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W6** (implementation-plan.md §W6). Offline/deterministic. No net,
no mutation, no SDK, no new dep. Reuse W5 ports + src/contracts. Worktree-guard.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Fixture/fake map + raw→normalized mapping (context.md). |
| T2 | implement | — | Umbrella: implement per plan (closed when T7+T9 done). |
| T3 | test | — | Umbrella: TDD tests (closed when T5/T6/T8 authored + impls green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T10 + completion done). |
| T5 | test (F-01 fix) | Haiku | `src/harness/provider/fixtures/transcripts/*.json` — 8 deterministic transcripts (text-deltas, tool_call, finish+usage, provider_error, malformed-event, unknown-extension, cancellation, retry-boundary), each valid against `fake-provider-transcript.schema.json`. |
| T6 | test (F-01 RED) | Sonnet | `src/harness/provider/fake-provider.test.ts` — replay each transcript via `FakeProvider` (import not-yet-existing) → assert exact `NormalizedEvent` snapshot; offline; re-run identical (deterministic); malformed→provider_error+partial trail; unknown→unknownExtensions; cancellation/usage/retry invariants. RED before T7. |
| T7 | impl (F-01) | Opus | `src/harness/provider/fake-provider.ts` — `FakeProvider` implements `ProviderPort`; matches transcript by requestHash; replays raw→normalized events (det. clock/ids). Make T6 green. |
| T8 | test (F-02 RED) | Sonnet | `src/harness/tool/fake-tool.test.ts` — register a read-only fake tool; validateToolCall→invoke→`ToolResult.outputHash` hash-bound & stable (same input→same hash); read-only (no side-effects); unregistered/invalid rejected. RED before T9. |
| T9 | impl (F-02) | Opus | `src/harness/tool/fake-tool.ts` — `FakeReadOnlyTool` (ToolDefinition read-only + ToolExecutorPort) returning a hash-bound `ToolResult`. No net/mutation/fs. Make T8 green. |
| T10 | review | Opus | code-verifier (`tsc` + full `bun test` ≥677 + new green); determinism/offline (no Date.now/Math.random/network/fs-write in fakes); no new dep (`deps {}`); frozen requirements pkg + src/eval + src/contracts + ADRs untouched. |
