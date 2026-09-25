# Wave 4 batch 5: stack packs for php-laravel, ruby-rails, c-cpp, sql-db

Status: in-progress
Source: user description (agent-platform-expansion program, Wave 4)

## Problem

W1-stack-catalog.md defines a stack-pack content shape (rules + skills +
governance) and a target-stack table with 21 stacks. Wave 4 batches 1-2
authored 9 packs (ts-js-node, python, go, react in batch 1; angular, mobx,
nestjs, nextjs-nuxt, vue in batch 2, PR #719 not yet merged). php-laravel,
ruby-rails, c-cpp and sql-db (batch 5) have zero authored content: no rules,
no skills, no agent profile, no eval coverage — despite `keryx stack detect`
already recognizing `php`, `laravel`, `ruby`, `rails`, `c-cpp`, and `sql` as
detection tags (`src/stack/detect.ts`).

## Expected Outcome

Phase A (this flow's authoring phase):
- Four new stack packs exist under `src/gdskills/bundled/stacks/<id>/`:
  `php-laravel`, `ruby-rails`, `c-cpp`, `sql-db` — each with `pack.json`,
  per-skill `SKILL.md` + `evals.json`, rules (`.mdc`, `paths:`-scoped),
  `governance/scout.json`, `agent-refs.json` (agents: [] until the gate
  clears in Phase B).
- Shared wiring updated by the runner only: `install-manifest.json` modules/
  components/profiles for the four packs, `STACK_EXTENSIONS` in
  `authoring-lint.ts`, W1/W2 docs' "Implementation notes" sections.
- `bun test src/gdskills/stack-packs.test.ts
  src/gdskills/governance/authoring-lint.test.ts
  src/gdskills/governance/authoring-lint-guard.test.ts
  src/gdskills/stack-pack-eval-integrity.test.ts` all green offline (no
  network, no model calls).
- Each pack committed separately; branch pushed; flow returns
  `STATUS: READY_FOR_GATE` and pauses for the orchestrator's go-ahead before
  calibration/gate work (Phase B), which depends on PR #719 and flow 334
  (extends-as-array, I11, extendsList, manifest/trigger-scoring changes)
  landing on main first.

Phase B (after go-ahead, not scoped to this initial task/AC set — tracked as
follow-on tasks added once Phase A tasks close): rebase onto main, record
calibration, run the honest 10-trial DeepSeek gate, set stability, generate
agents, update docs/ACs, open PR into main, adversarial Opus review, get CI
green, merge per the standing owner rule.

## Out of Scope

- Any other stack from the W1 table (batches 1-4 cover ts-js-node, python,
  go, react, angular, mobx, nestjs, nextjs-nuxt, vue; other stacks are later
  batches).
- Bumping the package version or editing CHANGELOG release sections.
- Running the model-backed gate (`skills judge-check` / `skills eval
  --runner ... --judge ...`) during Phase A — offline lint/integrity only.
- Merging PR #719 or landing flow 334 — this flow waits for both.
