# Keryx Slate — PRD
Version: 2.0.0

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

## Recommendation

**v1 (реализовано):** SLATE-1…15 реализованы. Явно не строить конкурирующую
архитектуру там, где RP-03/05/06/08 уже владеют скоупом — использовать
наименьшие уже существующие в харнесе примитивы как interim-меры (профиль
харнеса, detectSecrets/detectPii), с явной пометкой «заменить при
приземлении RP-*».

**v2 (Design):** Реализовать SLATE-20 (review confirm-token) первым и
независимо — чистый security-фикс, не зависящий от остального v2. SLATE-16/
17/18/19 — единый связанный блок (auto-bind без propose-dispatch
бесполезен; cross-runtime tools нужны SLATE-16/18, чтобы агент мог их
вызвать без `shell_exec`) — реализовать вместе, не по отдельности.
