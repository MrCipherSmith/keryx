# PRD — инструментальное ядро Keryx
Version: 0.1.2

Статус: **spec ready**. Технические контракты — **proposed**; их runtime-реализация этим пакетом не подтверждается.

## Проблема и цель

Отдельные локальные инструменты уже работают, но знание может потерять актуальность, основание или оговорку при переходе между интерфейсами. Длинная маршрутизация и лишние чтения повышают стоимость задачи; пустой поиск и неполная проверка могут выглядеть как уверенный результат. Цель — предсказуемые операции над проектом, объяснимые источники и безопасное продолжение длительной работы внешним агентом.

## Пользователи и сценарии

- Разработчик с внешним coding agent: найти правило и точки изменения, выполнить разрешённую работу и проверить результат.
- Следующий агент или член команды: продолжить задачу по компактному handoff без утраты ограничений и без доверия старому PASS на новой версии.
- Владелец знаний: принять версионированное исправление, увидеть зависимые объяснения и управляемо архивировать либо забыть данные.
- Автор автоматизации: соединить чтения через SDK/batch, не передавая все промежуточные данные модели.
- Сопровождающий: проверить установку, optional capabilities и достоверный CI gate независимо от Shell.

## Нормативные требования

Требования `AFC-01..32` фиксируют принятые направления; `AFC-M01..M11` и `AFC-W01..W06` конкретизируют их по последующему исследованию. Все — целевое поведение; описания wire format и алгоритмов остаются предлагаемым техническим решением. Acceptance IDs находятся в [матрице](decision-traceability.md); подробные общие oracle — в [плане проверки](metrics-and-validation.md).

