# Спецификация · Review v3
Version: 0.1.0

Статус: этап 1 реализуется в Flow 524; остальное — draft. Раздел «Основания» описывает код `origin/main` на коммите `ddad229f1`. Имена полей и команд этапа 1 окончательные, остальных этапов — предварительные.

## Идентичность модуля

Изменение затрагивает бэкенд ревью (`src/review/review-state*.ts`, `src/commands/review-state.ts`, позднее `src/review/desk-run-*`), скилл `review-orchestrator` (раздел «Desktop review state»; обе копии — `.metaproject/skills/gdskills/review/` и `src/gdskills/bundled/skills/review/`) и Desktop (`apps/desktop/src/App.tsx`, `apps/desktop/src/review/`). Формат пакета раунда, состав ревьюеров и волны не меняются.

Смежные спецификации: [Review v2](../keryx-desktop-review-v2/specification.md), [пакеты управляемого ревью](../managed-review-feedback-loop/specification.md).

## Основания

| № | Наблюдение | Где в коде |
|---|---|---|
| B1 | «Run review» на доске и во вкладке Reviews идёт через `boardReviewRun` → `startSessionReview`: создаётся новая сессия (`newSession()` без `bindSubject`, привязанная к PR сессия не переиспользуется), затем `review_run start` запускает отсоединённый исполнитель | `apps/desktop/src/App.tsx:625-660` |
| B2 | Сессия только владеет попыткой (`DeskRun.sessionId`); ход в неё отправляет текст агенту, который ревью не ведёт | `apps/desktop/src/App.tsx:629`, `src/review/desk-run-types.ts` |
| B3 | «Continue review» в карточке сессии создаёт новую попытку с `guidance` (`review_run continue`) | `apps/desktop/src/review/SessionReviewActivity.tsx:135-157` |
| B4 | `openSubjectSession` открывает последнюю привязанную к PR сессию или создаёт новую и привязывает её (`subject` в `flags.json`); `subjectOpener` не даёт открыть две сразу | `apps/desktop/src/review/prWork.ts:203-238` |
| B5 | `sendPrompt(text, sessionId)` начинает ход в удерживаемой и свободной сессии и возвращает `false`, если сессия занята | `apps/desktop/src/session/useAcpSession.ts:376-422` |
| B6 | Shell-процессы сессии ACP получают `KERYX_REVIEW_SESSION_ID`; `keryx review start` по PR в такой сессии регистрирует пакет как попытку `session` в `runs.sqlite` | `src/acp/server.ts:636`, `src/commands/review.ts:1303-1321`, `src/review/session-attempt.ts` |
| B7 | Пакет раунда создаётся в `.metaproject/reviews/<package-id>/`; не меньше восьми сканеров ищут пакеты как `.metaproject/reviews/*/manifest.json` и пропускают каталоги без `manifest.json` | `src/review/managed.ts:1345`, `src/review/publish-guard.ts:89-106`, `src/review/completion-gate.ts:735-748` |
| B8 | В shell ACP `/review` — команда-представление «что ждёт ревью в проекте», а не запуск скилла | `src/standard/help-groups.ts:368-372`, `src/acp/shell-command-views.test.ts:795` |
| B9 | Ключ настроек запуска уже есть: `deskOptionsKey(options)` | `src/review/desk-run-options.ts:84` |
| B10 | Метки сессии в окне: `busy`, `waiting` (разрешение или `ask_user`), `running` (субагенты и задачи), `subagents` | `apps/desktop/src/session/reducer.ts:757-768` |

## Сущности

```text
PullRequest (GitHub)
      │ subject
      ├── Review ── review.json ── Round ── Session (одна текущая, история перезапусков)
      │                              └── Package (.metaproject/reviews/<package-id>)
      └── Session (привязанные к PR)
```

- **Review** — ревью одного PR одним аккаунтом. Ключ: репозиторий, номер PR, аккаунт (D3 v2). Одна карточка.
- **Round** — проверка одной пары base..head с одним ключом настроек. Номер раунда растёт только по правилу R5.
- **Session** — живая сессия агента, в которой идёт раунд. Продолжение — ход в ней. Перезапуск после сбоя добавляет новую сессию тому же раунду.
- **Attempt** (v2) — остаётся только для чтения старых данных и для ревью по расписанию до этапа 4.

## Хранение

