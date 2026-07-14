# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: E-01 Release 2 evidence-matrix exists — `docs/decisions/keryx-harness/E-01-release2-evidence-matrix.md` mirrors the R1 E-01 format and contains a Capability/Evidence Matrix mapping each `@release-2` acceptance scenario (SC_R08_CHILD_DISPATCH_CANONICAL_RESULT, SC_R08_NEEDS_CONTEXT_ADAPTER, SC_R08_BOUND_PARALLEL_WAVE, SC_R18_REGISTERED_EXTENSION_PROVENANCE, SC_R08/R18_EXTENSION_ESCALATION, SC_R13_TUI_DEFERRED, SC_R04_SHELL_CONTAINMENT runtime half) to its real source file, test, and landing commit/PR; a Deferred-list update showing F-1 CLOSED (by R2-5) and the new H tool-call known-limitation added with rationale; an Invariants-Held section; and traceability to the frozen AC-R2-1…R2-5.
- AC2: E-02 Release 2 review-package exists — `E-02-release2-review-package.md` mirrors the R1 E-02 format with an executive verdict (GO, 0 BLOCKER/P0/P1), a Gate-evidence section VERIFIED against the working tree (tsc clean; the exact `bun test` pass/skip/fail; `dependencies` `{}`; D-02), per-lens verdicts (Architecture/Contract/Logic/Security/Testing/Performance/Gherkin) synthesizing the completed full 5-lens review + the two post-review passes, consolidated severity-ranked findings (0 BLOCKER/HIGH; 5 MED closed in #30; 7 LOW/INFO closed in #31; H deferred), and a `@release-2` coverage cross-check.
- AC3: E-03 Release 2 handoff exists — `E-03-release2-handoff.md` mirrors the R1 E-03 format and states Release 2 achieved (the last planned release, AC-R2-1…R2-5 met), what is built, the DAG actually executed, the standing gates, constraints carried forward, future OPTIONS (not commitments) since Release 2 is terminal, open items (F-1 CLOSED, H documented), and evidence links to E-01/E-02 + PRs #25–#31.
- AC4: Evidence is real and cross-consistent — every commit hash, PR number, test count, scenario tag, and AC id cited across the three docs is REAL (spot-checked against `git log`, `gh pr view`, `acceptance.feature`, the runbook, and the merged code) with no fabricated or mismatched numbers; the three docs agree with each other; and there is no contradiction with the frozen requirements package, ADR-0001…0004, or the actual merged Release 2 code (verified by the T8 consistency review).
- AC5: Docs-only, no regression — the change set is exactly the three new docs under `docs/decisions/keryx-harness/` (plus the flow package); NO source, canonical schema, `src/eval/`, `src/contracts/`, ADR-0001…0004, or frozen requirements-package file is modified; `tsc --noEmit` remains clean and the full `bun test` suite remains at the pre-change baseline (1338 pass / 2 skip / 0 fail) — unchanged, since this is documentation only.
