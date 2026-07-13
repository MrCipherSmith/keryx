# Implementation Plan — Flow 019 (Release 1 boundary re-run)

Status: frozen scope (Release 1 boundary) — docs + tests only

## Approach

Close Release 1 at its boundary: (B) run the deferred H-01 provider negative families
over the W14 Anthropic adapter as an offline red-team test suite, then (A) produce the
Release 1 evidence package (E-01 matrix, E-02 multi-lens review with GO/NO-GO, E-03
handoff — gated on a clean review), mirroring the W16(R0) boundary docs. No new runtime
code except the H-01 provider-negative test files; new docs under
`docs/decisions/keryx-harness/`.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (H-01 provider negatives) | test | tests-creator | **Sonnet** | security/testing |
| T6 (E-01 evidence matrix) | docs | docs writer | **Sonnet** | documentation |
| T7 (E-02 review package) | review | review-orchestrator | **Opus 4.8** | architecture/contract/logic/security/testing/perf/gherkin |
| T8 (E-03 handoff) | docs | docs writer | **Sonnet** | strict |
| T9 | review/verify | review-orchestrator | **Opus 4.8** | strict |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, each with the
worktree-guard (cd + pwd).

## Steps

1. T1: Release 1 boundary map + surface/commits + H-01 provider re-run scope (context.md).
2. T5 (H-01 provider negatives, test-only): offline red-team suite over the W14 adapter —
   timeout/rate-limit/malformed/truncation/egress-deny/cancel/auth fail-closed.
3. T6 (E-01 docs): `E-01-release1-evidence-matrix.md` — capability→source/test/commit for
   W8–W15+W14 (incl. T5), research-ledger + migration-notes; every claim implemented/
   planned/deferred.
4. T7 (E-02 review): `E-02-release1-review-package.md` — independent multi-lens review;
   GO/NO-GO with P0/P1; source untouched (read-only).
5. T8 (E-03 docs): `E-03-release1-handoff.md` — roadmap/package promotion + handoff (DAG,
   frozen-AC proposal, gates, constraints, out-of-scope), ONLY if T7 = no BLOCKER/P0/P1.
6. T9: verify — docs consistent/traceable; NO runtime code changed by E-01/E-03; H-01
   tests green; full `bun test` ≥1150 + new green; deps `{}`; frozen untouched.
7. `keryx health run`; confirm ACs; completion (option B).

## Verification

Gate: `tsc` clean; full `bun test` ≥1150 + new H-01 tests green and OFFLINE; the evidence
matrix is traceable (each claim → source/test/commit with a status); E-02 verdict recorded;
E-03 present only if the review is clean; deps `{}`; no runtime code beyond T5 tests; frozen
pkg + ADR + schemas + src/eval + src/contracts untouched.

## Risks

- **E-01/E-03 accidentally edit runtime code or frozen files** → docs-only; T9 confirms
  `git status` shows only new docs + T5 test files.
- **H-01 provider negatives are vacuous / duplicate W14** → the suite must be non-vacuous
  (drive the real adapter, assert the specific ProviderErrorKind + no model_end + no
  credential leak); avoid re-asserting identical W14 cases — add the consolidated red-team
  gaps.
- **A test hits the live network** → recorded transcripts + mocked fetch only; T5/T9
  confirm no live network.
- **E-03 written despite a BLOCKER/P0/P1** → E-03 is gated on T7's verdict; if not clean,
  T8 records the blockers instead of a handoff and the flow reports it.
- **Overwriting the R0 boundary docs** → Release-1 files use distinct `-release1-` names.
- **Wrong-worktree / new dependency** → guard directives; deps stays `{}`.
