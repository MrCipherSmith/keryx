# Implementation Plan

Status: active

## Approach

Follow the established Wave 4 pack shape exactly (batch 1: ts-js-node,
python, go, react; batch 2 on origin/flow/318-w4b2, PR #719: angular, mobx,
nestjs, nextjs-nuxt, vue). Four disjoint stack packs, one sonnet worker each,
dispatched in parallel — no shared files touched by workers. The runner
(this session) owns every shared file: `install-manifest.json`,
`STACK_EXTENSIONS` in `authoring-lint.ts`, the shared test files (read-only
— they already generalize over every directory under `stacks/`, no edits
needed unless a genuinely new check is required), and the W1/W2 doc
"Implementation notes" sections.

Detection tags already exist in `src/stack/detect.ts`: `php`, `laravel`,
`ruby`, `rails`, `c-cpp`, `sql` — no stack-detection code changes needed.

Family/extends decisions (recorded because the W1 table's "extends: lang:php"
etc. presuppose packs that don't exist yet in this batch):
- `php-laravel`: family `framework`, no `extends` (no `lang:php` pack exists
  yet) — pack covers general PHP idiom alongside Laravel specifics in one
  self-contained pack, same shape as ts-js-node did before react extended it.
- `ruby-rails`: family `framework`, no `extends` (no `lang:ruby` pack yet),
  same reasoning.
- `c-cpp`: family `language`, standalone.
- `sql-db`: family `capability`, standalone; cross-cutting rules (`.sql`
  files plus migration-directory globs ending in `.sql`), extending the
  *prose* of the existing generic `database-patterns.mdc` core rule (not a
  pack `extends`, since `database-patterns.mdc` isn't a stack pack).

## Steps

1. T1 (context) — done in this session: read W1/W2 specs, the rubric-writing
   guide, the batch-1 `go`/`python` packs as templates, `authoring-lint.ts`,
   `stack-packs.test.ts`, `install-manifest.json`'s go/python/react wiring,
   and `src/stack/detect.ts`'s tag table.
2. T5-T8 (implement, parallel) — one sonnet worker per pack:
   php-laravel, ruby-rails, c-cpp, sql-db. Each owns only its own
   `src/gdskills/bundled/stacks/<id>/` directory.
3. T9 (implement, runner) — wire `install-manifest.json` (module pairs
   `<id>-rules`/`<id>-skills`, component `framework:php-laravel` /
   `framework:ruby-rails` / `lang:c-cpp` / `capability:sql-db`, a
   `stackDetectionAware` profile per pack, and the `full` profile's module/
   component lists), add `STACK_EXTENSIONS` entries, update W1/W2 docs.
4. T10 (test) — offline verification: `bun test` on `stack-packs.test.ts`,
   `governance/authoring-lint.test.ts`, `governance/authoring-lint-guard.test.ts`,
   `stack-pack-eval-integrity.test.ts`, `manifest/*.test.ts`. Fix findings by
   returning work to the appropriate task, not by editing SKILL.md content to
   satisfy a grader (no grader runs offline anyway).
5. T11 (review) — commit each pack separately (never `-A`), run
   `git checkout -- .metaproject/data/gdgraph` after each commit, push the
   branch, return `STATUS: READY_FOR_GATE` and stop — do not start
   calibration/gate work until the orchestrator confirms PR #719 and flow 334
   are merged and this branch is rebased onto main.

## Risks

- STACK_EXTENSIONS extension-matching is purely by file extension (regex on
  the glob's trailing `.ext`), so sql-db's migration-directory globs must
  still end in `.sql` to lint clean — flagged to the sql-db worker explicitly.
- Judge-format evals must be authored per the lessons file and the rubric
  guide's integrity rules (I1-I10) even though the gate itself doesn't run
  until Phase B — a miswritten scenario would only surface then, so the
  runner reviews scenario shape (calibration completeness, anti_patterns
  presence in SKILL.md/known_wrong/rubric) before committing.
- `extends`/`extendsList`/I11 semantics are mid-flight on PR #719 + flow 334;
  this batch uses today's single-string `extends` convention and defers any
  array-based rework to the Phase B rebase.