| ID | Область | Требование |
|---|---|---|
| AFC-01 | Безопасное чтение | Core reader проверяет realpath узкого owner-root и конечного файла; разрешает внутренние symlink, отвергает выход наружу и не добавляет внешних roots. |
| AFC-02 | Redaction resources | Tools и resources проходят одну проверку выдачи: безопасная часть с признаком redacted, либо ошибка, если формат/схему нельзя сохранить. |
| AFC-03 | Локальный MCP HTTP | Non-loopback bind отклоняется до listener, IPv4/IPv6 loopback поддержаны; новые remote-возможности не добавляются. |
| AFC-04 | Полное обновление зависимостей | Будущая модернизация охватывает всё дерево, включая major, dev и optional, с проверкой совместимости и объяснением оставшихся рисков. |
| AFC-05 | Достоверный gate | PASS требует всех required проверок, успешного выполнения и разбора; FAIL и INCOMPLETE блокируют strict CI. Optional skip показан. |
| AFC-06 | Lifecycle retrieval | По умолчанию accepted с наступившим validFrom, неистёкшим validTo и без действующей замены; stale/unknown показаны справочно с сохранёнными authority metadata, без применения как подтверждённых текущих ограничений. |
| AFC-07 | Полнотекстовый baseline | Wiki ищет локально в разделах Markdown; источники/версии/бюджет обязательны, слабый сигнал даёт insufficient-evidence; embeddings не нужны. |
| AFC-08 | Generated wiki | Явный sync меняет только managed blocks, независимо от статуса страницы, проверяя producer/source/base digest и ручные конфликты. |
| AFC-09 | Testing snapshot | Discovery ограничен текущим checkout, исключает реальные вложенные worktrees и производные каталоги; валидный cache переиспользуется, изменённый обновляется. |
| AFC-10 | Graph snapshot | Graph хранит checkout/revision/config/content fingerprint; refresh по необходимости атомарно публикует целостный snapshot; freshness и coverage независимы. |
| AFC-11 | Типы связей | Runtime-static, type-only, dynamic, unknown раздельны; load-order cycles только из подтверждённых runtime-static, impact сохраняет type-only. |
| AFC-12 | Repomap | Dependency/impact/balanced имеют объяснимый выбор; для изменения default impact; score-zero не заполняет бюджет; обязательные seeds защищены. |
| AFC-13 | Symbols capability | Парсеры optional, явная установка нужных языков с проверкой версий/checksum; available/partial/unavailable, query ничего не скачивает. |
| AFC-14 | Ctx сохранность | Стратегия по формату, вопросу и бюджету; критичные поля сохраняются, раскрытие адресуемо, delta только от известного consumer snapshot. |
| AFC-15 | Структурное маскирование | Детерминированные локальные детекторы учитывают поле/контекст; безопасные метрики/ID не PII автоматически; URL отдельно от фактического egress. |
| AFC-16 | Удобный агентный контракт | Короткий вход, operation-specific help и общий envelope; узкая задача не требует обходить все слои; deterministic composition переиспользует core. |
| AFC-17 | Security scan | File и recursive directory scan с внутренними symlink, явными исключениями/лимитами, per-file coverage и итогом required gate. |
| AFC-18 | Shell CLI parser | Help завершает без session/provider/files; неизвестные, неполные и несовместимые флаги отвергаются до инициализации. |
| AFC-19 | Отдельный Shell | Модельный Shell — необязательный клиент публичного core; установка/работа core не тянут model runtime/credentials. |
| AFC-20 | Границы модулей | Core не импортирует CLI/MCP/client; coordination вызывает owners; utilities независимы; wiki parsing/types разрывают цикл collect/provenance/describes. |
| AFC-21 | Единый lifecycle | Init/update используют один план managed writes/hooks с preview, conflict и resumable partial report; пользовательские правки сохраняются. |
| AFC-22 | Freshness стоимость | Пакетные Git queries, cache внутри запуска и bounded concurrency учитывают dirty checkout; persistent cache только по измерению. |
| AFC-23 | Доказательство пользы | Сравнивать plain search, graph, wiki/memory, ctx и сочетания на нескольких repo; успех/полная стоимость/обслуживание; слабость ведёт к улучшению. |
| AFC-24 | Продуктовый фокус | Приоритет — длительные задачи внешних агентов и handoff; собственные проекты затем добровольные внешние пилоты. |
| AFC-25 | Тип и полномочия знания | Тип assertion, автор, exact source fragment/version, confirming participant, scope, условия/ограничения и acceptance basis сохраняются при search/compress/handoff; authority только trusted invocation. |
| AFC-26 | Граф оснований | Явные based-on/describes/verified-by/supersedes связи Markdown индексируются; изменение основания даёт needs-review с путём и альтернативами. |
| AFC-27 | Атомарные изменения | SAC proposal/revision + expectedVersion атомарно проверяются вместе с публикацией связанных записей; retries идемпотентны. |
| AFC-28 | Перенос задачи | SAC handoff переносит цель, ограничения/разрешения, решения, проверки, вопросы и источники/snapshot; resume показывает drift. |
| AFC-29 | Забывание | Archive/supersede/forget раздельны; forget по явному запросу/политике очищает known managed derivatives, preview и residual verification обязательны. |
| AFC-30 | Манифест потерь | Включённые/опущенные диапазоны, версии, причины и продолжение ограничены общим бюджетом; история consumer opt-in; denied не раскрывает IDs. |
| AFC-31 | Регрессии знаний | Deterministic cases lifecycle/authority/conflict/основания/concurrency/handoff/forget/compression и внешняя оценка разделены. |
| AFC-32 | SDK и batch | Тонкий SDK/batch вызывает те же операции; scoped/versioned/expiring handles, DAG, per-step status; начать с чтения. |
| AFC-M01 | Все writers короткого gate | Init/update/rules sync/distill используют общий writer index/routing с флагами модулей и сохранением правил; consumers читают правильный файл. |
| AFC-M02 | Доставка указателей | Delivery identity session/root/revision/contextEpoch предотвращает дубликаты; смена scope/утрата контекста передаёт необходимые ограничения снова. |
| AFC-M03 | Дешёвая неудача | Target-not-indexed, incomplete-index, no-match и insufficient-evidence различимы; короткая причина/разрешённое продолжение без циклического routing. |
| AFC-M04 | Описание к влиянию | Расширять gdgraph find по name/path/symbol, добавлять wiki sections→code→bounded affected через coordination, без нового поискового engine. |
| AFC-M05 | Польза ctx wrapper | Сравнивать равнозначные plain/ctx запросы по найденной информации, критичным строкам, overhead, latency и дальнейшим чтениям. |
| AFC-M06 | Нейтральный внешний runner | Переиспользовать только проверенные guards/contracts, сохранив private evidence отдельно; provider и API adapter принадлежат внешнему испытателю. |
| AFC-M07 | Валидность эксперимента | Parent-only standalone checkout, симметричные условия, graph query/inventory, отсутствие answer/remotes/operator memory; resume уникален и crash-safe. |
| AFC-M08 | Протокол до испытания | Новый non-inferiority+cost protocol, допуск качества, порядок arms/repeats/stopping определены заранее; прошлый threshold failure не переименовывается. |
| AFC-M09 | Корректная стоимость | Input/cache-create/cache-read/output, turns/tool calls, requested/resolved model, setup/maintenance и unknown отдельно; события дедуплицируются. |
| AFC-M10 | Независимые scripts fixes | Отдельно исправить неработающие caps, отсутствующий resolver stress JSON, optional containment port; покрыть scripts typecheck. |
| AFC-M11 | Честные заявления | README/docs связывают сравнительные обещания с разрешённой evidence, версиями и сценарием; ambition не превращается в measured superiority. |
| AFC-W01 | Поиск секций | Section index включает содержательную прозу, точные identifiers и явные scoped aliases; изменение/удаление обновляют адреса и индекс. |
| AFC-W02 | Содержательная wiki | Шаблоны scenario/rule/decision/change-guide содержат вход/выход, шаги, инварианты, ошибки, альтернативы и code/test evidence; scaffold обозначен. |
| AFC-W03 | Секция к коду и тесту | Section bindings сохраняют owner target/version/qualification и обратный impact; graph-derived candidate не подтверждённое правило. |
| AFC-W04 | Компактные доказательства | Evidence package содержит fragment, section/version, provenance/authority limits, caveats, links и continuation в общем бюджете. |
| AFC-W05 | Поддержка по основаниям | Изменения code/test/decision дают адресный needs-review с reason/diff; Reference sync отдельно; prose меняется только proposal/CAS. |
| AFC-W06 | Вклад wiki отдельно | Plain/graph/substantive-wiki/combined на одном parent snapshot, routing/ctx фиксированы; why/rules/patch/handoff/stale/conflict/no-answer задачи. |

## Успех, риски и рекомендация

Успех определяется правильным завершением целевой задачи и достоверностью ограничений, затем полной стоимостью и числом повторных действий. До измерения не утверждаются универсальная экономия, latency SLO или размер обязательного gate. Качественные invariants (не потерять concurrent write, не превратить гипотезу в permission, не скрыть required skip) проверяются строго; качество retrieval и удобство калибруются на корпусе до испытания.

Основные риски: смешение historical evidence с текущим runtime; копирование client/provider зависимостей в core; новый дублирующий слой вместо существующих owners; многозаписная публикация без crash recovery; сжатие, теряющее смысловые условия; приватные данные в публичном runner; переобучение ranking на удобной подвыборке. Меры закреплены в [политиках](policies.md), [lifecycle](artifact-lifecycle.md) и [измерениях](metrics-and-validation.md).

Рекомендуется сначала закрыть конкретные lifecycle/scripts дефекты и trust invariants, затем section retrieval и достаточную выдачу, после — versioned writes/handoff и batch. Shell выделяется постепенно после появления проверенных public seams. Зависимости обновляются отдельными проверяемыми группами. Внешние испытания и пилоты требуют самостоятельного разрешения на их исполнение; этот пакет готовит сценарии и gates.
