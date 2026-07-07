# Требования к Metaproject

Version: 0.8.1

## 1. Идея

Metaproject - это проект-оркестратор для разработки и сопровождения других проектов. Его задача - не хранить все знания в одном большом `CLAUDE.md`, а давать агентам компактную точку входа, которая ссылается на специализированные модули: граф кода, wiki, code health, память, задачи, доменные скилы и тестовые инструменты.

Ключевой принцип: контекст должен быть модульным, запрашиваемым и проверяемым. Агент не должен загружать всю информацию сразу. Он должен уметь найти нужный модуль, прочитать краткий манифест и затем подтянуть только релевантную часть знаний или выполнить нужный инструмент.

## 2. Цели

- Сократить размер always-on контекста для AI-агентов.
- Разделить знания, инструкции и исполняемую автоматизацию.
- Дать проекту локальную систему памяти, документации и задач.
- Поддержать доменные скилы, заточенные под конкретные модули проекта.
- Позволить агентам анализировать код через инструменты, а не только через ручное чтение файлов.
- Позволить агентам получать короткий релевантный output команд, поиска, diff и чтения файлов без загрузки лишних токенов.
- Поддержать generation, verification и learning lifecycle для entity-specific skills.
- Сделать структуру расширяемой: новые модули, скилы и инструменты должны добавляться без переписывания всей системы.

## 3. Основное архитектурное разделение

### Markdown

Markdown используется для декларативных знаний:

- инструкции для агентов;
- скилы;
- wiki;
- архитектурные описания;
- бизнес-правила;
- требования;
- задачи;
- lessons learned;
- локальная память;
- короткие манифесты модулей.

Markdown должен быть удобен для чтения человеком и AI-агентом. Файлы должны быть небольшими, связанными ссылками и иметь явные заголовки.

### TypeScript / Bun

TypeScript и Bun используются для исполняемой логики:

- сканирование проекта;
- AST-анализ;
- построение графа зависимостей;
- сжатие и нормализация вывода команд;
- запуск тестов;
- интеграция с Sonar, линтерами и внешними API;
- генерация отчетов;
- обновление задач;
- поиск по памяти;
- работа с SQLite, embeddings или индексами;
- CLI-команды для агентов.

Правило: если действие меняет состояние, запускает процесс, обращается к API или требует вычислений, это должен быть инструмент на TS/Bun, а не только Markdown-инструкция.

## 4. Модули Metaproject

### 4.1 spec-orchestrator

Назначение: центральный слой Metaproject для глобального CLI, установки в целевой проект, интерактивной инициализации `.metaproject/`, выбора модулей и генерации стартовых документов.

Ожидаемая реализация:

- глобальная команда `gd-metapro`;
- команда `gd-metapro init`;
- интерактивный выбор модулей, включая `gdgraph`;
- генерация `.metaproject/index.md` как точки входа для AI-агентов;
- генерация `.metaproject/README.md` как описания для разработчиков;
- генерация `.metaproject/metaproject.json` как machine-readable manifest;
- импорт root-инструкций из `AGENTS.md`/`CLAUDE.md` в `.metaproject/rules` как high-priority rules;
- команда `gd-metapro rules sync` для повторной синхронизации root entrypoints без полного init/update;
- команда `gd-metapro rules distill` для ручной декомпозиции большого `AGENTS.md`/`CLAUDE.md` на high-priority rules и project-specific skills;
- создание недостающих стандартных root entrypoints `AGENTS.md` и `CLAUDE.md`;
- добавление ссылки из root agent entrypoint на `.metaproject/index.md`;
- генерация скила `project-rules`, который направляет агента к импортированным правилам;
- разделение `.metaproject/core` и `.metaproject/data`.

Документация модуля: `docs/requirements/spec-orchestrator/`.

### 4.2 gdgraph

Назначение: построение графа кода и связей между файлами, сущностями, сервисами, компонентами и модулями.

Ожидаемая реализация:

- основа: TS/Bun;
- хранение графа: локальный JSON или SQLite;
- входные данные: исходный код проекта;
- выходные данные: граф, query API, scoped context для агента.
- рабочее имя модуля: `gdgraph`;
- внешние проекты с похожими идеями используются только как референсы, не как название продукта.
- MVP должен извлекать imports через parser-backed scanner с regex fallback и учитывать `tsconfig.json` `baseUrl`/`paths` aliases для локальных source/asset imports.

Markdown-часть:

- краткий манифест модуля;
- правила исключений;
- описание архитектурных слоев;
- правила интерпретации графа.

### 4.3 Wiki / gdwiki

Назначение: база знаний проекта от бизнес-логики до реализации.

Содержит:

- архитектуру;
- доменные модели;
- бизнес-правила;
- пользовательские сценарии;
- описание компонентов;
- описание сервисов;
- интеграции;
- known decisions.

Ожидаемая реализация:

- основа: Markdown;
- дополнительные CLI-команды: создание страниц по шаблону, проверка ссылок, генерация индекса.
- рабочее имя CLI-модуля: `gdwiki`;
- все Wiki-страницы должны иметь поле `Version`.

Документация модуля: `docs/requirements/wiki/`.

### 4.4 Code Health

Назначение: агрегировать качество кода и превращать технические отчеты в понятный агенту health report.

Источники:

- SonarQube;
- ESLint;
- TypeScript diagnostics;
- test coverage;
- complexity metrics;
- dependency audit.

Ожидаемая реализация:

- основа: TS/Bun;
- CLI namespace: `gd-metapro health`;
- auto-detected sources с режимами `auto`, `run`, `import`, `disabled`;
- layered output: Markdown summary для агента, JSON full report для инструментов, raw logs отдельно;
- quality gate со статусами `pass`, `warn`, `fail`;
- health metrics на уровнях project, module, entity/component/service/store, file и skill-owned scope;
- hybrid scoring: `health_score`, `risk_score`, `trend`, `regression_score`;
- versioned baseline в `.metaproject/health/baselines/`;
- runtime history в `.metaproject/data/health/history/`;
- ручной запуск, orchestrator/review integration и optional lightweight hook;
- generated/static assets (`public/**`, `storybook-static/**`, build outputs и т.п.) не должны портить health score больших frontend-проектов;
- finding adapters должны запускаться параллельно там, где это безопасно, но сохранять deterministic report ordering;
- integration with `gdskills`: health findings являются signal для `skill-verify-skill` и `gd-metapro skills learn --from-health`.

Документация модуля: `docs/requirements/code-health/`.

### 4.5 Documentation Memory

Назначение: долговременная память проекта.

Содержит:

- lessons learned;
- решения, принятые в ходе задач;
- частые ошибки;
- проектные ограничения;
- исторический контекст;
- паттерны, которые уже использовались.

Ожидаемая реализация:

- Markdown как source of truth;
- CLI namespace: `gd-metapro memory`;
- typed memory registry: lessons, decisions, constraints, known mistakes, historical context, patterns, task notes, review notes, incidents, migration notes, integration notes;
- MVP-шаблоны для `lesson`, `decision`, `constraint`, `known-mistake`;
- обязательные поля: `Version`, `Type`, `Status`, `Confidence`, `Provenance`, related scopes, tags, changelog;
- статусы: `draft`, `accepted`, `deprecated`, `conflict`, `superseded`;
- TS/Bun для индексации, поиска, chunking, dedup/conflict checks и возможных embeddings;
- layered search output: короткий Markdown summary для агента, full JSON для инструментов, ссылки на raw Markdown entries;
- результат поиска должен возвращать короткий релевантный контекст, а не всю память целиком;
- пополнение через CLI, orchestrator/job reports, review findings, Code Health findings и `skill-verify-skill`;
- integration with `gdskills`: accepted memory entries являются signal для `skill-verify-skill` и `gd-metapro skills learn --from-memory`.

Документация модуля: `docs/requirements/documentation-memory/`.

### 4.6 Task Manager

Назначение: локальная система задач, понятная человеку и агенту.

Содержит:

- backlog;
- active tasks;
- done tasks;
- статусы;
- acceptance criteria;
- ссылки на wiki, gdgraph и code health;
- историю выполнения.

Ожидаемая реализация:

- задачи: Markdown;
- автоматизация статусов и отчетов: TS/Bun;
- опциональная синхронизация с GitHub Issues, Jira или другим внешним трекером.

### 4.7 gdskills / Project Skills

Назначение: управление lifecycle skills в двух доменах:

- `gdskills` - native рабочие Metaproject skills и orchestrators: creator, verifier, learner, router, review, orchestration, project-docs и utility skills, поставляемые вместе с `gd-metapro`;
- `project-skills` - контентно/компонентно зависимые skills целевого проекта: модули, компоненты, stores, feature components, сервисы, domain concepts и wiki-сущности.

Пример: если в основном проекте есть модуль `pipelines`, то Metaproject должен уметь создать `project-skill` для `pipelines/step`, который описывает общий каркас component + store + tests, фиксирует архитектурные правила и заставляет агента спросить о специфичной бизнес-логике перед генерацией или изменением step.

Ожидаемая реализация:

