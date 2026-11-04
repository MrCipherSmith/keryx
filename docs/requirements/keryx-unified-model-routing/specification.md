# Спецификация единого роутинга моделей
Version: 0.1.0

Status: spec ready — весь контракт v2 ниже планируется; существующие механизмы перечислены отдельно.

## 1. Идентичность и исходные данные

Package: keryx-unified-model-routing. Runtime owner: src/harness/routing. Версия конфигурации и протокола решения: 2. Классификатор — адаптер решения, исполнение — существующий ProviderPort; замена provider adapters не требуется.

Исходный анализ текущего checkout от 2026-11-04, навигация gdgraph/gdwiki и проверка исходников:

| Текущий механизм | Наблюдение | Точка интеграции |
|---|---|---|
| [Таблица](../../../src/harness/routing/table.ts) | override/project/user/derived/session | Заменить сборку решений общим resolver |
| [Derived](../../../src/harness/routing/derive-default-table.ts) | Ранг по имени, optional task-cost input | Убрать из активной v2 резолюции |
| [Профили](../../../src/harness/routing/model-profile.ts) | Operator tier hints отдельно от derived ranking | Каталог фактов + отдельное членство в классах |
| [Subagent](../../../src/harness/tool/builtin/spawn-subagent-tool.ts) | model_tier обходит категорию subagents | Рекомендация класса ниже конфигурации |
| [Review](../../../src/commands/review.ts) | Категория переопределяет результат tier | Общий request/decision |
| [Tier](../../../src/gdskills/model-tier.ts) | Относительный к session model ранг | Legacy adapter и task signals |
| [Turn routing](../../../src/tui/routing-classifier-source.ts) | Derived вызывается без task-cost lookup | Общий сервис вне TUI |
| [Inspector](../../../src/tui/routing-inspector.ts) | Preview учитывает task-cost lookup | Вызов того же resolver |
| [Native classifier](../../../src/session/native-classifier.ts) | Ограничивает кандидатов remote scope | Сохранить ограничения и identity bindings |
| [Session routing](../../../src/session/routing.ts) | Отдельный выбор effective candidate | Потреблять canonical decision |
| [Child gates](../../../src/harness/child/model.ts) | Авторизация дочернего provider | Сохранить проверки перед I/O |

Ранее локально выполнены 98 тестов четырёх существующих файлов (table, derive-default-table, spawn-subagent-model-tier, spawn-subagent-codex-tiers): pass. Это baseline legacy, не проверка нового дизайна. Старый [Task Router](../keryx-jev-router/README.md) сохраняется как история; его ограничения single-provider derivation и отдельного tier resolver заменяются этим контрактом только в v2. [Remote sessions](../hub-remote-sessions/README.md) сохраняет собственную границу полномочий.

## 2. Четыре класса

| ID | Порядок | Назначение |
|---|---:|---|
| light | 0 | Классификация, простые проверки, механическая обработка |
| standard | 1 | Ограниченная реализация и обычная документация |
| expert | 2 | Сложная реализация, глубокое review, самостоятельная работа |
| frontier | 3 | Максимально сложные исследования и архитектурные решения |

Astra/Fable → Frontier, Opus/Sol → Expert — примеры предложенного оператором распределения, не проверенные model IDs и не встроенный рейтинг. Seed catalog может предлагать распределение с provenance/version, но не активировать его без выбора оператора. Новая/неизвестная модель остаётся unassigned до назначения; ранжирование по словам имени в v2 запрещено.

Членство — many-to-many: одна модель может обслуживать несколько классов. Это явное операторское заявление; пониженное качество автоматически не доказано и не опровергнуто. Пустой класс допустим как конфигурация, но resolve этого класса блокируется без разрешённого fallback. Capability и класс независимы. Пулы хранят точные providerId/modelId, при необходимости — identity существующего подключения; никакого совпадения только по modelId между провайдерами. В v2 providerId обозначает одно зарегистрированное подключение; несколько аккаунтов/endpoint одного vendor требуют разных зарегистрированных providerId. Alias → actual identity фиксируется в snapshot, resolver не выбирает аккаунт неявно.

## 3. Хранение, схемы и merge

