# Спецификация содержательной wiki
Version: 0.1.2

Статус: **spec ready**. Технические контракты — **proposed**; их runtime-реализация этим пакетом не подтверждается.

## 1. Назначение и статус

**Spec ready, предлагаемая реализация AFC-W01..W06 и AFC-06..08/22/25..27.** Wiki объясняет сценарии, правила, причины решений и безопасные точки изменения; graph отвечает за структурные связи. Достаточное число страниц не доказывает наличие нужного объяснения. Пустая generated map и проверенное описание сценария — разные классы содержимого.

Используются существующие Markdown pages, `describes`, Reference writer, freshness и SAC. Section index — производная проекция существующей wiki, не второй источник знаний. Ранжирование и проверка структуры локальны и детерминированы. Человек или внешний агент пишет смысловую прозу; Keryx не выбирает модель, не придумывает причины и не принимает выводы автоматически.

## 2. W01 — единица поиска и стабильный адрес

Предлагаемая единица — `WikiSection`: owner page ID, stable section ID, title, domain, language, body range, pageVersion, section content digest, lifecycle/freshness и evidence links. Stable ID создаётся при явном authoring/migration и хранится в Markdown marker. Пример предлагаемой разметки:

```markdown
<!-- keryx:section id="rule-retry" -->
## Повтор после конфликта

Перечитайте запись и подготовьте правку заново.
<!-- /keryx:section -->
```

ID не выводится только из heading: одинаковые заголовки разных страниц/доменов не должны сталкиваться; rename heading сохраняет ID. Дубликат ID внутри owner namespace — validation error. Удаление оставляет missing binding/tombstone без автоматического redirect на одноимённый раздел. Для legacy page до миграции допускается provisional locator `pageVersion + heading occurrence + range` с `stability=version-bound`; его нельзя обещать неизменным после правки. Явная миграция вставляет markers по preview и CAS, обычный search Markdown не изменяет.

Индекс включает основной текст (Details, Main flows, Constraints и произвольные содержательные секции), page/section title, точные identifiers, logical paths и explicit aliases. Code fences доступны для точного поиска, но их executable пример не становится принятой инструкцией. Boilerplate, пустые placeholders и Reference-only sections получают `contentClass=scaffold/reference`; они не удовлетворяют запросу «почему» по одному совпадению названия.

Индекс привязан к pageVersion/content digest, parser и ranking profile versions. Add/edit/delete/rename секции инвалидируют затронутую часть; query не смешивает старые offsets с новым body. Section paths проверяются owner resolver и containment до индексации/чтения; запрещённые материалы не попадают в candidate statistics клиента.

## 3. W01/M04 — lexical retrieval и понятие → код

Предлагаемый pipeline:

1. Проверить scope, budget, поддерживаемые языки/режим, lifecycle и доступные snapshot. Выбрать `accepted/current` по общей политике.
2. Разделить точные identifiers и обычные слова, сохранить пунктуацию значимых символов/путей; язык нормализации записать в diagnostic profile.
3. Получить candidates по section full text и точным term/alias matches. BM25 — предлагаемый baseline, конкретные weights задаются corpus calibration. Alias — явные versioned данные `(domain, language, alias, canonicalTerm, sourceRef)`; не скрытая LLM-генерация.
4. Различать одинаковые термины разных доменов. Domain filter явный; без него вернуть несколько размеченных candidates либо попросить сузить, а не смешать правила.
5. Повторно проверить status/dates/supersession/freshness, собрать обязательные caveats и противоречащие источники; ранжировать с reason без вероятностных обещаний.
6. При запросе точек изменения использовать подтверждённые section bindings как seeds в существующем `gdgraph find/affected`. Не добавлять весь граф и не превращать graph-derived candidates в подтверждённые business rules.
7. Собрать evidence в общем envelope и budget. Нерелевантный запрос → `no-match`; фрагменты есть, но основания/оговорки не позволяют ответ → `insufficient-evidence`. Next action ограничен конкретным domain/term/source, без повторного mandatory tour всех слоёв.

RU/EN проверяются отдельно: exact identifiers, доменные алиасы, перефразирование, однозначные и неоднозначные переводы. Lexical baseline не обещает свободный межъязыковой recall. Optional rerank — будущий внешний/локальный deterministic adapter только после измеренных ошибок; candidate retrieval и policy gates он не заменяет. Core не получает model config.

