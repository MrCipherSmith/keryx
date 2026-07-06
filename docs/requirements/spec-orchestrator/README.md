# spec-orchestrator

Version: 0.6.0

`spec-orchestrator` - спецификация центрального слоя Metaproject: глобального CLI, установки в проект, интерактивной инициализации `.metaproject/`, выбора модулей и генерации стартовой документации для агентов.

Главная идея: пользователь устанавливает один глобальный инструмент `gd-metapro`, запускает `gd-metapro init` в целевом проекте, выбирает нужные модули, после чего CLI создает локальную структуру `.metaproject/`. Внутри нее должны быть:

- `index.md` - основная точка входа для AI-агентов;
- `README.md` - человекочитаемое описание локального Metaproject;
- `metaproject.json` - машинный манифест включенных модулей;
- `core/` - служебная логика и адаптеры;
- `data/` - output и curated context для агентов;
- `skills/` - рабочие Metaproject skills;
- `project-skills/` - generated skills, завязанные на контент и компоненты целевого проекта;
- `modules/` - манифесты включенных модулей.

При включенном `gdskills` `init` должен настраивать local-first routing: `AGENTS.md`/`CLAUDE.md` сначала указывают на `.metaproject/index.md` и локальный skill catalog, а reusable working skills устанавливаются из текущего `gd-metapro` package в `.metaproject/skills/gdskills/`. Установленный проект не должен зависеть от `goodai-base`.

Первая версия должна поддерживать интерактивное подключение `gdgraph`, а архитектура должна позволять добавлять wiki, memory, task manager, Code Health, testing tools и `gdskills` без переписывания CLI.

Подробная спецификация: [specification.md](./specification.md).
