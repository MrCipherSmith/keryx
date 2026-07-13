# Context — Flow 018 (W14 real provider adapter)

Collected by `keryx flow init` and enriched for W14. (T1 context.) Last wave of the track.

## Baseline
- `bun test` = 1114 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ 0c4fed0.

## Frozen spec (implementation-plan.md — execute verbatim)
- **RP-01** (implement, reviewer=provider/contract): "Add first real provider adapter
  behind an explicit capability and privacy/retention contract." Depends R0-03, D-04.
  Negatives: "provider negatives." Evidence: "pinned research and provider fixtures
  pass; storage off by default."

## Approved decisions (user)
1. Provider = **Anthropic Messages API** (`POST /v1/messages`, `stream:true` SSE).
2. Transport = **thin HTTP `fetch` + pure SSE parser, NO SDK** → `dependencies` STAYS `{}`.
3. Fixtures = **recorded SSE transcripts** (W6 pattern), replayed offline; no live net in CI.

## D-04 provider-state (ADR-0004 §D4 — FROZEN)
"Provider-side storage, retention, and continuation are OFF by default and excluded
from Release 0." The frozen `provider-descriptor.schema.json` pins `storage`/`retention`/
`continuation` to `const: false` — machine-checkable. The adapter's `describe()` MUST
produce a descriptor validating against it (storage/retention/continuation = false).
Frozen schemas (S-02): `provider-descriptor`, `model-request`, `model-response`,
`model-error`. Validate via `src/contracts`.

## Reuse surface (do NOT rewrite; compose)
- **W5 ProviderPort** `src/harness/provider/{provider-port,types}.ts`:
  - `interface ProviderPort { describe(): ProviderDescription; stream(request:
    NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> }`.
  - `StreamOptions { attemptId: string; signal?: AbortSignal }` (cancellation).
  - `NormalizedEventKind` = `model_start | text_delta | tool_call_start |
    tool_call_delta | tool_call_end | usage_update | model_end | provider_error`.
  - `ProviderErrorKind` (9) = `authentication | invalid_request | rate_limit |
    overloaded | context_overflow | unavailable | cancelled | malformed | unknown`.
  - `NormalizedError { kind; retryable; message (credential-redacted); providerRequestId?;
    retryAfterMs? }`. `NormalizedEvent`, `NormalizedRequest`, `NormalizedUsage`,
    `ProviderCapabilities`, `ProviderDescription`, `Attempt`, `AttemptOutcome`.
  - `assertRequestValid`/`assertEventValid` (validate against frozen schemas),
    `defaultRetryable(kind)`, `toolCallExecutable(event)`.
- **W6 FakeProvider** `src/harness/provider/fake-provider.ts` (`FakeProviderTranscript`,
  `requestHashOf`) + `fixtures/transcripts/*.json` — the transcript/replay MODEL to mirror.
- **W7 evidence/redaction** `src/harness/evidence/redaction.ts` — reuse to redact
  credential material from error messages / any surfaced content.
- **W15 egress guard** `src/harness/mutation/guard.ts` — the private-egress predicate
  (`isPrivateEgressToken` + `isPrivateIPv4` + the encoded-IP decoder). REUSE for the
  base-URL host check. A minimal ADDITIVE `export` of that predicate (no behavior change,
  covered by existing tests) is permitted so the adapter does not duplicate the SSRF logic.

## Anthropic wire → Normalized mapping (SSE)
- `message_start` → `model_start`; `content_block_start`(tool_use) → `tool_call_start`;
  `content_block_delta`(text_delta) → `text_delta`, (input_json_delta) → `tool_call_delta`;
  `content_block_stop` (tool block) → `tool_call_end`; `message_delta`(usage/stop_reason)
  → `usage_update`; `message_stop` → `model_end`; SSE `error` event / non-2xx → `provider_error`.
- Error mapping: 401 `authentication_error` → `authentication`; 400 `invalid_request_error`
  → `invalid_request`; 429 `rate_limit_error` → `rate_limit` (retryable, `retryAfterMs` from
  `retry-after`); 529 `overloaded_error` → `overloaded`; 5xx `api_error` → `unavailable`;
  malformed/torn SSE → `malformed`; AbortSignal → `cancelled`. Reuse `defaultRetryable`.

## Capability gate + guarded egress + storage-off
- The live `fetch` fires ONLY when an explicit capability grant `{ network:true; apiKey }`
  is present; missing grant → fail-closed `NormalizedError` (no network attempt).
- Base-URL host checked with the W15 private-egress predicate; private/loopback/metadata
  → denied (fail-closed `NormalizedError`). `api.anthropic.com` (public) allowed.
- Credential (`apiKey`) NEVER persisted/logged; redacted from every error message. No
  persistence of prompts/responses without explicit opt-in (storage-off default). Stateless
  Messages API (no server storage/retention/continuation) → matches the frozen `const:false`.

## Test determinism (offline — hard requirement)
- NO live network in CI. Tests replay recorded SSE transcripts through the adapter's pure
  SSE parser + normalization, and mock `fetch` (`as unknown as typeof fetch`) to feed a
  recorded byte/SSE stream (and to simulate 429/401/5xx/abort/torn stream). `FakeProvider`
  stays the default provider everywhere else. No `Date.now`/`Math.random` (injected clock/id).

## Target modules
- `src/harness/provider/anthropic/anthropic-provider.ts` — `AnthropicProvider implements
  ProviderPort`; capability-gated guarded-egress transport; storage-off descriptor.
- `src/harness/provider/anthropic/sse.ts` — pure SSE line/event parser (deterministic).
- `src/harness/provider/anthropic/normalize.ts` — pure Anthropic-event → NormalizedEvent
  (+ error mapping). (May be inlined; the RED test pins the surface.)
- `src/harness/provider/anthropic/fixtures/*.json|*.sse` — recorded transcripts.

## D-02 invariant
The adapter NEVER writes flow.json. Only the Task Manager (`src/flow`) writes flow.json.

## Decisions (approved)
- New code under `src/harness/provider/anthropic/`. Thin `fetch`/SSE (NO SDK) → deps `{}`.
  Reuse W5/W6/W7/W15 (compose; only a minimal additive `export` of the W15 egress predicate
  if needed). Live network only behind a capability flag, never in CI; tests offline via
  recorded transcripts + mocked fetch. Deterministic (injected clock/id). Adapter never
  writes flow.json. Storage off by default; credential never persisted/logged.
- RP-01 runs TDD (RED tests Sonnet → GREEN impl Opus/provider-contract → review Opus).

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. fetch-mocks `as unknown as typeof fetch`; guard array indexing; immutability via `.toThrow()`.
- TDD order: RP-01 (T5→T6), review T7.
