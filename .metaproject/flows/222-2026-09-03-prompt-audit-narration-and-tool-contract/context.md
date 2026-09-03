# Context

Collected deterministically by `keryx flow init` at 2026-09-03T19:01:55.172Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`
- [accepted/task-note] SAC: Напиши мне скрипт на питоне цикла от 1 до 10 с промежутка… - `.metaproject/memory/task-notes/sac-proposal-d820f7ae5c4b43af.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-22T13:24:49.089Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Источник: `/claude-api prompt-audit` по методике
`claude-api/shared/prompt-audit.md`, прогон 2026-09-03 на чистом `main` (95976b4).
Отчёт: https://claude.ai/code/artifact/06132149-ca47-4ac2-a572-1184e28862cd

Инициализация заполнена инлайн, без `context-collector`/`brainstorm`/`interviewer`:
контекст уже собран аудитом, каждая находка несёт `file:line`, дословную цитату и
привязку к строке таблицы паттернов. Обоснование — в plan.md → Approach.

**Scope аудита.** `src/gdskills/bundled/` — 56 012 строк, 180 skill-файлов,
35 правил. Целевая модель `claude-opus-5`, выведена из фикстур и provider-тестов
репозитория: имён моделей нет ни в одном скилле и правиле (это требование
`rules/core/model-selection.mdc`, и оно соблюдено).

**Отношение к flow 221.** 221 закрыл предыдущий проход (frontmatter, triggers,
гигиена `description`, PR #438, merge 4f8e95a). Находки ниже сняты с дерева
*после* 221 и с его задачами не пересекаются: 221/T8 правил `description`
скилла `feature-analyzer`, здесь речь о теле файла на строках 28–60.

### Находки с действием

| ID | Место | Группа | Действие |
|---|---|---|---|
| F1 | `skills/orchestration/feature-analyzer/SKILL.md:28-60`, дубль на `:184-215` | 1a + 1c | rewrite |
| F2 | `skills/orchestration/task-implementer/SKILL.md:537-541` (×5 сборок) | 1d | remove |
| F3 | `skills/review/review-orchestrator/SKILL.md:682-690` | 1d | rewrite |
| F4 | `rules/core/model-selection.mdc:120-125` | 1d | rewrite |
| F5 | `src/mcp/tools.ts` — 9 описаний (:186 :188 :202 :493 :503 :582 :598 :611 :661) | 3 | add |
| F6 | `skills/orchestration/feature-dev/SKILL.md:163-165`; `job-orchestrator/SKILL.md:731` | 1a | rewrite |
| F7 | `skills/planning/interview/SKILL.md:3` vs `interviewer/SKILL.md:3` | 4 | remove |
| F8 | `skills/review/code-mobx-store-review/SKILL.md:3` vs `review-frontend/SKILL.md:4,:226-340` | 4 | remove |
| F9 | `review-orchestrator/SKILL.md:207-209`; `job-orchestrator/SKILL.md:1953` (×5) | 1d | rewrite |
| F10 | 88 из 102 `SKILL.{codex,cursor,zed,opencode}.md` идентичны своему `SKILL.md` | 2 | remove |
| F11 | `feature-analyzer/SKILL.md:270,:296,:331`; `job-orchestrator/SKILL.md:477` | 1a | rewrite |
| F12 | учёт токенов по скиллам отсутствует | 4 | исследование |

### Ключевые цитаты

`task-implementer/SKILL.md:537` — правило и его отменённая версия рядом:

    …and records. (This rule used to say the opposite — "return the JSON result
    object as your final message" — which contradicted 6.2, `## Reporting
    Results`, and `parseChildResult`, the production function that throws on any
    first line that is not a canonical STATUS token.)

`review-orchestrator/SKILL.md:682` — файл о собственной прошлой редакции:

    **Nothing refuses a dispatch that omits them, and this file used to say
    otherwise.** … The sentence that stood here until flow 209 told
    you the schema would reject a dispatch without `prior_findings`…

`feature-analyzer/SKILL.md:28-40` — стек усилителей перед gold-скриптом:

    ## ⚠️ MANDATORY: DO NOT PROCEED WITHOUT CONTEXT
    **CRITICAL RULE: You CANNOT start analysis until user explicitly provides:**
    **DO NOT assume defaults. DO NOT use current directory. DO NOT proceed without asking.**
    **You MUST respond:**

### Механика, важная для реализации

- `resolveSkillBuild` (`src/gdskills/export.ts:54`) отдаёт `SKILL.md`, когда
  сборки рантайма нет, и **сообщает** об этом через `ResolvedSkillBuild.fallback`.
  Удаление идентичных сборок переключает это поле с `false` на `true` — поле
  наблюдаемое, потребителей грепать до удаления (AC9).
- Расходятся с каноном только 14 сборок, все в `planning/`, только `.codex` и
  `.cursor`. Их сохранить.
- Образец описания нужного качества уже есть в том же файле: `sac.review`
  (`tools.ts:246`) и `sac.workspaceCreate` (`tools.ts:300`) несут предусловия,
  перекрёстные ссылки и причину ограничения.

### Проверено и чисто (не искать заново)

Отсутствуют во всём корпусе: «think step by step» / «take a deep breath»,
`<scratchpad>`/`<thinking>` в инструкциях, assistant prefill и JSON-forcing,
`budget_tokens`/`temperature`/`top_p`, числовые лимиты вывода, анти-форматные
правила, update-суппрессоры, «be thorough»/«do not be lazy», «do not
hallucinate», identity-stub'ы, устаревшие пины моделей, битые ссылки на
rule-файлы из описаний.

### Намеренно сохранено

32 `MUST` в `review-frontend` (чеклист конвенций с причинами — спецификационный
регистр), токены `CRITICAL/WARNING/INFO` в `consistency-checker` и заголовки
`### MUST`/`### MUST NOT` в `patterns-researcher`/`spec-writer` (выходная схема,
данные), пара `CLAUDE.md`/`AGENTS.md` (рабочая избыточность), цитата
GPT-4/GSM8K в `review-verifier:40` и `review-orchestrator:1237` (обоснование
конструктивного ограничения, а не пин модели).
