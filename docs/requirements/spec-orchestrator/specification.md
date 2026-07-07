# spec-orchestrator: спецификация Metaproject CLI и инициализации

Version: 0.8.2

## 1. Назначение

`spec-orchestrator` описывает центральный слой Metaproject: глобальный CLI, установку в проект, интерактивную инициализацию, выбор модулей и генерацию стартовых файлов `.metaproject/`.

Этот слой отвечает за то, чтобы Metaproject был не набором разрозненных папок, а управляемой системой:

- устанавливаемой глобально;
- инициализируемой в любом целевом проекте;
- расширяемой через модули;
- понятной AI-агентам через `index.md`;
- понятной людям через `README.md`;
- управляемой через `metaproject.json`.

## 2. Термины

- **Global CLI** - установленная команда `gd-metapro`, доступная из любого проекта.
- **Target project** - проект, в котором пользователь запускает `gd-metapro init`.
- **Local Metaproject** - папка `.metaproject/`, созданная внутри target project.
- **Module** - подключаемая функциональная область: `gdgraph`, `gdctx`, `gdwiki`, `gdskills`, memory, tasks, health, testing.
- **Core** - служебный код модуля.
- **Data** - output, который читают агенты: индексы, summary, отчеты, графы, curated context.
- **Rules** - импортированные проектные инструкции из `AGENTS.md`/`CLAUDE.md`.
- **Agent entrypoint** - `.metaproject/index.md`, главный файл для AI-агентов.
- **gdskills** - рабочие skills/orchestrators Metaproject.
- **project-skills** - generated skills, завязанные на контент и компоненты целевого проекта.
- **Bundled working skills** - native reusable skills shipped with `gd-metapro` and installed into the local Metaproject skill domain.

## 3. Цели

- Дать пользователю один глобальный CLI для управления Metaproject.
- Создавать `.metaproject/` в целевом проекте через `gd-metapro init`.
- Интерактивно спрашивать, какие модули включить.
- Генерировать `index.md` как точку входа для AI-агентов.
- Генерировать `README.md` как описание Metaproject для человека.
- Создавать machine-readable manifest `metaproject.json`.
- Импортировать существующие `AGENTS.md`/`CLAUDE.md` в `.metaproject/rules/`.
- Если root agent entrypoint отсутствует, создавать `AGENTS.md`.
- Добавлять в root agent entrypoint ссылку на `.metaproject/index.md`.
- Настраивать `.gitignore` так, чтобы agent-facing Metaproject файлы версионировались, а технические runtime/storage файлы игнорировались.
- Разделять служебную логику и output: `core/` отдельно от `data/`.
- Поддержать повторный запуск `gd-metapro init` без потери пользовательских изменений.
- Заложить расширяемую систему модулей.
- Поддержать инициализацию `gdskills`, включая optional hook для проверки актуальности entity skills.
- При включенном `gdskills` настраивать local-first routing, чтобы `AGENTS.md`/`CLAUDE.md` сначала ссылались на `.metaproject`, а не на внешние глобальные наборы skills.
- Поддержать инициализацию Code Health, включая optional lightweight hook для changed-scope health checks.
- Поддержать инициализацию Documentation Memory как searchable Markdown memory с local index.

## 4. Не цели первой версии

В первой версии не требуется:

- удаленный marketplace модулей;
- облачная синхронизация;
- UI-приложение;
- автоматическая публикация npm-пакета;
- полноценный plugin runtime;
- обязательная поддержка всех AI-клиентов;
- миграции старых версий `.metaproject/` сложнее одного schema version.

## 5. Установка

### 5.1 Глобальная установка

Пользователь должен получить глобальную команду `gd-metapro`.

Основной bootstrap-вариант:

Для приватного репозитория через GitHub CLI:

```bash
gh auth setup-git
gh api repos/MrCipherSmith/meta-project/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --global
```

Для публичного raw URL:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --global
```

После этого:

```bash
gd-metapro init
```

Альтернативный вариант после публикации npm-пакета:

```bash
pnpm add -g gd-metapro
```

### 5.2 Project-local установка + init

Если пользователь не хочет глобальную команду, bootstrap-скрипт должен уметь установиться прямо в проект и сразу выполнить `init`.

```bash
gh auth setup-git
gh api repos/MrCipherSmith/meta-project/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --project
```

или для публичного raw URL:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --project
```

