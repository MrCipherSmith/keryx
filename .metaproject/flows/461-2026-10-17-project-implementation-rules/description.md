# Project rules and skills are applied first when code and tests are written

Status: formalized (criteria proposed to the operator, not frozen)
Source: owner (origin: human-request)

## Problem

`keryx skills import` already brings an external project's review skills into `.metaproject/project-skills/review/` and `review-orchestrator` appends them to its reviewer set. Nothing equivalent exists for the skills that write code and tests. In a project such as vantage-frontend the authors' standards (design system, MobX store template, styling, testing conventions: 29 rules, 178 KB in vantage-ai-assistant `rules/core`) are enforced at review time but are never read at implementation time, so code is written to one standard and judged against another.

Code-confirmed gaps (branch base 330209bce):

- A. Only module `review` is wired (`PROJECT_REVIEWER_MODULE`, `src/gdskills/project-reviewers.ts:17`). Any other module prints "not auto-injected" (`src/gdskills/import-skills.ts:2128-2133`). `KNOWN_CATEGORIES` (`:694-700`) has no `implementation` or `testing`, so a package with that category needs `--module`.
- B. A rule is imported only when an imported skill cites it (`src/gdskills/rule-references.ts`). A rule nobody cites (Vantage `design-system.mdc`, `testing-conventions.mdc`) never reaches the project. The `globs`/`description` front matter that says when a rule applies is not kept in the registry (`ProjectSkillRegistryEntry`, `src/gdskills/project-skills.ts`).
- C. `task-implementer` Phase 2.4 (`SKILL.md:202-228`) loads a fixed list from `.metaproject/rules/core/` and says "the one tree every build reads"; the `.metaproject/rules/project/` slot that `resolveRuleReference` already prefers for reviewers is not mentioned. Phase 2.0b only runs `keryx skills route` and records `skill_drift`; it never requires applying the skill.
- D. `tests-creator` reads no rules at all; Phase 1.2 reads 2-3 existing tests. `flow-orchestrator` and `job-orchestrator` dispatch `tests-creator` and `task-implementer` without any project context (their only `project-skills` mention is the docs row, `flow-orchestrator/SKILL.md:304`).
- E. `keryx skills route` sorts equal scores by `source.localeCompare` (`src/commands/skills.ts:879-884`), and `"catalog" < "project"`, so a bundled skill outranks the project one on a tie.
- F. `task-implementer-output` (`additionalProperties: false`) has `skill_drift` and no field for the project rules applied, so applying them cannot be checked. A prose-only gate does not hold (orchestrator benchmark: 34 of 184 leaked), so the check has to be code.

## Expected Outcome

A project's own implementation and testing rules and skills are imported like review skills, and every skill that writes or tests code takes them first and the bundled ones second. The choice is made by code, not prose: a resolver returns the ordered list (project before bundled, shadowing recorded, content hashed), the implementer and test writer cite what they applied in a schema-validated result, and a validator compares the two. The first release warns on a miss; blocking is a later switch. Project content is capped at 40 KB per task; beyond the cap the entries are listed for on-demand reading with a warning, never silently dropped.

## Outcome criteria

- Запрос (дословно): «нам нужно реализовать такой же импорт, имплементейшн скиллов, например, или project rules, надо подумать, как это лучше сделать, чтобы при имплементации, при все наши скиллы, которые пишут код или тестируют, должны знать о них и учитывать их и брать их из Project Skills, а не, ну, сначала из Project Skills, а потом уже идти, допустим, куда-то во внутреннее» (source: helyx-channel message 211291, 2026-10-17T17:58:26Z (voice, transcribed))
- Эффект (формализация агента): после импорта правил проекта задача на реализацию или тесты в этом проекте получает их первыми, встроенные идут после, а результат задачи перечисляет, что применено; пропуск виден проверкой, а не только прозой.
- Как наблюдать (предложение агента): в vantage-frontend после импорта правил Vantage `keryx skills resolve-context --files <tsx-файл> --for implement` выдаёт design-system и остальные проектные правила раньше встроенных; результат задачи содержит `project_context_applied`, а проверка падает или предупреждает, если оно не покрывает вывод резолвера.

## Out of Scope

- Inheritance or merging of skills (`extends:` / override of a bundled skill): rejected; a project skill supplements with rules and templates, it does not replace an implementer or an orchestrator.
- Links as the main path: only a pointer that `skills update` expands into a copy.
- Changing what reviewers look for, or the review import path.
- Importing Vantage's copies of Keryx bundled skills.
- Loading `alwaysApply: true` rules whole (Vantage `rules/AGENTS.mdc`, 38,577 B is an index, not loaded whole).
- A new skills panel in the TUI (no skills surface exists today; see the PRD).
- Blocking mode as the default (decided later, after the warning period).
- A release (batched, per the operator).