- Проект: routing.config.json.modelRouting; пользователь: auth.json.routingV2 в существующем user config dir. Credentials остаются в текущем credential store и не копируются в routing.
- [routing-config.schema.json](schemas/routing-config.schema.json) описывает одну v2 layer. schemaVersion обязателен; остальные ключи можно опустить для наследования. Project layer действует только после trust approval её валидированного содержимого; она не может расширить родительские permissions.
- Слои: встроенный → user → trusted project → session override. Assignment запуска существует отдельно и помечается происхождением user; tool input агента не может выдать себя за этот источник.
- categories сливаются по ключу категории. classes сливаются по ключу класса, но запись класса целиком атомарна: candidates/fallback/selection не смешиваются между слоями. providers, classifier и execution — атомарные записи. Удаление ключа означает inherit; baseline — явное назначение, останавливающее наследование категории. Пустой candidates означает явный пустой пул.
- Built-in: все четыре пула пусты; selection=priority; cross-class fallback пуст; providers=all-connected, preferSessionProvider=false; execution maxAttempts=3, selectionTimeoutMs=3000, maxEstimatedCostUsd=null, unknownCost=allow; classifier chain пуст, timeoutMs=3000, minConfidence=0.7, onFailure=baseline. Все категории по умолчанию baseline. V2 activation требует явной проверки этих настроек; auto никогда не включается автоматически.
- Возможные overrides задаются теми же атомарными записями; окончательная нормализация заполняет все defaults и вычисляет configDigest. Policy ограничивает, а не участвует в merge.
- Runtime validators дополнительно проверяют unique provider/model внутри пула, allowlist непустой только при соответствующем scope, отсутствие self-class/дубликатов в fallback, отсутствие циклов (fallback никогда не рекурсивен), существование identities и отсутствие секретов в configuration.
- [classification.schema.json](schemas/classification.schema.json) — строгий ответ классификатора.
- [routing-decision.schema.json](schemas/routing-decision.schema.json) — решение, передаваемое исполнителю и preview. Схемы используют JSON Schema Draft-07, совместимый с текущим валидатором репозитория. Поведенческие проверки дополнительно обеспечивают digest, cross-field и budget semantics.

## 4. RoutingRequest и snapshot

RoutingRequest содержит taskId, runId, origin (operator/review/subagent/unattended/native-session), известную taskCategory или unknown, trusted userAssignment, agentSuggestedClass, requirements и baseline. Requirements: tools/vision/structured-output, inputTokensRequired с резервом, outputTokensReserved, trusted minimumClass и budget. Tool registry/task envelope задаёт обязательные требования, классификатор может только добавить более строгие. Пользователь может явно изменить minimumClass как отдельное действие до запуска; выбор модели сам по себе его не снимает.

Snapshot содержит нормализованную конфигурацию, каталог кандидатов и фактов, credential availability без значений секретов, policy/capability revisions, provider health/cooldown, cost observations, baseline и время снимка. snapshotDigest строится по каноническому представлению включая эти версии и policy scope; secrets и task text туда не включаются. Для классификации cache key дополнительно содержит защищённый task fingerprint, версию классификатора и контекст требований; cache never widens permissions.

Запущенная попытка использует frozen decision. Изменения config/baseline влияют на новые решения. Preview не делает provider execution; для auto по умолчанию показывает unresolved/needs-classification, а явный classify-preview выполняет ограниченную классификацию и сохраняет её receipt. На том же snapshot и receipt фактический resolve обязан совпасть. Изменение условий перед I/O приводит к новому decision с parentDecisionId и объяснением; устаревший preview не обещается выполнить.

## 5. Алгоритм resolver

1. Определить task category из trusted caller; классификатор не может изменить известную категорию. Для unknown сначала выбрать assignment категории default: если он не auto, исполнять его без классификации. Если default=auto, получить один результат classification/recommendation; его category затем выбирает настройки категории, а modelClass переиспользуется, если там тоже auto. Повторного classifier вызова нет. При отказе использовать default и его явный onFailure.
2. Выбрать assignment: explicit user launch override → trusted project category → user category → built-in baseline. Не пробовать нижний слой, если выбранный assignment оказался недоступен.
3. baseline и model задают одну пару напрямую; class задаёт пул. auto выбирает класс по принятой классификации либо agentSuggestedClass/детерминированным task signals, если caller явно использует такой источник. Порядок внутри auto: trusted task signals с однозначным результатом → валидная agent suggestion → configured classifier → onFailure. Источник всегда записывается. Никакая recommendation не перекрывает шаг 2.
4. Проверить minimumClass: членство выбранной модели хотя бы в одном классе не ниже floor обязательно при наличии floor; иначе minimum-class-unproven. Без floor model/baseline не требуют членства. class ниже floor блокируется; не повышается молча.
5. Взять candidates выбранного класса и разрешённых альтернативных классов. Только явный плоский fallback список; порядок — выбранный класс, затем listed classes. Не читать fallback альтернативных классов.
6. Применить gates к каждой паре: policy/external/network, parent/remote allowed candidates, provider scope, credentials, enabled, availability, capabilities/context, cooldown, budget. Класс и приоритет не могут снять отказ.
7. В первом пуле с допустимыми кандидатами отсортировать: priority по убыванию; при равенстве preferSessionProvider; затем secondary policy (priority: без дополнительной метрики, cost: оценка стоимости, latency: наблюдаемая задержка); затем providerId/modelId лексикографически. Исходный порядок массива не меняет результат. Статистика отсутствует → unknown, при сортировке после known. Перестановка списка не меняет решение.
8. Вернуть selected либо blocked с полной цепочкой исключений. В v2 нет скрытого terminal session fallback; baseline допускается только как assignment/onFailure. Все consumers исполняют именно selection canonical decision.

