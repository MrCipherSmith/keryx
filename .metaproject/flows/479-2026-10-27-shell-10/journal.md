# Flow Journal

- 2026-10-27T10:53:36.252Z - flow created

- Подготовлены scope, альтернативы, state × event matrix и AC1–AC6. Причина: срез вопроса до 72 символов в TUI host. AC ещё не подтверждены; продуктовый код не менялся, тесты реализации не запускались.
- 2026-10-27T10:59:26.285Z - task-done: T1: Collect remaining context
- 2026-10-27T10:59:26.504Z - task-added: T5: Live shell: высота, прокрутка, resize, ответ; evidence AC6
- 2026-10-27T10:59:26.713Z - frozen: 6 criteria; checksum recorded
- 2026-10-27T10:59:26.916Z - started
- 2026-10-27T11:45:42.091Z - task-attempt: T2: started (attempt 1) — 479-T2 implementation and regression tests

- Реализованы полное тело вопроса, переносы по ширине, область до 10 строк, прокрутка клавиатурой/мышью, перерасчёт при resize и освобождение ресурсов. Добавлены регрессионные тесты.
- Повторная проверка перед PR: 62 pass / 0 fail (`bun test src/tui/composer-choice.test.ts src/tui/ask-user-bridge.test.ts src/tui/ask-user-race.test.ts src/tui/ask-user-transcript.test.ts`); `bun run typecheck` и scoped eslint завершились с кодом 0. Полный AC4 пока не подтверждён: предыдущий запуск operator-confirm-tools был ограничен агентской средой.
- По решению оператора живая приёмка AC6 выполняется ПОСЛЕ мерджа в main и релиза. Это перенос этапа проверки, не успешная приёмка: AC6 и T5 остаются открытыми, критерии не меняются. Оператор поручил создать PR, дождаться зелёных проверок, провести ревью и слить готовый PR в main.
- 2026-10-29T07:49:13.501Z - decision d-mvt8sidl-9495e0 [in-progress, ordinary]: chose switch; followed the recommendation
