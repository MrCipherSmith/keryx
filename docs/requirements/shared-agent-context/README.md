# Keryx Shared Agent Context
Version: 1.5.0

## Назначение

Этот пакет описывает **текущий** local-first слой совместного контекста Keryx
(`src/sac/`, CLI `keryx workspace`, MCP `sac.*`, harness `workspace_*`).
Он даёт человеку и агенту воспроизводимый вход в работу от workspace, компонента
или flow: небольшой проверяемый обзор, адресное чтение деталей и безопасное
предложение нового знания по завершении работы.

## Статус

`implemented` (механизмы 0–5), плюс фаза 6, разбитая на две части: **6a** —
runtime-guard opt-in (`resolvePolicySelection`), реализована и проверена
(AC1–AC6, вся SAC-сюита 88/88 зелёная); **6b** — операторский процесс готовности
для реальных данных, частично (read-only `keryx workspace policy-readiness` и
playbook; runtime re-ingestion сырых receipts/outcomes остаётся). Фазы 0–5 и 6a
влиты в `main` и выпущены в `v0.2.32`; код lifecycle/CLI/MCP/harness с тех пор
расширен на `main` (в т.ч. `v0.2.35`). Точный статус и evidence приведены в
[Implementation plan](implementation-plan.md).

**Документационная правда (1.5.0):** более ранние versioned-заголовки этого
пакета помечали CLI/MCP/schema-enforcement как `future/planned` и прямо писали,
что runtime «не реализует SAC contracts». Это устарело относительно `src/sac/`
(~4.3k строк production + тесты: propose/review/accept, guarded owner-writers
wiki/memory/skill, receipt-integrity, access-receipt ledger; плюс
`src/commands/workspace.ts`, MCP `sac.*`, harness `workspace_*`). Норматив
этого пакета теперь —
как устроено **сейчас**. Спутниковые пакеты RP-01…RP-12 остаются future /
spec-ready и **не** отменяют этот runtime. Валидатор, который сверяется с
заголовками `future` в старых ревизиях или в RP-пакетах, получит ложный drift.

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
- [Implementation plan](implementation-plan.md) — delivery status фаз 0–6b
  и исторические exit criteria.
- [Phase execution prompts](phase-execution-prompts.md) — утверждённые промты
  для запуска и delivery-protocol каждой implementation phase.
- [Phase 4 usability report](phase-4-usability-report.md) — contract-only
  walkthrough evidence.
- [Phase 5 policy experiment report](phase-5-policy-experiment-report.md) —
  synthetic offline experiment evidence.
- [Phase 6 readiness](phase-6-real-opt-in-readiness.md) — 6a/6b split and
  remaining real-data work.
- [Phase 6b operator playbook](phase-6b-operator-playbook.md) — operator
  readiness process.
- [Design rationale](design-rationale.md) — решения и ограничения модели FWK.
- [Schemas](schemas/README.md) — JSON Schema, semantic-validation boundary и
  полный positive/negative/replay fixture corpus.

## Scope

- Локальный workspace registry со ссылками на компоненты, repositories, flows,
  evidence и approved knowledge; исходные артефакты не копируются.
- Bounded FWK overview и progressive retrieval через **существующие** CLI
  (`keryx workspace overview|read`), MCP (`sac.overview`/`sac.read`, только
  local stdio) и harness-tools (`workspace_overview`/`workspace_read`);
  hash-chained access-receipt ledger.
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
