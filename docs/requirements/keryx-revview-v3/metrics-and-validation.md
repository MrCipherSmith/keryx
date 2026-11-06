# Проверки и измерения
Version: 0.2.0

Статус: spec ready; runtime tests и benchmark ниже запланированы, не выполнены.

## Детерминированная приёмка

| Проверка | Сценарий / отрицательный контроль | Критерии |
|---|---|---|
| Scope | Изменить head после подготовки; потерять boundary owner | AC1, AC2: stale scope не считается covered |
| Catalog | 12 legacy + 4 новых; invalid override и unknown name | AC3: совместимость и fail before spawn |
| Authority | Denied shell/MCP/spawn; подмена parent/run token | AC4: запрет действует на всех descendants |
| Isolation | Два coordinator изменяют свои планы/slates | AC4: нет общей mutable state |
| Adapters | Нет spawn/nesting/auth/cancel; native и bridge fixture | AC5: exact parity только при capabilities |
| Limits | Все 6 генералов ждут детей; одновременные reservations | AC6: нет deadlock/oversubscription |
| Accounting | Crash/reconnect/retry; новый ход/волна; двойной refund | AC6: budget не растёт, counts не исчезают |
| Cancel | Root cancel во время spawn и late result | AC7: нет orphan acceptance |
| Results | Один skill у двух soldiers; truncated summary | AC8: два полных result artifacts и usage once |
| Gates | Missing reply/premise; child пытается complete | AC9: false clean/completion невозможен |

Для scheduler использовать fake clock/provider/adapter и barriers: доказать overlap активных независимых задач, а не только наличие Promise.all. Обязательные adapters первого выпуска: Keryx native и Keryx-as-external-general; проверить управление из внешнего harness через общий API. В measured-cost проверить budget admission, в cost-unknown — явное отсутствие денежной гарантии.

Варианты count/time boundaries проверять непосредственно ниже, на и выше ceiling. Тестировать root, general, leaf отдельно и совместно. Команды новых тестов указываются после появления файлов в P1–P5; не публиковать вымышленные проходящие команды.

## Сравнение скорости и качества

Baseline и V3 получают идентичные head/base, corpus, модели, prompt inputs и доступные evidence. Минимум 10 крупных review fixtures × 3 повтора каждого режима; перемешанный порядок. Отдельно измерять cold/warm контекст и provider throttling. Ground truth — заранее размеченные дефекты плюс независимая проверка новых findings.

Измерения: elapsed до verified report, preparation/queue/active/waiting/validation duration, input/output tokens, стоимость, duplicate reads, recall/precision, coverage gaps, отменённые/неуспешные assignments. Сохранять run configs и adapter versions. Цели из PRD — гипотезы приёмки пилота, не измеренный эффект.

Если скорость выросла при падении recall либо росте стоимости выше порога, результат не считается успехом. При отсутствии live доступа публиковать not measured, сохранив offline результаты; не объявлять profile проверенным нагрузкой.

## Проверка данного пакета

Проверить Version под H1, ссылки README на каждый файл, существование локальных ссылок, Verification у каждого R/AC, release/outcome списки, roadmap version/link, отсутствие runtime claims и согласованность лимитов. Запустить docpack-review на всех файлах. Результаты записать в verification.md. JSON schemas в этом пакете не определены: логические контракты намеренно оставлены до P1 и не выданы за стабильный wire API.

Cost-unknown допускает эксплуатацию с явной неизвестной стоимостью, но не удовлетворяет AC10 и критерию стоимости release benchmark. Release-validation cohort должен использовать measured-cost; при отсутствии данных фиксируется not measured, соответствующий gate не пройден.
