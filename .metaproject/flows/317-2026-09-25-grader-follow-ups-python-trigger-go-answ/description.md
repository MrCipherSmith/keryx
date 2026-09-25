# Grader follow-ups: python trigger, go answer-in-text runner note, live re-judge sampler, 10-trial promotion, honest re-run

Status: in-progress
Source: flow 316 journal follow-up list (FU1-FU7) + review-r1.md/review-r2.md under scratchpad/f316/

## Problem

Flow 316 shipped the LLM-judge grader gate but left seven follow-ups open:
1. `python-implementation` trigger-positive-6 not selected (6/7).
2. `go-testing#table-driven-subtests` fails because the model emits a tool/shell
   call instead of answering in text (single-turn runner has no tools).
3. No live re-judge sampler to catch judge drift against recorded trials.
4. `PACK_MIN_TRIALS` is 5; several scenarios sit exactly at the 0.8 floor with
   only 5 trials.
5. `react#no-disable-hooks-lint` scored 3/5 — needs a defect check, not a tune.
6. The round-2 reviewer found a legitimate third fix shape (TS getter
   accessor) for `nodejs-build-fix#no-ts-ignore-suppression` calibration.
7. Re-record calibration + an honest full gate run at trials=10 is needed
   after any of the above changes.

## Expected Outcome

- Trigger, runner-prompt, sampler, promotion-trials and calibration fixes
  landed with tests, honestly re-run, and `governance/eval.json` rebuilt from
  raw outputs only.
- No SKILL.md/grader edited to force a pass; every fix is justified by
  recorded evidence.
- PR merged into feat/agent-platform-expansion.

## Out of Scope

- Anything outside the FU1-FU7 list above.
- Editing PR #700 (the final draft PR) or any other flow's worktree.
