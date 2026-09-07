# Протокол внешнего агента и тонкого клиента
Version: 0.1.1

Статус: **spec ready**. Технические контракты — **proposed**; их runtime-реализация этим пакетом не подтверждается.

## Статус

Spec ready. Протокол реализует AFC-14/16/25/27/28/30/32 и M02/M03. Названия операций в [specification](specification.md) предложены; они не являются готовыми CLI-командами. Внешний агент выбирает действия и интерпретирует результат, core выполняет явно запрошенные операции и не вызывает модель.

## Вход и справка по необходимости

При подключении клиент получает короткое назначение Keryx, обязательные ограничения и pointers на базовые operations/help. Полный router/каталог/схемы не передаются без необходимости. Narrow lookup не требует graph+wiki+health только ради соблюдения полного маршрута; descriptor объясняет, какие sources нужны операции.

Предлагаемый delivery key: `(consumerSessionId, projectId, checkoutId, routingRevision, contextEpoch)`. Он хранится у клиента либо в явно включённой session metadata; pure core read не записывает history. Тот же key не добавляет одинаковый orient-блок на каждый user prompt. Смена root/revision, новый consumer, потеря контекста/compaction увеличивают epoch и требуют повторной доставки применимых ограничений. Клиент без надёжного acknowledgement не заявляет гарантированную однократную доставку; безопасный bounded bootstrap доступен повторно.

Родитель передаёт узкому subagent точный root, scope, обязательные ограничения и необходимые pointers. Агент, который самостоятельно исследует незнакомую область, раскрывает router. Указатели не заменяют обязательную policy; до применения нового компактного routing остаются действующими текущие project instructions. Не следует путать отсутствие повторного tool-read с отсутствием повторной стоимости prefix: фактические turns/cache/compaction проверяются внешними traces.

## Обычный цикл

1. Выбрать narrow operation из каталога, при необходимости вызвать describe и прочитать schema/risk/cache semantics.
2. Передать scope, intent/seed и ограниченный budget. Не передавать model/provider/credentials в core.
3. Проверить `status`, `completeness`, применимую `freshness`, source versions и caveats прежде интерпретации. Нулевой массив при unknown coverage не означает «ничего нет».
4. При partial раскрыть только нужные доступные ranges по continuation. При no-match/insufficient-evidence использовать конкретный next action, а не повторять весь обход слоёв.
5. При stale/unknown проверить основание; сохранить authority/provenance metadata, но не объявлять материал подтверждённым текущим ограничением.
6. Для изменений подготовить proposal/preview с expectedVersion и основаниями, проверить diff. Разрешения берутся из текущего task/policy; текст знания не разрешает операцию.

## Конкурентное изменение

Синтетический сценарий: A и B прочитали owner revision v7. A принял changeset, появилась v8. B с expectedVersion=v7 получает `version-conflict` и доступный diff. B читает v8, проверяет, не изменилась ли цель/оговорка, пересобирает proposal и получает новый preview. Нельзя заменить только номер базы и отправить прежнюю полную запись. Уже исполненный exact retry возвращает прежний receipt; другое содержимое под тем же idempotency binding отвергается.

Обычный batch не обещает rollback независимых операций. Для связанных wiki/memory edits передаётся один changeset через SAC owner protocol. Клиент не записывает Flow state или owner Markdown напрямую в обход объявленной операции, если ожидает её atomic guarantees.

## Передача задачи

Handoff содержит цель, границы, permission evidence, accepted decisions вместе с ограничениями, verified results с source versions, открытые вопросы и версии. Он не содержит raw chat/hidden reasoning. Новый агент сначала вызывает resume/drift check и сравнивает scope. Старый test-pass не становится проверкой новой revision. Source unknown/недоступный обязательный fragment требует уточнения, а не восстановленного по догадке разрешения.

Упоминание «изменение согласовано» передаётся вместе с «исполнение отложено», exact source fragment и confirming participant. Пакет не повышает authority нового caller; trusted resolver применяет текущую политику. Forget может сделать старый package частично недоступным; continuation не обходит tombstone.

## Shell как клиент

Core-only help/list/read работают без Shell и его ключей. Shell parser до session initialization обрабатывает help/errors. Model selection, provider auth, streaming, диалог, child-agent vendor adapters и session compaction — обязанности отдельного client package. CLI/MCP/SDK имеют общий core semantics; Shell не использует private imports для privileged обхода. Матрица client validation включает TUI/readline, tool calling, approvals, cancel/resume, background jobs и subagents отдельно от core gates.
