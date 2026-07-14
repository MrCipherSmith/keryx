# Flow 029 — Release 2 evidence pack (E-01 matrix + E-02 review-package + E-03 handoff)

Status: formalized
Source: user request — close the plan's one remaining tail: Release 0 and Release 1 each have an
E-01/E-02/E-03 evidence pack in `docs/decisions/keryx-harness/`; Release 2 has none. Docs-only
synthesis of already-existing evidence.

## Problem

Release 2 (R2-1…R2-5) + the two post-review flows (027/#30 hardening, 028/#31 polish) are built,
reviewed, and merged to main — but unlike R0/R1 there is no formal Release 2 evidence pack. The raw
material already exists (runbook "Release 2 — Стейт" table, flow packages 023–028 with confirmed AC,
git log, PRs #25–#31, the full 5-lens review, live-smoke results); it just needs assembling into the
same three-doc format R1 used.

## Scope — 3 new docs (mirror R1 exactly), under `docs/decisions/keryx-harness/`

- **E-01-release2-evidence-matrix.md** — mirror `E-01-release1-evidence-matrix.md`: Purpose;
  Capability/Evidence Matrix (each `@release-2` scenario → source file / test / commit); Deferred-list
  update (F-1 now CLOSED by R2-5; the new **H** tool-call known-limitation ADDED as deferred with
  rationale; SC_R13 TUI status); Invariants Held Across Release 2 (deps `{}`, D-02, determinism,
  offline, reuse-only, secrets); Traceability to the frozen AC-R2-1…R2-5.
- **E-02-release2-review-package.md** — mirror `E-02-release1-review-package.md`: Executive verdict;
  Severity scale; Gate evidence (tsc / `bun test` count / deps / D-02 / egress — verified against the
  working tree); Per-lens verdicts (Architecture, Contract, Logic, Security, Testing, Performance,
  Gherkin — synthesizing the completed 5-lens full review + the 2 post-review passes); Consolidated
  severity-ranked findings (0 BLOCKER/HIGH; 5 MED closed in #30; 7 LOW/INFO closed in #31; H deferred);
  Coverage cross-check of the `@release-2` scenarios; Consistency with frozen decisions/ADRs; Routing audit.
- **E-03-release2-handoff.md** — mirror `E-03-release1-handoff.md`: Status (**Release 2 achieved** — the
  last planned release); What is built (R2-1…R2-5 + interactive CLI); DAG actually executed; Gates
  (standing, verified at the Release 2 boundary); Constraints carried forward; Out of scope / future
  options (since Release 2 is terminal — live end-to-end wiring, real-model runs, closing H at the
  runtime layer — as OPTIONS not commitments); Open items (F-1 CLOSED; H documented); Evidence links.

## Expected Outcome

Three accurate, cross-consistent docs in `docs/decisions/keryx-harness/` mirroring the R1 pack, citing
REAL commits/PRs/test-counts/scenario tags (no invented evidence). A final consistency review confirms
no contradiction with the frozen requirements package, ADRs, or the actual merged code. This closes the
harness plan's documentation tail.

## Out of Scope (do NOT touch)

- NO code changes — docs-only. Do NOT modify the frozen requirements package, canonical schemas,
  `src/eval/`, `src/contracts/`, ADR-0001…0004, or any source; cite/quote only. Do NOT re-open or amend
  the R0/R1 evidence docs (reference them). Every claim must be backed by a real artifact (a commit hash,
  a PR number, a test count, a scenario tag, a runbook row) — no fabricated numbers. Commits/PR carry NO
  co-authorship trailer.