Non-interactive режим:

```bash
gh auth setup-git
gh api repos/MrCipherSmith/meta-project/contents/scripts/install.sh --jq .content | base64 -d | bash -s -- --project --yes
```

или для публичного raw URL:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/meta-project/main/scripts/install.sh | bash -s -- --project --yes
```

Ожидаемое поведение:

- создать `.metaproject/runtime/gd-metapro`;
- скачать туда runtime CLI;
- выполнить `gd-metapro init` через локальный runtime;
- создать `.metaproject/index.md`, `.metaproject/README.md`, `.metaproject/metaproject.json`;
- синхронизировать root agent entrypoints с `.metaproject/rules/`;
- создать выбранные module structures.

### 5.3 Локальная разработческая установка

```bash
pnpm link --global
```

### 5.4 Проверка установки

```bash
gd-metapro --version
gd-metapro doctor
```

`gd-metapro doctor` должен проверять:

- доступность Bun;
- версию CLI;
- наличие прав записи в текущем проекте;
- наличие `.metaproject/`, если команда запущена внутри уже инициализированного проекта;
- валидность `metaproject.json`;
- базовые зависимости включенных модулей.

## 6. Команды CLI

Минимальный набор команд:

```bash
gd-metapro --help
gd-metapro --version
gd-metapro doctor
gd-metapro init
gd-metapro status
gd-metapro update
gd-metapro modules list
gd-metapro modules enable <module>
gd-metapro modules disable <module>
gd-metapro index refresh
```

Команды модулей должны подключаться под namespace:

```bash
gd-metapro gdgraph build
gd-metapro gdgraph query "<query>"
gd-metapro gdgraph affected <target>
gd-metapro gdgraph explain <target>
```

## 7. Init flow

Команда:

```bash
gd-metapro init
```

### 7.1 Поведение

CLI должен:

1. Определить корень target project.
2. Проверить, существует ли `.metaproject/`.
3. Если `.metaproject/` уже есть, предложить:
   - обновить недостающие файлы;
   - включить дополнительные модули;
   - пересоздать generated files;
   - отменить операцию.
4. Если `.metaproject/` нет, создать базовую структуру.
5. Задать вопросы по включаемым модулям.
6. Создать `metaproject.json`.
7. Создать `.metaproject/index.md`.
8. Создать `.metaproject/README.md`.
9. Найти `AGENTS.md`, `agents.md`, `CLAUDE.md`, `claude.md`.
10. Если agent entrypoint не найден, создать `AGENTS.md`.
11. Добавить в найденные или созданный entrypoint ссылку на `.metaproject/index.md`.
12. Импортировать их содержимое в `.metaproject/rules/`.
13. Создать `.metaproject/skills/project-rules/`.
14. Синхронизировать `.gitignore` через managed-блок `gd-metapro`.
15. Если пользователь включил `gdgraph`, предложить установить Git `post-commit` hook для обновления графа после релевантных изменений.
16. Если пользователь включил `gdskills`, установить bundled working skills из текущего `gd-metapro` package в `.metaproject/skills/gdskills/`.
17. Если пользователь включил `gdskills`, сгенерировать `.metaproject/skills/catalog.md` и local-first routing block для `AGENTS.md`/`CLAUDE.md`.
18. Если пользователь включил `gdskills`, предложить установить Git hook для проверки актуальности entity skills после релевантных изменений.
19. Если пользователь включил `health`, предложить установить Git hook для lightweight health checks по changed/affected scopes.
20. Если пользователь включил `memory`, создать memory folders, templates, module manifest и `skills/memory/SKILL.md`.
21. Создать структуру `core/`, `data/`, `rules/`, `skills/`, `modules/`.
22. Запустить post-init hooks включенных модулей.

### 7.2 Интерактивные вопросы

Первый вопрос:

```text
Which Metaproject modules do you want to enable?