## 4. W02 — шаблоны объяснений

| Тип | Обязательное содержание | Проверочный вопрос |
|---|---|---|
| Scenario | Trigger, inputs/preconditions, результат, последовательность, side effects, исключения/ошибки, code/test refs | Как проходит операция и что остаётся после сбоя? |
| Rule | Scope, правило, условия применимости, исключения, authority/acceptance basis, enforcement refs | Какое правило действует именно в этой ситуации? |
| Decision | Проблема, выбранный вариант, отклонённые альтернативы и известные причины, последствия, ограничения, supersession | Почему выбран подход и когда решение перестаёт действовать? |
| Change guide | Поведение до/после, owner/boundary, точки изменения, consumers/tests, invariants, rollback/compatibility | Где безопасно менять поведение и что проверить? |

Неизвестная причина явно `unknown`, а не реконструкция намерений автора из кода. Секция может быть draft, даже когда соседняя Reference корректно сгенерирована. Canonical acceptance остаётся у page/owner lifecycle; section readiness не выдаёт более высокий status, чем её источник. Создатель предлагает содержимое через существующий proposal, reviewer проверяет основания и право принятия по действующей политике. Самопринятие или обязательный новый human approval не вводятся этим шаблоном: применяется текущий authorization/review contract.

Начальный corpus выбирается по частоте и критичности задач, не по желанию заполнить все каталоги. До написания страницы фиксируются вопросы, которые она должна закрыть, и evidence. Страница не может содержать ответ из будущего gold текущего benchmark. Для каждого вопроса различаются `covered`, `partial`, `unknown`, `not-applicable` с основанием; количество заполненных headings не заменяет проверку ответа.

## 5. W03/26 — связи секций и граф оснований

Предлагаемый `EvidenceLink`: relation (`describes`, `based-on`, `verified-by`, `supersedes`), owner target ref, targetVersion/digest, source section ref, qualification (`confirmed`, `proposed`, `broken`, `unknown`), origin/provenance. Подтверждение означает проверенную связь, не автоматическое доказательство всей прозы.

| Основание | Проверка и drift |
|---|---|
| Файл | Owner path + version/digest; rename может предложить remap по доказанной Git identity, но не молча поменять canonical link |
| Символ | Qualified identity + defining file + snapshot + signature, если слой доступен; отсутствие symbols → unknown/file fallback с ограничением |
| Тест/отчёт | Test identity, версия теста и проверяемого source, outcome, runner scope; старый PASS не подтверждает новую версию |
| Решение/требование | Owner ID, version, accepted/current и ограничения; superseding link сохраняет историю |

Индекс строит reverse dependencies по явным links. Изменение основания возвращает affected sections, dependency path, changed source/version, qualification и альтернативные независимые основания. Алгоритм использует visited set для cycles, bounded output и loss manifest; цикл основания сам по себе не превращает все записи в ложные. Учитываются только известные связи, `completeness` не обещает полный семантический impact.

Предлагаемый приоритет review — важность выбранного сценария, тип изменения, число известных зависимых секций и неизвестность проверки. Это порядок обработки backlog, не фильтр исчезновения остальных findings. `supersedes` не удаляет старую запись; invalid link даёт отдельный finding, не automatic accept новой.

## 6. W04 — пакет доказательств вместо всего manual

Контракт [wiki-evidence.schema.json](schemas/wiki-evidence.schema.json) и [пример](examples/wiki-evidence.json) встроены в [общую оболочку](specification.md). Evidence содержит section identity/version, excerpt/range, contentClass, lifecycle, freshness, claimType/provenance, обязательные caveats, code/test links и адрес continuation.

Фрагмент, действующая оговорка и исключение образуют неделимый `evidence item`. Если текст говорит «обновление согласовано», linked caveat «реализация отложена» обязателен независимо от ranking. Нельзя вернуть первую часть как current instruction. Отсутствующий caveat source даёт insufficient-evidence. Если unit не помещается, `budget-exceeded` и безопасное предложение увеличить бюджет/сузить query. Частичное раскрытие необязательных explanatory details допустимо с loss manifest.

