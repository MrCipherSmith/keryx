# Implementation Plan — Flow 018 (W14 real provider adapter)

Status: frozen scope (W14 only) — last wave of the track

## Approach

Add `src/harness/provider/anthropic/` — the first real provider adapter (Anthropic
Messages API) behind the W5 `ProviderPort`, test-first. A thin `fetch`/SSE transport
(NO SDK → `dependencies` stays `{}`) with a pure SSE parser + pure Anthropic→Normalized
mapping. The live `fetch` fires only behind an explicit capability grant and passes the
reused W15 private-egress guard; storage/retention/continuation stay `false` (frozen
descriptor); the credential is never persisted/logged. The whole test suite is offline:
recorded SSE transcripts replayed + mocked `fetch`; no live network in CI. Provider
negatives (timeout/cancel/malformed/truncation/rate-limit/auth/overloaded/5xx/egress-
deny/missing-capability) map to the 9-kind error taxonomy, fail-closed.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RP-01 RED) | test | tests-creator | **Sonnet** | provider/contract |
| T6 (RP-01) | implement | task-implementer | **Opus 4.8** | provider/contract |
| T7 | review | review-orchestrator | **Opus 4.8** | provider/contract/security |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, each with the
worktree-guard (cd + pwd).

## Steps

1. T1: adapter map + ProviderPort contract + D-04 storage-off + egress-guard + transcript
   model + constraint-reversal note (context.md).
2. T5 (RP-01 RED): adapter tests via recorded-transcript replay + mocked fetch —
   normalization (text/tool/usage/finish), provider negatives → fail-closed, storage-off
   descriptor, capability-gate, egress-guard. Offline/deterministic.
3. T6 (RP-01 GREEN): `anthropic-provider.ts` + pure `sse.ts` + `normalize.ts` + recorded
   fixtures; minimal additive `export` of the W15 egress predicate if needed. Make T5 green.
4. T7: `tsc` + full `bun test` (≥1114 + new green, ALL offline); ProviderPort conformance
   (no SDK type across the port); storage-off frozen invariant; egress guarded; capability-
   gated; provider negatives fail-closed; credential never persisted/logged; deps `{}`
   preserved; reuse-only (W5/W6/W7/W15); frozen schemas + ADR untouched.
5. `keryx health run`; confirm ACs; completion (option B, verified handoff).

## Verification (TDD)

Each behavior RED before impl, GREEN after. Gate: `tsc` clean; full `bun test` ≥1114 +
new green and FULLY OFFLINE (no live network); the adapter validates its descriptor +
normalized records against the frozen schemas; provider negatives fail-closed; deps `{}`;
deterministic.

## Risks

- **A test hits the live network / is non-deterministic** → all tests replay recorded
  transcripts + mock `fetch`; the live call is behind a capability flag and never runs in
  CI; T7 greps the tests for any un-mocked `fetch`/live host + confirms determinism.
- **SDK type leaks across ProviderPort** → thin `fetch` only, no SDK; the adapter maps to
  NormalizedEvent/NormalizedError; T7 confirms no SDK/provider-wire type is exported across
  the port.
- **Storage-off violated** → `describe()` descriptor validates against the frozen
  `const:false` schema; no persistence path; credential redacted; T7 asserts.
- **Egress to a private/metadata host** → base-URL host checked with the reused W15
  predicate; private/loopback/metadata denied; T5/T7 assert a private base URL fail-closes.
- **A new production dependency sneaks in** → thin `fetch`, NO SDK; `dependencies` MUST
  stay `{}`; T7 confirms package.json `dependencies` unchanged.
- **Rewriting W5/W6/W7/W15** → reuse-only; only a minimal additive `export` of the egress
  predicate is allowed; any deeper change → STOP + report.
- **Wrong-worktree / tsc-cast / index-guard** → guard directives in every dispatch.
