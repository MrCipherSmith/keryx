# Keryx Slate — PRD
Version: 1.0.0

## Problem

У харнеса keryx нет живой «обстановки задачи» во время работы: root/worktree
не сообщается модели явно, нет привязки session↔workspace, а единственный
путь возврата результата сессии в проект — ручной `workspace propose
--session`, который сегодня экспортирует **весь** транскрипт сессии verbatim
как evidence (`src/sac/session-wrap-up.ts` `exportSessionMarkdown`) — на
грани нарушения `docs/requirements/shared-agent-context/agent-protocol.md`
(«no raw transcript as candidate input»).

Инцидент, из которого выросла фича: сравнение keryx TUI (deepseek) vs Grok на
задаче «сделай /info» — keryx упёрся в лимит 8 non-read tool calls, читал не
тот checkout, спрашивал provider через `ask_user`, после budget wrap-up в
history осталась фраза «Do NOT call tools», перманентно отравляя остаток
сессии (`src/commands/agent.ts` `finishWithBudgetSummary`).

Отдельно: пользователь требует, чтобы keryx работал как интерактивно, так и
полностью автономно («получив задачу, ушёл, keryx работает без меня»).
Security/autonomy review (раунд 3) показал: self-accept в SAC технически уже
возможен сегодня (`localWorkspaceAuthorizationServer` в
`src/sac/workspace-service.ts` выводит actor только из OS uid/pid, не
различая человека и агента от его имени) и становится **структурным
дефолтом**, а не краевым случаем, при полностью автономной работе без
дополнительных мер.

## Goal

Дать харнесу дешёвый, task-local слой состояния на время одной задачи —
так, чтобы агент (родитель и сабагенты) не терял контекст исполнения, а
результат сессии попадал в существующий SAC `propose`/`review` через
машинно-собранные факты, а не дамп транскрипта — и чтобы это одинаково
безопасно работало и при человеке за терминалом, и в его отсутствие.

## Users

- Агент/харнес во время исполнения задачи.
- Reviewer, принимающий `workspace propose` — включая случай, когда review
  происходит утром, после ночи unattended-запусков.
- Оркестратор сабагентов.
- Оператор, настраивающий unattended/scheduled запуск keryx (`--unattended`
  на `keryx harness run`; для `keryx serve` — отдельный, уже существующий
  `--profile`/`serve.json`-механизм, не тот же флаг) — keryx сам не имеет
  cron/scheduler; внешний планировщик (cron, systemd timer, CI) вызывает
  keryx с уже зафиксированным профилем.

## Product requirements

- **SLATE-1 — Storage & lifecycle.** Slate — sibling-артефакт внутри
  существующей директории сессии (`src/session/paths.ts` `sessionDir()`), не
  новый сервис, не новое ID-пространство, не git-tracked, никогда не пишется
  в `.metaproject/`. Живёт и умирает с сессией; при последовательных задачах
  в одной shell-сессии архивируется под attempt-специфичным именем на закрытии
  — не тихий overwrite. Хранит `workspaceId?` верхнего уровня (не под
  Anchors/Course) — записывается один раз, при первом успешном explicit-
  consult (`workspace_overview`/`workspace_read`/`slate_read` с явным id) за
  время жизни slate, **или явно через `/goal --workspace` (SLATE-15)** — без
  какого-то из двух путей ничего не инициирует consult само по себе, и
  `workspaceId` останется unset на весь сеанс. Без него SLATE-7 не может
  вызвать `propose` (см. ниже).
- **SLATE-2 — Anchors.** Harness-owned: root, tree, runtime, touched,
  опциональный fence. Пишет только код харнеса; модельная проза никогда не
  источник. На restart/resume всегда пересобираются из живого состояния
  репозитория, никогда не наследуются от прежнего slate. Никогда не источник
  авторизации (не access-по-близости-worktree — согласовано с non-goal RP-08).