```text
.metaproject/reviews/pr/<review-id>/
  review.json      # состояние, пишет только `keryx review state`
  journal.md       # журнал: строка на каждую запись CLI и заметки скилла
```

- `<review-id>` — `<owner>-<name>-<number>` и через дефис аккаунт, если он известен; всё в нижнем регистре, символы кроме `[a-z0-9-]` заменяются на `-`. Функция `reviewStateId` переносима и используется Desktop.
- Каталог `pr/` не содержит `manifest.json`, поэтому сканеры пакетов (B7) его пропускают.
- **Пакет раунда остаётся в `.metaproject/reviews/<package-id>/`**, раунд хранит относительный путь к нему (`package`). Это постоянное место в проекте, а не временная копия попытки. Физический перенос пакетов под `rounds/rNN/` не делается: на него опираются `findPreviousRound`, реестр раундов, гейты завершения и защита публикации (решение V3 плана).
- Запись — под блокировкой файла (`withFileLock`) и атомарно (`writeFileAtomic`); каждая запись добавляет строку в `journal.md`.

## Схема `review.json`

```ts
interface ReviewRecord {
  schema: "keryx.review";
  version: 1;
  id: string;
  pr: { repo: string; number: number; url: string; repositoryId?: string };
  viewer: string | null;
  state: "draft" | "reviewing" | "ready" | "published" | "stale" | "closed";
  onHeadMove: "ask" | "follow" | "ignore";           // D2 v2: ask по умолчанию
  source: "desktop" | "session" | "scheduled";
  createdAt: string; updatedAt: string;
  rounds: ReviewRound[];                              // по возрастанию number
  publications: { round: number; headSha: string; verdict: Verdict; url?: string; at: string }[];
  migratedFrom?: { store: "runs.sqlite"; reviewId: string; runIds: string[] };
}

interface ReviewRound {
  number: number;
  baseSha: string; headSha: string;                   // полные SHA
  settingsKey: string | null;                         // deskOptionsKey; null — неизвестен
  state: "planning" | "dispatching" | "reconciling" | "ready" | "paused";
  previousRound: number | null;
  package: string | null;                             // путь пакета относительно проекта
  sessionId: string | null;                           // текущая сессия раунда
  sessions: { id: string; openedAt: string; reason: "start" | "restart" }[];
  plan: { slices: number; waves: number; assignments: { done: number; total: number } } | null;
  reviewers: { role: string; state: "running" | "done" | "failed"; findings?: number }[];
  usage: { tokens: number; costUsd: number | null };
  findings: { blocker: number; major: number; minor: number; info: number; carried: number; rechecked: number } | null;
  verdict: Verdict | null;
  openedAt: string; updatedAt: string;
}
type Verdict = "approve" | "comment" | "request-changes";
```

Файл с другим `schema` или `version` CLI не меняет и сообщает об этом; Desktop показывает такое ревью как «неизвестный формат».

### Состояние Review

| Состояние | Когда ставится |
|---|---|
| `draft` | Review создан без раунда (миграция, `state open` без head не бывает) |
| `reviewing` | открыт раунд, он не `ready` |
| `ready` | текущий раунд `ready` |
| `published` | `state publish` для текущего раунда |
| `stale` | `state mark --state stale`: head PR ушёл от head текущего раунда |
| `closed` | `state mark --state closed`: PR слит или закрыт, или пользователь закрыл ревью |

`state open` на `closed` отказывает без `--reopen`. Из `stale` новый раунд переводит в `reviewing`.

### Состояние раунда

`planning → dispatching → reconciling → ready`, плюс `paused` из любого не-`ready` состояния (скилл остановился: сбой провайдера, вопрос без ответа, конец хода без завершения). Переход назад к `planning` разрешён только из `paused`. `ready` — конечное для раунда: новые записи плана и ревьюеров в `ready`-раунд отклоняются, кроме `--verdict`, `--findings`, `--usage`.

### Правило номера раунда (R5)

`keryx review state open` с `--base`, `--head` и необязательным `--settings`:

1. Раундов нет — раунд 1 (`created`).
2. Последний раунд с тем же base, head и ключом настроек (неизвестный ключ, `null` с любой стороны, совпадает с любым), ещё не опубликованный, — тот же раунд (`reused`). Опубликованный раунд закончен: новое открытие той же ревизии идёт по правилу 3. Если `--session` отличается от текущей сессии раунда, она добавляется с `reason: "restart"` и становится текущей. Состояние раунда не меняется: скилл продолжит с того шага, на котором остановился пакет.
3. Иначе — раунд N+1 с `previousRound: N` (`advanced`); Review переходит в `reviewing`.

