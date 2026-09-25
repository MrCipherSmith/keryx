# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Exclusion-clause tokens ("Not for …", "Never …", "Do not use for …", "Use <X> instead", "(not X)", and the conventions the bundled SKILL.md files actually use, surveyed via `keryx ctx rg`) inside a skill's description/triggers no longer count as positive coverage evidence for that skill in `rankCatalog`/`coverageScore`/`checkSkillSelected`/`checkSkillSelectedLeaveOneOut`, with a documented, conservative choice recorded in the journal for whether they also count as mild negative evidence.
- AC2: `scoutSkill`'s use/fork overlap decision (0.55/0.30 thresholds) uses the same negation-aware extraction, so a skill's own "Not for" cross-reference to a sibling skill does not inflate that sibling's overlap score.
- AC3: The scorer remains pure (no model calls, no new classifier); `src/harness/routing/**` and `src/harness/decision/**` are untouched by this flow's diff.
- AC4: Unit tests using real bundled SKILL.md examples cover: a positive query for one skill does not select a different skill solely because that skill's description says "Not for" the query's topic; and a regression test exists for every trigger that currently selects correctly (via `checkSkillSelected`/eval trigger scoring over the bundled catalog).
- AC5: Trigger-accuracy-only (offline, deterministic, no model) is re-measured for every bundled stack skill and every core bundled skill via `skills eval <id> --scope bundled --json`, with before/after TP/FP reported per skill in the PR/journal, and no `evals.json`/`SKILL.md` description or trigger text edited to chase the numbers.
- AC6: `checkStablePackGate` is re-run for the python and go stable packs on main after the change; if either now fails only on triggers, that is reported (not silently fixed) in the PR.
- AC7: `docs/docs/guides/write-a-rubric-scenario.md` (or the closest skill-authoring guide, if that file does not cover trigger writing) is updated to state that exclusion clauses are safe to write in a skill's description/triggers.
