# Project implementation rules and skills: project first

Flow: 461 (`.metaproject/flows/461-2026-10-17-project-implementation-rules/`). Status: PRD revised to the operator's answers of 2026-10-17; criteria AC1-AC24 are frozen when the flow starts.
Companion: [TRD.md](TRD.md). Criteria (single source): `.metaproject/flows/461-2026-10-17-project-implementation-rules/acceptance-criteria.md`, AC1-AC24.

## 1. Problem

Keryx imports an external project's review skills (`keryx skills import`) and `review-orchestrator` runs them beside the built-in reviewers. A project such as vantage-frontend also has standards that matter while code is written: a design system, a MobX store template, styling and testing conventions (vantage-ai-assistant `rules/core`: 29 rules, 178 KB). Today those standards are enforced by review-only skills and are not read by the skills that write code and tests, so the author follows one standard and the reviewer judges by another.

Concretely (details with file and line in the TRD): only module `review` is wired after import; a rule is imported only when an imported skill cites it; `task-implementer` and `tests-creator` read the engine's `rules/core` and ignore the project slot; the orchestrators dispatch them with no project context; `skills route` ranks a bundled skill above a project one on equal score; and the implementer's result has no field that says which project rules were applied, so nothing can check it.

## 2. Goals

1. A project can import its implementation and testing rules and skills the way it imports review skills.
2. Every skill that writes code or tests takes the project's rules and skills first and the bundled ones second.
3. The order and the check are code, not prose: a resolver produces the list, the result cites what it applied, a validator compares them.
4. A miss warns first and can be switched to blocking later.
5. Context stays bounded by a configurable cap on project content per task (`gdskills.projectContext.maxBytes`, default 128 KiB). A task that overflows is a signal to raise the cap, not to cut rules.
6. Nothing in the frozen-AC and TDD flow changes: the resolved list is an input before the RED tests, it does not touch acceptance criteria.

## 3. Non-goals

- Inheritance or merging of skills (`extends:`) and replacing a bundled implementer, tests-creator or orchestrator with a project copy.
- Unpinned links. A linked rule is read from its origin only while its sha256 equals the one recorded at registration (AC23).
- Importing Vantage's copies of Keryx bundled skills.
- Loading `alwaysApply: true` rules whole (see sizing).
- Making blocking the default; releasing (batched).
- A project skill that carries the name of a bundled Keryx skill. Vantage adopted the same law ("never add a skill that shares a name with a Keryx bundled skill"), which agrees with the operator's answer that a project skill only supplements.

## 4. Users

- The operator of a project that imports an external rule and skill set (Vantage frontend today).
- Agents running `flow-orchestrator`, `job-orchestrator`, `task-implementer`, `tests-creator`, in keryx shell, Claude Code or Codex.
- Reviewers, who keep resolving cited rules project-first and must not change.

## 5. Operator decisions (poll 209, 2026-10-17T18:20:22Z; "Да" at message 211332)

| Question | Answer, verbatim |
|---|---|
| What counts as "project" rules | «Оба режима, импорт по умолчанию» |
| Missing `project_context_applied` | «Сначала предупреждение, блокировка позже» |
| May a project skill replace a bundled implementer/tests-creator | «Нет, только дополнять правилами и шаблонами» |
| Context limit and `alwaysApply: true` | «Решим после замера размера»; then «Да» to a 40 KB cap draft; then (voice, later): «потолок можно сделать как правильно, если он мал» and «повысь потолок». Result: configurable cap, default 128 KiB; `alwaysApply` rules up to 30 KB compete for the cap, larger ones are indexes |
| TUI representation | «нужна» (sidebar line, `/projectctx` modal, settings rows, command menu: AC24) |
| Live run on vantage-frontend | allowed; the operator runs it, the implementing agent only prepares the runbook (AC22) |
| Compare with the fresh vantage-ai-assistant | after implementation, by the parent session, not part of this flow's AC |

"Both modes, import by default" is read as: `--rules <dir>` copies rules into the project (`.metaproject/rules/project/`) by default, and `--rules <dir> --link` registers them in place (origin path and sha256 recorded, read from the origin only while the hash matches, AC23). A copy wins over a link of the same ref. This reading is stated here because the answer was one line; the operator can correct it.

## 6. Sizing (measured 2026-10-17 on vantage-ai-assistant)

| Item | Size |
|---|---|
| `rules/core`, 29 rules | 178 KB, none `alwaysApply: true` |
| frontend-relevant set (8 rules) | about 85 KB: design-system 25.4K, testing-conventions 15.2K, mobx-store-template 11.1K, styling 10.9K, frontend-assistant 10.5K, code-style-patterns 4.5K, playwright-testing 3.9K, storybook-guidelines 3.7K |
| `rules/AGENTS.mdc` (`alwaysApply: true`) | 38,577 B, an index |

