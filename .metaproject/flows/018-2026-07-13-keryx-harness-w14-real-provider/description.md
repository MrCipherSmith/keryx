# Flow 018 — W14 Real provider adapter (RP-01) — the last wave of the track

Status: formalized
Source: user description (harness runbook, Phase 14 — Release 2+ capability, scheduled last)

## Problem

Every wave W1–W15 ran fully offline against the deterministic `FakeProvider` (W6)
behind the W5 `ProviderPort`, keeping `dependencies: {}` and no network. Nothing yet
talks to a real model provider. W14 adds the FIRST real provider adapter — Anthropic
Messages API — behind the same `ProviderPort`, behind an explicit capability grant and
a privacy/retention contract (storage off by default), via a thin `fetch`/SSE
transport (NO SDK — `dependencies` stays `{}`). The entire test suite stays
offline/deterministic (recorded transcripts replayed; live network only behind a
capability flag, never in CI).

## Decisions (approved by the user)

1. **Provider:** Anthropic Messages API (`POST /v1/messages`, `stream:true` SSE).
2. **Transport:** thin HTTP over the built-in `fetch` + a pure SSE parser — NO SDK.
   `dependencies` REMAINS `{}` (no new production dependency; the constraint reversal
   is only guarded network egress behind a capability flag).
3. **Fixtures:** recorded SSE transcripts (the W6 pattern) replayed offline through the
   adapter's normalization; no live network in CI.

## Expected Outcome

- **RP-01 (implement)** — new code under `src/harness/provider/anthropic/`:
  - `AnthropicProvider implements ProviderPort` (W5) — `describe()` advertises
    capabilities + the frozen storage/retention/continuation = `false` descriptor
    (validates against `provider-descriptor.schema.json`); `stream(request, opts)` maps
    a `NormalizedRequest` → the Anthropic wire request, opens the SSE stream, normalizes
    each wire event → `NormalizedEvent`, honors `opts.signal` (cancellation), and maps
    failures → `NormalizedError` (the 9-kind taxonomy). NO SDK type crosses the port.
  - A pure SSE parser + a pure Anthropic→Normalized mapping (deterministic, offline-
    testable).
  - **Capability gate:** the live `fetch` fires ONLY when an explicit capability grant
    (network + credential) is present; without it → fail-closed `NormalizedError`
    (`authentication`/`invalid_request`), no network attempt.
  - **Guarded egress:** the base-URL host is checked with the W15 private-egress
    predicate (reuse) — a private/loopback/metadata destination is denied.
  - **Privacy/retention — storage off by default:** no persistence of prompts/responses
    without an explicit opt-in; the credential is never persisted or logged (redacted
    from every `NormalizedError.message`); Anthropic Messages API is stateless (no
    server-side storage/retention/continuation — matches the frozen `const:false`).
  - **Provider negatives → fail-closed:** timeout, cancellation (AbortSignal),
    malformed event, truncated stream, rate-limit (429 → `rate_limit`, retryable,
    `retryAfterMs`), auth (401), overloaded (529), 5xx (`unavailable`), egress-deny,
    missing-capability — each mapped to the correct `ProviderErrorKind`, fail-closed.
  - **Pinned fixtures:** recorded SSE transcripts under
    `src/harness/provider/anthropic/fixtures/` replayed through the adapter offline.

## Out of Scope (do NOT touch)

- No wave other than W14. This is the last wave of the track; Release 2 (@release-2
  scenarios) is a separate future track.
- Rewriting the W5 `ProviderPort`/`FakeProvider`, W6 fixtures, W7 evidence/redaction, or
  the W15 egress guard — REUSE them (compose; a minimal ADDITIVE `export` of the W15
  private-egress predicate is allowed, no behavior change). Large refactor → STOP + report.
- The frozen requirements package + frozen ADR-0001…0004 + canonical schemas + `src/eval/`
  + `src/contracts/` — read/cite only.
- **No live network in the test suite** (recorded transcripts / mocked `fetch` only; the
  real call is behind a capability flag and never runs in CI). No new production
  dependency (`dependencies` stays `{}`; no provider SDK). The adapter never writes
  flow.json (D-02). Deterministic tests (no `Date.now`/`Math.random`; injected clock/id).
