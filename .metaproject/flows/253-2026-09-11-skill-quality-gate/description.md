# Skill quality gate: anatomy lint, routing evals, installed-tree xref, generated runtime variants

Status: formalized (not frozen; freezes after flow 256 finishes)
Source: user request 2026-09-11 after the agent-skills comparison
Program: docs/plans/skills-quality-program.md (flow 2 of 4)

## Problem

`src/gdskills/bundled-eval.ts` is layer one of three and checks structure only.
Nothing checks that a skill is written so an agent can act on it, or that a
request reaches the right skill:

- no required anatomy: many skills lack "NOT for", Red Flags / rationalization
  rebuttals, or explicit exit criteria (`flow-orchestrator`, `code-verifier`,
  `tests-creator`, `test-gen`, `brainstorm`, `interviewer`, `interview`,
  `context-collector`, `commit`, `push`, `pr`, `deploy`);
- no length budget: `job-orchestrator` 2190 lines, `review-orchestrator` 1922;
- no routing test and no collision check between descriptions, while
  `interview`/`interviewer`, `test-gen`/`tests-creator` and
  `job-orchestrator`/`flow-orchestrator`/`feature-dev`/`review-orchestrator`
  overlap;
- `xref:path` resolves against the bundled root, so paths such as
  `skills/shared/git-merge-base.md` pass the check and are dead in an installed
  project;
- 88 of 102 `SKILL.<runtime>.md` files are byte-identical copies of `SKILL.md`,
  maintained by hand;
- no record of skill changes that were tried and rejected.

## Expected Outcome

- `keryx skills verify --bundled` enforces a documented skill anatomy and
  description rules, with an explicit, reasoned exemption list, and reports a
  length budget with a ratchet that forbids growth past today's size.
- A deterministic routing eval ships with cases for every bundled skill
  (positives, negatives naming the owning skill), a catalog-wide description
  collision check, and a checked-in baseline it may not fall below; it runs in CI.
- The collisions it surfaces are fixed in the descriptions.
- Cross-references are checked against the installed layout.
- Runtime variants are generated at export time; only files with a real
  difference are kept in the source tree.
- Skills lacking Red Flags / exit criteria get them, so the new lint passes
  without exemptions for workflow skills.
- A rejected-change ledger exists and the contribution rule points to it.

## Out of Scope

- Model-graded or repeated-run evals (flow 255).
- New skills (flow 254).
- Splitting `job-orchestrator` / `review-orchestrator` into smaller files beyond
  what the length ratchet requires (they are held, not cut, here).