- **SLATE-3 — Course.** Не хранит контент — хранит только `flowRef`-указатель;
  `now/next/done/blocked` всегда читаются live через существующую Flow-
  проекцию. Пере-синк на каждый consult и перед wrap-up. Ни slate, ни агент
  не может вызвать `flow complete` сам. Try/catch вокруг flow-read в
  `createLocalFwkReadService` (`src/sac/fwk-service.ts`) — **не
  slate-эксклюзивный фикс**: сегодня `workspace overview`/`workspace read`
  уже может упасть необработанным исключением при race между list/read
  referenced-flow файла, независимо от slate; включён в этот раунд заодно.
- **SLATE-4 — Seeds.** Append-only, model-writable гипотезы; никогда не
  auto-promote. Дедуп перед wrap-up — v1 только точное совпадение текста
(trimmed), similarity/embedding-дедуп не входит в v1, отложен явно (AC-23).
Каждый Seed
  может нести опциональный `kind` (`decision|wiki-update|memory-entry|
  follow-up|contract-change|risk`) — определяет, какой owner-writer примет
  его при accept; без тега Seed попадает в дефолтную группу `follow-up`
  (наименее рискованный fallback: неверно классифицированный follow-up
  стоит ревьюеру перечитывания, неверно классифицированный wiki-update/
  memory-entry — запись не в ту подсистему).
- **SLATE-5 — Открытие/закрытие.** Открывается на action-intent (шире
  нынешнего `isActionRequest`), с привязкой к тому же slate при последующем
  оформлении flow. Закрывается на flow done/явную команду человека/выход
  шелла (только temp snapshot). В unattended-режиме закрытие Course
  (SLATE-8) и review-gate должны быть исправлены **вместе**, никогда по
  отдельности — фикс одного без другого снимает последний ручной барьер
  раньше технического.
- **SLATE-6 — Ephemeral slate сабагента.** Полный slate (Anchors+Course+
  Seeds) на время dispatch. Два независимых канала возврата: (1) work-result
  — без изменений, verbatim в промпт родителя; (2) slate-state — отдельная
  немерженная запись `parent.slate.childDispatches[dispatchId]` со `status:
  completed|incomplete`, никогда не сливается в собственные Anchors/Course/
  Seeds родителя. Структурная защита от self-accept-подобного round-trip
  laundering (родитель не переавторит Seed ребёнка как свой — провенанс
  встроен в форму данных). Партиальное состояние при crash/timeout всё равно
  отдаётся, помечено `incomplete`.
- **SLATE-7 — Сборщик wrap-up.** Machine evidence (git diff, flow snapshot,
  Seeds) + модельный summary с первой версии (реюз `runModelTurn`,
  `src/harness/provider/single-turn.ts`). Fail-closed (нет proposal) только
  при отсутствии credential; bounded timeout → механический fallback на
  шаблонную summary при медленном provider с валидным credential. Evidence
  пишется attempt-scoped, не id-keyed — retry не привязывает summary к
  другому snapshot'у. Триггеры: flow complete, явная команда человека, **или
  естественное завершение процесса one-shot `keryx harness run`/`--goal`-
  инвокации** (не REPL `keryx shell`, где сессия остаётся открытой много
  ходов) — без этого третьего триггера задача без Flow и без человека,
  говорящего «готово» (типичный unattended-случай), никогда бы не дошла до
  wrap-up вообще. Каждый kind-group Seeds (см. Data contracts) даёт отдельный
  `propose`-вызов — один wrap-up может породить больше одного proposal.
  **Обязательное условие для реального `propose`**: `slate.workspaceId`
  должен быть захвачен раньше в жизни slate (SLATE-1) — `Course.flowRef` не
  даёт reverse lookup на workspace (flow может быть resource'ом нескольких
  workspace или ни одного, обратного индекса в `WorkspaceService` нет).
  Без `workspaceId` `propose` не вызывается вообще — evidence+summary
  сохраняются локальным артефактом, не теряются молча, видны в catch-up как
  `unbound-candidate`.
