# Server handoff: PR #1022 acceptance

Продолжи приёмку Evidence Retrieval Layer в PR:
https://github.com/MrCipherSmith/keryx/pull/1022

Цель: найти доступную на сервере embedding-модель и безопасный способ её использования, завершить необходимые проверки T12, затем независимое review T13 и документацию T14. Не выдавай smoke-тесты или зелёный CI за полную приёмку.

Начни с .metaproject/index.md и маршрутизации проекта. Для review загрузи skill review-orchestrator и следуй ему. Опубликуй план.

## Исходное состояние — перепроверь перед работой

- Последний проверенный head: fca318a880cbc69e3f891ccadea6133905f5d384.
- PR OPEN / Draft, MERGEABLE / CLEAN.
- GitHub CI: все checks SUCCESS, Pages SKIPPED.
- Flow: .metaproject/flows/415-2026-10-12-evidence-retrieval-layer
- T11 done; T12–T14 ещё не закрыты.
- В flow.json acConfirmed:{} и pr.url:null: требуется формальное оформление evidence, а не механическое подтверждение.
- В предыдущей рабочей копии финальное дополнение T13-focused.md не было закоммичено. Оно может отсутствовать на сервере — не считай отсутствующие локальные артефакты опубликованными.

## 1. Найди embedding-модель на сервере

Исследуй существующую документацию, конфигурацию и уже настроенные сервисы:
- какой endpoint/API/protocol используется;
- точное имя и revision модели, размерность векторов;
- как вызываются document/query embeddings, есть ли prefixes и нормализация;
- batch/token limits, timeout, авторизация;
- локальный ли это сервис, есть ли внешняя передача или тарификация.

Не выводи ключи, токены и содержимое credential-файлов. Указывай только имена переменных/профилей и безопасные параметры подключения. Не устанавливай и не скачивай модели, не меняй сервисы без согласования. До внешних платных вызовов запроси разрешение и бюджет. Для технической проверки используй только синтетические несекретные данные.

## 2. Перепроверь T12 — зависимость T13/T14

Читайте:
- docs/requirements/keryx-evidence-retrieval/paired-evaluation-protocol.md
- docs/requirements/keryx-evidence-retrieval/metrics-and-validation.md
- docs/requirements/keryx-evidence-retrieval/paired-evaluation-starter.json
- scripts/benchmark/*evidence-evaluation*

Сейчас есть smoke-набор, частичный runner и настоящий lexical-адаптер B. Это НЕ полное сравнение.
Production hybrid был явно закрыт gate при отсутствии approved embedding owner. Одного endpoint недостаточно: найди контракт embedding dependency и безопасно подключи реальную модель через предусмотренный owner/adapter, если это необходимо.

Требуется сравнение: A — accepted-memory tools; B — lexical; C — hybrid; D — hybrid + exact visibility; E — D + incremental indexing.

Не имитируй отсутствующие arms фикстурными векторами. Не обходи lifecycle, consent, scanner, model/dimension binding и delivery validation.

Подготовь достаточный frozen holdout с раздельными project/session dev и held-out. До оценки согласуй размер набора, практические пороги качества и слепого оценщика ответов. Соблюдай протокол: минимум три timing repetitions, реальные lifecycle/visibility сценарии, метрики retrieval, grounded answers, стоимость, latency, paired uncertainty и raw artifacts с hashes/revisions. Отсутствующие наблюдения не подменяй нулями.

Если для grounded-answer оценки нет модели или оценщика — явно сообщи блокер. Решение по rollout принимает оператор. Без полной оценки не закрывай T12/AC9 и не заявляй преимущество hybrid.

## 3. Заверши независимое review T13

Доступные отчёты ищи в .metaproject/data/review/pr1022-t13/, особенно T13-interim.md и T13-focused.md.
Пять существенных замечаний ранее исправлены и статически перепроверены; итог — сокращённая оценка, НЕ полный approval.

Проверь оставшиеся пробелы:
- restart automatic recall: действительно ли используется reopened runtime, а не закрытый runtime из closure;
- deterministic barriers для revoke/drain/late delivery;
- hybrid no-write: сравнение рекурсивных persisted bytes, не только имён файлов;
- валидный foreign-project fixture, без посторонней ошибки схемы;
- complexity на 4 MiB single-line archive и межпроцессный writer contention;
- agent/shell ownership/retry и границы неподдерживаемых provider adapters.

Обеспечь независимость проверки: автор исправления не должен быть единственным reviewer. Пустые ответы subagent не являются успешным review. Для каждого замечания укажи disposition, точный SHA, вид evidence и оставшиеся ограничения. Согласованное ранее сокращённое покрытие сохраняй явно; не представляй его полным role-by-slice review. Старые закрытые review-пакеты PR779 и flow-origin-main не относятся к approval PR1022.

## 4. Заверши T14

Актуализируй operator instructions, config/CLI, privacy, disable/clear/revoke; поддерживаемые adapters и реальные ограничения hybrid/automatic; docs/requirements/keryx-evidence-retrieval/implementation-plan.md (в нём устаревшее утверждение P2–P5 pending); current-evidence.md, wiki и фактический roadmap — путь найди в репозитории; отчёт evaluation, review, CI и решение оператора по rollout.
Не приписывай неподдерживаемые возможности и неизмеренные преимущества.

## 5. Верификация и завершение

Предпочтение оператора: тесты и общие прогоны выполнять через GitHub CI на draft PR, желательно после серии изменений. Локальные тестовые прогоны — только по отдельному согласованию. Не путай это с запуском согласованной серверной evaluation: заранее опиши её команды, сеть и стоимость.
Сохраняй чужие dirty/untracked файлы. Не переписывай историю, не мержи, не снимай draft и не публикуй изменения без разрешения оператора.
Обновляй flow и подтверждения AC штатными командами с конкретными evidence; не редактируй checksum-protected acceptance criteria вручную.

В конце предоставь найденную embedding-модель и безопасный способ использования; результаты T12, T13, T14 по отдельности; SHA и ссылки на CI/evidence; оставшиеся блокеры; обоснованный вывод о готовности к merge. Если нужны решения оператора — задай конкретные вопросы, не объявляй задачу завершённой.