Противоречащие источники не склеиваются в одно уверенное резюме: возвращаются отдельные items с `conflictRefs` и source versions. Stale accepted показывается справочно с reason; unknown — «не проверено». Draft/history доступны явно, не как confirmed constraints. Continuation закреплён за sourceVersion; изменение source между search и expand даёт conflict/new snapshot, а не старую цитату с новым номером версии.

Минимальный ответ не обязан включать большое повторяемое описание схемы: оно доступно через describe. Полный budget учитывает сами provenance/caveats/manifest. Недоступные источники не раскрывают private IDs, headings, paths и точные counts; metadata о доступе не является обходом content policy.

## 7. W05/08/22 — обновление без переписывания смысла

Generated Reference хранит producer/version, source fingerprint, generated block digest и последний owner base. Explicit sync пересчитывает только managed blocks, независимо от accepted/draft. Source graph/testing/health должен иметь известные freshness/coverage; запуск генератора не делает устаревшие входы fresh. При одинаковом входе bytes неизменны; observation time не создаёт бессодержательный churn. Авторская проза побайтно сохраняется.

Если текущий block digest не равен last-generated, sync возвращает conflict и preview: сохранить правку в author section либо явное восстановление machine block. Ошибка source сохраняет старый block и видимый stale/unknown result. `Describes: none` требует причины и не освобождает generated data от проверки его собственного producer source.

Затронутые зависимые prose sections после изменения основания получают производный `needs-review` с минимальным source diff и dependency path; canonical принятие не стирается и false не присваивается. Refresh проверяет группы одинаковых base revisions пакетно и кеширует Git результаты внутри запуска, учитывая dirty/untracked checkout. Per-page reference oracle сверяется на 50/500/2000 страницах; постоянный cache не вводится без отдельного измеренного основания.

Исправление прозы — новый SAC proposal/revision с expectedVersion страницы и версиями всех затронутых записей. Preview связывает rendered bytes и evidence; apply выполняет atomic CAS по [lifecycle](artifact-lifecycle.md). Два параллельных редактора одной страницы не могут оба принять полную замену от одной базы. Внешние редакторы, обходящие Keryx, обнаруживаются digest check; полная транзакционная защита от таких bypass writers не обещается.

## 8. Миграция и W06 acceptance

1. Inventory existing pages: owner/status, stable/provisional sections, authored/generated boundaries, links и source versions. Неполные/некорректные metadata не исправлять догадками.
2. Построить section index рядом с текущей retrieval path, сравнить на локальных fixtures; не менять prose при чтении.
3. Explicit preview мигрирует только stable IDs и managed metadata с сохранением контента/CAS. Legacy references остаются version-bound до обновления.
4. Перевести wiki search adapters на evidence envelope с compatibility mapping; оставить старую выдачу на объявленный период как thin projection, без второй retrieval реализации.
5. Включить reverse bindings/needs-review и общий sync; затем source-owner proposal edits. В каждой фазе acceptance старого corpus сохраняется.

AC-W01: term в deep section, duplicate headings/domains, edit/delete/rename и RU/EN. AC-W02: why/rule/scenario fixture с unknown reason и scaffold. AC-W03: confirmed/proposed/broken binding, missing symbols и same-name rename. AC-W04: budget + обязательная оговорка + conflict/stale/history + versioned expand. AC-W05: изменённый source, незатронутая страница, ручной block conflict, concurrent prose write и Git error. Точные нормативы также в [матрице](decision-traceability.md).

AC-W06 оценивается отдельно от routing/ctx: plain search, graph, substantive wiki, graph+wiki при одинаковом parent snapshot и окружении. Задачи why/rules/impact/safe patch/handoff плюс stale/conflict/boilerplate/no-answer. Диагностика различает: нет страницы → page exists but no content → retrieval miss → evidence delivered → evidence used incorrectly. Отчёт учитывает истинность ответа/ссылки, patch checks, stale reuse, дальнейшие чтения, setup/maintenance. Отсутствие пользы в историческом file-retrieval опыте не доказывает бесполезность wiki. [Протокол испытаний](metrics-and-validation.md) задаётся до запуска, новые model calls этим пакетом не разрешены.
