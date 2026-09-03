# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx ctx rg 'used to (say|be|read|call)|the sentence that stood here|until flow \d+' --glob 'src/gdskills/bundled/**'` возвращает ноль совпадений; ни один bundled-скилл и ни одно правило не описывает собственную предыдущую редакцию.
- AC2: В `src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md` и во всех четырёх harness-сборках отсутствует строка `return the JSON result object as your final message`, при этом факт про `parseChildResult`, бросающий на не-STATUS первой строке, сохранён.
- AC3: `feature-analyzer/SKILL.md` не содержит ни `⚠️ MANDATORY`, ни `CRITICAL RULE`, ни блока `**You MUST respond:**` со скриптом ответа; требование источника/цели/ветки по-прежнему заявлено во frontmatter `description:` и в `## Step 0: Context Gathering`.
- AC4: Поведенческая проба записана в journal: `feature-analyzer` прогнан на реальной ветке до и после правки; в обоих прогонах скилл останавливается и запрашивает пути репозиториев и ветку вместо использования текущего каталога. Если после правки запрос пропал — зафиксировано возвращение инструкции в минимальной форме и повторная проба.
- AC5: Поведенческая проба записана в journal: `feature-dev` прогнан до и после правки; в обоих прогонах порядок spec → tests-creator → implementation соблюдён, и без спецификации реализация не начинается.
- AC6: Девять описаний в `src/mcp/tools.ts` (`sac.collaboration`, `sac.overview`, `sac.read`, `gdgraph.cycles`, `gdgraph.orphans`, `memory.search`, `health.gate`, `health.status`, `standard.validate`) содержат не менее трёх предложений каждое и называют, что инструмент не возвращает.
- AC7: Описания `health.gate` и `health.status` явно предупреждают, что читают сохранённый артефакт и возвращают данные не свежее последнего `keryx health run`.
- AC8: В реестре нет двух скиллов на одну работу без заявленного различия: пара `interview`/`interviewer` сведена к одному, `code-mobx-store-review` слит в store-раздел `review-frontend` либо оба сохранены с явно разграниченными `description`. Решение и его причина записаны в journal.
- AC9: Для каждого удалённого скилла и файла grep по `src/`, `.metaproject/` и тестам не находит висячих ссылок; потребители `ResolvedSkillBuild.fallback` перечислены в journal, и ни один ассерт на это поле не сломан.
- AC10: `bun test` и `keryx skills verify` проходят; bundled-eval не сообщает о расхождении ни одной harness-сборки со своим `SKILL.md`.
- AC11: Ни одно изменение в этом фло не обосновано объёмом текста: в journal для каждой правки записан паттерн из `shared/prompt-audit.md`, к которому она привязана.
- AC12: Границы, заявленные в Out of Scope, соблюдены: 32 `MUST` в `review-frontend`, токены `CRITICAL/WARNING/INFO` в `consistency-checker`, `### MUST`/`### MUST NOT` в `patterns-researcher` и `spec-writer`, цитата GPT-4/GSM8K и пара `CLAUDE.md`/`AGENTS.md` остались без изменений.
