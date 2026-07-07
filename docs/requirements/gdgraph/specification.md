# gdgraph: спецификация модуля анализа графа кода

Version: 0.1.2

## 1. Назначение

`gdgraph` - модуль Metaproject для построения, хранения и запроса графа кодовой базы. Он должен помогать AI-агентам и разработчикам быстро отвечать на вопросы:

- где находится сущность;
- какие файлы и символы зависят друг от друга;
- что затронет изменение конкретного файла, класса, функции или компонента;
- какие циклы, orphan-файлы и архитектурные нарушения есть в проекте;
- какой минимальный контекст нужно прочитать перед реализацией или ревью.

Модуль не должен быть UI-визуализатором в первой версии. Его главный output - структурированные данные и короткие агентские артефакты.

## 2. Контекст исследования

Для проектирования использовались следующие референсы:

- [`dependency-cruiser`](https://github.com/sverweij/dependency-cruiser): dependency graph, правила зависимостей, циклы, orphan modules.
- [`Madge`](https://github.com/pahen/madge): dependency graph для JavaScript/TypeScript и поиск circular dependencies.
- [`ts-morph`](https://ts-morph.com/): удобная обертка над TypeScript compiler API для AST и symbol analysis.
- [`Joern Code Property Graph`](https://docs.joern.io/code-property-graph/): пример более тяжелого Code Property Graph подхода.
- [`tree-sitter`](https://tree-sitter.github.io/tree-sitter/): возможная будущая база для multi-language парсинга.

Вывод: для первой версии нужен не тяжелый CPG-инструмент, а практичный анализатор уровня dependency graph + TypeScript symbol graph. Архитектура должна позволять позже добавить CPG-like анализ без переписывания ядра.

## 3. Принятые решения

### 3.1 Имя

Рабочее имя модуля: `gdgraph`.

Другие названия похожих проектов можно упоминать только как референсы в документации, но не использовать как имя модуля, папок, CLI-команд или публичных API.

### 3.2 Уровень анализа

Первая версия реализует:

- dependency graph;
- TypeScript/JavaScript symbol graph;
- анализ импортов и экспортов;
- связи файл -> символ;
- связи символ -> символ там, где это надежно извлекается;
- базовые архитектурные запросы.

Архитектура должна оставлять путь к более глубокому CPG-like анализу:

- call graph;
- control-flow;
- data-flow;
- taint-flow;
- richer semantic graph.

### 3.3 Размещение в Metaproject

`gdgraph` является частью глобального CLI Metaproject.

При инициализации целевого проекта CLI создает `.metaproject/`.

Принцип разделения:

- `.metaproject/core/` - служебная логика, скрипты, adapters, query engine;
- `.metaproject/data/` - output, который читают агенты и человек;
- `.metaproject/skills/` - предустановленные и пользовательские скилы.

Пример:

```text
.metaproject/
  core/
    gdgraph/
      cli.ts
      build.ts
      query.ts
      types.ts
      README.md
  data/
    gdgraph/
      storage/
      artifacts/
      summaries/
      queries/
  skills/
    gdgraph/
      SKILL.md
  metaproject.json
```

### 3.4 Интерфейс

Первая версия должна поддерживать:

- CLI-команды;
- JSON/Markdown output в `.metaproject/data/gdgraph`;
- внутренний service layer, пригодный для будущего MCP-сервера.
- project-local scripts в `.metaproject/core/gdgraph`, установленные во время `gd-metapro init`.

MCP не обязателен для MVP, но API нельзя проектировать как набор CLI-only скриптов без переиспользуемого ядра.

### 3.5 Языки

Первая версия:

- TypeScript;
- JavaScript;
- React-проекты;
- Node/NestJS-проекты;
- обычные TS-монорепозитории.

Модель данных должна быть language-neutral:

- `language`;
- `adapter`;
- `node.kind`;
- `symbol.kind`;
- `edge.kind`;
- `metadata`.

Будущие адаптеры:

- Python;
- Go;
- Java;
- generic tree-sitter adapter.

### 3.6 Storage и output

Выбран гибрид:

- основной storage: SQLite или JSONL;
- агентские output-артефакты: curated JSON и Markdown;
- большие данные не должны заставлять агента читать весь граф целиком.

## 4. Цели MVP

> Статус реализации: текущая версия строит **file/asset dependency graph** (без symbol-графа).
> Узлы имеют `kind` `file` или `asset`; извлечение символов отнесено в раздел «Планируется».

MVP считается успешным, если `gdgraph` умеет:

- инициализироваться в проекте через глобальный CLI;
- сканировать TS/JS проект;
- строить dependency graph файлов;
- исключать generated/static output по умолчанию для больших frontend-проектов;
- резолвить локальные asset imports как asset nodes, а не как ошибки unresolved;
- сохранять граф в `.metaproject/data/gdgraph`;
- генерировать короткий summary проекта;
- отвечать на базовые запросы через CLI (`query cycles`, `query orphans`);
- показывать affected context для файла (прямые зависимости и прямые зависимые файлы);
- обнаруживать circular dependencies;
- находить orphan modules;
- выдавать агенту scoped context для дальнейшей работы.

Планируется (пока не реализовано):

- извлечение символов (exported symbols, symbol nodes/`symbols.jsonl`);
- affected context на уровне символов;
- транзитивный affected с лимитом глубины, связанные тесты и module skills.

## 5. Не цели первой версии

В MVP не входит:

- UI-визуализация графа;
- полноценный CPG;
- точный data-flow analysis;
- security taint analysis;
- runtime tracing;
- distributed graph database;
- обязательный MCP-сервер;
- поддержка всех языков с первого дня.

## 6. CLI

Базовая команда: `gd-metapro`.

### 6.1 init

```bash
gd-metapro init
```

Создает `.metaproject/`, устанавливает базовую структуру и предустановленные скилы.

### 6.2 build

```bash
gd-metapro gdgraph build
```

Сканирует текущий проект (полный скан `cwd`) и обновляет graph storage + агентские артефакты.

> Статус: команда не принимает опций. Всегда выполняется полный скан текущего каталога.

Планируемые опции (пока не парсятся):

```bash
gd-metapro gdgraph build --project .
gd-metapro gdgraph build --config .metaproject/gdgraph.config.json
gd-metapro gdgraph build --incremental
gd-metapro gdgraph build --full
```

### 6.3 query

```bash
gd-metapro gdgraph query cycles
gd-metapro gdgraph query orphans
```

Возвращает короткий результат в stdout. Поддерживаются только запросы `cycles` и `orphans`;
любой другой запрос завершается с ошибкой `Unsupported gdgraph query`.

> Статус: результаты выводятся только в stdout; каталог `.metaproject/data/gdgraph/queries/`
> не создается.

Планируется (пока не реализовано):

```bash
gd-metapro gdgraph query "module pipelines"
gd-metapro gdgraph query "symbol PipelineStore"
```

Free-form `module ...`/`symbol ...` запросы и запись подробного результата в
`.metaproject/data/gdgraph/queries/` относятся к будущей версии.

### 6.4 affected

```bash
gd-metapro gdgraph affected src/pipelines/PipelineStore.ts
```

Показывает прямые зависимости (файлы, которые импортирует цель) и прямые зависимые файлы
(файлы, которые импортируют цель) — one-hop в обе стороны.

Планируется (пока не реализовано): транзитивные зависимости с лимитом глубины,
потенциально затронутые тесты, модули и доменные скилы.

### 6.5 explain (планируется, пока не реализовано)

> Статус: команда не реализована. `gd-metapro gdgraph` поддерживает только
> `build`, `query cycles|orphans` и `affected`. Вызов `explain` завершится ошибкой
> `Unknown gdgraph command`.

```bash
gd-metapro gdgraph explain pipelines
```

Должна возвращать объяснение области: файлы, символы, зависимости, известные архитектурные границы и ссылки на wiki/skills.

### 6.6 path (планируется, пока не реализовано)

> Статус: команда не реализована (см. примечание к §6.5).

```bash
gd-metapro gdgraph path src/a.ts src/b.ts
```

Должна показывать путь зависимостей между двумя файлами или символами.

### 6.7 gdgraph skill

При включенном модуле `gdgraph` команда `gd-metapro init` должна создавать:

```text
.metaproject/skills/gdgraph/SKILL.md
```

Назначение skill:

- использоваться по умолчанию для навигации по проекту, поиска релевантных файлов и большинства задач работы с кодом: implementation, review, refactoring, debugging, code navigation;
- перед широким поиском, `rg` или чтением большого количества файлов вызвать подходящую команду `gd-metapro gdgraph ...`;
- использовать вывод графа для выбора минимального набора файлов;
- затем проверить вывод графа по реальному исходному коду.
- пропускать граф только когда задача явно не требует поиска проектных файлов/связей, пользователь просит буквальное содержимое одного известного файла или `gdgraph` недоступен.

Минимальные команды, которые skill должен уметь выбирать:

```bash
gd-metapro gdgraph build
gd-metapro gdgraph affected <file>
gd-metapro gdgraph query cycles
gd-metapro gdgraph query orphans
```

Важно: agent workflow не должен запускать `gd-metapro gdgraph build` на каждый пользовательский вопрос. Обновление графа выполняется:

- явно по команде пользователя или агента, если graph storage отсутствует;
- через явную команду `gd-metapro gdgraph build` после подсказки Git `post-commit` hook, если пользователь согласился установить его во время `gd-metapro init`;
- hook должен проверять измененные файлы последнего коммита и только сообщать, что граф может быть stale. Он не должен запускать build сам, потому что post-commit запись versioned artifacts оставляет рабочее дерево грязным.

Ответ агента должен фиксировать:

- `graph_context: used` и список команд, если граф использовался;
- `graph_context: unavailable` и причину, если граф недоступен.

## 7. Структура данных

> Ниже описана **реализованная** схема (`src/gdgraph/types.ts`). `id` узла — это
> относительный путь файла (без префикса `file:`), `id` ребра — `edge:<N>`.
> Поля `module`/`metadata` у узлов и `metadata`/`imported` у ребер пока не заполняются;
> символьный граф (§7.2) не строится. Целевая (расширенная) схема с модулями,
> метаданными и символами относится к разделу «Планируется».

### 7.1 Graph node

```json
{
  "id": "src/pipelines/PipelineStore.ts",
  "kind": "file",
  "path": "src/pipelines/PipelineStore.ts",
  "language": "typescript"
}
```

`kind` принимает значения `file` или `asset`; `language` — `typescript`, `javascript`
или `asset` (для asset-узлов).

### 7.2 Symbol node (планируется, пока не реализовано)

Symbol nodes не создаются текущей сборкой. Целевая форма:

```json
{
  "id": "symbol:src/pipelines/PipelineStore.ts#PipelineStore",
  "kind": "class",
  "language": "typescript",
  "name": "PipelineStore",
  "fileId": "src/pipelines/PipelineStore.ts",
  "module": "pipelines",
  "metadata": {
    "exported": true,
    "startLine": 12,
    "endLine": 180
  }
}
```

### 7.3 Edge

```json
{
  "id": "edge:1",
  "from": "src/pipelines/PipelineStore.ts",
  "to": "src/core/api/client.ts",
  "kind": "imports",
  "specifier": "../core/api/client"
}
```

`specifier` — исходная строка импорта. Поле `metadata` (`imported`, `isTypeOnly`)
относится к целевой схеме и пока не заполняется.

### 7.4 Edge kinds

Реализованный набор:

- `imports` — разрешенный локальный import между исходными файлами;
- `asset` — import локального asset (css/json/svg/png и т.п.), разрешенный в asset-узел;
- `unresolved` — относительный import, который не удалось разрешить.

Планируется (пока не реализовано): `exports`, `reexports`, `declares`, `uses`,
`extends`, `implements`, `calls`, `reads`, `writes`, `configured_by`, `tested_by`,
`documented_by`, `skill_for`.

## 8. Output-артефакты

Реализованная структура (файлы, которые пишет `gd-metapro gdgraph build`):

```text
.metaproject/data/gdgraph/
  storage/
    nodes.jsonl
    edges.jsonl
  artifacts/
    summary.md
    module-map.json
```

Планируется (пока не производится): `storage/symbols.jsonl`,
`artifacts/dependency-cycles.json`, `artifacts/orphan-modules.json`,
`artifacts/public-api-map.json`, `queries/latest.json`, `queries/latest.md`,
`summaries/<module>.md`.

Правило: storage может быть большим; artifacts должны быть маленькими и пригодными для чтения агентом.

## 9. Архитектура core

```text
.metaproject/core/gdgraph/
  cli.ts
  build.ts
  query.ts
  types.ts
  README.md
```

Глобальный runtime содержит fallback-реализацию. При выполнении `gd-metapro gdgraph ...` CLI сначала ищет `.metaproject/core/gdgraph/cli.ts` в текущем проекте и делегирует выполнение туда. Если local runner отсутствует, используется встроенный fallback из установленного runtime.

## 10. Service layer contract

CLI должен быть тонкой оболочкой над service layer.

Минимальные сервисы:

```ts
export interface GdGraphService {
  build(input: BuildInput): Promise<BuildResult>;
  query(input: QueryInput): Promise<QueryResult>;
  affected(input: AffectedInput): Promise<AffectedResult>;
  explain(input: ExplainInput): Promise<ExplainResult>;
  path(input: PathInput): Promise<PathResult>;
}
```

Это позволит позже подключить MCP tools без переписывания логики.

## 11. Конфигурация

> Статус: файл `gdgraph.config.json` пока не читается. Исключения каталогов
> (`node_modules`, `dist`, `build`, `coverage`, `generated`, `out`, `public`,
> `storybook-static`, `.next`, `.docusaurus`, `.turbo`, `.cache`, `.git`,
> `.metaproject`) и список asset-расширений заданы в коде (`src/gdgraph/build.ts`,
> `IGNORE_DIRS` / `ASSET_EXTENSIONS`). Схема ниже описывает целевую конфигурацию
> будущей версии.

Файл:

```text
.metaproject/gdgraph.config.json
```

Пример:

```json
{
  "projectRoot": ".",
  "languages": ["typescript", "javascript"],
  "include": ["src/**/*.{ts,tsx,js,jsx}"],
  "exclude": [
    "node_modules/**",
    "dist/**",
    "build/**",
    "coverage/**",
    ".next/**",
    "out/**",
    "storybook-static/**",
    "public/**",
    "**/.docusaurus/**",
    "generated/**",
    "**/*.test.ts",
    "**/*.spec.ts"
  ],
  "assets": {
    "resolveImportedAssets": true,
    "extensions": [".css", ".scss", ".json", ".svg", ".hbs", ".html", ".glsl", ".png", ".jpg", ".webp", ".woff2"]
  },
  "modules": [
    {
      "name": "pipelines",
      "paths": ["src/pipelines/**"],
      "skills": ["skills/pipelines"]
    }
  ],
  "storage": {
    "kind": "jsonl",
    "path": ".metaproject/data/gdgraph/storage"
  },
  "artifacts": {
    "path": ".metaproject/data/gdgraph/artifacts"
  }
}
```

MVP runtime already applies frontend-safe defaults even when `gdgraph.config.json`
is absent:

- skip generated/static directories: `storybook-static`, `public`, `.docusaurus`,
  `.next`, `out`, `dist`, `build`, `coverage`, `generated`;
- treat local relative asset imports with known extensions and Vite-style suffixes
  such as `?raw` and `?react` as `asset` edges;
- keep unresolved counts focused on actual missing relative code imports.

## 12. Brainstorm: варианты реализации

### Option A: Lightweight dependency graph

Подход: только файлы, imports/exports, циклы, orphan-файлы.

Плюсы:

- быстро реализовать;
- низкий риск;
- полезно уже для архитектурных проверок.

Минусы:

- мало доменного смысла;
- агенту все равно придется много читать руками;
- плохо отвечает на вопросы про классы, stores, services, components.

Оценка: effort S, risk low.

### Option B: Dependency + TS symbol graph

Подход: строить dependency graph и извлекать символы через TypeScript compiler API / ts-morph.

Плюсы:

- хороший баланс сложности и пользы;
- подходит для React/Nest/Node;
- дает агенту более точный scoped context;
- можно расширять до call graph.

Минусы:

- сложнее схемы;
- нужно аккуратно работать с alias/tsconfig/path mapping;
- не все связи можно надежно извлечь в MVP.

Оценка: effort M, risk medium.

### Option C: CPG-like engine

Подход: сразу строить AST/control/data-flow graph.

Плюсы:

- сильная база для security, performance, deep review;
- богатые запросы.

Минусы:

- высокий риск;
- долгий MVP;
- много ложной точности;
- сложная поддержка.

Оценка: effort L, risk high.

### Рекомендация

Выбран Option B как MVP с архитектурным путем к Option C.

## 13. Acceptance criteria

### Scenario: initialize gdgraph in a project

Given пользователь запускает `gd-metapro init`
When CLI выполняется в корне проекта
Then создается `.metaproject/core/gdgraph`
And создается `.metaproject/data/gdgraph`
And создается базовый `gdgraph.config.json`

### Scenario: build graph

Given проект содержит TypeScript файлы
When пользователь запускает `gd-metapro gdgraph build`
Then `gdgraph` строит file dependency graph
And сохраняет storage (`nodes.jsonl`, `edges.jsonl`) и artifacts (`summary.md`, `module-map.json`)
And генерирует `summary.md`

Планируется: извлечение exported symbols в рамках этого сценария.

### Scenario: find affected context

Given граф уже построен
When пользователь запускает `gd-metapro gdgraph affected <file>`
Then CLI возвращает прямые зависимости
And прямые зависимые файлы (dependents)

Планируется (пока не реализовано): транзитивные зависимости с лимитом глубины,
связанные тесты и связанные module skills.

### Scenario: explain module (планируется, пока не реализовано)

Команда `explain` не реализована (см. §6.5). Целевое поведение:

Given настроен module mapping для `pipelines`
When пользователь запускает `gd-metapro gdgraph explain pipelines`
Then CLI возвращает краткое описание модуля
And список ключевых файлов
And список ключевых symbols
And ссылки на `skills/pipelines` и wiki, если они существуют

## 14. Открытые вопросы на будущее

- Нужно ли хранить историю графов между build-запусками?
- Нужен ли diff graph между двумя git refs?
- Нужно ли автоматически строить suggested skills по модулям?
- Какой лимит размера artifact считается безопасным для AI-агента?
- Нужно ли поддержать monorepo package graph в MVP или во второй версии?
- Когда добавлять MCP: сразу после стабильного CLI или после первого реального внедрения?