[x] gdgraph - code graph, dependencies, symbols, affected context (recommended)
[x] gdctx - token-aware command output and context compression (recommended)
[ ] gdwiki - Markdown project knowledge base
[ ] memory - searchable lessons, decisions, constraints and known mistakes
[ ] tasks - local task manager
[ ] health - code health reports, quality gate, metrics and trends
[ ] testing - normalized test runner reports
[ ] gdskills - skill lifecycle tools and project-skill management
```

Для MVP `gdgraph` должен быть рекомендован, но не включаться молча без подтверждения.

Второй вопрос:

```text
Where should generated agent-readable data be stored?

A. .metaproject/data (recommended)
B. docs/.metaproject-data
C. Custom path
```

Третий вопрос:

```text
Which AI entrypoints should be generated?

[x] .metaproject/index.md (required)
[x] .metaproject/README.md (recommended)
[ ] AGENTS.md reference snippet
[ ] CLAUDE.md reference snippet
[ ] Cursor rules reference snippet
```

Если выбран `gdgraph`, следующий вопрос:

```text
Install git post-commit hook to refresh gdgraph only after relevant file changes?

Y. Yes (recommended) - keeps graph artifacts current after commits without rebuilding on every agent question
N. No - refresh graph manually with gd-metapro gdgraph build
```

Если выбран `gdskills`, следующий вопрос:

```text
Install project-local bundled gdskills?

Y. Yes - copy native gd-metapro working skills into .metaproject/skills so agents route locally first
N. No - keep only CLI/runtime discovery; project-skills can still be generated later
```

Следующий вопрос:

```text
Install git hook to verify entity skills after relevant code/wiki changes?

Y. Yes - keeps generated skills aligned with code, graph, wiki and review lessons
N. No - verify manually with gd-metapro skills verify or through orchestrators
```

CLI flag:

```bash
gd-metapro init --no-gdskills-hook
```

Если выбран `health`, следующий вопрос:

```text
Install lightweight git hook for changed-scope health checks?

Y. Yes - runs lightweight health checks only for changed/affected scopes
N. No - run health manually with gd-metapro health run or through orchestrators
```

Если выбран `memory`, дополнительных hook-вопросов в MVP нет. Модуль создает Markdown memory structure и локальный индекс, который обновляется вручную или оркестраторами.

## 8. Структура `.metaproject/`

Базовая структура после `gd-metapro init`:

```text
.metaproject/
  index.md
  gd-metapro-dashboard.html
  README.md
  metaproject.json
  core/
  data/
  rules/
    README.md
    agents-md.md
  skills/
    project-rules/
  project-skills/
  modules/
  reports/
  templates/
```

Если включен `gdgraph`:

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
  modules/
    gdgraph.md
```

Если включен `gdctx`:

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
  skills/
    gdctx/
      SKILL.md
  modules/
    gdctx.md
```

Если включен `gdskills`:

```text
.metaproject/
  core/
    gdskills/
      cli.ts
      generate.ts
      verify.ts
      learn.ts
      types.ts
      README.md
  data/
    gdskills/
      artifacts/
      reports/
      proposals/
  skills/
    gdskills/
      catalog.md
      entity-skill-router/
        SKILL.md
      entity-skill-creator/
        SKILL.md
      entity-skill-verifier/
        SKILL.md
      entity-skill-learner/
        SKILL.md
      core/
      orchestration/
      review/
      project-docs/
  project-skills/
    <module>/
      <entity>/
        SKILL.md
        references/
        templates/
        verification.md
        skill-changelog.md
  modules/
    gdskills.md
```

Если включен `health`:

```text
.metaproject/
  core/
    health/
      cli.ts
      run.ts
      sources/
      scoring.ts
      types.ts
      README.md
  health/
    baselines/
      project.json
      modules/
      entities/
  data/
    health/
      artifacts/
      history/
      raw/
  skills/
    health/
      SKILL.md
  modules/
    health.md
```

Если включен `memory`:

```text
.metaproject/
  memory/
    index.md
    lessons/
    decisions/
    constraints/
    known-mistakes/
    historical-context/
    patterns/
    templates/
  core/
    memory/
      cli.ts
      index.ts
      search.ts
      ingest.ts
      dedup.ts
      types.ts
      README.md
  data/
    memory/
      index/
      artifacts/
      queries/
      raw/
  skills/
    memory/
      SKILL.md
  modules/
    memory.md
