# Keryx — независимое инструментальное ядро для внешних агентов
Version: 0.1.2

Статус: **spec ready**. Технические контракты — **proposed**; их runtime-реализация этим пакетом не подтверждается.

## Назначение и статус

**Статус: spec ready — требования и спецификации проверены; новые гарантии runtime не заявлены реализованными.** Пакет переводит согласованные направления 01–32 и их уточнения M01–M11/W01–W06 в проверяемые контракты. Главный сценарий — длительная работа внешних агентов над существующим проектом и передача задачи следующему агенту: понять код и правила, выполнить разрешённое действие, сохранить ограничения и проверить основания результата.

Принятое продуктовое направление: Keryx предоставляет детерминированные инструменты; выбор модели, ключи, диалог и интерпретация находятся у внешнего потребителя. Собственный модельный Shell становится отдельным необязательным клиентом того же публичного контракта. Стремление стать лучшим инструментом — цель развития, не утверждение о достигнутом превосходстве.

**Нормативный язык:** «должен» задаёт требование целевого поведения; это не описание текущего runtime. 49 исходных ID сохранены в [матрице решений](decision-traceability.md). Конкретные новые имена операций, JSON-поля, схемы, атомарный протокол хранения и волны поставки имеют статус **предлагаемый технический контракт**. Они подлежат инженерному review до реализации и не расширяют пользовательское разрешение на работу. Пакет самодостаточен: для реализации не требуется доступ к внутренним исследовательским материалам или частным данным.

## Документы

| Документ | Назначение |
|---|---|
| [README](README.md) | Статус и навигация |
| [PRD](prd.md) | Пользователи, цели, нормативные требования, риски |
| [Матрица решений](decision-traceability.md) | Все 49 ID → требования → acceptance → волны |
| [Основная спецификация](specification.md) | Границы ядра, операции, статусы, композиция, concurrency |
| [Спецификация wiki](wiki-specification.md) | W01–W06: содержательные страницы, секции, поиск, связи, обновление |
| [Политики](policies.md) | Контроль доступа, lifecycle, redaction, health и граница Shell |
| [Жизненный цикл артефактов](artifact-lifecycle.md) | Канонические записи, кэши, atomic write, handoff, забывание |
| [Протокол внешнего агента](agent-protocol.md) | Обнаружение, раскрытие, конфликт версий и продолжение |
| [Измерения и acceptance](metrics-and-validation.md) | Сценарии, preregistration, telemetry, независимые gates |
| [План реализации](implementation-plan.md) | Волны, миграция, зависимости, выходные условия |
| [Общие типы](schemas/common.schema.json) | Scope, provenance, версии, freshness, бюджет |
| [Ответ операции](schemas/operation-response.schema.json) | Статусы и машинная оболочка |
| [Wiki evidence](schemas/wiki-evidence.schema.json) | Раздел, оговорки, основания и продолжение |
| [Пакет изменений](schemas/change-set.schema.json) | SAC revision, expectedVersion, связанные записи |
| [Пакет продолжения](schemas/handoff.schema.json) | Цель, ограничения, источники и snapshot |
| [Batch](schemas/batch.schema.json) | DAG операций и адресуемые результаты |
| [Пример wiki evidence](examples/wiki-evidence.json) | Синтетический согласованный пример |
| [Пример ответа](examples/operation-response.json) | Ограниченная выдача с evidence |
| [Пример changeset](examples/change-set.json) | Изменение от известной версии |
| [Пример handoff](examples/handoff.json) | Продолжение без расширения прав |
| [Пример batch](examples/batch.json) | Зависимая композиция чтений |
| [Позитивные и отрицательные cases](examples/validation-cases.json) | Schema mutations и ожидаемые service conflicts |

## Область и границы

Охвачены graph, wiki, memory, ctx, testing, health, security, SAC и lifecycle установки; общие CLI/MCP/SDK и миграция Shell. Существующие source owners сохраняются. SAC хранит proposals/revisions и ссылки на результаты владельцев, Flow владеет рабочим состоянием. Новый универсальный движок знаний, база вместо Markdown и внутренний LLM-планировщик не вводятся.