- **SLATE-8 — Human observation checkpoint / unattended session-profile
  gate.** В интерактивном режиме wrap-up-триггер обязан оставаться surfaced-
  действием. В unattended-режиме `accept` (и Course-close) гейтятся по уже
  существующему контекстному полю **`interactive: boolean`**
  (`src/harness/policy/engine.ts`, `src/harness/mutation/approval.ts`'s
  правило (h): `interactive === false → deny`) — не по `PolicyProfile`/
  `compareProfiles`. Это две разные оси: profile отвечает «что этому ходу
  разрешено делать» (capability ceiling), `interactive` — «может ли человек
  прямо сейчас ответить/подтвердить». Практическое следствие: для `keryx
  serve`-сессий `interactive` захардкожен в `false` независимо от
  сконфигурированного профиля (SSE-стриминг — только replay постфактум, не
  делает сессию «наблюдаемой в реальном времени») — значит **любая** `keryx
  serve`-сессия уже unattended для SLATE-8 без необходимости смотреть на
  профиль. Для локальных scheduled-запусков (`keryx harness run`) флага для
  этого сегодня **не существует** (`--profile` есть только у `keryx serve`/
  `serve.json`, для другой оси — capability ceiling, не interactive) —
  реальный prerequisite: добавить **булев** `--unattended`-флаг (не
  `--profile`-селектор — сознательно один флаг, отдельное имя от
  `PolicyProfile`, чтобы не смешивать две оси, которые SLATE-8 специально
  разводит) в `src/commands/harness.ts`, устанавливаемый человеком заранее
  (cron/systemd/CI вызывает keryx с уже зафиксированным флагом), никогда самим агентом в
  момент запуска — иначе внешний сигнал схлопывается в самодекларацию.
  Deferred-queue модель: unattended-сессия делает `propose` как обычно,
  `accept` ждёт следующей interactive-сессии человека.
- **SLATE-9 — Никакой новой review-authority.** `workspace review --decision
  accepted` остаётся управляемым ровно как сегодня (owner/editor role, запрет
  self-accept из `agent-protocol.md`). Ни один код-путь slate не связывает
  flow-complete → propose → accept без отдельного, явно surfaced/gated
  человеческого шага.
- **SLATE-10 — Catch-up review flow.** Команда/query (pull, не push — такой
  инфраструктуры в keryx нет), агрегирующая на возврате человека три
  раздельные категории: (1) pending proposals, (2) blocked/incomplete
  unattended-запуски (явный fail-closed safe-stop с terminal-state), (3)
  unknown/crashed (процесс упал без записи любого terminal-state). Жёстко
  раздельные секции, не единая лента. Freshness-check перед показом каждого
  proposal (не только на accept), явная пометка stale. Per-item — question+
  options+recommendation интервью-формат.
- **SLATE-11 — Course.blocked/ask_user unattended default.** Fail-closed
  safe-stop, не retry-с-дефолтами (которое потребовало бы новой декларации
  «что можно дефолтить», которой сегодня нет). Структурированный machine-
  readable terminal state (по образцу `KERYX_INSTALLATION_RESULT` из
  `docs/docs/agent-installation-playbook.md`), не вольный текст сегодняшнего
  `finishWithBudgetSummary`, который перманентно пишет инструкцию в общий
  session history без TTL/scoping.
- **SLATE-12 — Interim evidence scan.** До приземления RP-05, SLATE-7 вызывает
  уже существующие `detectSecrets`/`detectPii` (`src/security/detect/*`) на
  evidence перед persist — `security.gate` на proposal перестаёт быть
  хардкодом (`src/sac/proposal-lifecycle.ts:59` сегодня пишет буквальный
  `"pass"`). Временная мера, не конкурирующая архитектура — RP-05 суперсидит
  при приземлении. **Не slate-эксклюзивный фикс**: это баг сегодняшнего
  `keryx workspace propose --session` независимо от того, реализован slate
  или нет — включён в этот пакет для реализации в одном раунде с ним, не
  потому что slate его создал.
