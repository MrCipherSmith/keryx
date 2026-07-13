# Tasks — Flow 019 (Release 1 boundary re-run)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: Release 1 boundary. Docs (E-01/E-02/E-03) under `docs/decisions/keryx-harness/`
(NO runtime code) + H-01 provider-negative TEST files under `src/harness/provider/
anthropic/`. Reuse-only; deterministic/offline; deps `{}`; frozen requirements pkg +
ADR-0001..0004 + canonical schemas + src/eval + src/contracts NOT edited; do NOT overwrite
the R0 boundary docs. Worktree-guard.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Release 1 boundary map + surface/commits + H-01 provider re-run scope (context.md). |
| T2 | implement | — | Umbrella: (docs/tests only — no runtime impl) closed when T6/T8 done. |
| T3 | test | — | Umbrella: TDD/hardening tests (closed when T5 authored + green). |
| T4 | review | — | Umbrella: review + completion prep (closed when T7/T9 + completion done). |
| T5 | test (H-01 provider negatives) | Sonnet | `src/harness/provider/anthropic/anthropic-negatives.hardening.test.ts` (test-only, OFFLINE): a consolidated non-vacuous red-team suite driving the W14 `AnthropicProvider` (recorded fixtures + mocked `fetch as unknown as typeof fetch`) — timeout, rate-limit (429 +retryAfterMs), malformed event, truncation (torn SSE, no model_end), egress-deny (private/loopback/metadata base URL), cancellation (AbortSignal → cancelled), authentication (401) — each asserts the correct `ProviderErrorKind`, `retryable`, NO spurious `model_end`, and the apiKey never leaks. Reuse W14's fixtures/helpers; add the gaps not already covered by W14's own suite (no vacuous duplication). NO live network; deterministic. |
| T6 | docs (E-01) | Sonnet | `docs/decisions/keryx-harness/E-01-release1-evidence-matrix.md` (mirror `E-01-release0-evidence-matrix.md`): a capability → source-file / test / commit matrix for the Release 1 surface — W8 (c279e3a), W9 (33f8e8d), W10 (8ed5373), W11 (d2f8ca4), W12 (550f372), W13 (8ec1016), W15 (de46260), W14 (109c63c), incl. T5's provider negatives — plus a research-ledger update and migration notes; every claim marked implemented / planned / deferred (traceability gate). Cite baseline `bun test` 1150+/0, `tsc` clean, deps `{}`. Docs-only; cite (do NOT edit) the frozen pkg/ADRs. |
| T7 | review (E-02) | Opus | `docs/decisions/keryx-harness/E-02-release1-review-package.md`: an INDEPENDENT multi-lens review (architecture / contract / logic / security / testing-replay / performance / Gherkin over S-01…S-12) of the built Release 1 (read the code read-only; do NOT modify source). Record findings by severity and a GO / NO-GO verdict with any P0/P1. Confirm the fail-closed invariants (W10/W12/W13/W15) + provider adapter (W14) + resume/replay/migration (W8/W7) hold; deps `{}`; frozen untouched. Source review untouched (normalized managed review package only). |
| T8 | docs (E-03) | Sonnet | `docs/decisions/keryx-harness/E-03-release1-handoff.md` — ONLY if T7's verdict is GO with no BLOCKER/P0/P1: promote the roadmap/package + write the Release 1 → Release 2 handoff (DAG of what's built, frozen-AC proposal for Release 2, gates, constraints, out-of-scope). Explicitly list the deferred @release-2 scenarios (SC_R08_CHILD_DISPATCH_CANONICAL_RESULT, SC_R08_BOUND_PARALLEL_WAVE, SC_R18_REGISTERED_EXTENSION_PROVENANCE, SC_R08/R18_EXTENSION_ESCALATION_REQUIRES_POLICY, SC_R08_NEEDS_CONTEXT_ADAPTER, SC_R13_TUI_DEFERRED) as the next track. If T7 is NOT clean, record the blockers instead of a handoff and report. Docs-only. |
| T9 | review/verify | Opus | Final verification: the 3 evidence docs exist, are internally consistent + traceable (each E-01 claim → a real source/test/commit; E-02 verdict recorded; E-03 present iff clean); `git status` confirms E-01/E-02/E-03 changed NO runtime/frozen files (only new docs + T5 test file); H-01 provider-negative tests green + non-vacuous + offline; `tsc` clean; full `bun test` ≥1150 + new green; deps `{}`; frozen requirements pkg + ADR-0001..0004 + canonical schemas + src/eval + src/contracts untouched; health no new high-severity. |