```

## 9. `metaproject.json`

`metaproject.json` - машинный манифест локального Metaproject.

Пример:

```json
{
  "schemaVersion": 1,
  "name": "project-metaproject",
  "createdBy": "gd-metapro",
  "paths": {
    "root": ".metaproject",
    "core": ".metaproject/core",
    "data": ".metaproject/data",
    "rules": ".metaproject/rules",
    "skills": ".metaproject/skills",
    "modules": ".metaproject/modules"
  },
  "modules": {
    "gdgraph": {
      "enabled": true,
      "core": ".metaproject/core/gdgraph",
      "data": ".metaproject/data/gdgraph",
      "manifest": ".metaproject/modules/gdgraph.md",
      "commands": ["build", "query", "affected", "explain", "path"]
    },
    "gdctx": {
      "enabled": true,
      "core": ".metaproject/core/gdctx",
      "data": ".metaproject/data/gdctx",
      "manifest": ".metaproject/modules/gdctx.md",
      "commands": ["status", "diff", "rg", "read", "run", "show"]
    },
    "gdwiki": {
      "enabled": false,
      "wiki": ".metaproject/wiki",
      "data": ".metaproject/data/gdwiki",
      "manifest": ".metaproject/modules/gdwiki.md",
      "commands": ["status", "new", "index", "check-links", "validate"]
    },
    "gdskills": {
      "enabled": false,
      "core": ".metaproject/core/gdskills",
      "data": ".metaproject/data/gdskills",
      "skills": ".metaproject/skills",
      "projectSkills": ".metaproject/project-skills",
      "manifest": ".metaproject/modules/gdskills.md",
      "commands": ["generate", "verify", "learn", "status", "export", "sync"],
      "autonomy": "fully-autonomous",
      "hooks": {
        "verifySkills": false
      }
    },
    "health": {
      "enabled": false,
      "core": ".metaproject/core/health",
      "data": ".metaproject/data/health",
      "baseline": ".metaproject/health/baselines",
      "manifest": ".metaproject/modules/health.md",
      "commands": ["run", "status", "baseline", "explain"],
      "hooks": {
        "changedScopeHealth": false
      },
      "sources": {
        "eslint": { "mode": "auto" },
        "typescript": { "mode": "auto" },
        "tests": { "mode": "auto" },
        "coverage": { "mode": "import" },
        "sonarqube": { "mode": "import" },
        "complexity": { "mode": "auto" },
        "dependencyAudit": { "mode": "auto" }
      }
    },
    "memory": {
      "enabled": false,
      "core": ".metaproject/core/memory",
      "memory": ".metaproject/memory",
      "data": ".metaproject/data/memory",
      "manifest": ".metaproject/modules/memory.md",
      "commands": ["new", "index", "search", "ingest", "check"],
      "embeddings": {
        "enabled": false
      }
    },
    "tasks": {
      "enabled": false
    }
  },
  "agentEntrypoints": {
    "index": ".metaproject/index.md",
    "readme": ".metaproject/README.md",
    "root": ["AGENTS.md"]
  }
}
```

## 10. `.metaproject/index.md`

`index.md` - обязательная точка входа для AI-агентов.

Файл должен быть коротким и ссылочным. Он не должен дублировать всю документацию модулей.

### 10.1 Обязательные секции

- Project identity.
- How to use this Metaproject.
- Enabled modules.
- Rules references.
- Agent workflow.
- Module references.
- Data locations.
- Skills locations.
- Safety rules.
- Refresh instructions.

### 10.2 Шаблон

```markdown
# Metaproject Index

## Purpose

This `.metaproject` folder contains agent-readable context, tools, generated data, and module manifests for this codebase.

Human dashboard: [gd-metapro-dashboard.html](gd-metapro-dashboard.html)

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
| gdgraph | Code graph, dependencies, symbols, affected context | modules/gdgraph.md |
| gdctx | Token-aware command output and context compression | modules/gdctx.md |
| gdskills | Skill lifecycle tools and working Metaproject skills | modules/gdskills.md |
| health | Code quality reports, quality gate, metrics and trends | modules/health.md |
| memory | Searchable project memory: lessons, decisions, constraints and known mistakes | modules/memory.md |

