# Acceptance Criteria

- AC1: **AC-01**: Обычный файл и внутренняя цепочка читаются одинаково через CLI/MCP/SDK; внешняя цепочка и нечитаемый target дают безопасную ошибку без данных.
- AC2: **AC-02**: Синтетический секрет отсутствует в JSON, текстовом ресурсе и ошибке; safe JSON проходит схему, числовое обязательное поле с секретом не заменяется невалидной строкой.
- AC3: **AC-03**: Запуски с внешним адресом и wildcard не открывают socket; IPv4/IPv6 loopback принимаются; существующие transport-deny для SAC не ослаблены.
- AC4: **AC-05**: Bun/npm fixtures, повреждённый JSON, skipped required и неполная область дают ожидаемый итог; нарушения не теряются, даже если другой check недоступен.
- AC5: **AC-15**: Смешанный corpus safe IDs и настоящих секретов не допускает field-name bypass; URL-секрет маскируется, публичная ссылка не считается сетевой отправкой.
- AC6: **AC-17**: Вложенная папка не даёт EISDIR; цикл symlink не зацикливает обход; inaccessible/limit отражены; найденное нарушение и incomplete видны одновременно.
- AC7: **AC-18**: --help/-h с пустыми credentials ничего не записывают; typo и missing value дают ненулевой exit и пример исправления; валидный вызов сохраняется.
- AC8: Current focused/type/build/health checks and independent review have explicit evidence; prerequisites are satisfied; no required failed/incomplete check is relabeled PASS; partial acceptance is not full phase completion.
