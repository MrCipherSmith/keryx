# Project implementation rules and skills: project first

Flow: 461 (`.metaproject/flows/461-2026-10-17-project-implementation-rules/`). Status: draft PRD for the operator; criteria are not frozen.
Companion: [TRD.md](TRD.md). Criteria (single source): `.metaproject/flows/461-2026-10-17-project-implementation-rules/acceptance-criteria.md`, AC1-AC22.

## 1. Problem

Keryx imports an external project's review skills (`keryx skills import`) and `review-orchestrator` runs them beside the built-in reviewers. A project such as vantage-frontend also has standards that matter while code is written: a design system, a MobX store template, styling and testing conventions (vantage-ai-assistant `rules/core`: 29 rules, 178 KB). Today those standards are enforced by review-only skills and are not read by the skills that write code and tests, so the author follows one standard and the reviewer judges by another.

Concretely (details with file and line in the TRD): only module `review` is wired after import; a rule is imported only when an imported skill cites it; `task-implementer` and `tests-creator` read the engine's `rules/core` and ignore the project slot; the orchestrators dispatch them with no project context; `skills route` ranks a bundled skill above a project one on equal score; and the implementer's result has no field that says which project rules were applied, so nothing can check it.

## 2. Goals

1. A project can import its implementation and testing rules and skills the way it imports review skills.
2. Every skill that writes code or tests takes the project's rules and skills first and the bundled ones second.
3. The order and the check are code, not prose: a resolver produces the list, the result cites what it applied, a validator compares them.
4. A miss warns first and can be switched to blocking later.
5. Context stays bounded: at most 40 KB of project content per task.
6. Nothing in the frozen-AC and TDD flow changes: the resolved list is an input before the RED tests, it does not touch acceptance criteria.

## 3. Non-goals

- Inheritance or merging of skills (`extends:`) and replacing a bundled implementer, tests-creator or orchestrator with a project copy.
- Links as the main path (allowed only as a pinned pointer `source: <path>@<sha256>` that `skills update` expands into a copy).
- Importing Vantage's copies of Keryx bundled skills.
- Loading `alwaysApply: true` rules whole (see sizing).
- A new TUI skills panel (see section 8).
- Making blocking the default; releasing (batched).

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
| Context limit and `alwaysApply: true` | «Решим после замера размера» (measured; 40 KB proposed; answered «Да» to "Делать PRD и критерии приёмки прямо сейчас, с потолком 40 КБ?") |

"Both modes, import by default" is read as: rules are copied into the project by default (`.metaproject/rules/project/`), and a pinned pointer expanded into a copy is the only link-like mode. This reading is stated here because the answer was one line; the operator can correct it.

## 6. Sizing (measured 2026-10-17 on vantage-ai-assistant)

| Item | Size |
|---|---|
| `rules/core`, 29 rules | 178 KB, none `alwaysApply: true` |
| frontend-relevant set (8 rules) | about 85 KB: design-system 25.4K, testing-conventions 15.2K, mobx-store-template 11.1K, styling 10.9K, frontend-assistant 10.5K, code-style-patterns 4.5K, playwright-testing 3.9K, storybook-guidelines 3.7K |
| `rules/AGENTS.mdc` (`alwaysApply: true`) | 38,577 B, an index |

Reading: a UI-component task on the table's own mapping (code-style-patterns, frontend-assistant, storybook-guidelines plus design-system) is about 44 KB, over the cap; adding styling is about 55 KB. These are file sizes. The `globs` of each Vantage rule were not read, so which rules a real `.tsx` file selects is not measured; AC21 fixes that with a fixture, AC22 with a live run.

Design consequence: the 40 KB cap does not truncate. Entries that fit are `must_read`; the rest are `on_demand` (path and description only) and the output warns. The index file is listed, not loaded whole.

Open for the operator: whether 40 KB should count only project content (as drafted) or also the bundled rules; and whether the first Vantage UI task, which will probably exceed it, is acceptable as a warning.

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

Each new function needs a TUI representation or a stated reason. The resolver is exposed as shell and MCP operation `skills_resolve_context` (next to `skills_catalog` and `skill_load`), so a keryx shell session calls it and its transcript shows the resolved list (AC16). A sidebar line or modal is not planned: `src/tui` has no skills surface today (one `skill` mention in `tui-shell.ts`), and building one is a separate feature. Operator to confirm or ask for a sidebar line (for example "project context: N rules, warn").

## 9. Risks

| Risk | Handling |
|---|---|
| Bundled copy (`src/gdskills/bundled`) vs installed copy drift | project must `keryx update` before a live test; noted in AC22 |
| Imprecise `globs` select too much or too little | fixture with Vantage shapes (AC21); `reason` in each entry shows why it matched |
| Cap hit on the first real task | `on_demand` split plus warning; never silent truncation |
| Gate stays prose in the orchestrator dispatch | validator is a command; block mode (AC17-AC18) is the prevention step |
| A project rule shadows an engine rule by name | `shadows` in the output; import never writes `rules/core/` (AC6) |
| Imported rule text carries prompt injection | same security gate as skills (AC6); links rejected for this reason |

## 10. Documentation to update (AC19)

README; docs-site pages for `skills import` and project rules; CLI reference for `--rules`, `resolve-context`, the new categories and the setting; engine rules `skill-lifecycle.mdc` and `skills-storage-workflow.mdc`.

## 11. Open questions for the operator

1. Cap scope: project content only (drafted), or all resolved content?
2. The first Vantage UI task likely exceeds 40 KB: accept the warning plus `on_demand`, or raise the cap?
3. Sidebar line in the TUI, or the shell/MCP operation alone?
4. Where the enforcement setting lives (a new `skills` block in `.metaproject/tasks.config.json`, next to `review.jev.edit_guard`, is proposed).
5. Live proof on vantage-frontend (AC22) needs your OK; Vantage `globs` have to be read first.
