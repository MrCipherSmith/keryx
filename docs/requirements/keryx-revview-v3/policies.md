# Лимиты и полномочия
Version: 0.2.0

Статус: spec ready. D4/D6 приняты: значения ниже — начальный профиль large-review для проверки, не текущие настройки и не результат нагрузочного теста.

## Термины и область учёта

Review run — один управляемый запуск на закреплённой revision, переживает ходы и reconnect. Round — первичное ревью или delta-проверка после исправлений. Wave — зарегистрированная партия assignments; model round — одно обращение к модели. Эти счётчики независимы. Лимиты count/time/concurrency общие для дерева и adapters, а не выдаются заново каждому генералу.

## Принятый начальный профиль

| Лимит | Значение | Область |
|---|---:|---|
| Активные descendants | 32 | Run, все роли/adapters; root — отдельный управляющий слот |
| Начальная concurrency | 12 | Run, рост до 32 при успешной работе |
| Незавершённые генералы | 6 | Run, включая waiting |
| Активные дети генерала | 8 | General, с учётом свободных глобальных slots |
| Общие фактические descendant launches | 512 | Run: все волны, вне волн, генералы, soldiers и retries |
| Фактические запуски wave | 128 | Все descendants wave, retries и generals включены |
| Запуски без wave | 128 | Run, не сбрасывается новым ходом |
| Зарегистрированные waves | 50 | Run, не на каждого генерала |
| Общий descendant agent-time | 960 минут | Run, active time; waiting не дублирует время детей |
| Elapsed review deadline | 120 минут | Run, с начала preflight, включая ожидания |
| Резерв verification/recovery | 20% = 192 agent-minutes | Внутри 960; ordinary work не тратит резерв |
| Review rounds | 8 | Один change lineage; дальше решение оператора |
| Максимальная глубина | 2 ребра | Root → general → soldier |

Волновые лимиты — подмножества общего потолка 512 запусков за run, а не дополнительные бюджеты. Когда исчерпаны 512, новая волна или ход не разрешают spawn. Значение 512 принято как начальный общий потолок fan-out для проверки. Time/concurrency limits действуют независимо; регистрация wave проверяется по package/plan. Повышение run ceiling требует решения оператора и сохраняется в audit.

| Роль | Elapsed deadline | Model rounds default / max | Hard tool calls | Дочерних запусков |
|---|---:|---:|---:|---:|
| Soldier/scout/validator | 15 минут | 80 / 400 | 400 | 0 |
| General | 45 минут, включая ожидания | 120 / 600 | 800 | 48, включая retries |
| Root | В пределах run deadline | 200 / 800 | 2000 | Только общие run/wave caps |

Model-round ceiling допускает одно дополнительное bounded submit-result обращение, также учитываемое в agent-time/deadline. Tool cap не отменяет возможность записать итог через host-controlled finalization. Root tool cap входит в начальный профиль; перенос счётчиков с turn на run принят D6/D7.

## Admission, scheduling и стоимость

Каждый запуск атомарно проходит authority, depth, entity allowlist, глобальные и локальные count/concurrency/time checks. Count после завершения не возвращается; неиспользованная time reservation возвращается один раз. Runtime учитывает active duration непересекающимися интервалами; general waiting не списывается второй раз. Crash оставляет консервативную reservation до reconciliation, а не бесплатный бюджет.

Ожидающий general освобождает execution slot; резерв времени выдаётся по активным участкам, не целиком на 45 минут ожидания. Scheduler контролирует поток реальных запросов, поэтому может параллелить задания независимо от того, выдал ли главный spawn одним сообщением. Per-provider caps могут быть ниже global cap. После rate limit concurrency данного provider уменьшается вдвое до минимум 1; увеличение после серии успешных запросов задаётся и проверяется реализацией.

Сохранять usage каждого вызова один раз; general aggregate не добавлять поверх children usage. Приняты два режима стоимости: measured-cost — оператор задаёт spending ceiling, runtime учитывает доступные расходы и обеспечивает потолок только если adapter даёт достаточные данные и admission контроль; cost-unknown — стоимость явно unknown, monetary enforcement не заявляется, действуют count/time caps. Недостаточность данных для measured-cost блокирует запуск либо требует явного выбора cost-unknown; автоматического скрытого перехода нет. Конкретный режим и сумма выбираются до live пилота, не блокируя offline разработку. Повышение лимитов никогда не происходит только по просьбе модели.

## Права

General наследует эффективные инструменты и approval policy root в рамках host ceiling. Каждый вызов повторно авторизуется, включая MCP, shell, bridge и spawn. Право использовать инструмент не означает право менять чужое задание или закрывать review: run ownership проверяется отдельно. Общие completion/publish и human decisions остаются root/operator-owned.

Истории, mutable plans, slates и result paths изолированы по agent instance/dispatch внутри run. Shared context immutable/versioned. Все участники review-фазы, включая root и generals, работают с исходниками read-only; запись разрешена в выделенные result artifacts через контролируемый путь. Изменение исходников допускается только в отдельной явно разрешённой фазе исправлений. Текстовая инструкция read-only не считается sandbox enforcement.

External policy определяется пересечением authority родителя и реально обеспечиваемой adapter sandbox. Нельзя обещать exact parity, если harness не умеет ограничивать tools или отменять descendants. Неизвестный capability — unsupported, не разрешение. Доступ к provider credentials отдельный; родитель не копирует свои credentials детям.
