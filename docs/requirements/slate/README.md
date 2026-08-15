# Keryx Slate — Task-Local Harness Layer
Version: 1.0.0

## Назначение

Slate — временный, непубличный, task-local слой харнеса, который живёт рядом с
уже реализованным Shared Agent Context workspace (`src/sac/`), но не заменяет
и не переопределяет его. Slate даёт агенту (родителю и сабагентам) живую
«обстановку задачи» во время работы — где я, что уже сделано, какие есть
непроверенные гипотезы — и на завершении работы поставляет машинно-собранные
факты в уже существующий `workspace propose`/`review` pipeline вместо дампа
сырого транскрипта сессии.

## Статус

**Design.** Кода нет. Пакет формализует решения, принятые за 4 раунда review
(2 brainstorm-раунда Pragmatist/Innovator/Critic, 1 security/autonomy
стресс-тест, 1 SLATE-10 aggregation deep-dive), каждое утверждение сверено с
реальным кодом (`src/sac/`, `src/session/`, `src/harness/`) с привязкой
file:line. В отличие от более раннего состояния пакета `shared-agent-context`
(который до версии 1.5.0 ошибочно годами описывал уже реализованный SAC как
«future/planned»), этот пакет явно не совершает ту же ошибку в обратную
сторону: slate **не реализован**, и этот README прямо это утверждает, а не
маскирует под «future contract» без даты.

## Модель Anchors · Course · Seeds

Вдохновлено идеей трёх «полок» из EvoHarness-RL (arXiv:2608.05446,
Belief/Progress/Experience) — но не скопировано 1:1: свои имена, своя
семантика, привязанная к словарю SAC (Facts/Work/Know-how), не к RL-циклу
оригинала.

- **Anchors** (≠ workspace Facts) — harness-owned обстановка исполнения: root,
  tree, runtime, touched, опциональный fence. Пишет только код харнеса,
  никогда — модель.
- **Course** (≠ workspace Work) — не хранит контент, только `flowRef`-
  указатель; всегда живая проекция существующего Flow. Slate/агент никогда не
  вызывает `flow complete` сам.
- **Seeds** (≠ workspace Know-how) — append-only, model-writable гипотезы;
  никогда не auto-promote; попадают в Know-how только через уже существующий
  `workspace review`.

## Документы

- [PRD](prd.md) — проблема, пользователи, требования (`SLATE-N`), риски,
  результаты.
- [Specification](specification.md) — границы, storage, функциональная
  surface, data contracts, acceptance criteria (`AC-N`).
- [Agent protocol](agent-protocol.md) — обязательное поведение агента для
  Anchors/Course/Seeds, wrap-up, unattended-режима и catch-up review.
- [Implementation plan](implementation-plan.md) — 5 фаз, зависимости между
  SLATE-N, внешняя зависимость на `sac-workspace-lifecycle` для Phase 5.
- [Phase execution prompts](phase-execution-prompts.md) — утверждённые
  промты для запуска каждой фазы через `flow-orchestrator`.

## Scope

- Task-local `slate.json` (sibling-файл в существующем session dir), три
  полки, без нового сервиса, без нового ID-пространства.
- Ephemeral slate для сабагентов на время dispatch, с раздельным,
  провенанс-помеченным handoff-каналом в slate родителя.
- Wrap-up-сборщик, заменяющий raw-transcript evidence (сегодняшний
  `session-wrap-up.ts`) на machine-собранные факты + модельный summary,
  питающий уже существующий `workspace propose`.
- Unattended-режим: gating `accept` и Course-close по режиму сессии
  (interactive/unattended), не по актору — переиспользуя уже реализованный
  `unattended-untrusted`-профиль харнеса (`src/harness/policy/profiles.ts`) и
  `checkApproval`'s headless-deny паттерн (`src/harness/mutation/approval.ts`),
  а не изобретая новую identity-модель.
- Catch-up review flow (`SLATE-10`) — агрегация накопленного за unattended-
  время (pending proposals + blocked/incomplete/unbound/unknown-crashed
  запуски) в структурированный per-item интервью-формат.
