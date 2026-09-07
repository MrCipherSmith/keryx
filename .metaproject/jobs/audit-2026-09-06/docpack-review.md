# Независимое ревью пакета Keryx Agent-first Core
Version: 1.0.0

STATUS: DONE
verdict: PASS
blockers: 0
warnings: 0

## Итог

Пакет семантически согласован и достаточно полный для статуса specification ready при сохранении явной оговорки: все wire-контракты предлагаемые, runtime по ним не реализован и не проверен. Все 49 направлений представлены отдельными AFC-требованиями, acceptance-сценариями и волнами реализации. Повторное согласование уже принятых решений не требуется.

## Проверенные контракты

- Atomic CAS: change-set содержит отдельную `expectedVersion` каждой записи; версии повторно проверяются под canonical per-target locks вместе с source, policy и preview binding. Ошибка одной базы отменяет prepare всего связанного пакета. Durable intent, staging, barrier, commit marker и recovery не позволяют участвующим Keryx readers увидеть смешанный committed set. Граница внешних редакторов описана честно.
- Supersession: существующий successor является `targetRef` операции `supersede`, `supersedesRef` указывает predecessor; predecessor обновляется отдельным `replace` в том же atomic changeset и получает `supersededBy` на successor. Новый successor оформляется `create` + `replace` predecessor. Self-links, cycles и неполная пара отклоняются service validator. Направления связей не противоречат lifecycle source.
- Authority и freshness: trusted invocation определяет полномочия; source record, handoff, model confidence и handle их не создают. Accepted stale/unknown сохраняет author/authority metadata, но не применяется как подтверждённое текущее ограничение. PRD, policies, wiki-specification и agent-protocol используют одну семантику.
- Provenance: exact source fragment/version, author, confirming participant, scope, acceptance basis и обязательные caveats сохраняются по search → compression → handoff. Unknown constraint представлен `sourceStatus=unknown`, `source=null` и обязательной причиной, без выдуманного ref и без повышения полномочий.
- Handles и batch: scope/access/version/expiry повторно проверяются при resolve; handle не bearer capability. Batch ограничен deterministic read operations, DAG и bounded concurrency; обычный batch не обещает транзакцию, связанные writes разрешены только одним knowledge changeset.
- Redaction и access: tool/resource/SDK используют общий output validator. Schema-safe redaction возвращает изменённый payload с причиной, иначе `format-unsafe`. Secret исключён из error, receipt, manifest и continuation. Directory scan сохраняет одновременно findings и incomplete coverage.
- Wiki: содержательные stable/version-bound sections, lexical body retrieval, explicit aliases, concept-to-code bindings, caveat indivisibility, access-safe candidate statistics, managed Reference blocks, dependent needs-review и отдельная W06 ablation заданы без встроенной модели и без второго graph/search engine.
- Измерения: preregistration фиксирует candidate cap, epsilon и arm order до результата; double-zero остаются в primary; paired uncertainty отделена от operational threshold. Wiki author не получает future gold, patch оценивается поведенческим oracle. Слабый результат ведёт к проверяемой гипотезе улучшения.

## Traceability и честность статуса

Матрица содержит 49 уникальных строк: 01–32, M01–M11 и W01–W06. Каждая строка ссылается на PRD, проверяемый AC, нормативный документ и волну. README и roadmap помечают пакет как requirements/specification, а не implementation. Existing baseline claims отделены от target behavior; private evidence отсутствует. Model/provider runtime остаётся у внешнего клиента/runner. M10 явно различает удаление неподдерживаемого поля и реализацию настоящего round/tool-call cap.

Общий response/schema boundary согласован: шесть JSON Schema задают shared types, envelope, wiki evidence, changeset, handoff и batch; operation-specific schemas и live validators остаются release work. Примеры синтетические и не называются runtime traces. Structural verifier сообщил PASS: local refs компилируются в Ajv Draft 2020-12, 7 positive shapes приняты, 10 schema-negative отклонены, 6 service-only cases оставлены schema-valid с будущим outcome.

## Исправления во время review

- Исправлено смешение authority и freshness в PRD.
- Добавлены exact fragment/confirming participant в AFC-25 и AC-25.
- Добавлен честный unknown-source вариант Constraint и синтетические cases.
- Уточнены dependent prose sections в W05.
- Добавлены обязательные status/range/handoff/DAG negative/service cases.
- Уточнено, что полная W04 code/test binding acceptance достигается после W03.
- Зафиксировано направление `supersede`/`supersededBy` и atomic linked update.

Нерешённых семантических противоречий после финальной перепроверки нет.

## Audit

- `files_checked`: README.md, prd.md, decision-traceability.md, specification.md, wiki-specification.md, policies.md, artifact-lifecycle.md, agent-protocol.md, metrics-and-validation.md, implementation-plan.md; schemas/common.schema.json, operation-response.schema.json, wiki-evidence.schema.json, change-set.schema.json, handoff.schema.json, batch.schema.json; examples/wiki-evidence.json, operation-response.json, change-set.json, handoff.json, batch.json, validation-cases.json.
- `schemas_checked`: 6/6.
- `roadmap_checked`: yes, docs/requirements/roadmap.md links the package and marks it requirements-only.
- `graph_used`: not-relevant; review subject is a newly drafted requirements package, not code topology.
- `wiki_used`: not-relevant; approved improvement plan and package contracts are the normative sources.
- `ctx_used`: yes, for bounded listings, searches and roadmap evidence.
- `raw_rg_used`: no.
