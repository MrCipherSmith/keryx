# План реализации и миграции
Version: 0.1.1

Status: draft implementation — работа M0–M5 отслеживается в job unified-model-routing и PR #1128.

## Принцип перехода

Legacy и v2 — отдельные версии engine, а не две последовательно применяемые эвристики. Сессия фиксирует engineVersion/configDigest при создании snapshot. Активная попытка и её дочерние задачи наследуют engineVersion; переключение допускается только на границе top-level turn после завершения старой волны. Смешивание legacy tier и v2 resolver в одной попытке запрещено.

## M0 — Контракты и baseline

Зоны: src/harness/routing, src/gdskills/model-tier.ts, src/commands/review.ts, src/harness/tool/builtin/spawn-subagent-tool.ts, src/session, src/trigger, src/scheduler.

- Создать inventory всех native call sites и adapter ownership; отметить external CLI unmanaged.
- Зафиксировать fixtures текущих расхождений: user pin против model_tier; profile hint против derived; cost lookup preview/turn; provider switch; session-default в review.
- Реализовать runtime validation приложенных схем, нормализацию defaults и deterministic digest. Добавить behavioral проверки merge/source provenance.
- Gate: schemas валидируются; fixtures демонстрируют старые расхождения и будущие assertions, без изменения default execution.

## M1 — Единый чистый resolver

Новые предлагаемые файлы в src/harness/routing: model-class.ts, routing-request.ts, resolver.ts, decision.ts, snapshot.ts, config-v2.ts. Имена уточняются по конвенциям при реализации, ответственность обязательна.

- Ввести четыре абсолютных класса, membership, assignments и provider scope.
- Перенести availability/capability/policy/budget inputs в snapshot; resolver остаётся без network/fs.
- Реализовать общий priority порядок, flat fallback и exhaustive reasons.
- Gate: table-driven tests покрывают AC1–5,7–9,12; перемешивание входных candidates не меняет результат; model_class из агента не создаёт userOverride.

## M2 — Классификация и безопасное исполнение

Зоны: src/harness/decision/classify-turn.ts, src/harness/routing/classifier-model.ts, src/harness/provider, child/model.ts и budget/session lifecycle.

- Адаптировать JEV/модель к classification schema, deadline и non-recursive explicit classifier chain.
- Вынести shared routing orchestration из src/tui/routing-classifier-source.ts в runtime/service слой; TUI станет consumer.
- Атомарно резервировать budget; pre-I/O revalidation, confirmed-failure retry, cooldown и запрет replay после side effects.
- Gate: fake ProviderPort проверяет AC5–7 и конкурентный budget; не использовать платные запросы как единственную проверку.

## M3 — Все consumers и preview

Зоны: tui/routing-inspector.ts, tui/tui-shell.ts, commands/routing.ts, commands/review.ts, spawn-subagent-tool.ts, session/native-classifier.ts, session/routing.ts, native runtime, scheduler/trigger native factories.

- Один RoutingRequest → RoutingDecision на всех native путях; сохранить parent gates, remote candidate identities и permissions.
- Native remote исполняет только выбранный и допущенный candidate. Multi-attempt fallback остаётся закрыт до появления fresh execution-attempt grant/receipt с candidateId и decision lineage; current-role check и уже закрытый admission grant не считаются такой авторизацией.
- Inspector и CLI объясняют этот же decision. Удалить самостоятельную derived/tier резолюцию из v2 consumers.
- Shadow mode: production исполняет legacy, v2 считает лишь решение. Переиспользовать разрешённый classification receipt; дополнительные classifier I/O по умолчанию запрещены. Если данных нет — shadow-unresolved, не выдуманная эквивалентность.
- Gate: cross-entrypoint conformance fixtures; ни один v2 consumer не импортирует legacy ranking для принятия решения. AC8/10 подтверждены на реальных wiring, не source substring assertions.

## M4 — Настройки и миграция

Зоны: routing config/trust/profile stores, routing CLI/TUI, shell config, compiled skills/agents и dispatch contracts.

