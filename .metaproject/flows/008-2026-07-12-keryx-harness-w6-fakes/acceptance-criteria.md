# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: F-01 fixtures — deterministic fake-provider transcript fixtures exist under `src/harness/provider/fixtures/transcripts/` covering deltas, malformed events, unknown provider extensions, errors, cancellation, usage, and retry; each validates against `fake-provider-transcript.schema.json` via the `src/contracts` validator (providerId `fake-provider`, sha256 requestHash, ordered events).
- AC2: F-01 provider — `src/harness/provider/fake-provider.ts` defines a `FakeProvider` implementing the W5 `ProviderPort` that replays a matched transcript into the expected `NormalizedEvent` sequence OFFLINE and DETERMINISTICALLY (two runs produce byte-identical event snapshots); a malformed transcript event yields a typed `provider_error` while preserving the partial event trail; unknown provider extensions are preserved in `unknownExtensions`; the fake contains no `Date.now`/`Math.random`/network/SDK.
- AC3: F-02 tool — `src/harness/tool/fake-tool.ts` defines one registered read-only fake tool over the W5 tool port whose `invoke` returns a `ToolResult` with a hash-bound `outputHash` that is stable across runs (same input → same `outputHash`); execution occurs only after `validateToolCall` (unregistered or schema-invalid calls are rejected); the tool performs no network, filesystem, or mutating side effect.
- AC4: Reuse — the fakes reuse the W5 ports (`ProviderPort`, `ToolExecutorPort`, `ToolRegistry`, `validateToolCall`) and the `src/contracts` validator; no new port, validator, or production dependency is added (`package.json` dependencies stay `{}`); no provider SDK is imported.
- AC5: No regression / scope — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline of 677 pass with the new tests green and 0 fail; all new code lives under `src/harness/`; the frozen requirements package, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified.