Hard class floor задаёт task policy, не heuristic имя модели. Для pin/baseline с разрешённым fallbackClass альтернативы проходят тот же floor. Класс selected может отличаться от requested только при разрешённом cross-class fallback; причина class-escalated/class-downgraded сохраняется.

## 6. Конфигурация провайдеров и стоимость

provider scope: all-connected, session-only, allowlist. all-connected означает доступные уже авторизованные подключения; не подключает провайдеры автоматически. session-only отсекает остальные даже у pin, показывая provider-scope-conflict. Allowlist ограничивает и исполнителей, и classifier I/O; дополнительные classifier policy gates могут только сузить scope.

Кандидаты имеют enabled и priority. Catalog refresh обновляет факты/availability, не удаляет назначения и не заменяет operator membership. Факт availability действителен 5 минут от observedAt в v2; TTL проверяется по injected clock snapshot. Живой положительный probe или current authenticated session может подтвердить доступность; offline list/устаревшее наблюдение остаётся unknown. Для unknown необходим ограниченный probe без текста задачи, если adapter его поддерживает; иначе candidate-unverified. Missing required capability не подразумевает поддержку.

Budget: эффективный предел — минимум parent/task/config limits. Оценка = известные input/output prices × input estimate/output reservation; task-cost observations являются вторичным сигналом выбора и не заменяют hard reservation. Unknown цена с числовым лимитом всегда блокируется; unknownCost=allow действует лишь без денежного лимита. Подписка не приравнивается к бесплатной модели; ноль разрешён только как явная подтверждённая accounting policy. Резервирование стоимости атомарное между параллельными дочерними задачами. Все classifier и execution attempts учитываются в общем бюджете; actual usage корректирует резерв, но не допускает oversubscription следующей попытки.

## 7. Классификатор

Плагин адаптирует JEV DecisionPort или model ProviderPort к одному ответу: category, modelClass, confidence, reasonCode, requiredCapabilities. reasonCode — короткое объяснение, не chain-of-thought. Schema reject, низкая confidence, timeout, cancellation и policy denial имеют отдельные причины.

classifier.chain — упорядоченные явные adapterId и optional provider/model. Model adapter требует конкретную пару; JEV adapter использует зарегистрированную service identity и текущую систему credentials. Registration проверяет соответствие adapter/identity; неизвестный adapter блокируется. Отправка текста следует redaction/external policy; разрешение executor не подразумевает разрешение отдельному JEV endpoint.

Нет рекурсии: classifier сам не вызывает routing auto. Не более одного вызова каждого элемента chain, не более трёх элементов; общий deadline 3000 ms по умолчанию, учитывает подготовку. При неуспехе применить явный onFailure (baseline, class или model; auto запрещён), затем обычные gates/fallback. Отмена прекращает цепочку и весь routing, не запускает onFailure. Смена classifier не меняет семантику классов или приоритеты.

## 8. Fallback и lifecycle

Configuration fallback: модель pin/baseline по умолчанию strict; optional fallbackClass разрешает перейти в указанный пул и его явные class alternatives. Class fallback по умолчанию только внутри собственного пула. Переход в любой другой класс требует записи fallbackClasses и соблюдения minimumClass/budget.

Availability fallback разрешён до отправки запроса. Runtime fallback возможен только после подтверждённого terminal отказа до первого видимого токена и до любого tool execution. Учитывать уже понесённые затраты. Timeout с неизвестным remote outcome запрещает автоматическую повторную отправку. После первого токена или tool call — interrupted, ручное/существующее checkpoint recovery, без автоматического replay и склейки ответов разных моделей.

