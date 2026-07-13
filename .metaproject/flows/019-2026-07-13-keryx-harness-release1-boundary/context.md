# Context — Flow 019 (Release 1 boundary re-run)

Collected by `keryx flow init` and enriched. (T1 context.) Release 1 boundary.

## Baseline
- `bun test` = 1150 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ 01a1ab5.

## Frozen spec (implementation-plan.md — execute verbatim)
- **E-01** (docs, reviewer=documentation): "Update package index, research ledger,
  migration notes, and capability/evidence matrix." Depends H-01. Evidence:
  "traceability gate; every claim marked implemented/planned/deferred."
- **E-02** (review, reviewer=review-orchestrator): "Run independent architecture,
  contract, logic, security, testing/replay, performance, and Gherkin reviews (S-01…S-12)."
  Depends E-01. Evidence: "normalized managed review package created; source review
  untouched."
- **E-03** (docs, reviewer=strict): "Promote roadmap/package and create handoff only if
  no BLOCKER/P0/P1 remains." Depends E-02. Evidence: "handoff includes DAG, frozen AC
  proposal, gates, constraints, and out-of-scope."
- **H-01** (test, reviewer=security/testing/performance): "Run … provider … hardening
  suites." The provider negative families were deferred from W15 (depended on RP-01/W14);
  now run them over the real adapter, offline.

## W16(R0) precedent (mirror the structure; new Release-1 files — do NOT overwrite R0)
- `docs/decisions/keryx-harness/E-01-release0-evidence-matrix.md`
- `docs/decisions/keryx-harness/E-02-release0-review-package.md`
- `docs/decisions/keryx-harness/flow-orchestrator-handoff.md` (the R0 handoff)
→ New: `E-01-release1-evidence-matrix.md`, `E-02-release1-review-package.md`,
  `E-03-release1-handoff.md`.

## Release 1 surface (waves → commits, for the evidence matrix)
- W8 durable resume (RS-01/RS-02) — `c279e3a` — `src/harness/resume/*`.
- W9 branching + typed compaction (B-01/B-02) — `33f8e8d` — `src/harness/branch/*`.
- W10 guarded mutation + approval (M-01/M-02) — `8ed5373` — `src/harness/mutation/*`.
- W11 flow integration (FI-01/FI-02) — `d2f8ca4` — `src/harness/flow/*` + additive `src/flow`.
- W12 child agents (CA-01/CA-02) — `550f372` — `src/harness/child/*`.
- W13 parallel scheduling (PA-01) — `8ec1016` — `src/harness/parallel/*`.
- W15 security & recovery hardening (H-01/H-02) — `de46260` — `src/harness/{extension,budget}/*`
  + additive `guard.ts`/`approval.ts` + `H-02-deferred-extension-capability-contract.md`.
- W14 first real provider (RP-01) — `109c63c` — `src/harness/provider/anthropic/*`
  + additive `guard.ts` `isPrivateEgressHost` export.
- (Release 0 reused: W1–W7 + W16(R0); frozen decisions D-01..D-04 / ADR-0001..0004.)

## H-01 provider-negatives scope (B — test-only, offline)
- Over `src/harness/provider/anthropic/anthropic-provider.ts` (W14): timeout, rate-limit
  (429 +retryAfterMs), malformed event, truncation (torn SSE), egress-deny (private base
  URL), cancellation (AbortSignal), authentication (401) — each fail-closed with the
  correct `ProviderErrorKind`, no spurious `model_end`, credential never leaked. Reuse the
  W14 adapter + recorded fixtures + mocked `fetch` (`as unknown as typeof fetch`). NO live
  network; deterministic. Some cases may already be covered by W14's own suite — this
  suite is the CONSOLIDATED red-team family; avoid vacuous duplication, add the gaps.

## D-02 invariant
Harness never writes flow.json. Docs/evidence never touch runtime state.

## Decisions (approved)
- ONE flow for both boundary re-runs. Docs (E-01/E-02/E-03) under
  `docs/decisions/keryx-harness/` — NO runtime code. H-01 provider negatives = TEST-ONLY
  under `src/harness/provider/anthropic/`. Reuse-only; deterministic/offline; deps `{}`;
  frozen requirements pkg + ADR-0001..0004 + canonical schemas + src/eval + src/contracts
  NOT edited. E-03 handoff only if E-02 = no BLOCKER/P0/P1.
- Models: H-01 tests — Sonnet; E-01/E-03 docs — Sonnet; E-02 review + final verify — Opus.

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. fetch-mocks `as unknown as typeof fetch`; guard array indexing.
- Order: T5 (H-01) → T6 (E-01) → T7 (E-02) → T8 (E-03, gated) → T9 (verify).
