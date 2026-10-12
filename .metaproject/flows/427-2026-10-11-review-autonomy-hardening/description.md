# Надёжность и безопасность автономного review

Status: approved for implementation
Model: openai-codex/gpt-6.1-sol

## Problem
Аудит до PR #974 выявил восемь дефектов: ложное покрытие ledger, stale retry-state, обход denial memory, разные safety floors, несовместимые parsers, starvation needs_context, неверные cached option IDs и неучтённый вложенный прогресс watchdog.

## Expected Outcome
Восемь сценариев подтверждены regression-тестами и исправлены. Покрытие, safety boundaries, parser, retries и completion согласованы.

## Outcome criteria
- Все regressions и профильные tests проходят, deterministic fixture проверяет согласованность компонентов без вызовов модели.
- CI результаты отделены от локальных; Flow закрывается только с подтверждением MrCipherSmith.

## Out of Scope
Vantage review, реальные review-прогоны, dispatch-wave, релиз, merge и публикация без отдельного разрешения.
