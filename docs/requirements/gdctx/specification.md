# gdctx: спецификация модуля управления контекстом

Version: 0.1.0

## 1. Назначение

`gdctx` - модуль Metaproject для управляемого получения контекста агентом. Он должен помогать агенту выполнять поиск, читать файлы, смотреть `git status`, `git diff`, логи тестов и вывод команд без загрузки лишних токенов.

Главная идея: агент должен получать компактный результат для принятия следующего решения, а полный сырой output должен сохраняться локально и быть доступен по ссылке при необходимости.

## 2. Контекст исследования

Референс: [`rtk-ai/rtk`](https://github.com/rtk-ai/rtk).

Полезные идеи из RTK:

- фильтрация шумного вывода;
- группировка похожих строк;
- дедупликация повторяющихся блоков;
- truncation больших outputs;
- разные стратегии для `ls/tree`, `cat/read`, `grep/rg`, `git diff`, тестов, lint/build logs;
- быстрый machine-friendly output для LLM-агентов.

Ограничения, которые нужно учитывать:

- shell auto-rewrite не покрывает встроенные tool calls агента вроде Read/Grep/Glob;
- автоматическое переписывание команд может быть опасным и непрозрачным;
- Metaproject уже имеет `gdgraph`, поэтому поиск релевантных файлов должен использовать граф, а не только shell proxy.

## 3. Принятые решения

### 3.1 Имя

Рабочее имя модуля: `gdctx`.

Обоснование: модуль управляет контекстом, а не является generic proxy. Названия внешних проектов используются только как референсы в документации.

### 3.2 Уровень MVP

MVP должен быть явным CLI-инструментом, а не автоматическим shell hook.

Причины:

- агент и пользователь должны понимать, когда output был сжат;
- проще отлаживать и проверять;
- ниже риск сломать привычные команды;
- можно позже добавить shell integration поверх уже стабильного ядра.

### 3.3 Связь с gdgraph

> Статус: интеграция с `gdgraph` пока не реализована. Текущий `gdctx` (`src/commands/ctx.ts`)
> нигде не обращается к `gdgraph`. Раздел описывает целевое поведение.

`gdctx` должен использовать `gdgraph` как навигационный слой, когда это помогает сократить чтение файлов:

- перед широким `rg`;
- перед чтением нескольких файлов;
- при анализе diff;
- при вопросах про связи между файлами;
- при поиске affected context.

`gdctx` не должен пересобирать граф на каждый запрос. Он использует существующие artifacts/storage и делает fallback на обычные команды, если граф отсутствует.

### 3.4 Размещение в Metaproject

```text
.metaproject/
  core/
    gdctx/
      cli.ts
      commands.ts
      filters.ts
      summarize.ts
      types.ts
      README.md
  data/
    gdctx/
      raw/
      artifacts/
      queries/
  gdctx.config.json
  skills/
    gdctx/
      SKILL.md
  modules/
    gdctx.md
```

Правило:

- `.metaproject/core/gdctx/` - исполняемая логика и adapters;
- `.metaproject/data/gdctx/raw/` - полный сырой output, игнорируется Git;
- `.metaproject/data/gdctx/artifacts/` - короткие runtime summaries, по умолчанию игнорируются Git, чтобы частое использование `gdctx` не засоряло рабочее дерево;
- `.metaproject/data/gdctx/queries/` - transient query outputs, игнорируются Git;
- `.metaproject/gdctx.config.json` - лимиты и настройки сжатия output;
- `.metaproject/skills/gdctx/` - правила для агента, когда использовать модуль.

## 4. Цели MVP

MVP считается успешным, если `gdctx` умеет:

- устанавливаться через `gd-metapro init`;
- создавать module manifest и skill;
- выполнять базовые команды через `gd-metapro ctx ...`;
- сжимать output без потери критичных ошибок;
- сохранять raw output отдельно от agent-facing summary;
- показывать агенту путь к raw output;
- возвращать machine-readable metadata: command, exit code, raw path, summary path, truncation stats;
- не ломать exit code исходной команды.

Планируется (пока не реализовано): использование `gdgraph` для выбора релевантных
файлов, когда граф доступен.

## 5. Не цели первой версии

В MVP не входит:

- автоматическое переписывание всех shell-команд;
- MCP-сервер;
- UI;
- облачная аналитика;
- embeddings;
- semantic search по всем файлам;
- полная поддержка Docker/Kubernetes/log aggregation;
- попытка заменить `gdgraph`.

## 6. CLI

Namespace модуля:

```bash
gd-metapro ctx <command>
```

### 6.1 status

```bash
gd-metapro ctx status
```

Возвращает компактный статус модуля `gdctx`:

- наличие `.metaproject` (present/missing);
- наличие manifest `.metaproject/metaproject.json` (present/missing);
- источник конфигурации: `.metaproject/gdctx.config.json` или `default`;
- путь к данным модуля `.metaproject/data/gdctx` (или `missing`);
- путь к последнему summary `.metaproject/data/gdctx/artifacts/latest.md` (или `missing`);
- включен ли `gdctx` в manifest (`gdctx enabled: yes|no`).

Планируется (пока не реализовано): Git branch, dirty files grouped by status,
информация о stale/missing gdgraph artifacts.

### 6.2 diff

```bash
gd-metapro ctx diff
gd-metapro ctx diff --staged
gd-metapro ctx diff --stat
```

Поведение:

- сохраняет полный diff в `data/gdctx/raw/`;
- возвращает summary по файлам и типам изменений;
- выделяет большие файлы и потенциально рискованные зоны.

Планируется (пока не реализовано): при доступном `gdgraph` добавлять affected hints
для измененных файлов.

### 6.3 rg

```bash
gd-metapro ctx rg "<pattern>"
gd-metapro ctx rg "<pattern>" src/pipelines
```

Поведение:

- запускает `rg`;
- группирует совпадения по файлам;
- показывает top matches и total count;
- скрывает повторяющийся шум;
- сохраняет полный output.

Планируется (пока не реализовано): если pattern похож на имя символа/модуля,
сначала пробовать `gdgraph` для narrowing.

### 6.4 read

```bash
gd-metapro ctx read <file>
gd-metapro ctx read <file> --mode outline
gd-metapro ctx read <file> --mode compact
gd-metapro ctx read <file> --mode full
```

Режимы:

- `outline` - структура файла: exports, classes, functions, imports, key sections;
- `compact` - релевантные фрагменты с line references;
- `full` - полный файл, но с metadata и warning при большом размере.

Для TypeScript/JavaScript файлов `outline` в текущей реализации извлекает imports,
exports/declarations и TODO/FIXME построчно через регулярные выражения. Использование
AST для более точного outline — планируемое улучшение.

### 6.5 run

```bash
gd-metapro ctx run -- <command...>
```

Примеры:

```bash
gd-metapro ctx run -- bun test
gd-metapro ctx run -- bun run lint
gd-metapro ctx run -- pnpm build
```

Поведение:

- запускает команду;
- сохраняет stdout/stderr полностью;
- возвращает agent-friendly summary;
- группирует ошибки;
- сохраняет исходный exit code;
- для тестов показывает failed tests first.

### 6.6 show

```bash
gd-metapro ctx show latest
gd-metapro ctx show <artifact-id>
gd-metapro ctx show <artifact-id> --raw
```

Позволяет открыть предыдущий summary или raw output без повторного запуска команды.

## 7. Output model

Каждый запуск создает metadata (реализовано в `src/commands/ctx.ts`):

```json
{
  "id": "2026-07-06T10-15-30-000Z_diff",
  "kind": "diff",
  "command": "git diff",
  "exitCode": 0,
  "rawPath": ".metaproject/data/gdctx/raw/2026-07-06T10-15-30-000Z_diff.log",
  "summaryPath": ".metaproject/data/gdctx/artifacts/2026-07-06T10-15-30-000Z_diff.md",
  "bytesIn": 184221,
  "bytesOut": 9210,
  "truncated": true
}
```

`id` имеет форму `<iso-timestamp>_<kind>`, где `kind` — `diff`, `rg`, `read` или `run`.
Поля `module` и `graphContext` пока не эмитятся (относятся к будущей `gdgraph`-интеграции).

Stdout должен быть коротким и включать краткий вывод, critical findings/errors first, ссылки на raw/summary artifacts, warning об усечении и next useful command, если применимо.

## 8. Compression strategies

Минимальные стратегии:

- `error-first` - ошибки и failed assertions выше обычного output;
- `dedupe` - повторяющиеся строки схлопываются;
- `group-by-file` - результаты поиска группируются по файлам;
- `head-tail` - для длинных логов показываются начало, конец и critical middle;
- `diff-summary` - diff сжимается до files, hunks, symbols, risk hints;
- `outline` - для исходников показывается структура вместо полного текста.

Планируется (пока не реализовано):

- `secret-redaction` - базовая маскировка env tokens/secrets в agent-facing output.

Сжатие не должно скрывать exit code, command, первую причину ошибки, файл и строку ошибки, путь к полному raw output.

## 9. Skill

При включенном `gdctx` команда `gd-metapro init` должна создавать:

```text
.metaproject/skills/gdctx/SKILL.md
```

Назначение skill:

- использовать `gd-metapro ctx ...` для команд, которые могут вернуть большой output;
- предпочитать `ctx rg` перед широким raw `rg`, если задача не требует полного вывода;
- предпочитать `ctx read --mode outline|compact` перед чтением больших файлов;
- использовать `ctx diff` для первичного анализа изменений;
- проверять важные выводы по реальным файлам, если на основе summary делается утверждение;
- не использовать `ctx` для маленьких точечных команд, где raw output короче и яснее.

## 10. Init integration

`spec-orchestrator` должен добавить `gdctx` в список модулей:

```text
[x] gdgraph - code graph, dependencies, symbols, affected context (recommended)
[x] gdctx - token-aware command output and context compression (recommended)
```

Если пользователь включает `gdctx`, init должен создать:

- `.metaproject/core/gdctx/`;
- `.metaproject/data/gdctx/raw/`;
- `.metaproject/data/gdctx/artifacts/`;
- `.metaproject/data/gdctx/queries/`;
- `.metaproject/skills/gdctx/SKILL.md`;
- `.metaproject/modules/gdctx.md`;
- manifest entry в `.metaproject/metaproject.json`;
- ссылку на skill и module manifest в `.metaproject/index.md`.

## 11. Versioning policy

В Git должны попадать:

- `.metaproject/modules/gdctx.md`;
- `.metaproject/skills/gdctx/SKILL.md`;
- `.metaproject/gdctx.config.json`.

В Git не должны попадать:

- `.metaproject/core/gdctx/*.ts`, если это project-local runtime scripts;
- `.metaproject/data/gdctx/raw/`;
- `.metaproject/data/gdctx/queries/`;
- `.metaproject/data/gdctx/artifacts/`;
- большие transient logs.

## 12. Service layer contract

CLI должен быть тонкой оболочкой над service layer:

```ts
export interface GdCtxService {
  status(input: CtxStatusInput): Promise<CtxResult>;
  diff(input: CtxDiffInput): Promise<CtxResult>;
  rg(input: CtxRgInput): Promise<CtxResult>;
  read(input: CtxReadInput): Promise<CtxResult>;
  run(input: CtxRunInput): Promise<CtxResult>;
  show(input: CtxShowInput): Promise<CtxResult>;
}
```

Это позволит позже добавить MCP tools или agent runtime integration без переписывания логики.

## 12.1 Config

Файл:

```text
.metaproject/gdctx.config.json
```

MVP-поля:

```json
{
  "maxOutputLines": 120,
  "maxImportantLines": 60,
  "maxGroupItems": 12,
  "compactHeadLines": 120,
  "compactTailLines": 80,
  "outlineMaxEntries": 160
}
```

Назначение:

- ограничивать объем stdout summary;
- ограничивать число grouped files/matches;
- управлять head/tail режимом для больших файлов;
- управлять количеством outline entries.

## 13. Acceptance criteria

### Scenario: initialize gdctx in a project

Given пользователь запускает `gd-metapro init`
And выбирает модуль `gdctx`
When init завершается
Then создается `.metaproject/core/gdctx`
And создается `.metaproject/data/gdctx`
And создается `.metaproject/skills/gdctx/SKILL.md`
And создается `.metaproject/modules/gdctx.md`
And `.metaproject/index.md` содержит ссылку на `gdctx`.

### Scenario: compact diff output

Given проект содержит незакоммиченные изменения
When агент запускает `gd-metapro ctx diff`
Then полный diff сохраняется в `.metaproject/data/gdctx/raw/`
And stdout содержит краткий summary по измененным файлам
And stdout содержит путь к raw output
And exit code соответствует исходной команде.

### Scenario: search with compact result

Given проект содержит много совпадений по pattern
When агент запускает `gd-metapro ctx rg "<pattern>"`
Then stdout группирует совпадения по файлам
And показывает total count
And сохраняет полный raw output
And не заставляет агента читать все совпадения сразу.

### Scenario: read large file as outline

Given файл больше установленного лимита
When агент запускает `gd-metapro ctx read <file> --mode outline`
Then stdout содержит imports, exports и основные symbols
And не выводит полный файл
And указывает команду для получения полного raw output.

### Scenario: command failure is visible

Given команда завершается с ошибкой
When агент запускает `gd-metapro ctx run -- <command>`
Then stdout показывает failed command
And показывает exit code
And показывает первую релевантную ошибку
And сохраняет полный stdout/stderr.

## 14. Открытые вопросы

- Должен ли `gdctx` быть включен по умолчанию вместе с `gdgraph`?
- Нужно ли делать отдельные profiles: `normal`, `compact`, `ultra`?
- Какие limits выбрать по умолчанию: bytes, lines, max files, max matches?
- Должны ли curated artifacts версионироваться всегда или только после явной команды `ctx save`?
- Нужен ли shell hook после MVP или достаточно явных команд и agent skill?

## 15. Метрики

Текущие baseline-замеры сокращения контекста и процедура повторной проверки описаны в [metrics-and-validation.md](metrics-and-validation.md).
