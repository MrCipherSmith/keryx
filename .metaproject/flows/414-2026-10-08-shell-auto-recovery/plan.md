# Implementation Plan

Status: ready for implementation

## Approach

Same-turn recovery supervisor в agent orchestration, включаемый interactive shell. Разделить logical turn, model round и transport attempt; сохранить историю, результаты tools, approvals, usage и бюджеты. Providers нормализуют ошибки и выполняют только узкий credential refresh.

Brainstorm: adapter-only retries не контролируют partial history и бюджеты; новый shell-generated «continue» ход рискует повторить эффекты и сбросить счётчики. Обе альтернативы отвергнуты как основной механизм. Read-only feature-analyzer/brainstorm worker: STATUS DONE, evidence в context.md.

Recovery: streaming -> recovering/backoff -> streaming. Terminal: success, cancel, permanent failure, hard policy/resource limit. Короткий retry batch не завершает recoverable ход: после него более редкие пробы. Ограничить частоту, jitter, Retry-After и стоимость; численные defaults определить и документировать в T5. Не обещать удалённое byte-stream continuation.

## Steps

1. T1 context: audit error/EOF, оба shell call sites, retry layers, тесты; определить recovery contract и commit boundaries.
2. T5 implement: typed transport/HTTP/stream/auth classification, безопасная политика 403/refresh, defaults.
3. T2 implement: same-turn supervisor, interruptible backoff, partial text/reasoning/tools, сохранение результатов и лимитов.
4. T6 implement: readline/TUI wiring, status/countdown/cancel, сериализация input/task wakes/session transitions/lease invalidation.
5. T3 test: fake-clock/scripted-provider fault injection, long outage/recovery, partial streams/tools, cancellation/budgets.
6. T4 review: независимая проверка replay/approval/cost/security и evidence по AC.
7. T7 docs: пользовательская политика, permanent ошибки и ограничения.

## Risks

- Дублирование partial output/side effects: не перезапускать весь turn; failed tool batch не исполнять; unknown effect требует reconciliation.
- Truncated EOF без model_end может выглядеть как успех: проверить terminal boundary.
- Retry storm/расходы: единый retry owner, bounded intervals/Retry-After, учёт failed-attempt usage, hard budgets.
- Поздний retry после cancel/session change и гонки input/wakes: AbortSignal и generation guard.
- Generic 403 permanent до подтверждённой классификации; нельзя обещать автоматическое исправление запрещённого доступа.
