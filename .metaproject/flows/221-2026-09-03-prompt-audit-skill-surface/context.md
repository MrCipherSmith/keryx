# Контекст

Источник — прогон `/claude-api prompt-audit` (бандл-скилл Claude Code
`claude-api`, файл методики `shared/prompt-audit.md`) от 2026-09-03.
Контекст собран в ходе самого аудита; отдельных воркеров не диспетчеризовали,
потому что добывать было нечего — это разрешённый init.md случай заполнения
инлайн.

## Область аудита

- **Канон:** `src/gdskills/bundled/skills/**/SKILL.md` — 67 файлов, 20 289 строк.
- **Установленная копия:** `.metaproject/skills/gdskills/` — 48 скиллов,
  побайтово идентичны источнику.
- **Harness-сборки:** `SKILL.codex.md` (37), `.cursor.md` (37), `.zed.md` (14),
  `.opencode.md` (14) — байтовые копии. Из 102 копий 88 идентичны, 14 отличаются
  только строкой `compatible_harnesses` frontmatter.
- **Целевая модель:** `claude-opus-5`, выведена по правилу «текущее флагманское
  поколение». Правила 1–3 не сработали: модель в запросе не названа, миграции не
  задокументировано, и в поверхности скиллов **нет ни одного пина model-id** —
  модели вычисляются через `keryx review tier`.

## Что оказалось чистым

Четыре сигнальных сканирования вернули ноль совпадений по всей поверхности:

| Что искали | Сигнатуры | Найдено |
|---|---|---|
| Леса, заменённые фичами API | `think step by step`, `<scratchpad>`, `budget_tokens`, `stop_sequences`, `temperature`, `top_p` | 0 |
| Пины выведенных моделей | `claude-2`, `claude-3`, `Opus 4.0–4.5`, `Sonnet 4.0–4.5`, `gpt-4` | 0 |
| Подавители апдейтов, анти-формат | `hold findings`, `don't narrate`, `no interim`, `never use bullets/headers` | 0 |
| Числовые потолки вывода | `at most N words`, `under N words`, `every N tool calls` | 0 |

## Находки, ведущие в этот флоу

| ID | Уверенность | Место | Суть |
|---|---|---|---|
| F-1 | high | `src/harness/tool/metaproject-adapter.ts:193–226` | Блочный скаляр `description:` парсится как литерал `\|`; затронуто 15 из 48 скиллов |
| F-2 | high | 4 ревьюера в `src/gdskills/bundled/skills/review/` | Нет `triggers:` и описание съедено → нулевой сигнал маршрутизации |
| F-3 | medium | 11 файлов в `review/` | `Triggered by:` прозой дублирует ключ `triggers:` того же файла |
| F-4 | medium | `orchestration/job-orchestrator/SKILL.md:2054–2085` | 30 пунктов пересказывают правила, изложенные выше, без их причин |
| F-5 | medium | `orchestration/feature-analyzer/SKILL.md` frontmatter | `NEVER start without...` — поведенческое правило в маршрутизирующем описании |

Дословные дубли в F-4: пункт 10 ↔ строка 663, пункт 11 ↔ строка 704,
пункт 17 ↔ строка 42, пункт 20 ↔ строка 1242, пункт 28 ↔ строка 1074.

## Доказательство по F-1 (поведенческое)

Вызов `mcp__keryx__skills_catalog`, фрагмент ответа:

```
- review-core-boundaries (review) — |
- review-flow-graph (review) — |
- review-frontend-conventions (review) — |
- review-testing-practices (review) — |
- review-clean-code (review) — | [triggers: review clean code, ...]
- reviewer-skill-creator (core) — | [triggers: create a reviewer, ...]
```

## Смежные факты о коде

- `triggers:` из frontmatter действительно потребляется — тем же
  `parseSkillFrontmatter`, и рендерится как `<описание> [triggers: ...]`.
  Это отдельная структура от жёстко прописанного реестра `BUNDLED_GDSKILLS`
  в `src/gdskills/catalog.ts`; путать их не следует.
- `bundled-eval.ts` валидирует `frontmatter:block`, `frontmatter:name`,
  `frontmatter:description`, `frontmatter:metadata` — но не `triggers`.
  Отсюда и то, что четыре скилла без триггеров прошли мимо проверок.
- В `bundled-eval.ts` два знаменателя (скиллы и документы) заведены именно
  потому, что сборка однажды разошлась со своим `SKILL.md`, а sweep отчитался
  чисто.

## Предложенный диф аудита

`prompt-audit-keryx.patch` (scratchpad сессии) — 5 ханков, по одному на находку,
плюс блок про распространение правок на harness-сборки. Ничего не применялось:
по контракту prompt-audit диф предлагается, а не накатывается.

## Артефакт с разбором

https://claude.ai/code/artifact/c2180e1b-8d4f-48c3-af48-af78e922f3c0
