# Implementation Plan

Status: active

## Approach

A moment of choice, never a gate. The marker is put in front of the agent at the three places it
writes criteria (scaffold template, flow skill step, flow-orchestrator), and `flow freeze` makes a
missing marker visible (warning, interactive question, journal line) without refusing.
`ac-kinds-never-gates.test.ts` stays green and unchanged.

Three lanes with disjoint files run in parallel in this worktree; docs follow.

## Steps

1. Lane A (T5, T6, T8): `src/flow/templates.ts` rule + placeholder with marker; flow skill text in
   `templates.ts` and `.metaproject/skills/flow/SKILL.md`; flow-orchestrator bundled + `.metaproject`
   copy (within `skill-length-ceilings.ts`); tests that intake and `goal` scaffold the marker.
   Placeholder detector in `src/flow/service.ts` is not edited by this lane: the placeholder keeps
   the `<replace with a hard, verifiable criterion` substring, and `<exec|invariant|judged|none>` must
   classify as `unclassified` in `src/flow/ac-kinds.ts`.
2. Lane B (T7): `flow freeze` warning naming unclassified criteria; interactive question on a TTY;
   journal line otherwise; never refuses.
3. Lane C (T9): `research-sync-status.ts` share of `unclassified` among criteria of flows frozen in
   the last 7 days, warning above 20%.
4. T10 docs: `docs/docs/cli-reference.md`, CHANGELOG.
5. T11 verification: run every AC command, AC7 invariant diff.
6. T4 review.

## Risks

- flow-orchestrator SKILL.md length ceiling (flow 417): the rule must be short.
- The interactive question on freeze must not hang non-TTY callers (agents, CI, intake).
- helyx/Telegram creation path: confirm it goes through `flow init`; if it renders its own template,
  record it in the journal rather than widening scope silently.