| Старое состояние | План миграции |
|---|---|
| Concrete provider/model category pin | Перенести без изменения пары в mode=model; strict fallback по умолчанию |
| Явный session-default | mode=baseline; не трактовать как auto |
| Отсутствующая категория | Сохранить legacy до activation; предложить явное baseline/class/auto для v2 |
| provider-default | Показать фактически разрешённую пару; пользователь подтверждает materialized model pin или выбирает class. Неразрешённый default блокирует apply |
| model_tier light/standard/deep в skill/dispatch | Предложить новое model_class с учётом назначения задачи; никакого автоматического standard→standard или deep→expert |
| Operator strengthTier/profile hints | Сохранить исходные профили; показать предложения membership отдельно, требовать подтверждения |
| Derived category defaults/task-cost heuristic | Предложить явные class assignments/pools; не сохранять скрытый derived layer в v2 |
| KERYX_SUBAGENT_MODEL | Сохранить legacy-смысл только в legacy; v2 migration предлагает явный scoped user override и блокирует activation пока конфликт не разрешён |
| Старые frozen dispatch/run records | Не переписывать; читать прежней версией и показывать legacy provenance |

Dry-run создаёт отдельный migration plan с версиями/хешами входов, proposed config, всеми unresolved mappings, точным diff и rollback manifest; не меняет активный engine и credentials. Это запись артефакта, не активной конфигурации. --apply требует 0 unresolved, явное подтверждение плана и совпадение input digests; stale plan отклоняется.

Transaction: сохранить оригинальные bytes конфигураций с ограниченными правами; user backup может содержать секреты auth.json, поэтому только в существующем закрытом config dir, никогда в repo/report. Записать v2 layers атомарно, проверить их, затем последним атомарным шагом activation marker с digests. До marker активен legacy; partial failure оставляет legacy и staged v2. Повторный apply того же migrationId — no-op; несовпадающий digest требует нового dry-run. Marker и session snapshot проверяются loader, не отдельными call sites. Trust approval распространяется только на подтверждённый v2 digest; старое legacy approval его не покрывает.

Gate: migration-on-copy tests на malformed/partial/untrusted config, unknown defaults, env override, crash между writes и marker, concurrent edit, repeated apply; originals восстанавливаются byte-for-byte.

## M5 — Pilot, cutover, retirement

- Явное opt-in для новых top-level turns, feature switch engineVersion=2; доступен единый rollback в legacy.
- Pilot 14 дней: metrics из PRD; проверить fixture parity, fallback trace completeness и отсутствие лишних classifier calls. Runtime release требует всех AC, а не только отсутствия pilot ошибок.
- Rollback переключает activation marker для будущих turns; frozen v2 attempts продолжают v2 или отменяются штатно. Не удалять v2 configs/receipts. Откат на старый бинарник допускается только после остановки v2 attempts: он не обязан читать v2 records.
- После успешного pilot v2 становится default только для новых настроек/установок; существующие пользователи без подтверждённой миграции остаются legacy с понятным уведомлением.
- Legacy readers и schemaVersion dispatch сохраняются минимум два minor-релиза и до завершения активных legacy runs. Удаление отдельным изменением с inventory и объявленным compatibility boundary, не в M5 автоматически.

## Что заменяется и что остаётся

- assignTier task signals можно перенести в deterministic class recommendation; конкретные mappings фиксируются новыми fixtures, отдельно от legacy относительной модели.
- resolveTierModel/resolveTierWithAgent/buildTierMap остаются только legacy adapter до retirement; rank-by-name и LLM ranking каталога не используются v2.
- deriveDefaultTable заменяется явными class pools. Task-cost store остаётся источником наблюдений для selection policy, общим для preview и execution.
- Category resolution сохраняет категории и доверие проекта, но concrete selection пишет только новый resolver.
- Provider factories, credentials, child G1/G2/G3, external policy, remote identity bindings и harness replay guards сохраняются; v2 их не ослабляет.

## Порядок и проверка

M0 → M1 → M2 → M3 → M4 → M5. Разработка UI может идти после стабильных M1 contracts, но activation требует M2–M4. На этапе реализации выбрать точные команды через keryx test related; добавить conformance, migration и budget integration suites. Нынешний пакет не создаёт Flow, не изменяет runtime и не объявляет перечисленные будущие проверки выполненными.
