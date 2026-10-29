# Контекст исследования wiki → OpenSpec → Flow

Version: 1.0
Date: 2026-10-25
Timezone: Asia/Muscat
Scope: read-only research; source/document consistency, не quality gate
Job: wiki-openspec-flow-research

## Источники и снимки

- Keryx: `/Users/Goodea/goodea/keryx`, main, `1b7852748055d264d046092612fe3190fc82f70a`.
- Vantage: `/Users/Goodea/work/vantage-frontend`, develop, `037e059292a64978bc11f386c114413a82ef252f`.
- [Общий анализ](../analysis.md), [wiki](../wiki-findings.md), [SAC/Slate](../sac-findings.md), [Flow](../flow-findings.md), [Vantage](../vantage-findings.md), [проверка источников](../verification-source.md).
- Поведение установлено чтением исходников. Тесты/CI/health не запускались. Наличие test cases не означает PASS текущего HEAD. Graph служит навигацией: parent перестроил его, но вложенные backup/review-копии продолжают вызывать freshness warnings; ключевые выводы проверены в root source.

## Разрешённый объём

Пользователь разрешил исследование и обновление Page. Этот worker пишет только данный контекст и verification-source.md. Изменения исходников, Flow/wiki/OpenSpec state, sync/enrich/verify/review/archive, дополнительные метрики и тестовые запуски не входят в задачу. Managed job принадлежит родительскому оркестратору.

## Что уже реализовано

Wiki разделяет детерминированные scaffold/Reference и model prose. `enrich` не повышает draft до accepted; page/force могут выбрать уже accepted страницу, затем writer сохраняет прежний Status/frontmatter. Поэтому новая prose может сохранить старые accepted и provenance. Это вывод из selection и invariants, не результат нового запуска: [selection](/Users/Goodea/goodea/keryx/src/wiki/enrich.ts:300), [writer](/Users/Goodea/goodea/keryx/src/wiki/enrich.ts:898). `verify`/freshness измеряют привязку к исходникам, а не защищённую человеческую приёмку точной prose revision.

Workspace содержит ACL и ссылки на владельцев. Slate — рабочий контекст агента: Anchors/Course/Seeds/Trail/Notes; Notes не становятся Seeds или proposals автоматически. «Private» означает назначение и lifecycle, а не доказанную криптографическую изоляцию файлов: [Slate](/Users/Goodea/goodea/keryx/src/session/slate.ts:128). Wrap-up создаёт кандидаты proposals; Course ссылается на canonical Flow.

SAC имеет immutable proposal, review, write-intent, owner writer и receipt. Но текущий wiki owner создаёт `decisions/sac-<id>.md`, а не применяет diff к существующей модульной странице: [writer](/Users/Goodea/goodea/keryx/src/sac/wiki-owner-writer.ts:76). Routing: wiki-update → wiki; memory-entry → memory; остальные kinds, включая contract-change, → skill: [ownerFor](/Users/Goodea/goodea/keryx/src/sac/proposal-lifecycle.ts:847). Это не готовый OpenSpec owner.

Flow владеет AC checksum, freeze, invalidation подтверждений, completion gates и done. Token полезен как local interactive confirmation primitive; native Keryx shell имеет approval floor. Однако shell-capable агент и writable local files не дают независимой authenticated human identity: [ограничение](/Users/Goodea/goodea/keryx/src/flow/confirm-token.ts:19). Не смешивать Flow token с SAC token: у них разные binding/TTL и issuance paths.

## Реальный пример Vantage

`add-inflight-request-guard` (#8013) уже имеет axios prototype wrapper, Set, очистку и afterEach assertion, общий setup и test cases: [код](/Users/Goodea/work/vantage-frontend/src/test/msw/in-flight.ts:25), [подключение](/Users/Goodea/work/vantage-frontend/src/test/vitest.setup.ts:51). Это не незавершённая реализация только потому, что change остаётся в openspec/changes.

Spec описывает unawaited/awaited/abort/late-response сценарии: [delta](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/specs/test-tooling/spec.md:5). Scope ограничен перехваченными axios requests; bare fetch и direct axios entry points не обещаны. Abort должен успеть settle до assertion. Очистка регистрации не означает отмену оставшихся запросов и не гарантирует отсутствие любых побочных эффектов позднего ответа.

Tasks отмечены [x], но DoD хранит исторические «No test files found»/«Today: 0»: [tasks](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/tasks.md:21). Related wiki accepted, но in-flight guard не описывает. В проверенных scopes связи выбранного change с Flow не найдено; единственный найденный Flow относится к иной задаче. Эти отрицательные выводы ограничены локальным checkout/объёмом исследования.

## Проектное направление, ещё не существующий контракт

Развивать существующих owners: локально код/приложение/агенты; Hub хранит shared metadata, immutable revisions, ACL и authenticated decisions; Git служит финальной публикацией. Нужны typed spec owner, patch existing wiki page с expected base revision, точный digest всего landing payload и server recovery-conflict contract. Local undo/history и файловый CAS не объявлять готовым командным ledger.

Связь: accepted SpecRef → frozen Flow AC revision → code subject/evidence → KnowledgeProposal(base, digest) → KnowledgeReview(authenticated actor, digest) + отдельная applicability attestation → owner receipt → publication receipt. Это предложение; UI может объединять действия, но полномочия и scopes различаются. Не повторять уже данную авторизацию неизменившегося действия, однако не наследовать approval при смене subject/text.

Первый slice: один read-only OpenSpec import, proposed scenario→AC mapping и один reviewable patch существующей wiki. Никаких автоматических archive/baseline/done по checkbox или наличию тестов. Перед будущей реализацией определить deliveryContract и актуальную версию OpenSpec CLI; в исследованном PATH CLI отсутствовала, версия не установлена.

## Update Log

- 2026-10-25 — v1.0: собраны findings, отдельно обозначены текущие факты, ограничения доказательств и проектируемые Hub contracts; выполнена bounded проверка ключевых source slices и citation paths.
