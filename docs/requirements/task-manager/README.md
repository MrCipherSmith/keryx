# Task Manager requirements

Version: 0.3.2
Status: Phase 1 implemented. CLI `gd-metapro flow`, init scaffold, flow skills and gdskills `flow-orchestrator` shipped; Notion/Jira adapters are Phase 2.

`Task Manager` - модуль Metaproject для agent-first управления работой. Единица работы - **flow**: прохождение стори от инициализации до завершения. CLI (`gd-metapro flow`) - детерминированная state machine, хранилище и гейты; скилы (flow-init, flow-manager, flow-complete) - когнитивный слой, встраиваемый в оркестраторы.

## Ключевые принципы

- Flow-пакет: папка `<NNN>-<date>-<slug>` с md-документами (описание, контекст, план, задачи, критерии приёмки).
- Жёсткие критерии приёмки: checksum-заморозка; правки только через CLI task-manager.
- Единственный авторитет статусов: CLI валидирует переходы; только flow-manager объявляет реализацию завершённой (draft PR).
- Completion-гейты: AC подтверждены + PR checks зелёные + health gate pass; провал возвращает flow в in-progress с fix-нотами.
- Вход: описание проблемы или GitHub issue (через `gh`); TrackerAdapter для будущих Notion/Jira.

## Документы

- [prd.md](prd.md) - продуктовые требования и пользовательские сценарии.
- [specification.md](specification.md) - техническая спецификация: state machine, flow-пакет, CLI, гейты, адаптеры, скилы.
- [brainstorm.md](brainstorm.md) - видение пользователя, research и решения интервью.

## Связанные модули

- `gdgraph`, `gdctx`, `memory`, `health`, `testing` - источники контекста при init и гейты при completion.
- `gdskills` - `flow-orchestrator` исполняет Task Manager lifecycle через `gd-metapro flow`; обычные `job-orchestrator`/`task-implementer` остаются доступными без task flow.
- `spec-orchestrator` - включает Task Manager при `gd-metapro init`.

Routing: если пользователь просит managed implementation через flow, агент
должен выбирать `flow-orchestrator` перед обычным `job-orchestrator`; `flow`
skill остаётся роутером для команд состояния и lifecycle.

## Рабочее имя CLI

Namespace CLI: `gd-metapro flow` (единица работы - flow). Manifest-ключ модуля: `tasks`.
