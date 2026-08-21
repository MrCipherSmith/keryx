# Keryx Slate — PRD
Version: 3.0.0

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

**v2 addendum (после реализации v1).** SLATE-1…15 реализованы и работают, но
проверка против реального кода (текущая сессия) нашла два разрыва,
пережившие реализацию, а не устранённые ей:

1. **Биндинг остался 100% ручным даже там, где v1 планировал его облегчить.**
   `workspaceId` пишется в `slate.json` ровно одним путём — `/goal --workspace
   <id>` (`src/commands/goal-command.ts:181-186`), явно набранным человеком.
   Дефолтный action-intent триггер (обычное «почини X» без `/goal`) никогда
   не биндит вообще. `keryx workspace propose`/`sac.propose` тоже не читают
   `slate.workspaceId` — id вводится заново как позиционный аргумент
   (`src/commands/workspace.ts:96`, `src/mcp/tools.ts:104`), никак не связан
   с тем, что было привязано через `/goal`.
2. **SLATE-7's wrap-up composer, как задумано (machine evidence вместо raw
   transcript), не реализован.** `resolveSessionWrapUp`
   (`src/sac/session-wrap-up.ts:1-110`) по-прежнему буквально экспортирует
   **весь** транскрипт сессии verbatim (`exportSessionMarkdown`) как
   единственное evidence — собственный комментарий файла: «it EXPORTS the
   session's real archive... every role, every message, verbatim». Ни одного
   обращения к `seeds`/`course`/`readSlate` во всём файле. То есть основная
   заявленная цель slate (не raw-transcript evidence) технически не
   достигнута реализацией v1 — SLATE-7 в specification.md описывал
   `resolveMachineWrapUp` как новый резолвер, но реально построенный код
   продолжает вызывать старый `resolveSessionWrapUp`.

