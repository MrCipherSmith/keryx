# Keryx shell: ручной smoke-тест 2026-10-05

Источник: интерактивная проверка оператором в keryx shell. Это журнал
наблюдений, а не подтверждение устранения замечаний.

## Результаты

| Проверка | Результат |
|---|---|
| Интерактивные вопросы | Выбор варианта, собственный ответ и отмена работают. |
| План | Отображение и ожидание явного одобрения проверены. |
| Main queue и Side-1 | Основные действия проверены; наблюдение о последнем сообщении остаётся открытым. |
| Прерывание | Работает; контрольная метка `INTERRUPT-ALPHA` сохранилась. |
| Shell-задачи | Фоновый запуск, чтение вывода и остановка проверены; итоговый статус тестовой задачи `killed`. |
| Подагент | Read-only сравнение документов завершилось; запуск субъективно долгий, время не измерено. |
| Compact и восстановление | После compact и перезапуска через `keryx shell -c` сохранены три контрольных факта. |
| Маршрутизация | Не подтверждена: включена, но метки выбранного маршрута нет. |
| Разрешения | Отказ в подтверждении блокирует `shell_exec`; повторного запуска и обхода отказа не было. Остальные защиты этим тестом не проверялись. |

## Открытые замечания и проверка закрытия

1. **Маршрутизация.** Перед приветствием `/route` показал `on · 0 routed`;
   в ответе метки маршрута не было. По сообщению оператора счётчик не вырос.
   Причина не установлена. Закрытие: тест с конкретным доступным назначением
   категории, без ручной фиксации `/model`, подтверждает выбранную модель и
   рост счётчика; причины пропуска/блокировки явно видны. Не включать внешнюю
   передачу данных автоматически ради прохождения теста.
2. **Последнее сообщение очереди.** Оператор наблюдал сообщение, на которое
   агент не отреагировал. Потеря контекста или ошибка очереди не доказаны.
   Закрытие: воспроизведение и регрессионный тест подтверждают, что последнее
   сообщение FIFO обработано ровно один раз, в том числе на границе конца хода.
3. **Справка неизвестной slash-команды.** Пожелание оператора: показывать
   5–8 доступных команд сразу, остальные — в раскрываемом блоке.
   Закрытие: ручная проверка свёрнутого/раскрытого состояния и тест UI.
4. **Доступность `/tasks`.** В shell оператора команды не было. Закрытие:
   выяснить отличие runtime/документации и обеспечить документированный
   доступ к списку, выводу и остановке задач; проверить в реально запускаемом shell.
5. **Запуск подагента.** Субъективно медленный, причина и длительность неизвестны.
   Закрытие: измерить задержку до видимого статуса и начала работы, устранить
   выявленные лишние ожидания, показывать прогресс запуска; записать замеры.
6. **Токены короткого ответа.** Для `17 × 23` показано `↑22041 ↓5`.
   Вход включает контекст и определения инструментов; cached/uncached в этой
   строке не различаются. Закрытие: измерить состав и стоимость запроса,
   проверить экономию без потери контекста, сделать показатели понятными.

## Implementation evidence — flow 406

Prepared on `fix/406-shell-smoke`: deterministic Russian greeting routing;
explicit fallback/manual-pin notices; shared TUI/readline `/tasks`; eight-line
collapsed help; visible subagent preparation with terminal setup-error status;
shared reported-cache usage formatting.

The queue boundary fix and FIFO/exactly-once regression tests are already in
the branch base (`src/tui/main-queue.test.ts`) and remain covered by CI.
Regression tests cover greeting/fallback, tasks, cache formatting, setup
failures, and help preview/expand/collapse. No local tests or builds were run
(operator requirement); CI is the automated gate. Runtime startup latency,
request cost/composition, and operator convenience still need measurements
and repeated manual evidence. Those acceptance criteria are not marked passed.

## Remote CI follow-up — PR #901

Draft PR: https://github.com/MrCipherSmith/keryx/pull/901. No local tests/builds were run.
Commit `714ef64e4`: the only failing core test was the generated commands-by-task
page missing the `/tasks` row. The page is now synchronized; the next remote CI
result is pending. Manual acceptance and latency/input-load measurements remain open.
