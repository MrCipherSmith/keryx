# Implementation Plan — Flow 010 (W16 Release 0 evidence)

Status: frozen scope (W16 at Release 0 boundary) — docs + reviews only

## Approach

Produce consolidated Release 0 release-evidence: a capability/evidence matrix
(E-01), an independent 7-lens managed review of the assembled slice (E-02), and a
promoted roadmap + flow-orchestrator handoff (E-03, gated on a clean review). No
new runtime code or test changes; the 797/0 suite stays as-is.

## Worker routing & Model Policy

| Task | Kind | Worker | Model |
|---|---|---|---|
| T5 (E-01) | docs | job-documenter | **Sonnet** |
| T6 (E-02) | review | review-orchestrator | **Opus 4.8** |
| T7 (E-03) | docs | job-documenter | **Sonnet** |
| T8 | review | review-orchestrator | **Opus 4.8** |
| T2/T3/T4 | umbrella | orchestrator | Opus |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result` with a
worktree-guard (cd + pwd) in every writing dispatch.

## Steps

1. T1: W1–W7 inventory + matrix skeleton (context.md).
2. T5 (E-01): write `E-01-release0-evidence-matrix.md`; update `research-ledger.md`
   and `decision-registry.md`; migration-notes; mark the 2 deferred scenarios.
3. T6 (E-02): 7-lens independent review of the Release 0 slice → normalized
   `E-02-release0-review-package.md` with severity; verdict on BLOCKER/P0/P1.
4. Orchestrator reads E-02 verdict. If BLOCKER/P0/P1 → surface to user, do NOT
   auto-create the handoff (E-03 documents why not). Else proceed.
5. T7 (E-03): promote roadmap/package + `flow-orchestrator-handoff.md`
   (DAG/AC/gates/constraints/out-of-scope/deferred).
6. T8: verify docs-only (git shows no `src/**` change), `bun test` 797/0, `tsc`
   clean, deps `{}`, frozen requirements + ADR-0001…0004 untouched, matrix paths/
   tests exist, handoff complete.
7. `keryx health run`; confirm ACs; completion choice (ask user A/B/C).

## Verification

Docs+reviews only. Gate: no `src/**` change (git); `bun test` still 797/0; `tsc`
clean; deps `{}`; evidence-matrix rows resolve to real files/tests/commits;
E-02 severity verdict recorded; handoff gated correctly.

## Risks

- **Accidentally changing runtime/tests** → docs-only; T8 asserts `git status`
  shows no `src/**`/test change.
- **Editing frozen requirements / frozen ADRs** → only new docs +
  research-ledger/decision-registry; T8 asserts frozen paths untouched.
- **E-02 surfaces a real P0/P1** → E-03 handoff is gated; orchestrator surfaces to
  the user rather than promoting a handoff over an open blocker.
- **Inaccurate matrix** (dead paths/tests) → T8 spot-checks each row resolves.
- **Wrong-worktree writes** → worktree-guard + post-worker location check.
