# Skill gaps: debugging, doubt, source-verification, deprecation, floor-guard, definition of done

Status: formalized (not frozen; freezes after flow 253 finishes)
Source: user request 2026-09-11 after the agent-skills comparison
Program: docs/plans/skills-quality-program.md (flow 3 of 4)

## Problem

Lifecycle areas with no skill or rule in the bundled set:

- debugging and root-cause work (reproduce, localize, reduce, fix, guard;
  non-reproducible bugs);
- in-flight adversarial doubt: a fresh-context reviewer that gets the artifact
  and the contract but not the author's claim, bounded cycles — distinct from
  the after-the-fact `review-verifier`;
- source-driven development: check current library docs before use, mark what
  was not verified;
- deprecation and migration of code, CLI flags and config for a published CLI;
- definition of done as one standing bar reconciled with flow acceptance
  criteria (now spread across three rules);
- CLI interface design: exit codes, stdout vs stderr, `--json` stability, flag
  deprecation;
- a floor guard: nothing mechanically catches a diff that lowers a threshold,
  adds `.skip`/`.only`, removes assertions or adds lint/type suppressions;
- `task-implementer` results carry no structured "noticed but not touched",
  "assumptions" or "not touched" fields;
- `interviewer` accepts hedged answers as approval and states no confidence;
- performance skills do not require reverting a neutral change or recording
  reverted attempts.

## Expected Outcome

New skills and rules written in our own words, passing the flow 253 gate
(anatomy lint, routing eval cases, no collisions), registered in the catalog
and installed mirrors; the floor guard is a real, tested check wired into
health or review; the `task-implementer` output contract gains the structured
fields with schema and parser support; attribution for adapted techniques is
recorded in `THIRD_PARTY_NOTICES.md`.

## Out of Scope

- Behavioural evals of the new skills (flow 255).
- Frontend-UI, observability, CI/CD and shipping skills (not selected for this
  program).