## CLI

Все команды: `keryx review state <verb> … [--json] [--cwd <dir>]`. Ответ `--json` — `{ version: 1, review, round?, action? }`. Ошибка — ненулевой код и одна строка `error: …`.

| Команда | Что делает |
|---|---|
| `open --pr <url> --base <sha> --head <sha> [--viewer <login>] [--session <id>] [--settings <key>] [--source desktop\|session\|scheduled] [--on-head-move ask\|follow\|ignore] [--reopen]` | Создаёт Review при первом вызове, применяет правило номера раунда. `--session` по умолчанию берётся из `KERYX_REVIEW_SESSION_ID` |
| `round --review <id> [--round <n>] [--state <s>] [--package <dir>] [--session <id>] [--plan <slices>,<waves>,<done>/<total>] [--reviewer <role>=running\|done\|failed[:<findings>]]… [--usage <tokens>[,<usd>]] [--findings <b>,<M>,<m>,<i>[,<carried>,<rechecked>]] [--verdict <v>]` | Обновляет раунд (по умолчанию текущий). `--usage` задаёт итог раунда, не прибавляет |
| `publish --review <id> --verdict <v> [--url <url>] [--round <n>]` | Записывает публикацию, Review → `published` |
| `mark --review <id> --state stale\|closed\|ready` | Ставит состояние Review вне раунда (`ready` — снять `stale` без нового раунда) |
| `note --review <id> --text <text>` | Строка в `journal.md` без изменения состояния |
| `show --review <id> \| --pr <url> [--viewer <login>]` | Печатает Review |
| `list [--pr <url>]` | Все Review проекта |

## Скилл `review-orchestrator`

Раздел «Desktop review state» обязателен, когда ход называет Desktop review или задан `KERYX_REVIEW_SESSION_ID` и цель — PR:

| Шаг скилла | Вызов |
|---|---|
| До `keryx review start` | `keryx review state open --pr … --base … --head … [--viewer …] [--settings …]` |
| После `keryx review start` | `keryx review state round --review <id> --package <путь из вывода start> --state planning` |
| План готов (`review plan`/`slice`) | `round --state dispatching --plan <срезы>,<волны>,0/<назначения>` |
| Волна закончилась | `round --plan …,<сделано>/<всего> --reviewer <role>=done:<n> … --usage …` |
| Сверка (`ingest`, `verdict`) | `round --state reconciling --findings …` |
| Отчёт готов | `round --state ready --verdict … --findings … --usage …` |
| Остановка без отчёта (ошибка провайдера, вопрос без ответа, конец хода) | `round --state paused`, причина — `note` |
| Продолжение | `state show`, взять `package`, продолжить с шага, который называет состояние раунда; пакет не создавать заново |
| Публикация | после `keryx review publish` — `state publish --verdict …` |

Пропущенный вызов не ломает раунд: живой статус сессии остаётся верным, а следующий вызов восстанавливает состояние.

## Ход ревью (этап 1)

Desktop отправляет текст, а не `/review` (B8). Начало раунда:

```text
Review pull request <url> with the review-orchestrator skill (.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md).
This is a Desktop review: keep its state with `keryx review state` as the skill's "Desktop review state" section says (a copy of the skill without that section is older than this keryx: follow `keryx review state --help` instead).
Review this revision: base <base>, head <head>.
First run: keryx review state open --pr <url> --base <base> --head <head> --viewer <login> --session <session> --settings <key> --source desktop
Launch settings: <режим, адаптивность, параллельность, лимиты, модели, Flow>.
Request: <исходная просьба пользователя, если была>
```

Продолжение:

```text
Continue the Desktop review of <url> in this session (review <review-id>).
Run `keryx review state show --review <review-id>`, take the round's package and carry on from the step its state names; do not start a new package for the same head.
<текст пользователя, если есть>
```

Если сессия занята ходом, Desktop не отправляет ход, не ставит его в очередь и показывает «В сессии идёт ход. Отправьте ревью, когда он закончится».

## Статус: сессия + `review.json` (R6)