Пакет не разрешает обновление зависимостей, запуск моделей, изменение исходников, отправку приглашений пилотам или публикацию данных. Семантический поиск и постоянный freshness-кэш не обязательны; их необходимость устанавливается измерением локального baseline. Удаление функций из-за слабого измеренного результата не автоматическое: сначала диагностика и повторная проверка улучшения.

## Проверенное основание и существующие пакеты

Текущая база анализа исходников: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`. Короткий `index.md` и отдельный `routing.md` уже генерируются init/update; `rules sync/distill` ещё возвращают прежний полный индекс. Существующий lexical `gdgraph find`, wiki Reference/freshness, memory lifecycle и SAC не считаются отсутствующими. Их межмодульные гарантии расширяются ниже. Старое измерение поиска файлов выполнено до короткого gate, не отделяло содержательную wiki от других слоёв и не доказывает её бесполезность. Частные результаты здесь не публикуются и не служат текущим acceptance.

| Пакет | Отношение к новому контракту |
|---|---|
| [Memory Reliability](../keryx-memory-reliability/README.md) | Сохраняем pure recall, Markdown и accepted/current; закрываем согласованность wiki retrieval и добавляем основания/забывание |
| [Context Operations](../keryx-context-operations/2026-07-12/README.md) | Переиспользуем композицию и manifest. Предлагаем заменить обязательную запись trace на opt-in, исключить model/provider config из core, оставить mandatory-item overflow ошибкой |
| [Living Wiki + Graph](../keryx-living-wiki-graph/README.md) | Расширяем существующие describes/Reference/provenance до секций и источников graph/testing/health; не строим второй граф |
| [SAC](../shared-agent-context/README.md) | Сохраняем proposals/revisions, owner writers, workspace ссылки и bounded views |
| [SAC promotion integrity](../shared-agent-context-promotion-integrity/README.md) | Переиспользуем immutable preview, receipt, recovery; добавляем атомарный expectedVersion и пакет связанных owner-записей |
| [SAC identity/capabilities](../shared-agent-context-identity-capabilities/README.md) | Не выдаём authority из входного JSON; не включаем remote или ослабление действующей политики |
| [SAC receipts/provenance](../shared-agent-context-receipts-provenance/README.md) | Различаем операционную диагностику и security evidence; расширяем перенос оговорок |
| [SAC collaboration/worktrees](../shared-agent-context-collaboration-worktrees/README.md) | Используем Project/Clone/Checkout и переносимые ссылки; handoff не общий transcript |
| [SAC lifecycle binding](../shared-agent-context-lifecycle-binding/README.md), [Slate](../slate/README.md) | Не дублируем Flow/Session/workspace state; модельная привязка принадлежит клиенту |
| [External Agent Runtime](../keryx-external-agent-runtime/README.md) | Модельное исполнение и vendor adapters — зона миграции клиента; действующие security-ограничения сохраняются |
| [Context loading](../keryx-context-measurement/context-loading.md) | Историческая мотивация короткого входа. Размер prefix не равен денежной стоимости, turns не равны tool calls |
| [Wiki/graph research note](../keryx-wiki-graph-next/README.md) | Гипотезы и история; требования этого пакета точнее, статистика из note не принимается как текущий факт |
| [Roadmap](../roadmap.md) | Пакет отмечен spec ready |

Здесь не меняются нормативы соседних пакетов молча. Замены Context Operations и границы Shell должны сопровождаться их версионированной правкой в волне миграции; до этого действуют текущие гарантии. Ни один новый schema-файл не объявляется уже подключённым к runtime.

## Проверка пакета

Независимые structural/schema/link/coverage проверки пройдены: 49 ID, 6 JSON Schema, 5 согласованных примеров и 18 позитивных/отрицательных случаев. Документационное ревью: PASS, blockers 0, warnings 0. Schema-valid service-negative случаи задают будущие integration-проверки; их runtime здесь не исполнялся.