Second measurement, unmerged branch `origin/chore/thin-overlays-drift-sync` of vantage-ai-assistant (a survey, not read as code): the rules are thinner. `AGENTS.mdc` 11.3 KB (still the only `alwaysApply: true`, now a routing index), design-system 15 KB, testing-conventions 5.8 KB, frontend-assistant 6.8 KB, styling 6.8 KB, mobx-store-template 4.9 KB; all of `rules/core` about 125 KB; a UI task set about 50 KB. That overlay stores the project's contracts (`CLAUDE.md`, `.claude/rules/*.md`, `STYLING.md`, `THEMING.md`) in vantage-frontend and has its rules point at them instead of copying them, with `project-sources.json` holding baseline hashes and a drift check. Consequence for this design: linked rules and referenced contract files (AC23, AC25) are first-class, not an edge case, and the resolver pins a hash per entry so the standard cannot change between the RED and the GREEN step (AC13).

Reading: a UI-component task on the table's own mapping (code-style-patterns, frontend-assistant, storybook-guidelines plus design-system) is about 44 KB, over the cap; adding styling is about 55 KB. These are file sizes. The `globs` of each Vantage rule were not read, so which rules a real `.tsx` file selects is not measured; AC21 fixes that with a fixture, AC22 with a live run.

Cap decision: 40 KB would have been exceeded by the first UI task (about 44 to 55 KB by the table's own mapping, about 70 KB with the test conventions), which the operator called a signal to raise the cap. Default: 131,072 bytes (128 KiB): about 1.5 times the 85 KB set of the current Vantage `main`, about 2.5 times the 50 KB set of the thinner overlay branch, and still below even the thinner 125 KB `rules/core`, so a project can never load all of its rules by default. Both measurements are file sizes, not resolver output. The cap is `gdskills.projectContext.maxBytes` in `.metaproject/tasks.config.json`, overridable per call with `--max-bytes`; values outside 4,096..1,048,576 read as the default with a warning. The cap does not truncate: entries that fit are `must_read`, the rest `on_demand` (path and description only) and the output warns, naming the setting to raise. `alwaysApply: true` files up to 30,720 bytes compete for the cap like other rules; larger ones (the 38.6 KB `rules/AGENTS.mdc`) are indexes, listed, never loaded whole. Bundled rules are not counted: they are today's baseline.

## 7. Staged scope

| Stage | Content | AC |
|---|---|---|
| 0 | `skills route` project-first on ties; `rules/project` slot in `task-implementer` Phase 2.4/2.0b; rules step in `tests-creator` | AC1-AC3 |
| 1 | categories `implementation`/`testing`; `skills import --rules <dir> [--only <glob>]`; registry keeps globs/description/alwaysApply/taskTypes; update/remove | AC4-AC8 |
| 2 | `skills resolve-context`; selection and 40 KB budget; schemas `resolved_context_file` and `project_context_applied`; `contracts validate --resolved`; skills call the resolver | AC9-AC14 |
| 3 | orchestrator dispatch templates pass the resolved file; shell/MCP operation `skills_resolve_context` | AC15-AC16 |
| 4 | `enforcement: warn|block`; `flow task done` check | AC17-AC18 |
| cross | docs, reviewer non-regression, Vantage fixture, live proof | AC19-AC22 |

Each stage is shippable alone; stage 0 is small and safe and can go first.

## 8. TUI and shell

The resolver is a shell and MCP operation `skills_resolve_context` (AC16). The operator asked for a TUI representation (AC24): a sidebar line `ProjectCtx` (mode, rule count, `cap exceeded`), a `/projectctx` modal with Status and Last resolve tabs and an enforcement toggle, `/projectctx warn|block`, rows in the settings modal and an entry in the command menu. It follows the `/editguard` pattern (`src/tui/jev-edit-guard-inspector.ts`). Every resolve records its result at `.metaproject/data/skills/project-context/last.json` (best effort, overwritten) so the modal has something to show. The state x event matrix is `TUI-states.md`.

## 9. Risks

| Risk | Handling |
|---|---|
| Bundled copy (`src/gdskills/bundled`) vs installed copy drift | project must `keryx update` before a live test; noted in AC22 |
| Imprecise `globs` select too much or too little | fixture with Vantage shapes (AC21); `reason` in each entry shows why it matched |
| Cap hit on a real task | `on_demand` split plus a warning that names the setting to raise; never silent truncation; a recurring overflow means raise the cap |
| Gate stays prose in the orchestrator dispatch | validator is a command; block mode (AC17-AC18) is the prevention step |
| A project rule shadows an engine rule by name | `shadows` in the output; import never writes `rules/core/` (AC6) |
| Imported rule text carries prompt injection | same security gate as skills (AC6); links rejected for this reason |

## 10. Documentation to update (AC19)

README; docs-site pages for `skills import` and project rules; CLI reference for `--rules`, `resolve-context`, the new categories and the setting; engine rules `skill-lifecycle.mdc` and `skills-storage-workflow.mdc`.

## 11. Remaining questions for the operator

1. Cap scope: it counts project content only (bundled rules are today's baseline and uncounted). Say if bundled rules should count too.
2. The enforcement setting and the cap live in `gdskills.projectContext` of `.metaproject/tasks.config.json`, beside `review.jev`. Say if another home is wanted.
3. Vantage `globs` of each rule are still unread; the fixture (AC21) uses the front-matter shapes, the live run (AC22, by the operator) shows the real selection.
