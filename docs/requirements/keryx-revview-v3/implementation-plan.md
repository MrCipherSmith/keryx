# План реализации
Version: 0.2.0

Статус: spec ready; решения D1–D7 приняты, этот план не запущен. Реализация требует отдельного согласования; текущая работа — только docpack.

## P0 — Baseline и подготовка

Зафиксировать текущие host paths, ограничения, тестовые fixtures и показатели плоского review. Проверить фактические root caps, session authority и external adapters. Построить capability matrix. Выход: воспроизводимый baseline, без live запусков/изменения auth по умолчанию. R1, R5, R10.

## P1 — Контракты и сущности

Использовать принятые четыре имени, schema v2 с чтением v1 без перезаписи legacy definitions; добавить schema/validator/compiler поддержку entity dispatch и delegation. Сохранить старые defaults и overrides, добавить четыре definitions. Определить версионированные JSON schemas планов/assignments/runs/events, migration и storage в review package. До фиксации wire API написать failing contract tests. Автоматизируемые PRD требования R3, R6–R9 перевести с временного judged на exec/invariant с командами существующих тестов соответствующего этапа; это gate приёмки этапа. R2, R3, R8.

## P2 — Host-owned scheduler и native tree

Общий ledger, очередь, leases, descendant registry, идемпотентный spawn, cancellation/recovery и lifecycle. Rebind tools к состоянию ребёнка, inheritance authority без разделения mutable closures. Учитывать waiting separately, снять зависимость parallelism от одного model batch. Оба shell paths и native session host проверяются. R4, R6, R7.

## P3 — Переносимость и external generals

Единый API capabilities/spawn/status/wait/cancel/result с CLI/MCP bindings; external process adapter с scoped bridge и отзывом полномочий. Обязательный для первого выпуска путь Keryx-as-external-general, в том числе для harness без nested tools. Codex/Claude controllers используют общий API; их process adapters принимаются отдельно после проверки. Pi отложен. Auth preflight и unsupported/degraded statuses. Provider/version tests, в том числе невозможность enforcement. Нельзя считать этап готовым только после запуска CLI процесса. R5, R7.

## P4 — Review orchestration

Подготовка, risk/coverage plan, владельцы границ, назначения general/direct soldier, scoped task updates, immutable context refs, уникальные dispatch artifacts. Ingest leaf results, dedup/provenance, независимая validation, delta rounds, сохранение readiness/premise/completion gates. R1, R2, R8, R9.

## P5 — Проверка и выпуск

Детерминированные offline concurrency/authority/recovery tests, adapters compatibility, независимый code/security review, benchmark и калибровка large-review. Документировать limitations и rollback. Новую иерархию включать capability-gated profile; flat path сохранить. Отключение V3 не бросает процессы: сначала отмена/reconciliation и сохранение package. R6, R9, R10.

Зависимости: P0 → P1 → P2; P3 после P1/P2; P4 использует P1/P2 и подключает P3; P5 после P3/P4. Тесты контрактов предшествуют реализации каждого этапа. Параллельная работа допустима только на независимых контрактах, без конкурирующих правок схем.

## Готовность к началу

D1–D7 согласованы. Реализацию пока не начинать: нужен отдельный запрос пользователя. При выполнении P0/P1 предстоит создать fixtures AC1–AC10, закрепить wire contracts и проверить adapter/version matrix; их наличие сейчас не заявляется. До live benchmark выбрать провайдеров, авторизацию и measured-cost со spending budget либо явно cost-unknown. Не включать в этот план commits/PR/publish без отдельного запроса.
