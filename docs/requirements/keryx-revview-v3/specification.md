# Спецификация Keryx Review V3
Version: 0.3.1

Статус: spec ready, D1–D7 приняты; всё целевое поведение ниже planned, кроме явно названного baseline в evidence-and-decisions.md.

## Идентичность и состав

Владелец процесса — существующий skill review-orchestrator в главной сессии. Оркестрация не передаёт целиком ревью одному ребёнку. General — роль экземпляра сущности review-coordinator, worker — роль исполнителя. Skill, definition, task и runtime независимы.

| Принятая сущность | Результат | Делегирование |
|---|---|---|
| review-scout | Карта изменений, сценариев и рисков | Нет |
| review-coordinator | План области, assignments, сводка покрытия с leaf evidence | Только разрешённые leaf entities |
| review-worker | Проверка по reviewer skill и заданным slices | Нет |
| review-validator | Независимый verdict по находкам | Нет |

Существующие 12 сущностей остаются в каталоге. Координатор может использовать существующего leaf-агента только если его инструменты/права совместимы с read-only review contract. Число типов не ограничивает число экземпляров.

## Изменения модели определений

Расширить src/agents/types.ts, schema.ts, compile.ts и существующую каноническую schema согласованно; не вводить второй реестр. Предлагаемые поля: execution_kind (worker/orchestrator), tool_scope (static/parent), delegation (allowed_entities и ограничения). У старых определений defaults: worker/static/no delegation. parent tool scope разрешён только для orchestrator и при host authority. Имя сущности передаётся в spawn и разрешается каталогом до запуска. Unknown entity/invalid override — явная ошибка без запуска. Каждое задание выбирает skill из разрешённого оператором/project review roster и разрешений сущности. Host до spawn разрешает точный skill reference/version и проверяет tools, read-only policy, output contract и delegating capability. Неизвестный или несовместимый skill блокирует запуск; generic worker не служит обходом allowlist.

Принята schema v2 с чтением v1 и прежними leaf defaults, без автоматической перезаписи 12 legacy definitions. Точные wire-названия и JSON Schema расширения детализируются на этапе P1; этот пакет задаёт логические контракты, а не новый JSON API. Текущую schema_version=1 нельзя молча заставить принимать несовместимый формат; экспорт v2 в несовместимый harness сообщает unsupported. Compile/export показывает enforced/advisory/unsupported для каждого ограничения; декларация tools не считается enforcement.

## Хранилище и контракты данных

Использовать существующий review package. Предлагаемые дочерние области хранения: plan, assignments, runs, events, coverage; точные файлы закрепить вместе с persistence schema в P1. Существующие slices/raw/drivers и ingest остаются источниками результатов. Каждый dispatch получает уникальный ID, чтобы два солдата с одним reviewer skill не перезаписывали файл.

Логические записи:

- ReviewPlan: revision/base/head, plan version/hash, scope units, risk ranking, обязательные аспекты, владельцы, межобластные проверки, зависимости, estimates.
- Assignment: task ID, parent/run IDs, entity, skill refs, scope/slice IDs, expected output, runtime choice, authority reference, budget reservation, attempt и idempotency key.
- Run: actual adapter/model selection, capability snapshot, state, cancellation lineage, timestamps, usage и result references. Credentials в записи не помещаются.
- Coverage: scope×aspect×revision → assignment → result/blocked/not run; высокий риск требует явного сценарного evidence, а не только отметки чтения файла.
- Result: полный существующий subagent/reviewer result плюс проверенная привязка task/revision/slices; summary генерала — отдельный производный объект, не повторный finding или usage.

## CLI, skills и конфигурация

Существующие review scope/start/slice/ingest/readiness и autonomous runner сохраняются. D2/D7: один Keryx controller владеет durable state, assignments, coverage, budgets, results и cancellation, а adapter исполняет задания. Главный может оставаться во внешнем harness. Принят единый версионированный host API операций capabilities, spawn, status, wait, cancel, result и scoped task update. Его CLI/MCP/tool bindings **планируются**: рабочие команды с такими именами этим пакетом не объявляются.

Конфигурация задаёт выбранный профиль лимитов, разрешённые adapters/entities, модельный tier и capability policy. Приоритет ограничений: operator/host authority → глобальный review run → assignment → entity defaults. Проект и модель могут сужать права; повышение выше operator ceiling требует решения оператора. Эффективная конфигурация сохраняется в run, а не выводится из текста prompt.

### Логическая форма конфигурации (planned)

Это обязательная типизированная форма проекта, а не опубликованный JSON/wire API. Имена ниже концептуальные; сериализация и JSON Schema закрепляются в P1.

| Поле | Тип / default | Правило |
|---|---|---|
| config_version | Положительное целое, начальное 1 | Неизвестная версия отклоняется; config_version независима от agent schema_version=2 |
| profile | Идентификатор, large-review при явном выборе | Legacy остаётся default до пилотной приёмки |
| run_ceilings | Положительные count/time/concurrency/depth ceilings | Значения policies.md; включает total launches=512 |
| role_ceilings | Root/general/leaf limits | Не расширяют run/host ceilings |
| allowed_adapters | Список runtime adapter IDs | Пустой список запрещает external; native требует capability check |
| allowed_entities | Список catalog names | Нет wildcard по умолчанию; explicit review roster |
| allowed_skills | Список разрешённых skill refs | Пересечение operator/project/entity policy; unknown запрещён |
| fallback_policy | refuse / ask / preapproved mapping | По умолчанию ask интерактивно, refuse unattended |
| authority_ceiling | Host-owned policy reference | Не редактируется моделью или проектным prompt |
| cost_mode | measured-cost / cost-unknown, explicit выбор до live пилота | Unknown не означает нулевую стоимость; денежная гарантия не заявляется |
| spending_ceiling | Сумма+валюта для measured-cost | Нужны adapter usage/admission guarantees; иначе blocked или явный cost-unknown |
| reserve_fraction | Число 0..1, default 0.2 | Включено в run agent-time, не добавляется сверху |