## Rules

| Source | Purpose | Entry |
|--------|---------|-------|
| AGENTS.md | Imported repository agent instructions | rules/agents-md.md |

## Skills

| Skill | Purpose | Entry |
|-------|---------|-------|
| project-rules | Use imported repository rules before planning or editing | skills/project-rules/ |
| gdgraph | Default graph-first navigation for finding relevant project files before broad raw search | skills/gdgraph/SKILL.md |
| gdctx | Use compact command/search/read outputs before loading large raw output | skills/gdctx/SKILL.md |
| gdskills | Use skill lifecycle tools and project-skill routing before implementing, refactoring or reviewing known project entities | skills/gdskills/entity-skill-router/SKILL.md |
| health | Use normalized health reports before reading raw lint/type/test/audit logs | skills/health/SKILL.md |
| memory | Use project memory search before relying on broad historical context or assumptions | skills/memory/SKILL.md |

## Skill Resolution Priority

When `gdskills` is enabled, agents must resolve skills and rules in this order:

1. `.metaproject/index.md`.
2. `.metaproject/skills/catalog.md`.
3. `.metaproject/project-skills/**`.
4. `.metaproject/skills/gdskills/**`.
5. Global runtime skills only as optional fallback when the project explicitly allows it.

## Agent Workflow

1. Read this file first.
2. Check enabled modules.
3. Load relevant rules from `rules/`.
4. For project navigation, file discovery, code understanding, implementation, review, debugging, or refactoring, use `skills/gdgraph/SKILL.md` before broad raw file search when gdgraph is enabled.
5. For commands, search, diff, test logs, and large file reads that can produce long output, use `skills/gdctx/SKILL.md` when gdctx is enabled.
6. For known modules/components/stores/services/domain entities, check generated project skills under `project-skills/<module>/<entity>/` when gdskills is enabled.
7. For lint/type/test/coverage/complexity/audit questions, read normalized health artifacts before raw logs when health is enabled.
8. For lessons, prior decisions, project constraints, known mistakes, patterns and historical context, use memory search before reading all memory files when memory is enabled.
9. Use relevant skills from `skills/`.
10. Use module manifests before reading raw generated data.
11. Prefer curated artifacts in `data/*/artifacts`.
12. Run module CLI commands when generated data is stale.

## Data

- `data/gdgraph/artifacts/summary.md`
- `data/gdgraph/artifacts/module-map.json`
- `data/gdgraph/queries/latest.md`
- `data/gdctx/artifacts/latest.md`
- `data/gdskills/artifacts/latest.md`
- `data/health/artifacts/latest.md`
- `data/health/artifacts/latest.json`
- `data/memory/artifacts/latest.md`
- `data/memory/artifacts/latest.json`

## Refresh

Run:

```bash
gd-metapro index refresh
gd-metapro gdgraph build
gd-metapro skills status
gd-metapro health status
gd-metapro memory index
```
```

## 11. `.metaproject/README.md`

`README.md` - описание локального Metaproject для разработчика.

### 11.1 Обязательные секции

- What is this folder?
- Installed modules.
- Common commands.
- Generated data policy.
- Editing policy.
- Troubleshooting.

### 11.2 Шаблон

```markdown
# Project Metaproject

This folder contains local Metaproject configuration, tools, generated data, and agent instructions.

## Installed Modules

- `gdgraph`: code graph and affected context.
- `gdctx`: compact command/search/read output and raw output archive.

## Common Commands

```bash
gd-metapro status
gd-metapro index refresh
gd-metapro gdgraph build
gd-metapro gdgraph query "module pipelines"
gd-metapro ctx status
gd-metapro ctx diff
```

## Editing Policy

- Edit module manifests and skills manually when needed.
- Do not manually edit generated files under `data/*/storage`.
- Regenerate artifacts with CLI commands.
```

## 12. Module manifests

Каждый включенный модуль должен иметь manifest в `.metaproject/modules/<module>.md`.

Пример `.metaproject/modules/gdgraph.md`:

```markdown
# gdgraph

## Purpose

Builds code graph, symbol graph, dependency map, and affected context.

## Commands

