# Измерения, контракты и критерии проверки
Version: 0.1.2

## Статус и два вида результата

Spec ready — спецификация плана проверки; контракты proposed, реализация и результаты runtime этим статусом не подтверждаются. Все `AC-01..32`, `AC-M01..M11`, `AC-W01..W06` определены в [матрице](decision-traceability.md). Каждая реализующая задача добавляет fixtures с явными inputs/oracle, запускает связанные проверки по project testing context и сохраняет область/version/outcome. Внутренняя строгая проверка контрактов отделена от внешней оценки качества смысла и пользы. В этом docpack модели и benchmark не запускались; статистика исполнения docpack не собирается.

## Детерминированные блокирующие gates

| Контур | Исходное состояние | Действие и oracle |
|---|---|---|
| Security (01–03/15/17) | Временные файлы, internal/external/cyclic symlink, synthetic secrets и safe IDs | Все adapters применяют containment/redaction; JSON валиден; unsafe binding не создаёт listener; per-file coverage не теряется |
| Quality (05/M10) | Bun/npm valid/unknown/malformed output, required skip, отсутствующий script cap | Нельзя получить PASS при incomplete; stub останавливается по реальному лимиту, stress report создаётся, script type error обнаруживается |
| Knowledge (06/25/31) | Accepted decision с оговоркой, author/fragment/confirming participant; draft/conflict/future/superseded | Search→compress→handoff сохраняет exact provenance/оговорку; stale/unknown не использован как current evidence; history явно отделена |
| Snapshot (09–13/22) | Commit/dirty/untracked/rename/config/worktree изменения, отсутствующая grammar | Freshness/coverage независимы; target-not-indexed не successful empty; on-demand cache coherent, никаких неявных downloads |
| Wiki (07/08/26/W01–W05) | Deep section, explicit aliases, conflicting rules, generated block ручной diff | Section retrieval и reverse binding верны; author prose неизменна при sync; caveat mandatory; no-answer честен |
| CAS (27) | Два процесса с одной базой, multi-owner set, injected crash на каждом journal stage | Один writer выигрывает, один conflict; нет mixed committed view через Keryx; exact retry один receipt; orphan recovery не success |
| Handoff/forget (28/29) | Старый snapshot и managed derivatives, недоступный cache, два consumers | Drift виден; scope не расширен; tombstone не содержит удаляемый текст; partial cleanup неполна и данные не resurrect после restart |
| Ctx/batch (14/30/32) | Loss manifest, missing base, expired/wrong-scope handle, failed DAG dependency | Critical fields сохранены; schema+budget валидны; dependency skipped; unrelated step по policy; denied ID не раскрыт |
| Routing/lifecycle (16/21/M01/M02) | Init/update/sync/distill, module flags/user edits, повторные prompts | Pair index/routing устойчив; preview/apply соответствуют; no duplicate bootstrap без потери ограничений |

Файловые/процессные tests используют безопасные временные roots и локальные stubs. Наличие JSON Schema не тестирует OS containment, атомарность и доступ: для них обязательны integration/fault-injection cases. Старые тестовые результаты после смены HEAD не переносятся. Required/optional и threshold policy фиксируются перед gate.

## Schema fixtures и отрицательные случаи

Positive examples в `examples/` должны проходить Draft 2020-12 и service validators, когда последние реализованы. Schema validators компилируют все local refs без сети. Обязательные negative mutations: redacted без reason; unknown freshness без reason; `status=error` без error; `status=ok` с error; missing expectedVersion; replace с null base; section excerpt с невалидными ranges; handoff без provenance/ограничения; batch duplicate IDs/cycle/cross-scope/expired reference.

Синтаксические случаи должны отвергаться схемой, живые версии/полномочия/сравнение scope/DAG — service validator. В частности JSON может быть правильным при `expectedVersion=v7`, когда current=v8: oracle — **service conflict**, а не schema failure. Этот набор предотвращает ложное заявление, что схема сама обеспечивает atomic CAS.

## M06/M07 — независимый runner и preflight

Внешний runner имеет собственный package/repository boundary и владеет model/API adapters. Из исследовательской реализации можно переносить только отдельно проверенные neutral contracts/guards, без private dataset, путей, task hashes, комментариев, агрегатов и raw records. Публичные fixtures синтетические/разрешённые. Полный research cherry-pick запрещён этим планом; экспорт — отдельная reviewable работа.

Перед дорогим запуском preflight проверяет standalone checkout из **parent snapshot**, недоступность answer commit/remotes, manifest task/arm identity, одинаковые tool roster/model/budget/config и отсутствие памяти оператора. Context строится только из parent; wiki не содержит будущего gold/patch solution. Control удаляет только управляемые Keryx hooks, сохраняет внешнюю инфраструктуру симметрично. Isolation manifest фиксирует filesystem/network границы: отсутствие remotes не доказывает полный sandbox.

Inventory до/после фиксирует graph readable schema/snapshot, control query с известным expected shape, build revision/freshness/capability; пустая директория `data/gdgraph` не проходит. Wiki inventory различает accepted substantive/scaffold/reference/draft и retrievable section coverage. SAC/orient включение фиксируется, не выводится из числа файлов. Requested и resolved model должны совпадать с protocol либо run invalid. Неполная подготовка → `INCOMPLETE`, не нулевой recall.

Предлагаемый pair store: immutable arm artifact по `(runId, taskId, repetition, arm, protocolDigest)`, atomic pair manifest после двух проверенных arms. Scorer читает только manifest-complete пары, проверяет единственность ключей и identical task/protocol. Orphan quarantine не получает вес. Resume валидирует каждое поле, не усредняет дубли; same key/different data — conflict. Crash между arm writes → resume → restart снова даёт ровно одну пару. Invalid task не исчезает бесследно: counts/reasons и missingness опубликованы отдельно от scored outcomes.