- CLI namespace: `gd-metapro skills`;
- рабочие skills: `entity-skill-router`, `entity-skill-creator`, `entity-skill-verifier`, `entity-skill-learner`;
- reusable working skills/orchestrators должны поставляться внутри текущего `gd-metapro` package; установленный проект не должен зависеть от `goodai-base`;
- `AGENTS.md`/`CLAUDE.md` должны использовать local-first routing: `.metaproject/index.md`, `.metaproject/skills/catalog.md`, `.metaproject/project-skills`, `.metaproject/skills/gdskills`, и только затем явно разрешенные глобальные runtime skills;
- генерация skill по path, symbol или wiki reference;
- источники контекста: `gdgraph`, `gdctx`, `gdwiki`;
- хранение canonical generated project skills в `.metaproject/project-skills/<module>/<entity>/`;
- гибридный формат: один `SKILL.md` для простых сущностей, skill package для сложных;
- обязательное поле `Version` в каждом `SKILL.md`;
- обязательный `skill-changelog.md` рядом со skill;
- verifier `skill-verify-skill` / `gd-metapro skills verify`;
- learning loop на основе review findings, test failures, code changes и wiki decisions;
- configurable autonomy: `suggest-only`, `auto-high-confidence`, `fully-autonomous`;
- protected manual sections и machine-managed sections;
- optional git hook, который предлагается при `gd-metapro init`;
- интеграция с orchestrator/review pipeline.
- runtime/exported skills для Codex/Claude должны быть компактными best-practice artifacts, с `SKILL.md`, `references/`, `scripts/`, `assets/`, без management-only файлов вроде `skill-changelog.md`.

Пример структуры skill package:

```text
.metaproject/
  project-skills/
    pipelines/
      http-step/
        SKILL.md
        references/
          context.md
          patterns.md
        templates/
          component.template.md
          store.template.md
          test.template.md
        verification.md
        skill-changelog.md
```

Смысл этих скилов:

- объяснять структуру модуля;
- фиксировать архитектурные границы;
- описывать доменные сущности;
- перечислять разрешенные и запрещенные паттерны;
- подсказывать, где искать код;
- помогать писать новые фичи;
- помогать ревьюить изменения;
- помогать генерировать тесты;
- обновляться при изменении архитектуры или review lessons;
- предотвращать типовые ошибки.

Важно: доменные скилы не должны быть просто общей документацией. Они должны быть операционными инструкциями для агента: что делать, что читать, какие проверки выполнить, какие правила применить.

Документация модуля: `docs/requirements/gdskills/`.

### 4.8 Testing Module

Назначение: единый слой тестового контекста, запуска тестов, интерпретации
результатов и выдачи короткого agent-readable отчета.

Ожидаемая реализация:

- основа: TS/Bun;
- namespace CLI: `gd-metapro test`;
- при `init` анализирует тестовый стек проекта, scripts, configs, CI, тестовые
  файлы и инструкции из docs/AGENTS/CLAUDE/wiki/rules;
- создает hybrid context: `skills/testing/SKILL.md`,
  `data/testing/context.md/json`, recommendations и wiki pages при включенном
  `gdwiki`;
- запуск unit, integration, e2e и smoke-тестов через существующий test runner;
- нормализация ошибок в `data/testing/artifacts/latest.json` и краткий
  `latest.md` для агента;
- changed-scope selection: runner related mode -> `gdgraph` -> naming fallback;
- optional hooks: post-commit context refresh и pre-push changed-scope gate;
- `Code Health` потребляет normalized testing report и не владеет test execution.

Документация модуля: `docs/requirements/testing/`.

### 4.9 gdctx

Назначение: token-aware слой получения контекста для AI-агентов. Модуль должен выполнять поиск, чтение файлов, просмотр diff/status и запуск команд так, чтобы агент получал короткий релевантный output, а полный сырой вывод сохранялся локально.

Ожидаемая реализация:

- основа: TS/Bun;
- namespace CLI: `gd-metapro ctx`;
- команды: `status`, `diff`, `rg`, `read`, `run`, `show`;
- интеграция с `gdgraph` для выбора релевантных файлов перед широким поиском или чтением;
- сохранение raw output в `.metaproject/data/gdctx/raw/`;
- сохранение curated summaries в `.metaproject/data/gdctx/artifacts/`;
- предустановленный skill `skills/gdctx/SKILL.md`, объясняющий агенту, когда использовать `gd-metapro ctx ...`;
- отсутствие автоматического shell auto-rewrite в MVP.

Правило: `gdctx` не заменяет `gdgraph`. `gdgraph` отвечает за связи и навигацию по проекту, `gdctx` отвечает за компактный вывод команд и файлового контекста.

Документация модуля: `docs/requirements/gdctx/`.

## 5. Требования к доменным скилам модулей

Для каждого крупного модуля проекта должна быть возможность создать отдельный набор скилов.

Примеры модулей:

- `pipelines`;
- `analytics`;
- `auth`;
- `billing`;
- `users`;
- `workflows`;
- `reports`.

Каждый набор скилов должен отвечать минимум на вопросы:

- какая ответственность у модуля;
- какие основные сущности и сценарии;
- где находятся ключевые файлы;
- какие архитектурные границы нельзя нарушать;
- какие паттерны используются;
- какие ошибки чаще всего возникают;
- как правильно добавлять новую фичу;
- как правильно писать тесты;
- как проводить ревью изменений в этом модуле.

Рекомендуемый минимальный набор файлов:

```text
skills/<module-name>/
  README.md
  architecture.md
  business-logic.md
  implementation-patterns.md
  testing.md
  review-checklist.md
```

## 6. Предлагаемая структура репозитория

> Note: разделы 6-7 - исходное предложение из ранней проработки и не отражают
> фактический shipped layout. Реальная структура `.metaproject/` и манифест
> описаны в `.metaproject/metaproject.json` и в
> [spec-orchestrator/specification.md](spec-orchestrator/specification.md)
> (sections 8-9); при расхождении источником истины является актуальный layout.

```text
metaproject/
  metaproject.json
  AGENTS.md
  core/
    orchestrator/
    gdgraph/
    gdctx/
    health/
    memory/
    testing/
    tasks/
  docs/
    requirements/
    architecture/
  wiki/
    index.md
    business/
    architecture/
    modules/
  skills/
    pipelines/
    analytics/
    auth/
    gdskills/
  tasks/
    backlog/
    active/
    done/
  reports/
    health/
    graph/
    test/
```

## 7. Metaproject Manifest

Нужен центральный манифест, который описывает доступные модули и точки входа.

Пример:

```json
{
  "name": "goodpro-metaproject",
  "modules": {
    "spec-orchestrator": {
      "type": "system",
      "entry": "core/orchestrator/index.ts",
      "docs": "docs/requirements/spec-orchestrator/specification.md"
    },
    "gdgraph": {
      "type": "tool",
      "entry": "core/gdgraph/index.ts",
      "docs": "wiki/architecture/gdgraph.md"
    },
    "gdctx": {
      "type": "tool",
      "entry": "core/gdctx/index.ts",
      "docs": "docs/requirements/gdctx/specification.md"
    },
    "wiki": {
      "type": "knowledge",
      "entry": "wiki/index.md"
    },
    "gdskills": {
      "type": "skills-tool",
      "entry": "core/gdskills/index.ts",
      "docs": "docs/requirements/gdskills/specification.md",
      "skillsRoot": "skills/"
    },
    "health": {
      "type": "quality-tool",
      "entry": "core/health/index.ts",
      "docs": "docs/requirements/code-health/specification.md",
      "data": "data/health",
      "baseline": "health/baselines"
    },
    "memory": {
      "type": "knowledge-tool",
      "entry": "core/memory/index.ts",
      "docs": "docs/requirements/documentation-memory/specification.md",
      "memory": "memory",
      "data": "data/memory"
    },
    "skills": {
      "type": "skills",
      "entry": "skills/"
    },
    "tasks": {
      "type": "tasks",
      "entry": "tasks/"
    }
  }
}
```

## 8. Главный вывод по исходному тексту

Идея сильная: Metaproject должен быть не огромной инструкцией, а системой навигации и инструментов вокруг проекта. Markdown хранит знания и правила, TS/Bun выполняет действия и строит производный контекст.

Уточнение про `pipelines` важно и должно стать одним из центральных требований: скилы должны быть не только глобальными, но и модульными. Для каждого сложного домена должна существовать своя папка скилов, которая помогает агенту понимать структуру, архитектуру, паттерны, бизнес-логику, тестирование и правила ревью именно этого модуля.

## 9. Открытые вопросы

- Metaproject будет отдельным репозиторием или папкой внутри основного проекта?
- Нужно ли поддерживать несколько целевых проектов одновременно?
- Нужна ли совместимость с Codex, Claude Code, Cursor и другими агентами сразу?
- Где должен храниться индекс памяти: только Markdown/JSON или SQLite/vector store?
- Нужно ли делать MCP-сервер для инструментов или достаточно CLI-команд на Bun?
- Должен ли `gdctx` быть включен по умолчанию вместе с `gdgraph` или предлагаться отдельным вопросом?

## 10. Версионирование документации

Все документы в `docs/requirements/` должны содержать поле:

```markdown
Version: x.y.z
```

Правила:

- поле `Version` размещается сразу после H1;
- при каждом изменении документа версия должна обновляться в том же коммите;
- новые документы стартуют с `0.1.0`;
- patch/minor/major инкременты описаны в `docs/requirements/documentation-versioning.md`.