401/403 → исключить credential identity до её изменения; 404 model-not-found → исключить пару до catalog refresh; 429 → уважать Retry-After и пробовать другой допустимый кандидат; 5xx → следующий кандидат без немедленного повтора той же пары. Permission/capability отказ нельзя лечить ослаблением policy. Общий maxAttempts=3 для executor, classifier attempts ограничены отдельно; selection deadline покрывает probes и перебор, а execution timeout остаётся собственностью harness. Cooldown ключуется по фактической identity; общий provider quota блокирует все соответствующие кандидаты. В пределах одного decision пара не исполняется дважды, даже если включена в разные классы.

Полный набор причин: policy-denied, provider-scope-conflict, credentials-missing, auth-failed, model-unavailable, candidate-unverified, capability-missing, context-insufficient, cooldown, budget-exceeded, cost-unknown, minimum-class-unproven, class-below-minimum, empty-class, classifier-failed, config-invalid, attempts-exhausted, cancelled, uncertain-outcome. Человекочитаемые подробности редактируются существующей redaction системой.

## 9. Поверхности и наблюдаемость

Новые planned CLI под существующим keryx routing: classes list/set; explain --request <file> --json; migrate --dry-run; migrate --apply <plan>; migrate --rollback <backup>. Это проект интерфейса, не доступные сейчас команды. Atomic setter использует schema validation, file lock и expected revision, исключая stale writes. Existing routing list/set/unset/profile сохраняются как compatibility surface с явным legacy/v2 режимом, без двойной записи.

/routing: разделы Categories, Classes, Providers, Classifier, Fallback; общий список моделей с провайдером, membership, доступностью и причиной исключения. Добавление в класс не меняет baseline. /model меняет baseline; UI показывает влияние session-only и preferSessionProvider, число pins на других провайдерах, не перезаписывает их.

Decision журнал: decisionId, requestId, parentDecisionId, configDigest, snapshotDigest, assignmentSource, requestedClass, selectedClass, selection, status, exclusions, classifier receipt reference. Существующий attempt журнал связывается по decisionId и хранит actual usage/terminal status, без копирования текста задачи. Для disabled routing фиксируется baseline decision с gates; для external CLI — unmanaged, не фиктивное selected. NativeSession adapter сохраняет advertised candidateId и actual identity mapping; decision не расширяет RoutingAvailability.

## 10. Acceptance criteria

Все пункты — целевые проверки реализации, не уже пройденные тесты.

- AC1 / R1: изменение baseline не меняет идентификаторы/смысл классов; модель может быть в двух пулах; unknown не классифицируется по имени. Verification: judged
- AC2 / R2: category review → expert разрешается без classifier; auto вызывает цепочку только при отсутствии определённой рекомендации. Verification: judged
- AC3 / R3: агент предлагает light при user pin/классе expert — пользовательское назначение сохраняется; trusted project priority одинаков во всех consumers. Verification: judged
- AC4 / R4: два провайдера с одинаковым modelId различаются; all-connected/session-only/allowlist дают ожидаемые пары после смены baseline. Verification: judged
- AC5 / R5: неизвестный context, отсутствующие tools, отозванные credentials и недостаточный общий budget не дают selected; concurrent reservations не превышают бюджет. Verification: judged
- AC6 / R6: JEV и fake model adapter с одинаковым ответом дают одинаковое решение; malformed/timeout/low-confidence используют onFailure; cancellation не отправляет запрос. Verification: judged
- AC7 / R7: сначала same-class; запрещённое понижение не происходит; 429 допускает другой кандидат, uncertain outcome и tool side effect запрещают replay; maxAttempts соблюдается. Verification: judged
- AC8 / R8: одинаковые snapshot+classification receipt → одинаковый preview/execution; изменившаяся policy создаёт новое решение или блокирует I/O. Verification: judged
- AC9 / R9: provider switch сохраняет pins, не меняет in-flight модель и обновляет future snapshots; конфликт scope явно отображается. Verification: judged
- AC10 / R10: общий fixture проходит shell/review/subagent/native/unattended; external adapter без model control сообщает unmanaged. Verification: judged
- AC11 / R11: dry-run не пишет активную конфигурацию; stale plan отклоняется; apply идемпотентен; rollback не меняет выполняющиеся attempts. Verification: judged
- AC12 / R12: каждый отказ имеет reason и provenance, journals не содержат секретов; priority/cost/latency tie-break воспроизводим без сети. Verification: judged