- `gd-metapro gdgraph build`
- `gd-metapro gdgraph query "<query>"`
- `gd-metapro gdgraph affected <target>`
- `gd-metapro gdgraph explain <target>`

## Data

- `data/gdgraph/artifacts/summary.md`
- `data/gdgraph/artifacts/module-map.json`
- `data/gdgraph/storage/nodes.jsonl`
- `data/gdgraph/storage/edges.jsonl`

## Skills

- `skills/gdgraph/`
```

Пример `.metaproject/modules/gdctx.md`:

```markdown
# gdctx

## Purpose

Runs common project context commands with token-aware filtering and stores raw output separately.

## Commands

- `gd-metapro ctx status`
- `gd-metapro ctx diff`
- `gd-metapro ctx rg "<pattern>"`
- `gd-metapro ctx read <file>`
- `gd-metapro ctx run -- <command...>`
- `gd-metapro ctx show latest`

## Data

- `data/gdctx/artifacts/latest.md`
- `data/gdctx/raw/`
- `data/gdctx/queries/`

## Skills

- `skills/gdctx/`
```

## 13. Module lifecycle

Каждый модуль должен поддерживать lifecycle hooks:

```ts
export interface MetaprojectModule {
  name: string;
  description: string;
  recommended: boolean;
  init(input: ModuleInitInput): Promise<ModuleInitResult>;
  status(input: ModuleStatusInput): Promise<ModuleStatusResult>;
  postUpdate?(input: ModulePostUpdateInput): Promise<ModulePostUpdateResult>;
  refresh?(input: ModuleRefreshInput): Promise<ModuleRefreshResult>;
}
```

Lifecycle:

1. `discover` - CLI знает доступные модули.
2. `prompt` - CLI показывает вопросы пользователю.
3. `init` - модуль создает core/data/skills/modules entries.
4. `status` - модуль сообщает состояние.
5. `postUpdate` - модуль выполняет idempotent обновления после `gd-metapro update`.
6. `refresh` - модуль обновляет generated artifacts.

Команда `gd-metapro update` должна:

- обновить managed runtime, если он установлен глобально или project-local;
- обновить managed service layer без повторного `init`: core scripts, skills, module manifests, dashboard, README/index references и managed hook blocks;
- не выполнять module analyzers/builders по умолчанию;
- не писать `.metaproject/data/**` artifacts по умолчанию;
- выполнить executable hooks из `.metaproject/hooks/post-update.d/` только при явном флаге `--hooks`;
- не перезаписывать user-authored файлы без явного подтверждения.

Команды dashboard:

```bash
gd-metapro dashboard build
gd-metapro dashboard open
```

- `build` пересобирает `.metaproject/gd-metapro-dashboard.html` из существующих service/data files;
- `open` пересобирает dashboard и открывает HTML-файл локальной системной командой;
- обе команды не запускают analyzers/builders и не пишут `.metaproject/data/**`.

## 14. Generated vs user-authored files

Файлы должны делиться на категории:

### User-authored

- `.metaproject/index.md` после первичной генерации допускает ручные правки.
- `.metaproject/README.md` после первичной генерации допускает ручные правки.
- `.metaproject/modules/*.md`.
- `.metaproject/skills/**`.

### Generated

- `.metaproject/data/**/storage/**`.
- `.metaproject/data/**/queries/latest.*`.
- `.metaproject/reports/**`.

CLI не должен перетирать user-authored файлы без подтверждения. Для generated files перезапись допустима.

### 14.1 Git versioning policy

`gd-metapro init` должен поддерживать managed-блок в `.gitignore`.

Версионируются по умолчанию:

- `.metaproject/index.md`;
- `.metaproject/README.md`;
- `.metaproject/metaproject.json`;
- `.metaproject/rules/**`;
- `.metaproject/skills/**`;
- `.metaproject/modules/**`;
- `.metaproject/wiki/**`;
- `.metaproject/data/*/artifacts/**`;
- исключение: `.metaproject/data/gdctx/artifacts/**` является transient command output и по умолчанию игнорируется;
- README/документация внутри `.metaproject/core/**` и `.metaproject/hooks/**`.

Игнорируются по умолчанию:

- `.metaproject/runtime/`;
- `.metaproject/core/**/*.ts`;
- `.metaproject/data/**/storage/`;
- `.metaproject/data/**/raw/`;
- `.metaproject/data/**/queries/`;
- `.metaproject/data/**/summaries/`;
- `.metaproject/data/gdctx/artifacts/`;
- `.metaproject/data/gdwiki/artifacts/`;
- `.metaproject/data/gdwiki/link-check/`;
- `.metaproject/reports/`.

Если в `.gitignore` есть устаревшая строка `.metaproject/`, `gd-metapro init` должен удалить ее и заменить granular managed-блоком.

### 14.2 Documentation versioning policy

Все Markdown-документы, создаваемые `gd-metapro init` или module commands как требования, спецификации, PRD, Wiki-страницы, module manifests и skill-facing documentation, должны иметь поле:

```markdown
Version: 0.1.0
```

Правила:

- поле размещается сразу после H1;
- при каждом изменении документа версия должна обновляться в том же коммите;
- новые документы стартуют с `0.1.0`;
- подробные правила описаны в `docs/requirements/documentation-versioning.md`.

## 15. Refresh behavior

Команда:

```bash
gd-metapro index refresh
```

Должна:

- прочитать `metaproject.json`;
- проверить включенные модули;
- обновить список ссылок в `.metaproject/index.md`;
- не удалять пользовательские секции;
- добавлять недостающие module references;
- обновлять generated block между маркерами.

Рекомендуемые маркеры:

```markdown
<!-- gd-metapro:index:begin -->
generated content
<!-- gd-metapro:index:end -->
```

## 16. Status behavior

Команда:

```bash
gd-metapro status
```

Должна показать:

- project root;
- наличие `.metaproject/`;
- schema version;
- enabled modules;
- stale artifacts;
- missing files;
- рекомендуемые команды.

Пример:

```text
Metaproject: ready
Root: .metaproject
Modules:
  gdgraph: enabled, graph stale
