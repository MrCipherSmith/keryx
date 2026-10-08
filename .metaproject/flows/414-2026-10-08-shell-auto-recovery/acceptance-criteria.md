# Acceptance Criteria

После freeze изменения только через flow ac update. Подтверждение AC требует evidence.

## Criteria

- AC1: В readline и OpenTUI network/unavailable failure, затем успешный scripted-provider ответ автоматически завершают один исходный prompt без нового ввода и нового logical turn.
- AC2: 429/5xx/recoverable transport failures используют interruptible backoff с jitter, ограниченной частотой и bounded Retry-After. Fake-clock long-outage тест переживает короткую серию retries и продолжает после восстановления. Defaults документированы; короткая серия сама по себе не возвращает ожидание user input.
- AC3: Partial text/reasoning и EOF без подтверждённого terminal marker не считаются успехом. Interrupted output отмечен; continuation не дублирует слепо partial output и не отправляет некорректные reasoning replay artifacts.
- AC4: Tool calls незавершённого/ошибочного attempt не исполняются, даже если arguments получены полностью до обрыва. Выполненный ранее batch не повторяется при сбое следующего round; результаты сохраняются; unknown tool outcome не повторяется автоматически.
- AC5: Stop/cancel/exit и invalidating session switch/rewind/lease loss отменяют stream/backoff без позднего retry; queued input/task wakes не создают параллельный foreground turn. Проверено fake-clock/race тестами.
- AC6: Recovery сохраняет round/tool/subagent/spend limits и approvals, учитывает reported failed-attempt usage и явно отражает unknown usage. Context-overflow retry/credential refresh не создают вложенный неограниченный цикл; hard limits дают явный terminal outcome.
- AC7: Generic HTTP 403, permission/entitlement/policy и invalid_request не повторяются вслепую; supported auth-expiry refresh ограничен и безопасен до output. Временный 403 восстанавливается только по подтверждённой structured provider classification и покрыт fixture, если поддерживается; unknown 403 показывает честную причину/guidance.
- AC8: Оба интерфейса показывают recovering/waiting, попытку/следующую пробу, поддерживают отмену и отзывчивость; во время recovery не публикуют success-looking turn_end. Success/cancel/permanent error/hard-limit outcomes различимы; credentials не раскрываются.
- AC9: Scripted-provider интеграционные тесты через реальные agent/shell IO покрывают recovery до/после output, после tools, long outage, cancellation/budgets без реальной сети; существующие shell/provider/context-overflow regression suites проходят.
- AC10: Документация объясняет recovery и границы permanent 403/unknown tool effects; unattended/print/subagent поведение не изменено без отдельного решения и тестов.
