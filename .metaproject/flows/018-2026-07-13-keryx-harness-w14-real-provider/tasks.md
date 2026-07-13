# Tasks — Flow 018 (W14 real provider adapter)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W14** (implementation-plan.md RP-01). New code under
`src/harness/provider/anthropic/`. Thin `fetch`/SSE, NO SDK → `dependencies` STAYS `{}`.
Reuse W5 ProviderPort + W6 transcript model + W7 redaction + W15 egress guard
(composition; only a minimal ADDITIVE `export` of the W15 egress predicate if needed).
Live network ONLY behind a capability flag, NEVER in CI — tests offline via recorded
transcripts + mocked fetch. Adapter never writes flow.json (D-02). Deterministic
(injected clock/id). Worktree-guard. Last wave of the track.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Adapter map + ProviderPort/D-04-storage-off + egress-guard + transcript model + constraint-reversal note (context.md). |
| T2 | implement | — | Umbrella: implement per plan (closed when T6 done). |
| T3 | test | — | Umbrella: TDD tests (closed when T5 authored + impl green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T7 + completion done). |
| T5 | test (RP-01 RED) | Sonnet | `src/harness/provider/anthropic/` tests, OFFLINE/deterministic (recorded SSE transcripts + mocked `fetch as unknown as typeof fetch`). Cases: (a) **normalization** — a recorded Anthropic SSE transcript (message_start/content_block_start(tool_use)/content_block_delta(text_delta + input_json_delta)/content_block_stop/message_delta(usage,stop_reason)/message_stop) replays through the adapter's `stream()` into the exact `NormalizedEventKind` sequence (model_start/text_delta/tool_call_start/tool_call_delta/tool_call_end/usage_update/model_end); each yielded event validates via `assertEventValid`. (b) **storage-off** — `describe()` returns a descriptor with storage/retention/continuation = false that validates against `provider-descriptor.schema.json`. (c) **capability-gate** — no capability grant → fail-closed `NormalizedError` (no `fetch` attempted; assert the mocked fetch was NEVER called). (d) **egress-guard** — a private/loopback/metadata base URL → fail-closed (reuse W15 predicate). (e) **provider negatives** — 401→authentication, 400→invalid_request, 429→rate_limit (retryable, retryAfterMs from retry-after), 529→overloaded, 5xx→unavailable, malformed/torn SSE→malformed, AbortSignal→cancelled — each a `provider_error`/`NormalizedError` with the right `ProviderErrorKind`, and the credential is redacted from `.message`. RED before T6. |
| T6 | impl (RP-01) | Opus (provider/contract) | `src/harness/provider/anthropic/anthropic-provider.ts` (`AnthropicProvider implements ProviderPort`; capability-gated guarded-egress `fetch` transport; storage-off descriptor; credential redaction) + pure `sse.ts` (SSE parser) + pure `normalize.ts` (Anthropic-event → NormalizedEvent + error mapping) + recorded `fixtures/*.json|*.sse`. Reuse the W15 egress predicate via a minimal ADDITIVE `export` if needed (no behavior change). NO SDK; `dependencies` stays `{}`. Make T5 green. |
| T7 | review | Opus (provider/contract/security) | code-verifier (`tsc` + full `bun test` ≥1114 + new green, ALL OFFLINE — no live network); **ProviderPort conformance** (no SDK/provider-wire type exported across the port); **storage-off frozen invariant** (descriptor validates const:false; no persistence path; credential never persisted/logged/redacted from errors); **egress guarded** (private base URL denied via reused W15 predicate); **capability-gated** (no grant → no network attempt, fail-closed); **provider negatives fail-closed** (9-kind taxonomy mapping correct; adversarial: any un-mocked fetch / live-network path / non-determinism in tests?); **deps `{}` preserved** (package.json dependencies unchanged); reuse-only (W5/W6/W7/W15 unmodified except a minimal additive egress export); D-02 (no flow.json write); frozen requirements pkg + canonical schemas + src/eval + src/contracts + ADR-0001..0004 untouched. Lens: provider/contract + security. |
