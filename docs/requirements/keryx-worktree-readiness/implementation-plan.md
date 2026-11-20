# План реализации · Готовность worktree
Version: 0.2.0

Статус: план, ничего не начато. Каждый этап — отдельный flow и PR в `main`.

## Этап 1 — Подготовка и metaproject в worktree (R1–R6)

- `src/worktree/`: `create`, `prepare`, `promote`, `env`, `exec`, `status`, `remove`; метка checkout в git-каталоге worktree (§3), `.env` (§7.1), зависимости (§7.2), порты (§7.3), перестройка индексов (§5.1).
- `promote`: обучение — через существующий `keryx learn promote`; память — копия в `~/.keryx/memory` под блокировкой. Журнал решений, номера flow и шина не меняются.
- Строки §5.3 для сессий, подагентов (`provisionWorktrees`), внешних агентов и `trigger run`; расширение существующей проверки `worktrees` в `keryx doctor`.
- `keryx trigger run` использует `src/worktree`.

Демонстрация: `keryx worktree create demo`, `bun test src/lib` в нём без установки, индекс памяти построен; новая запись памяти после `promote` лежит в `~/.keryx/memory`, рабочая копия основного checkout не изменилась.

## Этап 2 — Головная ветка и проверка конфликтов (R7–R8)

- Поля `headBranch`, `worktree` в `flow.json`; заполнение в `create --flow` и `flow start`.
- `keryx worktree check` (§7.5).
- Desktop: блок «Перед слиянием» в деталях flow, значок в футере, порты во вкладке Info.

Демонстрация: два flow правят один файл, main ушёл вперёд; проверка называет конфликт и соседний flow.

## Этап 3 — Базовая линия (R9)

- `keryx test baseline capture|show`; источник команд (§7.6); захват при `flow start` отдельным процессом с блокировкой, логом и остановкой при `flow complete`; разбор имён падений для шести раннеров.
- Отчёт в `keryx test run` и `keryx test baseline show`, блок в деталях flow в Desktop. Гейтов не меняет: блокировать по отчёту сможет только W1 слоя приёмки после G1.

Демонстрация: ветка с заранее падающим тестом в main — отчёт «было 1, стало 1», `regressed: false`.

## Этап 4 — Нестабильные тесты (R10)

- Повтор один раз, классификация `flaky`, отчёт с именами; только отчёт.

Демонстрация: тест с гонкой падает один раз из двух — помечен нестабильным и назван в отчёте.

## Проверки

`bun test src/worktree src/testing src/flow`, `bun run typecheck`; для Desktop — `cd apps/desktop && bun test src`, `cargo test`. Пробный прогон на реальном клоне keryx — владелец.

## Порядок с парным пакетом

Этапы этого пакета не зависят от [рабочих панелей](../keryx-desktop-workspace-panels/implementation-plan.md). Desktop-часть этапа 2 удобнее делать после вкладки «Changes», но может идти раньше.
