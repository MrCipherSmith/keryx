# Keryx Shared Agent Context
Version: 1.4.0

## Назначение

Этот пакет определяет будущий local-first слой совместного контекста для Keryx.
Он даёт человеку и агенту воспроизводимый вход в работу от workspace, компонента
или flow: небольшой проверяемый обзор, адресное чтение деталей и безопасное
предложение нового знания по завершении работы.

## Статус

`implemented` (механизмы 0–5), плюс фаза 6, разбитая на две части: **6a** —
runtime-guard opt-in (`resolvePolicySelection`), реализована и проверена
(AC1–AC6, вся SAC-сюита 88/88 зелёная); **6b** — операторский процесс готовности
для реальных данных, в плане. Фазы 0–5 влиты в `feat/shared-agent-context`;
дальнейший операционный rollout (6b) остаётся в плане. Точный статус, evidence и
список временно сохранённых веток приведены в [Implementation plan](implementation-plan.md).

Важно: Phase 5 (policy experiment) сейчас подтверждает корректность механизма на
synthetic offline evidence и по умолчанию не включает production эффектов.

## Модель FWK

- **Facts** — evidence-linked, task-local и freshness-bound утверждения о
  текущей работе. Fact не становится источником долгосрочного знания.
- **Work** — read-only проекция существующего Flow: выполненное, следующее,
  блокировки и verification evidence. SAC никогда не создаёт второй tracker.
- **Know-how** — reviewed и reusable knowledge из memory, wiki и skills.
  Необработанные транскрипты и скрытые рассуждения не являются Know-how.

## Документы

- [PRD](prd.md) — проблема, пользователи, требования, риски и результаты.
- [Specification](specification.md) — границы, функциональная surface,
  интеграции и acceptance criteria.
- [Agent protocol](agent-protocol.md) — обязательное поведение агента при
  read, wrap-up и proposal lifecycle.
- [Artifact lifecycle](artifact-lifecycle.md) — источники истины, freshness,
  retention, supersession и deletion policy.
- [Metrics and validation](metrics-and-validation.md) — baseline, evals,
  rollout/rollback и измеримые gates.
- [Implementation plan](implementation-plan.md) — последовательность будущих
  implementation flows и их exit criteria.
- [Phase execution prompts](phase-execution-prompts.md) — утверждённые промты
  для запуска и delivery-protocol каждой implementation phase.
- [Design rationale](design-rationale.md) — решения и ограничения модели FWK.
- [Schemas](schemas/README.md) — JSON Schema, semantic-validation boundary и
  полный positive/negative/replay fixture corpus.

## Scope

- Локальный workspace registry со ссылками на компоненты, repositories, flows,
  evidence и approved knowledge; исходные артефакты не копируются.
- Bounded FWK overview, progressive retrieval через будущие CLI/MCP adapters,
  receipts стоимости и результатов доступа.
- Evidence-linked session wrap-up, proposal queue, human review и guarded
  promotion в существующие wiki/memory paths.
- Freshness, least disclosure, trusted ActorContext, local roles, redaction и
  audit trail; proposal может быть принят только после проверяемого,
  append-only review transition.

## Non-goals

- Новый task manager, дубликат Flow или новый primary store для wiki/memory.
- Хранение raw transcripts, secrets, PII, hidden reasoning или unrestricted
  environment snapshots как knowledge.
- Обязательная облачная база, multi-tenant service, SSO или внешний catalog.
- UI/IDE/terminal shell как prerequisite первой поставки.
- Обучаемая или self-modifying access policy до воспроизводимых offline evals.

## Связанные модули

- [Keryx Context Operations](../keryx-context-operations/2026-07-12/README.md)
  — владелец context assembly, retrieval trace и feedback lifecycle.
- [Keryx Project Agent Harness](../keryx-project-agent-harness/README.md) —
  владелец сессий, approvals, worktrees и execution runtime.
- `src/flow`, `src/memory`, `src/wiki`, `src/gdgraph`, `src/mcp`,
  `src/security`, `src/ctx`, `src/harness` — существующие интеграционные
  границы; изменения в них требуют отдельных implementation flows.
