# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

AC ids refer to `acceptance-criteria.md`; context to `context-map.md`, which is
read before `description.md` because it corrects it.

Lanes: W1 (T5-T8) is serialized — every one of them edits `routing-corpus.ts`,
`catalog.ts` and `skill-length-ceilings.ts`. W2, W3 run in parallel with it on
disjoint files. W4 starts after W1 so no worker is fighting the ratchet and
holding the corpus lane at once.

| ID | Kind | Depends | AC | Title |
|----|------|---------|----|-------|
| T1 | context | - | - | Context collected and re-verified against the post-257 tree (done) |
| T2 | implement | - | - | Scaffold row, superseded by T5-T16 (skipped) |
| T5 | implement | T1 | AC1, AC2, AC3 | W1: the debugging / root-cause skill |
| T6 | implement | T5 | AC1, AC2, AC3 | W1: the in-flight adversarial doubt skill |
| T7 | implement | T6 | AC1, AC2, AC3 | W1: the source-driven development skill |
| T8 | implement | T7 | AC1, AC2, AC3 | W1: the deprecation and migration skill, and the rank-1 record re-measured for all four |
| T9 | docs | T1 | AC4 | W2: the definition-of-done rule, citing every rule whose bar it reconciles |
| T10 | docs | T1 | AC4 | W2: the CLI interface design rule |
| T11 | implement | T1 | AC5 | W3: `keryx review floor` — the diff-scoped guard and its four detections |
| T12 | implement | T1 | AC7 | W4: the task-implementer output contract gains the three structured fields |
| T13 | implement | T8, T12 | AC8 | W4: task-implementer's SKILL.md fills them, paid for inside its ceiling |
| T14 | implement | T8 | AC9 | W4: interviewer — a hedged answer is not approval, confidence per question |
| T15 | implement | T8 | AC10 | W4: perf-check states neutral is a revert and attempts are recorded; review-performance cites it |
| T16 | docs | T5, T6, T7, T8, T9, T10 | AC11 | Attribution: an MIT credit in each adapting document, by the existing convention |
| T3 | test | T5-T16 | AC12, AC6 | Full suite, typecheck, eslint, bundled verify, mirror identity, and `review floor` run on this branch's own diff |
| T4 | review | T3 | AC13 | Review rounds to a clean gate |