- **Bundled SAC hardening** (`SLATE-12`…`SLATE-14`) — три фикса в
  сегодняшнем `src/sac/`, найденные по ходу дизайна slate, не создающиеся
  им: захардкоженный `security.gate: "pass"` вместо реального скана,
  необработанное исключение в `createLocalFwkReadService` при race на
  flow-read, отсутствие general-purpose `list-proposals`, и вводящий в
  заблуждение комментарий про self-accept в
  `createLocalProposalLifecycleService`. Включены в этот пакет для
  реализации в одном раунде со slate, не потому что slate их создал.

## Non-goals

- Переопределение того, что такое workspace, или когда/как он создаётся —
  зафиксировано, не в скоупе этой фичи.
- Копирование имён/действий EvoHarness-RL 1:1 (track/commit/recall/note, RL).
- Slate в git/`.metaproject/` как wiki — это temp-артефакт.
- Шаринг открытого slate между клиентами (Claude, keryx TUI, Grok) — только
  workspace шарится.
- **Session↔workspace↔Flow автоматический binding** — владеет
  [SAC RP-03 Lifecycle Binding](../shared-agent-context-lifecycle-binding/README.md);
  slate v1 продолжает требовать явный `workspaceId`, как сегодняшние
  `workspace_overview`/`workspace_read`, и не строит конкурирующий механизм.
- **Полная модель evidence-security (sealed/scanned/schema-closed)** — владеет
  [SAC RP-05 Secure Minimal Evidence](../shared-agent-context-secure-evidence/README.md);
  slate v1 использует уже существующие `detectSecrets`/`detectPii`
  (`src/security/detect/*`) как временную меру до RP-05, не строит
  параллельную архитектуру.
- **Explicit execution identity / continuous authorization** — владеет
  [SAC RP-06 Identity and Capabilities](../shared-agent-context-identity-capabilities/README.md);
  slate v1 использует уже реализованный `unattended-untrusted`-профиль
  (`src/harness/policy/profiles.ts`) как временную меру до RP-06, не строит
  конкурирующую identity-модель.
- **TTL-резервации/«кто-то уже смотрит»** — владеет
  [SAC RP-08 Collaboration and Worktrees](../shared-agent-context-collaboration-worktrees/README.md);
  slate v1 catch-up (`SLATE-10`) не строит собственный reservation-механизм.
- **Access, выведенный из близости worktree/checkout** — явный non-goal и в
  RP-08, и здесь: Anchors.root/tree — это situational awareness для агента,
  никогда не источник авторизации.
- Push/webhook-уведомления — такой инфраструктуры в keryx нативно нет;
  catch-up (`SLATE-10`) — pull-based (человек сам запрашивает), не push.

## Связанные модули

- [Keryx Shared Agent Context](../shared-agent-context/README.md) — владелец
  workspace, FWK, proposal/review lifecycle; slate — потребитель, не замена.
- [SAC RP-03 Lifecycle Binding](../shared-agent-context-lifecycle-binding/README.md),
  [RP-05 Secure Minimal Evidence](../shared-agent-context-secure-evidence/README.md),
  [RP-06 Identity and Capabilities](../shared-agent-context-identity-capabilities/README.md),
  [RP-08 Collaboration and Worktrees](../shared-agent-context-collaboration-worktrees/README.md)
  — соседние future-пакеты с прямым пересечением скоупа; slate явно
  расписывает границы против каждого в Non-goals, а не дублирует их.
- [SAC Workspace Lifecycle Completion](../sac-workspace-lifecycle/README.md)
  — archive/resource-removal/rename для уже реализованного `WorkspaceService`;
  SLATE-10/SLATE-13 зависят от его WSL-2 (archived workspaces никогда не
  исчезают из pending-review discovery).
- `src/session/`, `src/harness/child/`, `src/harness/policy/`,
  `src/harness/mutation/`, `src/flow/` — существующие интеграционные
  границы.