Один словарь `ReviewStatus` для слота доски, вкладки Reviews и карточки. Порядок проверки сверху вниз, первая подходящая строка:

| Условие | Статус | Подпись |
|---|---|---|
| Review `closed` | `closed` | Закрыто |
| сессия текущего раунда ждёт разрешения или `ask_user` (`waiting`) | `waiting` | Ждёт вас |
| в сессии идёт ход или работают субагенты (`busy` или `running > 0`) | `working` | Работает · <состояние раунда> |
| раунд не `ready`, сессия свободна или не открыта в окне | `paused` | Пауза · <состояние раунда> |
| раунд `ready`, публикации нет | `ready` | Готово |
| публикация текущего раунда есть | `published` | Опубликовано |
| Review без раундов | `draft` | Черновик |

Отставание (`stale` или head PR ≠ head раунда) — отдельная пометка «отстаёт на N» рядом со статусом, как freshness в v2. Сессия, не удерживаемая окном, не может быть `working` или `waiting`: статус берётся из `review.json`.

## Карточка Review (этап 2)

- **Заголовок.** PR (номер, заголовок, автор), проверенный коммит, пометка «отстаёт на N».
- **Статус** по таблице выше.
- **План текущего раунда.** Срезы, волны, назначения сделано/всего (`plan`).
- **Ревьюеры.** Идут/готовы, из `reviewers` и событий субагентов сессии.
- **Токены и стоимость** по раундам и всего (`usage`).
- **Находки** по мере появления, по тяжести, с пометкой «перенесена»/«перепроверена» (`findings`, детали — из пакета).
- **Раунды.** Номер, коммит, вердикт, ссылка «Открыть сессию» (`sessionId`).
- **Действия.** «Продолжить» (ход в сессию текущего раунда), «Новый раунд» (новая сессия и `keryx review advance`), «Опубликовать» (`keryx review publish` и `publish-guard`), «Исправить находки» (Flow 522).

Существующая карточка в сессии (`SessionReviewActivity`) остаётся для данных v2 и переходит на `review.json` на этапе 2.

## Миграция из v2

Этап 1 только читает `runs.sqlite`, как v2. Этап 2 добавляет `keryx review state import [--dry-run]`:

| v2 | v3 |
|---|---|
| строка `reviews` (ключ репозиторий, PR, аккаунт) | один `review.json`, `migratedFrom.reviewId` |
| раунд v2 (`runs.round`) | `rounds[]` с тем же номером; base/head — диапазон последней попытки раунда |
| попытка `completed`/`partial` в раунде | раунд `ready`; `findings`, `verdict`, `usage` — из её `result` |
| только `failed`/`cancelled`/`blocked` попытки | раунд `paused` |
| `DeskRun.sessionId` | `sessions[]` (`reason: "start"`) и `sessionId` последней попытки |
| пакет попытки (`attempts/<id>/…`) | `package` остаётся пустым: пакет вне проекта; путь попытки — в `journal.md` |
| квитанция публикации | `publications[]` |
| `closed_at` | `closed` |
| все id попыток | `migratedFrom.runIds` |

Импорт идемпотентен (повтор не меняет файлы), не трогает `runs.sqlite` и проверяется на копии рабочей базы: число Review до и после совпадает, каждая попытка попадает ровно в один раунд.

## Критерии приёмки этапа 1

1. `state open` по правилу R5: первый вызов — раунд 1; тот же head и настройки с другой сессией — тот же раунд, две сессии; новый head или другой ключ настроек — раунд 2 с `previousRound: 1`.
2. Каждая команда записи добавляет строку в `journal.md`; `review.json` чужой версии не меняется.
3. Недопустимые переходы раунда и записи в `ready`-раунд отклоняются ненулевым кодом.
4. «Run review» на доске и во вкладке Reviews не вызывает `review_run start`; открывает последнюю привязанную к PR сессию или новую с `subject` и отправляет в неё ход ревью с командой `state open`.
5. Диалог `/review` в сессии отправляет ход ревью в эту же сессию.
6. «Продолжить» в карточке сессии отправляет ход продолжения в ту же сессию и не вызывает `review_run continue`.
7. Занятая сессия: ход не отправляется, пользователь видит причину.
8. Review v2 из `runs.sqlite` по-прежнему видны на доске, во вкладке Reviews и в карточке сессии.