## M08 — preregistration до нового опыта

Сохранить исходную оценку прошлого протокола неизменной; новый критерий не переименовывает исторический threshold failure в успех. Новая preregistration содержит репозитории/eligible tasks, gold construction, независимые strata, sample/repeats, arm order (randomized или counterbalanced), stop rules, primary/secondary metrics, допустимую non-inferiority margin качества и criterion полной стоимости. Числа выбираются до scored runs по калибровочному corpus, не после outcomes.

Primary содержит все eligible задачи, включая double-zero outcomes. Дополнительные strata выбираются независимо от результатов arms и не заменяют primary выгодной подвыборкой. Операционный threshold не называется тестом статистической значимости; confidence intervals/paired uncertainty показываются отдельно. Неуспешная проверка superiority не доказывает equivalence.

Для file retrieval фиксируются recall = matched/gold, precision = matched/predicted и F1, определения пустых множеств и одинаковый максимум predicted candidates. Возвращение всех файлов не считается продуктовым успехом только из-за recall. Число найденных файлов не заменяет verified task success и patch checks. Новая гипотеза «качество не хуже более чем на ε при меньшей полной стоимости» задаёт единицы ε и границу выигрыша до scored runs; универсальные значения не назначаются этим документом. Отдельно показываются дорогие случаи с приростом и без прироста качества.

Минимальные arm families: plain search/read; graph; содержательная wiki/memory; graph+wiki; ctx; full selected composition. Routing/ctx фиксируются для отдельного W06, а для M02/M05 меняется только исследуемый компонент. Задачи: description→files, symbol→impact, why/rule, safe patch с checks, продолжение другим агентом. Одинаковый parent snapshot и ограничения внутри пары, несколько репозиториев и повторы; учитываются cold/warm режимы и setup/maintenance.

## W06 — источник пользы wiki

Включить substantive wiki, boilerplate-only, stale, conflicting, no-answer и missing-page fixtures. Отдельно фиксировать: page existed → релевантная section indexed → candidate retrieved → evidence delivered → источник использован → ответ/патч верен. Ссылка в ответе не доказывает прочтение или использование, а наличие страницы не доказывает содержание. Для использования нужен проверяемый trace/answer citation и внешний scoring; semantic judge (если разрешён) размечается отдельно от deterministic source/patch checks.

Task oracle готовится независимо от arm outputs. Wiki для опыта строится по parent code и предшествующим знаниям; её автору не передаются target gold, будущий patch или скрытые ответы проверок. Если смысловую прозу создаёт внешний агент, фиксируются версия способа подготовки, источники и полная стоимость authoring/review; Keryx не выбирает эту модель. При оценке patch используется поведенческий oracle, а не только совпадение со списком файлов исторического PR.

Метрики: source/section precision/recall, correctness цитаты и правил/исключений, task success, patch checks, stale reuse, unsafe permission inference, handoff constraint retention, no-answer correctness, repeated reads и maintenance. Wrong confident answer хуже корректного insufficient-evidence по заранее заданной задаче scoring, не по скрытой универсальной формуле. Слабый результат ведёт к проверяемой гипотезе улучшения страницы/retrieval/interface/routing и повторной оценке, не автоматическому удалению wiki.

## M09/M05/22 — телеметрия и калибровка

Usage event хранит event ID, attempt/run/task/arm, timestamp, requested/resolved model в **runner**, input/cache-create/cache-read/output отдельно, turns и tool calls отдельно, latency, источник измерения. Null/unknown не заменяется нулём. Агрегирование сначала дедуплицирует stable event IDs; replay не увеличивает cost. Provider-specific inclusive/exclusive semantics token counters фиксируются adapter contract, чтобы cache tokens не посчитать дважды.

Суммарный обработанный вход, уникальный контент, peak context, денежная оценка и фактическое списание — отдельные величины. Если известен тариф, rate version/currency/accounting basis сохраняются; subscription allocation не называется банковским списанием. Полная стоимость включает setup/index/wiki authoring/review/refresh, repeated reads, failures/retries и runner overhead. Показывать distribution/P50/P95, mean и wins/ties/losses, а не только выгодное среднее.

Перед реализацией performance changes собрать cold/repeated baseline на 50/500/2000 wiki pages; сравнить output с per-page oracle и счётчики Git operations. Latency budget, concurrency bound и ranking weights фиксируются в versioned calibration profile. Для ctx сравнить одинаковый useful content у plain и wrapped output: critical lines, envelope overhead, дальнейшие чтения и aggregate tokens. Короткий gate не обещает «prefix оплачен один раз»; фактическое влияние проверяется traces.

После успешных offline guards можно **отдельно разрешить** bounded external smoke для диапазона стоимости и stop budget. Smoke не scored experiment. Изменение model/config/roster/snapshot аннулирует прежнюю оценку; запуск не продолжает расход по устаревшему budget. Новые model calls не входят в документационную работу.

## M11/24 — продуктовые заявления и пилоты

Claims inventory хранит точный текст утверждения, поддерживающую разрешённую evidence, measured scenario/version и ограничения либо статус hypothesis. Не приписывать README буквальную цитату из пересказа исследования. Структурный affected пример можно описывать как пример; универсальное «лучше поиска» требует отдельного сравнения. «Быть лучшим» — направление, не measured fact.

Пилоты сначала на собственных проектах, затем по отдельно разрешённым приглашениям. До подключения задаются самостоятельный onboarding, success сценарий, time-to-useful-action и критерий повторного использования без сопровождения. Конкретные участники, сроки и численные thresholds здесь не выдумываются. Публичные результаты только из данных с разрешением распространения.
