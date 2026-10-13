# Implementation Plan

Status: formalized; implementation not performed

## Approach

Разделить baseline сессии, classifier selection и turn dispatch; сохранить resolver project > user > derived > session-default. Убрать бессрочный pin после /model и явно согласовать новый контракт с PRD §9.5.

Достаточный классификатор — доступный разрешённый кандидат с поддержкой classifier transport и требуемой способностью классифицировать категории. Использовать существующие профили/ранжирование, документировать минимум и порядок выбора; предпочитать наименее затратный достаточный кандидат. Baseline допустим как кандидат, но не как единственный безусловный выбор. Не угадывать пригодность по имени и не подменять явные назначения исполнителя.

Альтернативы: одна правка guard не исправит fallback/provider-default; отключение /model ухудшает UX; перепись shell избыточна. Выбран локальный контракт с поведенческими регрессиями.

## Steps

1. T1 context: установить runtime/entrypoint, воспроизвести /routing → /model → turn; прочитать актуальные wiki/impact/related tests перед кодом. Зафиксировать opt-in JEV, достаточность кандидатов, доступность, общий latency budget и scope 406/411.
2. T2 implement: отделить baseline от turn dispatch, убрать постоянный pin; выбрать достаточный classifier fallback, разрешать provider-default общей политикой выбора модели. Сохранить resolver precedence, конфигурацию, per-call overrides и policy gates. Пробросить отмену; ошибки классификации/подготовки цели возвращают baseline с причиной.
3. T3 test: исполняемые регрессии фактического dispatch после смены модели, JEV success/refusal/error/timeout/no credentials/policy denial, достаточного fallback, недоступных целей, provider-default, off/slash/session-default, отмены и latency. Обновить pinning assertions; прогнать related tests и type/lint/health.
4. T4 review: независимый review, PRD/docs и live smoke с оператором в запускаемом shell. Записать команды/версии и доказательства; AC подтверждать только по результатам. Подготовить draft PR; публикация по отдельному разрешению.

Scaffold T1–T4 остаётся действующим; детализация определена выше. Задачи реализации пока не выполнены.

## Risks

- Старые тесты/PRD требуют manual-model override: обновить контракт явно, не просто удалить проверки.
- Detected/profiles могут устареть после /connect или /model; актуальность требует проверки.
- Отмена не должна допускать поздний dispatch, менять baseline или увеличивать счётчик успешных маршрутов.
- Timeout сейчас выделен этапам отдельно: проверить общий бюджет и transport cancellation, не только Promise race.
- Новый resolver не делает запрещённую модель доступной: сохранить policy gates и объяснимый fallback.
- Flow411 владеет независимостью от /model; flow406 сохраняет прочие smoke concerns, их не переносить и не объявлять завершёнными.