Отсутствующие числовые значения наследуются из выбранного профиля и ограничиваются operator ceiling. Неположительные лимиты, неизвестные поля/профили и конфликт роли с entity capability — validation error. Уже начатый run хранит snapshot; изменение конфигурации не сбрасывает used counters. Уменьшение лимита блокирует новые admission сверх остатка, повышение требует operator approval. Изменение authority немедленно применяется к следующим действиям и отзыву leases.

## Интеграции и portability

D3: обязательны Keryx native и Keryx runtime как внешний general. Codex/Claude как управляющие hosts используют общий API; их процессы как generals поддерживаются только после adapter verification. Pi — последующий adapter, вне обязательного первого выпуска. Точные версии определяются проверкой. D4: все участники review-фазы читают исходники без изменений; инструмент доступен лишь для разрешённых review-действий. Исправления — отдельная явно разрешённая фаза.

| Host | Целевой путь | Условие |
|---|---|---|
| Keryx Shell | Native tree scheduler | Реальное наследование live authority и изолированных состояний |
| Hub Session | Тот же scheduler за session authority | Текущие ограничения удалённой сессии сохраняются |
| Codex/Claude/другой управляющий harness | Единый Keryx controller через CLI/MCP/API | Путь первого выпуска; controller владеет ledger и состоянием |
| Harness-native или сторонний process general | Optional adapter после отдельной verification | Не обязательный состав первого выпуска; тот же controller и ledger, capability checks без предположений по имени продукта |
| Harness без nested spawn | Keryx-backed execution через CLI/MCP | Установленный runtime, авторизация, доступ к workspace и мост управления |
| External general | Process adapter + scoped bridge к scheduler | Tool calls детей, cancellation, result и policies реально контролируются |

Skill сам не добавляет tools. Export agent definition сам не создаёт runtime. При несовместимости exact tool parity нельзя объявить fulfilled: показать unavailable capabilities и предложить Keryx-backed путь либо явный degraded flat review. Автоматический переход разрешён лишь заранее заданной fallback policy; иначе вопрос пользователю. Herdr не является зависимостью; Pi/другой CLI не становится managed general из-за запуска процесса.

## Приёмка

Все критерии planned, Verification: judged означает проверку приложенных тестовых/экспериментальных доказательств, а не уже пройденный тест.

- AC1 (R1): подготовка объединяет scout outputs в закреплённый план; изменение head инвалидирует затронутое покрытие. Verification: judged
- AC2 (R2): два генерала и прямой солдат выполняют разные задания; общая граница назначена явно; orphan scope блокирует готовность. Verification: judged
- AC3 (R3): 12 legacy definitions загружаются без миграции; четыре новых разрешаются через тот же каталог; неизвестное имя не запускается. Verification: judged
- AC4 (R4): approval denial у родителя действует на генерала, его детей и external bridge; state одного агента не меняет plan/slate другого. Verification: judged
- AC5 (R5): один fixture проходит native и Keryx-backed adapters; неподдерживаемая глубина и отсутствующая auth дают явный статус до полезной работы. Verification: judged
- AC6 (R6): конкурирующие родители не превышают глобальные caps; ожидание не создаёт deadlock; перезапуск и новый ход не сбрасывают ledger. Verification: judged
- AC7 (R7): отмена родителя останавливает descendants, поздний ответ не завершает отменённое задание; resume не дублирует finished work. Verification: judged
- AC8 (R8): два одинаковых reviewer skill сохраняют разные полные результаты, дедупликация не стирает evidence; summaries/usage не считаются повторно. Verification: judged
- AC9 (R9): child не может закрыть общий review; readiness/premise/publish gates сохраняются, missing replies не превращаются в clean verdict. Verification: judged
- AC10 (R10): benchmark публикует baseline/V3, версии, параметры, качество, стоимость и время; непроверенные адаптеры отмечены unsupported. Verification: judged

Cost-unknown — допустимый operational mode, но он не удовлетворяет AC10 в части стоимости и release benchmark gate. Release-validation cohort использует measured-cost; при отсутствии данных результат not measured и соответствующий gate не пройден.

Детали: [протокол](agent-protocol.md), [политики](policies.md), [проверки](metrics-and-validation.md). Расширяет [agent platform](../keryx-agent-platform-expansion/specification.md) и [multi-agent engine](../keryx-multi-agent-engine/specification.md); интеграция [Hub sessions](../hub-remote-sessions/README.md) не означает, что будущие возможности Hub уже реализованы.

## Реализация и машинные контракты

Фактическая реализация/ограничения описаны в [отчёте реализации](implementation-report.md). Схемы: [config](schemas/review-agents-config.schema.json), [plan](schemas/review-agents-plan.schema.json), [state](schemas/review-agents-state.schema.json). Runtime hand validator дополнительно проверяет семантические связи/authority/fencing; JSON Schema сама по себе не доказывает эти гарантии. Исходные accepted requirements выше сохраняются как целевой контракт, а не blanket claim о паритете всех adapters.