- **SLATE-13 — General-purpose proposal listing.** `listProposedProposals`/
  `listVisibleProposedProposals` (уже нужны внутри SLATE-10 как helper'ы)
  выставляются также как самостоятельная команда
  `keryx workspace list-proposals [<workspace-id>]` — сегодня узнать, что
  ждёт review на workspace, можно только зная точные id proposal'ов или читая
  сырые JSON-файлы в `proposals/` руками; `ProposalLifecycleService` не имеет
  `list()`-метода вообще. Полезно независимо от unattended-режима/catch-up.
- **SLATE-14 — Исправить вводящий в заблуждение комментарий self-accept.**
  `createLocalProposalLifecycleService` (`src/sac/proposal-lifecycle.ts`)
  утверждает в комментарии «Local CLI/stdin MCP composition... can never
  self-accept» — но реальные CLI/MCP-хендлеры `propose`/`review`
  (`src/commands/workspace.ts`, `src/mcp/tools.ts`) используют
  `createHarnessProposalLifecycleService`, не эту композицию вообще.
  Комментарий описывает недостижимый/неиспользуемый код-путь как будто это
  реальная защита — исправить текст (или, если композиция действительно
  мертва, явно пометить/удалить её), чтобы не создавать ложного чувства
  безопасности у будущих читателей кода.
- **SLATE-15 — Явный `/goal`-триггер.** Найденная дыра: ничего сегодня не
  инициирует workspace-consult само по себе — обычная задача без явного
  упоминания workspace в разговоре навсегда остаётся с unset `workspaceId`
  и оседает в catch-up как `unbound-candidate`, никогда не попадая в
  workspace. `/goal <текст цели> [--workspace <id>]` — детерминированная
  альтернатива нечёткому `isActionRequest`-классификатору: открывает slate
  сразу (не полагаясь на классификатор), и если дан `--workspace` —
  валидирует id (видимость по роли через существующий `WorkspaceService`)
  и записывает `slate.workspaceId` явно. Без `--workspace` — slate
  открывается как обычно, `workspaceId` остаётся unset (никакого
  авто-create workspace — согласовано с уже принятым «не авто-create доски
  на open slate», раздел 8 исходного обсуждения). Тот же механизм
  доступен как CLI-флаги на `keryx harness run --goal "<текст>" --workspace
  <id> [--unattended]` — даёт scheduled/unattended-запускам детерминированный
  способ открыть slate и связать workspace без зависимости от классификатора
  и без человека, печатающего что-то в реальном времени (закрывает
  практический пробел, отмеченный в SLATE-8: «инструкции unattended-задачи
  должны называть workspace id»).

## Success criteria

- Anchors.root/tree актуальны на момент первого tool call сессии — баг
  «читал не тот checkout» не повторяется.
- 0 новых proposal с raw-transcript evidence.
- Ни один сабагент не создаёт propose/flow-complete напрямую.
- Ни один unattended-actor не может технически выполнить `accept` без
  interactive-профиля, выставленного человеком заранее.
- Каждый unattended-запуск (успешный, blocked, crashed) диагностируем через
  SLATE-10 catch-up — ни один класс исхода не исчезает молча.

## Risks

- **Self-accept pre-existing gap** — SLATE-8 смягчает через переиспользуемый
  профильный gate, не устраняет полностью до приземления RP-06.
- **Evidence security** — SLATE-12 — временная мера, не полная защита до
  RP-05 (сегодня `detectSecrets`/`detectPii` не покрывают весь класс утечек,
  который RP-05 специфицирует: monotonic sensitivity, retention, deletion).
- **Course staleness / dual-trigger idempotency / concurrency slate.json** —
  закрыты конкретными инженерными фиксами (try/catch→unbound, `withFileLock`,
  attempt-scoped evidence) — см. Specification AC.
- **Overlap с RP-03/05/06/08** — если эти пакеты продвинутся в реализацию
  раньше slate, часть interim-мер (SLATE-8's профильный gate, SLATE-12's
  прямой вызов detectSecrets/detectPii) должна быть заменена на их
  финальные механизмы, а не оставлена как параллельная архитектура.

## Recommendation

Реализовать SLATE-1…12 как v1. Явно не строить конкурирующую архитектуру
там, где RP-03/05/06/08 уже владеют скоупом — использовать наименьшие уже
существующие в харнесе примитивы как interim-меры (профиль харнеса,
detectSecrets/detectPii), с явной пометкой «заменить при приземлении RP-*».
