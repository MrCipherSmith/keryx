# Acceptance Criteria

- AC1: **AC-27**: Два процесса от v7: один применяет, другой conflict; независимые targets не конфликтуют; пакет с плохой базой не частично успешен; restart возвращает тот же receipt.
- AC2: **AC-28**: Другой checkout/consumer видит изменённые основания до действия; недоступная проверка unknown; пакет не выдаёт прав и не переиспользует старый test-pass для нового кода.
- AC3: **AC-29**: Тестовое содержимое исчезает из индекса/cache/handles/handoff, tombstone не содержит текст; недоступный store даёт incomplete; внешние копии/Git-history не обещаются стереть.
- AC4: Current focused/type/build/health checks and independent review have explicit evidence; prerequisites are satisfied; no required failed/incomplete check is relabeled PASS; partial acceptance is not full phase completion.