Отдельно: пользователь пересмотрел раздел 8 исходного обсуждения («никакого
auto-create workspace на open slate», зафиксированный в v1 как SLATE-1/
SLATE-15's явный non-goal) — новое явное решение (текущая сессия): биндинг
должен быть автоматическим, управляемым суждением агента, а не требовать
`/goal --workspace` каждый раз.

**v3 addendum (после реализации v1/v2).** keryx + Metaproject задуманы как
общее «ядро», а keryx TUI, keryx CLI, Claude Code, Codex и другие агентские
харнессы — «руки», которые должны получать одинаковый функционал ядра
независимо от того, через какой интерфейс идёт обращение. Сегодня это уже
верно для SAC workspace (`sac.workspaceList/Show/Create`, `sac.propose`,
`sac.review` — все stateless MCP-вызовы, `cwd`/`workspaceId`-scoped, не
требуют keryx-сессии) — но не для Slate: `slate.json` живёт и открывается
только `commands/agent.ts`/`tui-shell.ts`/`spawn-subagent-tool.ts`,
in-process, никакого MCP-пути нет.

Важное уточнение, зафиксированное в этой сессии, **исправляющее более раннее
черновое направление обсуждения** (которое предлагало сделать Seeds общим
cross-hand append-логом, ключованным по `(repo, workspace, taskRef)`): смысл
Slate — быть **временным и session/task-local**, не расшариваемым объектом.
Не нужно шарить сам slate между руками — расшаривается workspace. У каждой
руки (keryx shell, Claude Code, Codex) на конкретной задаче есть **свой**
slate (или несколько slate'ов на несколько задач), который помогает именно
этой руке помнить, что она уже сделала, что делает сейчас, что будет делать
дальше — и не терять нить/не повторяться в рамках одной задачи. По закрытию
slate его Seeds диспатчатся в **уже расшаренный** SAC workspace через
существующий `propose`/`review` pipeline — ровно как это делает
keryx-сессия сегодня (SLATE-7/SLATE-18), просто теперь тот же путь должен
быть доступен и внешней руке, а не только внутреннему рантайму keryx.

Записанный non-goal («шаринг открытого slate между клиентами — только
workspace шарится», см. README.md) **не отменяется и не сужается** — он
остаётся буквально верным: ни один код-путь v3 не даёт одной руке видеть
или писать в slate, открытый другой рукой. Единственное новое: **кто может
открыть свой собственный, приватный slate** — раньше только внутренний код
keryx, теперь любой MCP-подключённый клиент.

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

### v2 (Design) — Автоматический binding и cross-runtime паритет

- **SLATE-16 — Workspace resolve-or-create.** **Отменяет** SLATE-1/SLATE-15's
  «никакого auto-create workspace» (явное, задокументированное решение
  пользователя, см. Problem v2 addendum). Процедура запускается в двух
  точках: (1) при создании flow; (2) при открытии slate без flow (дефолтный
  action-intent триггер или `/goal` без `--workspace`). Агент вызывает
  `workspace_list` (SLATE-19), сам оценивает совпадение по теме
  (title/component существующих workspace против текста задачи) — без нового
  similarity/embedding-сервиса, тем же способом, каким уже принимает решения
  `ask_user`/`spawn_subagent` (модельное суждение через существующий
  tool-calling цикл, не новая инфраструктура). Совпадение найдено → биндит
  существующий id. Не найдено → `workspace_create` (SLATE-19) → биндит новый.
  Связь однонаправленная (flow → workspace): `WorkspaceService` не
  индексирует обратно от workspace к flow, и это не меняется этим
  требованием. Привязка пишется как `flow.workspaceId` (новое поле flow
  record, если есть flow) или прямо `slate.workspaceId` (если flow нет —
  ровно то же поле, что SLATE-1 уже определяет).
- **SLATE-17 — Мид-сессийная ре-оценка.** Точка «новый несвязанный вопрос =
  новый slate» (существующая close-trigger эвристика, SLATE-5/`isActionRequest`)
  без `/clear` теперь дополнительно перепроверяет workspace-биндинг через ту
  же процедуру SLATE-16, не только slate-boundary. После `/clear`/`/new` —
  тот же алгоритм, что для новой сессии (без изменений в текущем SLATE-5
  close-поведении).
- **SLATE-18 — Автономный wrap-up dispatch.** SLATE-7's существующие триггеры
  (flow complete, явная команда человека, one-shot-invocation termination)
  остаются без изменений; добавляется: сам wrap-up composer, дойдя до
  propose-worthy момента при наличии `workspaceId`, вызывает
  `workspace_propose` (SLATE-19) сам, без ожидания отдельной человеческой
  команды. Не меняет SLATE-9 («никакой новой review-authority») — propose
  создаёт draft, не accepted knowledge; человеческий чекпойнт остаётся на
  review (SLATE-20).
- **SLATE-19 — Cross-runtime agent-tool паритет.** Найденная асимметрия:
  MCP-клиенты (`src/mcp/tools.ts`) имеют `sac.propose`/`sac.review`/
  `sac.overview`/`sac.read`/`sac.collaboration`, но не `list`/`create`;
  keryx-shell interactive agent (`src/commands/interactive-agent-tools.ts`)
  имеет только `workspace_overview`/`workspace_read` — ни `propose`, ни
  `create`, ни `list`; агент вынужден идти через `shell_exec` (approval-
  трение) для действий, которые MCP-клиент делает вообще без approval
  (`sac.propose`/`sac.review` гейтятся только `interactive: true`, не
  реальной проверкой — см. SLATE-20). Добавляются 4 keryx-shell interactive
  tools, зеркалящие существующий MCP-набор тем же risk-tier'ом, что
  `slate_write_seed` (`risk: "read"` — создаёт draft/discovery, self-accept
  структурно невозможен): `workspace_create` (`{title, component?}`),
  `workspace_list` (`{includeArchived?}`), `workspace_show` (`{workspaceId}`),
  `workspace_propose` (`{workspaceId, kind, sessionId?, note?}` —
  `sessionId` по умолчанию текущая сессия, не требует набирать id заново).
  `workspace_review` **не добавляется** ни в keryx-shell, ни расширяется в
  MCP — остаётся вне agent-tool поверхности на любом раннтайме, на любом
  из трёх (CLI/MCP/keryx-shell).
- **SLATE-20 — Review confirm-token.** Закрывает существующий,
  задокументированный self-accept gap: `sac.review`/`keryx workspace review
  --decision accepted` сегодня гейтятся только `interactive: true` (хардкод,
  не проверка) — MCP-клиент технически может accept свой же proposal без
  реального человеческого действия (`src/mcp/tools.ts:138-142`'s собственный
  комментарий: «matches current MCP trust posture... does not invent a
  stricter MCP-specific policy» — известный, ранее сознательно отложенный
  gap, не новая находка). Новая команда `keryx workspace confirm-review
  <workspace-id> <proposal-id>` печатает короткоживущий (2 минуты),
  одноразовый токен — требует реальный терминал, или `shell_exec` (уже
  гейтится существующим approval — тот же барьер, что и любая другая
  мутирующая команда). `decision: "accepted"` (и только `"accepted"` —
  `"rejected"`/`"dismissed"` не требуют токена, они ничего не promote)
  требует этот токен как дополнительный параметр; без валидного,
  непросроченного, неиспользованного токена review завершается
  `token_required`/`token_invalid`, никогда не проходит по умолчанию.
  Особенно важно теперь, когда SLATE-16/18 делают create+bind+propose
  полностью автономными — review остаётся единственной точкой, где
  обязателен человек.
- **SLATE-21 — Довести SLATE-7 до задуманного (machine evidence, не
  транскрипт).** Не новое требование v2 по духу — SLATE-7 (v1) уже
  специфицировал `resolveMachineWrapUp` под `WrapUpSource === "flow"`, но
  реально построенный код (`src/sac/session-wrap-up.ts`) продолжает вызывать
  старый `resolveSessionWrapUp`, который экспортирует **весь** транскрипт
  сессии verbatim как единственное evidence (см. Problem v2 addendum) —
  разрыв между спекой и реализацией, найденный этой сессией, не новое
  решение. Исправление: evidence кандидата собирается из `anchors.touched`
  (файлы) + git diff по ним + `course.flowRef`/статус flow + `seeds[]` как
  основной текст evidence; полный экспорт транскрипта (`exportSessionMarkdown`)
  сохраняется как ссылка-приложение (не embedded, не убран целиком —
  пользовательское решение этой сессии), доступная ревьюеру по клику, а не
  единственный источник.

### v3 (Design) — Приватный slate для внешних рук (core/hands parity)

- **SLATE-22 — MCP-экспонированный приватный slate lifecycle.** Новые MCP
  tools `slate.open`/`slate.writeSeed`/`slate.close` (module `slate`),
  зеркалящие внутренний lifecycle `commands/agent.ts`/`tui-shell.ts` тем же
  паттерном, что и `sac.workspaceCreate` (SLATE-19b) зеркалит внутренний
  workspace-lifecycle. Каждый вызов scoped по `(cwd, externalSessionId)`, где
  `externalSessionId` — непрозрачная строка, которую поставляет сам
  вызывающий клиент (например, собственный id разговора/задачи Claude Code)
  — это НЕ keryx session id, у внешней руки нет keryx-сессии на диске.
  `slate.open` идемпотентен для уже открытого `externalSessionId` — повторный
  вызов с тем же id возвращает текущее состояние существующего slate, а не
  ошибку и не второй конкурирующий файл (восстановление после потери
  handle). Никакого list/read-эндпоинта, охватывающего несколько
  `externalSessionId`, не добавляется — это прямое условие сохранения
  non-goal (см. PRD v3 addendum, AC-40).
- **SLATE-23 — Self-reported Anchors для внешних рук.** `slate.open`/
  `slate.writeSeed` принимают опциональный `anchors`-payload (`root`,
  `touched?`, свободный `note?`), который поставляет **сама вызывающая
  рука** — то, что она реально знает о себе. keryx сохраняет как есть,
  нормализует форму, никогда не вычисляет/не обогащает (никакого tree-walk,
  никакого runtime-probing чужого процесса) — в отличие от SLATE-2, где
  Anchors для keryx-native сессий вычисляет сам харнесс. Это осознанно
  отдельный код-путь, не обобщение SLATE-2 — SLATE-2 для keryx-native
  сессий не меняется.
- **SLATE-24 — Происхождение и доверие Seed.** `SlateSeed` получает два новых
  поля: `origin: { harness: string; sessionRef?: string }` (обязательно на
  каждом Seed, записанном через SLATE-22 MCP-путь; автозаполняется
  `{ harness: "keryx" }` для Seeds, записанных через существующий
  keryx-native `slate_write_seed` tool — без изменения поведения там) и
  `trust: "external-unverified"` (фиксированное значение — v3 не строит
  модель скоринга доверия, только делает факт внешнего происхождения видимым
  и машинно-читаемым для reviewer'а). Экраны review (CLI `workspace review`,
  TUI review modal) показывают `origin.harness` рядом с каждым Seed в
  evidence предложенного proposal.
- **SLATE-25 — Wrap-up принимает evidence внешнего slate.** `WrapUpSource`
  получает третий вариант, `"external-slate"` (наряду с существующими
  `"session"`/`"flow"`), потребляемый уже существующим и работающим
  `resolveMachineWrapUp` (`src/sac/machine-wrap-up.ts`, композитор
  SLATE-7/21) — SLATE-25 добавляет к нему новый branch, не дублирует и не
  ждёт его. `slate.close` внешнего slate с уже
  привязанным `workspaceId` вызывает `propose` ровно так, как SLATE-18 уже
  делает для keryx-native автономного диспатча — тот же единственный гейт
  (человеческий `review`/`accept`), никакой новой review-authority, никакого
  нового self-accept пути. Если `workspaceId` не привязан — `slate.close`
  ведёт себя как v1's `unbound-candidate`-путь (SLATE-1): накопленные
  Anchors+Seeds сохраняются локальным артефактом, видны в следующем
  `workspace catch-up`, никогда не теряются молча. `slate.open` без явного
  `workspaceId` запускает ту же процедуру SLATE-16 resolve-or-create, что и
  keryx-native slate-open — не новую процедуру, тот же путь, применённый и к
  внешней руке (это и есть определение «одинаково для всех рук»).
- **SLATE-26 — Idle-TTL авто-закрытие внешнего slate.** У внешней руки нет
  OS-процесса, которым управляет keryx, поэтому заброшенный открытый slate
  (краш клиента, забытый `slate.close`) нуждается в реклейм-механизме,
  которого нет у keryx-native in-process lifecycle. `slate.json` под внешним
  namespace хранит `lastWriteAt`; slate, чей `lastWriteAt` превышает уже
  существующий stale-lock threshold (`withFileLock`, `src/lib/fs.ts` — тот
  же порог, что уже используют критерии `unknown`-классификации SLATE-10, не
  новый) — авто-закрывается при следующем любом `slate.*`-вызове,
  затрагивающем тот же `cwd` (не фоновым таймером/демоном — у keryx нет
  scheduler-инфраструктуры, тот же pull-based принцип, что и у SLATE-10).
  Авто-закрытие идёт тем же путём диспатча/`unbound-candidate`, что и явный
  `slate.close`.

- Anchors.root/tree актуальны на момент первого tool call сессии — баг
  «читал не тот checkout» не повторяется.
- 0 новых proposal с raw-transcript evidence.
- Ни один сабагент не создаёт propose/flow-complete напрямую.
- Ни один unattended-actor не может технически выполнить `accept` без
  interactive-профиля, выставленного человеком заранее.
- Каждый unattended-запуск (успешный, blocked, crashed) диагностируем через
  SLATE-10 catch-up — ни один класс исхода не исчезает молча.
- **v2:** Ни один SLATE-16 resolve-or-create вызов не биндит workspace без
  предварительного `workspace_list` — никогда «угадано» без вызова
  инструмента.
- **v2:** Ни один `decision: "accepted"` review не проходит без валидного
  confirm-token, ни через CLI, ни через MCP.
- **v2:** Одинаковый набор операций (`create`/`list`/`show`/`overview`/`read`/
  `propose`) доступен через CLI, MCP, keryx-shell interactive tools —
  review-accept остаётся единственным исключением на всех трёх.
- **v2:** Сабагент никогда не резолвит/не создаёт workspace и не вызывает
  `workspace_propose` сам — только родитель (без изменений от SLATE-9/AC-3).
- **v3:** Ни один код-путь не даёт одному `externalSessionId` прочитать или
  записать slate другого `externalSessionId` — non-goal остаётся буквально
  верным после v3 (см. AC-40).
- **v3:** Anchors внешнего slate — ровно то, что прислала вызывающая рука;
  keryx ничего не довычисляет за неё.
- **v3:** Каждый Seed, продиспатченный из внешнего slate, несёт
  `origin.harness` и `trust: "external-unverified"` в evidence proposal'а,
  видимые ревьюеру.
- **v3:** Заброшенный внешний slate не остаётся открытым бессрочно — авто-
  закрывается тем же путём, что и явный close, без фонового демона.

## Risks

- **Self-accept pre-existing gap** — SLATE-8 смягчает через переиспользуемый
  профильный gate (interactive-барьер на `accept`); **SLATE-20 (v2) закрывает
  его полнее** через confirm-token, не устраняет полностью до приземления
  RP-06 (OS-UID-only identity остаётся; токен поднимает планку с «ничего» до
  «требует реального terminal-присутствия или explicit shell approval», не
  заменяет полноценную identity-модель).
- **Evidence security** — SLATE-12 — временная мера, не полная защита до
  RP-05 (сегодня `detectSecrets`/`detectPii` не покрывают весь класс утечек,
  который RP-05 специфицирует: monotonic sensitivity, retention, deletion).
- **Course staleness / dual-trigger idempotency / concurrency slate.json** —
  закрыты конкретными инженерными фиксами (try/catch→unbound, `withFileLock`,
  attempt-scoped evidence) — см. Specification AC.
- **Overlap с RP-03/05/06/08** — если эти пакеты продвинутся в реализацию
  раньше slate, часть interim-мер (SLATE-8's профильный gate, SLATE-12's
  прямой вызов detectSecrets/detectPii) должна быть заменена на их
  финальные механизмы, а не оставлена как параллельная архитектура. **v2**
  сужает RP-03's Non-goal (см. README.md), а не убирает его целиком —
  `keryx shell --workspace <id>`, `--session current`, Flow/worktree
  derivation preview, accepted-target link-back остаются RP-03's скоупом.
- **v2 — Дубликаты workspace от плохого суждения модели.** SLATE-16's
  «совпадение по теме» — модельное суждение, не гарантированно точное;
  плохое суждение может расплодить несколько workspace под одну тему.
  Смягчается: (1) `workspace_list` обязателен ДО `create` — модель не может
  создать не проверив существующие; (2) дубликаты не теряют данные — их
  можно archive/rename постфактум через уже существующий
  `sac-workspace-lifecycle`.
- **v2 — Confirm-token не полная защита.** Не защищает от скомпрометированного
  терминала или заранее одобренного (`allow always`) `shell_exec`-паттерна на
  саму команду `confirm-review` — только поднимает планку, не заменяет
  полноценную identity-модель (RP-06).
- **v3 — Prompt injection в Seeds от недоверенной руки.** `trust:
  "external-unverified"` делает происхождение видимым, но не проверяет его —
  внешняя рука, скомпрометированная prompt injection'ом, всё ещё может
  записать вводящий в заблуждение Seed. Смягчается тем же гейтом, что и
  сегодня: Seed никогда не становится Know-how без `workspace review`
  (SLATE-9, без изменений) — человек видит `origin.harness` и трактует
  внешний evidence с поправкой на источник. Полноценная identity/доверие —
  скоуп RP-06, v3 сознательно не строит эту модель сам.
- **v3 — Семантические (не exact-text) дубликаты Seeds от разных рук на
  одной теме.** Каждая рука пишет в свой приватный slate, поэтому дедуп
  внутри одного slate (SLATE-4/AC-23, exact-text) не меняется — но если
  несколько рук независимо продиспатчат Seeds об одном и том же факте
  разными proposal'ами, ревьюер увидит несколько формулировок одной идеи.
  Не решается в v3 (явный follow-up, не блокер) — сегодняшний `workspace
  review` уже требует ревьюера читать evidence целиком, это не новый класс
  нагрузки, только более частый в мире с несколькими руками.
- ~~**v3 — Расширение `sac.propose`/`WrapUpSource` может опередить
  SLATE-7/21.**~~ **Снято** — проверено в этой же сессии, одной ревизией
  позже: SLATE-21/`resolveMachineWrapUp` уже реализован и слит (PR #314), не
  требует отдельного приземления перед SLATE-25.

## Recommendation

**v1 (реализовано):** SLATE-1…15 реализованы. Явно не строить конкурирующую
архитектуру там, где RP-03/05/06/08 уже владеют скоупом — использовать
наименьшие уже существующие в харнесе примитивы как interim-меры (профиль
харнеса, detectSecrets/detectPii), с явной пометкой «заменить при
приземлении RP-*».

**v2 (реализовано, README до этой ревизии ошибочно помечал как Design):**
SLATE-16…20 реализованы и на main (см. README.md changelog). **Исправление
в этой же сессии, одной ревизией позже:** SLATE-21 (machine evidence вместо
raw-transcript) тоже реализован — `src/sac/machine-wrap-up.ts` (588 строк,
`resolveMachineWrapUp`/`runWrapUp`) и `src/sac/session-wrap-up.ts` (переиспользует
его `courseStatusLine`/`dedupedAttributedSeeds`/`diffStatLine`/`gitDiff` как
primary evidence, transcript — evidence[2], reference-only). Подтверждено
`gh pr view 314` (`MERGED`, 2026-08-17) и journal'ом flow 166. Более ранняя
версия этого документа (в этой же сессии) ошибочно утверждала обратное —
на основе неудавшегося `find`, не перепроверенного прямым чтением файла.

**v3 (Design):** Никакой внешней зависимости у SLATE-25 больше нет —
`resolveMachineWrapUp` уже существует и работает для `"flow"`-источника;
SLATE-25 добавляет к нему branch `"external-slate"`, не ждёт его появления.
SLATE-22/23/24/25/26 — единый связанный блок v3, реализовать одним раундом
(lifecycle + self-reported anchors + provenance tag + wrap-up dispatch не
имеют смысла по отдельности: приватный slate без Anchors бесполезен агенту,
Seeds без provenance не должны диспатчиться внешней рукой, а dispatch без
lifecycle нечего диспатчить). SLATE-26 (idle-TTL) технически независим и
может быть отдельной, самой маленькой задачей внутри того же Flow.
