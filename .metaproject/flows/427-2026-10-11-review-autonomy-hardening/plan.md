# Implementation Plan

Status: approved by operator
Model: openai-codex/gpt-6.1-sol

## Approach
Test-first, минимальные изменения существующих компонентов. Worktree /home/altsay/keryx/.worktrees/review-autonomy-hardening, branch fix/review-autonomy-hardening, baseline 00879558256cef065f5e22fb0df66d227253a180.
Неатрибутированное покрытие не принимается. Широкая переработка runner и реальные model E2E отвергнуты как расширение scope и нарушение запрета запускать прогоны.

## Steps
1. Baseline и RED regression evidence для восьми сценариев.
2. Coverage конкретного dispatch и manifest/content identity retry-state.
3. Denial memory до auto-approval и общие safety floors.
4. Общий parser и needs_context независимо от DONE.
5. Arbiter cache current options и recursive content watchdog.
6. Профильные tests/typecheck, deterministic lifecycle fixture, независимая проверка diff. CI после разрешённой публикации; локальные RED checks без model calls.

## Execution tracking
- [ ] Baseline и восемь RED reproductions
- [ ] Coverage/retry identity
- [ ] Safety
- [ ] Parser/context
- [ ] Arbiter/watchdog
- [ ] Verification и change report

## Risks
- Legacy результаты без identity не должны давать достоверное coverage.
- Основной checkout грязный, не изменять его файлы.
- Graph не содержит новых review-файлов; wiki freshness unknown. Использовать текущий код worktree и воспроизводимые tests.
