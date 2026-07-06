# spec-orchestrator: спецификация Metaproject CLI и инициализации

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
- **Module** - подключаемая функциональная область: `gdgraph`, wiki, memory, tasks, health, testing, skills.
- **Core** - служебный код модуля.
- **Data** - output, который читают агенты: индексы, summary, отчеты, графы, curated context.
- **Rules** - импортированные проектные инструкции из `AGENTS.md`/`CLAUDE.md`.
- **Agent entrypoint** - `.metaproject/index.md`, главный файл для AI-агентов.

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
16. Создать структуру `core/`, `data/`, `rules/`, `skills/`, `modules/`.
17. Запустить post-init hooks включенных модулей.

### 7.2 Интерактивные вопросы

Первый вопрос:

```text
Which Metaproject modules do you want to enable?

[x] gdgraph - code graph, dependencies, symbols, affected context (recommended)
[ ] wiki - project knowledge base
[ ] memory - long-term project memory
[ ] tasks - local task manager
[ ] health - code health reports
[ ] testing - normalized test runner reports
[ ] domain-skills - module-specific AI skills
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

## 8. Структура `.metaproject/`

Базовая структура после `gd-metapro init`:

```text
.metaproject/
  index.md
  README.md
  metaproject.json
  core/
  data/
  rules/
    README.md
    agents-md.md
  skills/
    project-rules/
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
    "wiki": {
      "enabled": false
    },
    "memory": {
      "enabled": false
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

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
| gdgraph | Code graph, dependencies, symbols, affected context | modules/gdgraph.md |

## Rules

| Source | Purpose | Entry |
|--------|---------|-------|
| AGENTS.md | Imported repository agent instructions | rules/agents-md.md |

## Skills

| Skill | Purpose | Entry |
|-------|---------|-------|
| project-rules | Use imported repository rules before planning or editing | skills/project-rules/ |
| gdgraph | Default graph-first navigation for finding relevant project files before broad raw search | skills/gdgraph/SKILL.md |

## Agent Workflow

1. Read this file first.
2. Check enabled modules.
3. Load relevant rules from `rules/`.
4. For project navigation, file discovery, code understanding, implementation, review, debugging, or refactoring, use `skills/gdgraph/SKILL.md` before broad raw file search when gdgraph is enabled.
5. Use relevant skills from `skills/`.
6. Use module manifests before reading raw generated data.
7. Prefer curated artifacts in `data/*/artifacts`.
8. Run module CLI commands when generated data is stale.

## Data

- `data/gdgraph/artifacts/summary.md`
- `data/gdgraph/artifacts/module-map.json`
- `data/gdgraph/queries/latest.md`

## Refresh

Run:

```bash
gd-metapro index refresh
gd-metapro gdgraph build
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

## Common Commands

```bash
gd-metapro status
gd-metapro index refresh
gd-metapro gdgraph build
gd-metapro gdgraph query "module pipelines"
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
- выполнить executable hooks из `.metaproject/hooks/post-update.d/`;
- не перезаписывать user-authored файлы без явного подтверждения.

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
- `.metaproject/data/*/artifacts/**`;
- README/документация внутри `.metaproject/core/**` и `.metaproject/hooks/**`.

Игнорируются по умолчанию:

- `.metaproject/runtime/`;
- `.metaproject/core/**/*.ts`;
- `.metaproject/data/**/storage/`;
- `.metaproject/data/**/queries/`;
- `.metaproject/data/**/summaries/`;
- `.metaproject/reports/`.

Если в `.gitignore` есть устаревшая строка `.metaproject/`, `gd-metapro init` должен удалить ее и заменить granular managed-блоком.

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
