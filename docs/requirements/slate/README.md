# Keryx Slate — Task-Local Harness Layer
Version: 3.0.0

## Назначение

Slate — временный, непубличный, task-local слой харнеса, который живёт рядом с
уже реализованным Shared Agent Context workspace (`src/sac/`), но не заменяет
и не переопределяет его. Slate даёт агенту (родителю и сабагентам) живую
«обстановку задачи» во время работы — где я, что уже сделано, какие есть
непроверенные гипотезы — и на завершении работы поставляет машинно-собранные
факты в уже существующий `workspace propose`/`review` pipeline вместо дампа
сырого транскрипта сессии.

## Статус

**Implemented (v1, SLATE-1…15).** `src/session/slate.ts`,
`src/harness/tool/builtin/slate-tool.ts`, `src/commands/goal-command.ts` и
интеграция в `commands/agent.ts`/`commands/shell.ts`/`tui/tui-shell.ts`/
`spawn-subagent-tool.ts` реализованы и работают в проде — Anchors/Course/
Seeds пишутся и читаются в реальных сессиях, `/goal` открывает слейт и
опционально биндит `workspaceId`. Этот README раньше (v1.0.0) утверждал
«Design. Кода нет.» — это было верно на момент написания пакета, но устарело
после реализации; оставлять неверным было бы хуже, чем поправить задним
числом, поэтому статус обновлён вместе с этой ревизией, а не отдельным PR.

**Implemented (v2, SLATE-16…20).** **Исправлено этой ревизией** — раздел
ранее (v2.0.0) утверждал «Design», что на момент написания v2.0.0, видимо,
было верно, но устарело после реализации и не было обновлено вместе с ней
(та же ошибка, что v1.0.0 уже совершал и уже был предупреждён о ней выше).
Проверено против реального кода на `main` (`c47e8f0`): `src/sac/
workspace-resolve.ts` (SLATE-16), `src/sac/review-confirm-token.ts`
(SLATE-20), `src/harness/tool/builtin/workspace-lifecycle-tool.ts`
(SLATE-19/19b), интеграция в `commands/agent.ts`/`commands/goal-command.ts`
(SLATE-16/17/18) и `src/mcp/tools.ts` (SLATE-19b's `sac.workspaceList/Show/
Create`) — все с покрывающими тестами (`goal-command.test.ts`,
`agent.test.ts`, `mcp/sac-tools.test.ts`). **SLATE-21** (machine evidence
вместо raw-transcript, доводящий до конца ещё v1's SLATE-7) остаётся
нереализованным — единственный найденный разрыв, не новая находка этой
сессии сверх уже описанного в PRD.

**v3 (SLATE-22…26) — Design.** Приватный, MCP-экспонированный slate для
внешних рук (Claude Code, Codex и т.д.) — каждая рука открывает свой
собственный, session/task-local slate (никогда не шарится с другой рукой),
который на закрытии диспатчит Seeds в уже расшаренный SAC workspace через
существующий `propose`/`review`. См. [PRD](prd.md) v3 addendum и
[Specification](specification.md) v3 acceptance criteria. Не реализовано.

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

**v3 уточнение.** Slate — это ядро/руки-нейтральная концепция, а не
keryx-эксклюзивная: любая рука (keryx shell, Claude Code, Codex, будущие
харнессы) может открыть *свой собственный*, приватный slate через MCP
(`slate.open`/`slate.writeSeed`/`slate.close`) — но не общий с другими
руками. Расшаривается не slate, а его результат: продиспатченные Seeds
уходят в уже общий SAC workspace, ровно как это делает keryx-сессия сегодня.
Non-goal ниже («шаринг открытого slate между клиентами») остаётся буквально
верным после v3 — v3 расширяет только то, кто может открыть свой slate, не
то, шарится ли открытый slate между кем-либо.

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
- **Приватный slate для внешних рук** (`SLATE-22`…`SLATE-26`, v3) — MCP
  tools, позволяющие любому MCP-подключённому харнессу (не только keryx)
  открыть собственный, приватный, task-local slate и продиспатчить его
  Seeds в уже расшаренный SAC workspace на закрытии. Не новый sharing-
  механизм — расширение того, кто может воспользоваться уже существующей
  Anchors/Course/Seeds моделью.

## Non-goals

- Переопределение того, что такое workspace, или когда/как он создаётся —
  зафиксировано, не в скоупе этой фичи.
- Копирование имён/действий EvoHarness-RL 1:1 (track/commit/recall/note, RL).
- Slate в git/`.metaproject/` как wiki — это temp-артефакт.
- Шаринг открытого slate между клиентами (Claude, keryx TUI, Grok) — только
  workspace шарится. **Подтверждено v3 (SLATE-22…26, AC-40):** это условие
  не отменяется и не сужается расширением MCP-доступа — v3 даёт любой руке
  открыть *свой* приватный slate, но ни одна рука не получает доступ к
  slate, открытому другой рукой. Non-goal остаётся структурно верным, не
  просто задекларированным — см. Specification.md AC-34/AC-40.
- ~~**Session↔workspace↔Flow автоматический binding** — владеет RP-03;
  slate v1 продолжает требовать явный `workspaceId`~~ — **отменено в v2**
  (SLATE-16…19, см. PRD). Slate теперь сам резолвит/создаёт workspace через
  суждение модели (`workspace_list` + собственная оценка темы), без нового
  ACL/binding-record сервиса, которого требовал RP-03. RP-03 продолжает
  владеть тем, что v2 НЕ трогает: явный `keryx shell --workspace <id>`,
  `--session current` resolution, Flow/worktree derivation preview,
  accepted-target link-back — см. обновлённый
  [RP-03 README](../shared-agent-context-lifecycle-binding/README.md).
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

## Changelog

- 3.0.0 — Статус v2 (SLATE-16…20) исправлен на Implemented (было ошибочно
  оставлено как Design после реализации — см. Status). Добавлены
  SLATE-22…26 (v3, Design): приватный, MCP-экспонированный slate lifecycle
  для внешних рук (`slate.open`/`writeSeed`/`close`), self-reported Anchors,
  происхождение/доверие Seed (`origin`/`trust`), расширение wrap-up на
  `"external-slate"`-evidence, idle-TTL авто-закрытие. Non-goal «шаринг
  открытого slate между клиентами» не отменяется и не сужается — v3
  расширяет только то, кто может открыть свой собственный slate (см.
  Модель Anchors · Course · Seeds выше, AC-40 в Specification.md).
- 2.0.0 — Статус обновлён на Implemented для SLATE-1…15. Добавлены
  SLATE-16…20 (v2, Design): auto-resolve/create workspace через суждение
  модели, автономный wrap-up dispatch, review confirm-token, cross-runtime
  паритет agent tools. Отменяет SLATE-1/SLATE-15's «никакого auto-create
  workspace» — явное, задокументированное решение пользователя разворачивает
  более раннее «согласовано, раздел 8 исходного обсуждения». RP-03
  Non-goal сужен, не убран целиком.
- 1.0.0 — Исходный пакет (SLATE-1…15), design-only.