Recommended:
  gd-metapro gdgraph build
```

## 17. Ошибки и безопасность

CLI должен:

- не удалять существующие пользовательские файлы без подтверждения;
- создавать backup перед перезаписью user-authored файлов;
- валидировать пути, чтобы не писать вне target project без явного разрешения;
- не включать скрытую отправку данных наружу;
- явно показывать, какие модули создают generated output;
- иметь `--dry-run` для `init` и `modules enable`.

## 18. Acceptance criteria

### Scenario: global CLI is available

Given пользователь установил Metaproject CLI
When он запускает `gd-metapro --version`
Then CLI показывает версию
And команда завершается успешно.

### Scenario: initialize project with gdgraph

Given пользователь находится в корне target project
When он запускает `gd-metapro init`
And выбирает модуль `gdgraph`
Then создается `.metaproject/`
And создается `.metaproject/index.md`
And создается `.metaproject/README.md`
And создается `.metaproject/metaproject.json`
And создаются `core/gdgraph` и `data/gdgraph`
And `.metaproject/index.md` содержит ссылку на `modules/gdgraph.md`.

### Scenario: initialize project without gdgraph

Given пользователь находится в корне target project
When он запускает `gd-metapro init`
And не выбирает `gdgraph`
Then создается базовая `.metaproject/` структура
And `metaproject.json` отмечает `gdgraph.enabled = false`
And `index.md` не содержит активной ссылки на `gdgraph`.

### Scenario: refresh index

Given `.metaproject/` уже существует
And пользователь включил новый модуль
When он запускает `gd-metapro index refresh`
Then generated block в `index.md` обновляется
And пользовательские секции вне generated block сохраняются.

## 19. Открытые вопросы

- Нужно ли `gd-metapro init` по умолчанию создавать snippets для `AGENTS.md`, `CLAUDE.md`, Cursor rules и Codex skills?
- Должны ли модули храниться полностью внутри `.metaproject/core` или ссылаться на глобальный CLI runtime?
- Нужен ли lockfile `.metaproject/metaproject.lock.json` для версий модулей?
- Нужно ли поддерживать workspace/monorepo режим в первой версии?
- Должны ли generated artifacts попадать в git или быть ignored по умолчанию?
