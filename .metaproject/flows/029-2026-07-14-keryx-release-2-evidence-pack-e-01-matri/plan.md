# Implementation Plan — Flow 029 (Release 2 evidence pack)

Status: frozen scope (docs-only; 3 new evidence docs)

## Approach

Assemble the Release 2 evidence pack (E-01/E-02/E-03) by synthesizing existing, durable evidence —
the runbook "Release 2 — Стейт" table, flow packages 023–028 (with confirmed AC), `git log`, PRs
#25–#31, the frozen `acceptance.feature` `@release-2` scenario tags, and the R0/R1 pack for format —
into three docs mirroring R1. Docs-only; every claim cites a real artifact. A final consistency
review verifies no contradiction with the frozen package / ADRs / merged code.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Notes |
|---|---|---|---|---|
| T5 (E-01 matrix) | docs | docpack | **Haiku 4.5** | mechanical: scenarios → source/test/commit, deferred list, invariants, AC traceability |
| T6 (E-02 review-package) | docs | docpack | **Opus 4.8** | synthesis of the 5-lens review + 2 post-review passes; per-lens verdicts; gate evidence |
| T7 (E-03 handoff) | docs | docpack | **Haiku 4.5** | structured: status/built/DAG/gates/constraints/options/open-items, from E-01+E-02 |
| T8 (consistency review) | review | review | **Opus 4.8** | cross-doc + vs frozen package/ADRs/code; no fabricated evidence; no contradiction |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via subagent-dispatch → subagent-result, worktree-guard
(`cd /Users/Goodea/goodea/keryx`, branch `feature/keryx-release2-evidence`). Sequential: T5 → T6 → T7 → T8.

## Steps

1. T1: scope + format from the R1 pack (description.md).
2. T5 (E-01): `docs/decisions/keryx-harness/E-01-release2-evidence-matrix.md` mirroring the R1 matrix —
   each `@release-2` scenario (SC_R08_CHILD_DISPATCH_CANONICAL_RESULT, SC_R08_NEEDS_CONTEXT_ADAPTER,
   SC_R08_BOUND_PARALLEL_WAVE, SC_R18_REGISTERED_EXTENSION_PROVENANCE, SC_R08/R18 EXTENSION_ESCALATION,
   SC_R13_TUI_DEFERRED, SC_R04_SHELL_CONTAINMENT runtime) → source file / test / commit; deferred-list
   update (F-1 CLOSED by R2-5; H ADDED as known-limitation); invariants held; AC-R2-1…R2-5 traceability.
3. T6 (E-02): `E-02-release2-review-package.md` mirroring the R1 review-package — verdict, gate evidence
   (verify against the tree: `tsc`, `bun test` count, deps `{}`, D-02), per-lens verdicts, consolidated
   findings (5 MED #30 + 7 LOW #31 + H deferred), `@release-2` coverage cross-check, consistency, audit.
4. T7 (E-03): `E-03-release2-handoff.md` mirroring the R1 handoff — Release 2 achieved; built; DAG; gates;
   constraints; future OPTIONS (not commitments); open items (F-1 closed, H documented); evidence links.
5. T8 (review): cross-doc consistency + every claim backed by a real artifact (spot-check commits/PRs/
   counts/tags) + no contradiction with the frozen requirements package/ADRs/merged code + no code touched.
6. `keryx health run` (docs-only → expect no code-quality delta); confirm ACs; completion (option B) + PR.

## Verification

Gate: 3 docs exist and mirror the R1 format; every scenario/commit/PR/test-count/AC cited is REAL
(spot-checked against git/runbook/acceptance.feature); F-1 shown CLOSED and H documented as the sole
known-limitation; no source/frozen-package/ADR/schema edits (docs-only); cross-doc consistent; the full
`bun test` still 1338/2skip/0 (unchanged — docs-only) and `tsc` clean.

## Risks

- **Fabricated/inaccurate evidence** → every claim cites a durable artifact (commit hash, PR#, test
  count, scenario tag, runbook row); T8 spot-checks. Prefer "cite, don't invent".
- **Contradicting the frozen package / ADRs** → docs reference, never re-decide; T8 contradiction-check.
- **Accidental code/frozen edit** → docs-only; only new files under `docs/decisions/keryx-harness/`;
  T8/`git diff` confirms no source/schema/ADR change.
- **Drift from R1 format** → workers read the R1 E-01/E-02/E-03 first and mirror headings/structure.
- **Wrong-worktree / index-guard** → guard directives in every dispatch.
