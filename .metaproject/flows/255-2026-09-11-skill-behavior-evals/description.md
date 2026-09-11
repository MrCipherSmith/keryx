# Behavioral skill evals with a control arm on the benchmark harness

Status: formalized (not frozen; freezes after flow 254 finishes)
Source: user request 2026-09-11 after the agent-skills comparison
Program: docs/plans/skills-quality-program.md (flow 4 of 4)

## Problem

Nothing measures whether a skill changes agent behaviour. `bundled-eval.ts`
declares layers two (judge across dimensions) and three (reliability over
repeated runs) "NOT BUILT"; `scripts/benchmark/` has oracle and ablation
infrastructure but never ablates a skill. The reference project runs
behavioural evals without a control arm, with a single grader sample, and
outside CI — so it cannot claim impact either.

## Expected Outcome

- A behavioural case format: scenario, fixtures, optional dirty-tree patch,
  pressure variants (time, authority, sunk cost), and checkable expectations.
- A runner that executes each case with the skill and without it (control),
  N >= 3 times per arm, grades traces with a fenced, schema-validated grader,
  and reports per-expectation pass rates and the with-minus-without delta.
- A deterministic offline path (recorded traces / fake provider) that runs in
  CI; live runs are opt-in and never in CI.
- A first corpus over discipline skills where a behaviour difference is
  checkable (task-implementer scope, tests-creator RED-first, review-verifier
  evidence, flow loop bound, interviewer hedged-approval, the new debugging
  skill).
- `bundled-eval.ts` states truthfully which layers now exist.

## Out of Scope

- Using eval results as a merge gate (report only in this flow).
- Evals for every bundled skill.
