# Task Manager: technical specification

Version: 0.2.0
Status: Phase 1 implemented (v1 scope; see section 16). Notion/Jira adapters and flow board are Phase 2.

## 1. Purpose

Task Manager - agent-first система управления работой. Единица работы - flow:
стори от инициализации до завершения. CLI `gd-metapro flow` - детерминированная
state machine, хранилище flow-пакетов и механические гейты. Скилы (flow-init,
flow-manager, flow-complete) - когнитивный слой поверх CLI, встраиваемый в
оркестраторы.

## 2. Design decisions (frozen for v1)

Пользовательское видение V1-V10 и интервью D1-D8 - в
[brainstorm.md](brainstorm.md) sections 2 и 5. Сводно:

| # | Decision | Choice |
|---|---|---|
| D1 | Namespace | CLI `gd-metapro flow`; manifest key `tasks` |
| D2 | Storage | `.metaproject/flows/<NNN>-<YYYY-MM-DD>-<slug>/`, versioned |
| D3 | AC protection | checksum freeze in flow.json; edits only via `flow ac update` |
| D4 | Statuses | 7-status strict state machine (section 6) |
| D5 | Tracker | `gh` CLI + typed TrackerAdapter; graceful degradation |
| D6 | Completion gates | AC confirmed + PR checks green + health gate pass |
| D7 | Init context | CLI collects deterministic context; skills do cognitive work |
| D8 | Tasks | tasks.md = definitions; statuses in flow.json via CLI |

Границы авторитета (V6, V8, research):

- **CLI** - единственный писатель flow.json; валидирует все переходы.
- **flow-manager** - единственная роль, переводящая flow в `implemented`.
- **Имплементатор** - не меняет AC, статусы и flow.json; работает по плану,
  отмечает задачи через flow-manager, завершается созданием draft PR.

## 3. Placement

`gd-metapro init` (при включённом Task Manager) создаёт:

```text
.metaproject/
  flows/
    README.md
  modules/
    tasks.md
  skills/
    flow/
      SKILL.md        # router: какая роль когда
      init.md         # flow-init skill
      manage.md       # flow-manager skill
      complete.md     # flow-complete skill
  data/
    tasks/
      artifacts/      # generated: latest.md (flow board)
```

## 4. Flow package

`flow init` создаёт `.metaproject/flows/<NNN>-<YYYY-MM-DD>-<slug>/`:

| Файл | Назначение | Кто пишет |
|---|---|---|
| `flow.json` | состояние: статус, задачи, checksum AC, PR, история | только CLI |
| `description.md` | формализованное описание стори | flow-init skill |
| `context.md` | собранный контекст | CLI (детерминированная часть) + skill |
| `plan.md` | план реализации | flow-init skill |
| `tasks.md` | определения задач (id, суть, тип) | CLI scaffold + skill/CLI (`task add`) |
| `acceptance-criteria.md` | критерии приёмки `- ACn: ...` | flow-init skill до freeze; далее только `flow ac update` |
| `journal.md` | человекочитаемая лента событий | CLI (append) |

`flow.json` (schemaVersion 1):

```json
{
  "schemaVersion": 1,
  "id": "001",
  "slug": "fix-login-timeout",
  "title": "Fix login timeout",
  "status": "initializing",
  "createdAt": "...", "updatedAt": "...",
  "source": { "type": "github-issue" | "description", "ref": "<url|null>" },
  "acChecksum": null,
  "acConfirmed": { "AC1": { "at": "...", "note": "..." } },
  "pr": { "url": null },
  "tasks": [
    { "id": "T1", "title": "Collect remaining context", "kind": "context", "status": "todo" }
  ],
  "history": [ { "at": "...", "event": "created" } ]
}
```

Нумерация NNN - следующий номер по существующим папкам flows (001, 002, ...).

## 5. Init context collection (D7)

`flow init` детерминированно собирает в `context.md`:

- issue title/body через TrackerAdapter (если `--issue`);
- top-5 `memory search` по заголовку (accepted приоритетно);
- ссылки на gdgraph-артефакты (summary, module-map) при наличии;
- последний health gate status при наличии;
- список включённых модулей Metaproject.

Когнитивная часть (формализация, брейншторм, интервью пользователя,
формулировка AC) - работа скила flow-init, не CLI.

## 6. Status machine (D4)

```text
initializing -> ready            (flow freeze: AC непустые, checksum записан)
ready        -> in-progress      (flow start)
in-progress  -> implemented      (flow implemented --pr <url>; только flow-manager)
implemented  -> completing       (flow complete: вход в гейты)
completing   -> done             (все гейты pass)
completing   -> in-progress      (гейты fail: авто-возврат + fix-ноты)
<any except done> -> blocked     (flow block --reason)
blocked      -> предыдущий статус (flow unblock)
```

Любой другой переход - ошибка CLI. `done` - терминальный.

## 7. Acceptance criteria freeze (D3)

- `acceptance-criteria.md` содержит критерии строками `- ACn: <текст>`.
- `flow freeze`: требует >=1 критерий; пишет `acChecksum = sha256(нормализованный файл)`.
- Все гейты и смены статуса сверяют checksum; расхождение - ошибка
  `acceptance criteria modified outside task-manager`.
- Правка AC: `flow ac update <id>` - пересчитывает checksum, пишет событие в
  history и journal (кто/когда/почему через `--reason`).
- Подтверждение выполнения: `flow ac confirm <id> <ACn> [--note]` - фиксируется
  в `flow.json.acConfirmed`, файл AC не трогается (checksum цел).

## 8. CLI

```bash
gd-metapro flow init (--issue <url> | --title "<t>") [--slug <s>]
gd-metapro flow list
gd-metapro flow status <id>
gd-metapro flow freeze <id>
gd-metapro flow start <id>
gd-metapro flow task add <id> --title "<t>" [--kind context|implement|test|review|docs]
gd-metapro flow task done <id> <taskId>
gd-metapro flow ac confirm <id> <ACn> [--note "<n>"]
gd-metapro flow ac update <id> --reason "<r>"
gd-metapro flow implemented <id> --pr <url>
gd-metapro flow complete <id> [--comment]
gd-metapro flow block <id> --reason "<r>"
gd-metapro flow unblock <id>
gd-metapro flow check
```

- `implemented`: только из in-progress; требует PR url; при доступном gh
  проверяет, что PR существует и является draft; предупреждение о non-draft.
- `complete`: гейты section 9; `--comment` постит итоговый комментарий в issue
  через адаптер; без issue печатает подсказку спросить пользователя о тикете.
- `check`: валидирует все flows (структура пакета, checksum, версия схемы,
  консистентность статусов/задач); non-zero exit при нарушениях.

## 9. Completion gates (D6)

`flow complete` последовательно:

1. **AC gate** - checksum цел; каждый ACn из файла подтверждён в acConfirmed.
2. **PR gate** - pr.url задан; через gh: PR существует, checks зелёные
   (`gh pr checks`). gh недоступен - гейт помечается `skipped` с warn (локальный
   режим), но отсутствие pr.url - всегда fail.
3. **Health gate** - `CodeHealthService.gate()` текущего репозитория: fail - гейт fail.

Все pass → `done`, событие в history/journal, итог для issue-комментария.
Любой fail → статус `in-progress`, fix-ноты (какие гейты упали, детали) в
journal.md и history; completion-скил решает: мелкое - fix-агент, крупное -
перезапуск имплементатора (V9).

## 10. TrackerAdapter (D5)

```ts
export interface TrackerAdapter {
  id: string; // "github"
  detect(): Promise<boolean>;                       // gh установлен и авторизован
  parseRef(input: string): TrackerRef | null;       // issue URL -> {repo, number}
  fetchIssue(ref: TrackerRef): Promise<{ title: string; body: string } | null>;
  prStatus(url: string): Promise<{ exists: boolean; isDraft: boolean; checksGreen: boolean | null }>;
  comment(ref: TrackerRef, body: string): Promise<boolean>;
}
```

v1: `github` через `gh` CLI. Notion/Jira - будущие адаптеры тем же контрактом.
Без работающего адаптера CLI работает в локальном режиме (warn + skipped-гейты,
кроме обязательного наличия PR url).

## 11. Skills (V1, V4, V8, V9)

- `skills/flow/SKILL.md` - router: когда какая роль; политика «имплементатор не
  трогает AC/статусы; все операции состояния - через CLI».
- `init.md` (flow-init): запустить `flow init`; дособрать контекст (gdgraph/
  gdctx/memory/wiki); формализовать description.md; брейншторм подходов; при
  неясности - интервью пользователя (вопросы с вариантами); написать plan.md,
  tasks (через `flow task add`), acceptance-criteria.md; перепроверить;
  `flow freeze` → `flow start`.
- `manage.md` (flow-manager, встраивается в оркестратор): вести задачи
  (`task done`), обновлять description/journal, следить за статусом; принять
  реализацию только при созданном draft PR → `flow implemented --pr`.
- `complete.md` (flow-complete): перепроверить пакет; `flow ac confirm` по
  каждому критерию с проверкой; `flow complete`; при fail - решить
  мелкое/крупное (V9), запустить исправление; при pass с issue -
  `flow complete --comment`; без issue - спросить пользователя о тикете (V10).

## 12. Init flow

Вопрос в `gd-metapro init`:

```text
Enable Task Manager (agent-first flow lifecycle)?
Y. Yes - flows with frozen acceptance criteria, status gates, and PR completion
N. No
```

Флаг `--no-tasks`. Создаётся структура section 3, manifest-запись
(`tasks: { enabled, commands: [...] }`), скилы.

## 13. Git policy

Versioned: `.metaproject/flows/**` (весь пакет, включая flow.json - это
документация работы), `modules/tasks.md`, `skills/flow/**`.
Ignored: `.metaproject/data/tasks/**` (generated board/artifacts).

## 14. Service contract

```ts
export interface FlowService {
  init(input: FlowInitInput): Promise<FlowInitResult>;
  list(input: { cwd: string }): Promise<FlowSummary[]>;
  get(input: { cwd: string; id: string }): Promise<FlowState>;
  freeze(input: { cwd: string; id: string }): Promise<FlowState>;
  start(input: { cwd: string; id: string }): Promise<FlowState>;
  taskAdd(input: FlowTaskAddInput): Promise<FlowState>;
  taskDone(input: { cwd: string; id: string; taskId: string }): Promise<FlowState>;
  acConfirm(input: { cwd: string; id: string; criterion: string; note?: string }): Promise<FlowState>;
  acUpdate(input: { cwd: string; id: string; reason: string }): Promise<FlowState>;
  implemented(input: { cwd: string; id: string; prUrl: string }): Promise<FlowState>;
  complete(input: { cwd: string; id: string; comment?: boolean }): Promise<FlowCompleteResult>;
  block(input: { cwd: string; id: string; reason: string }): Promise<FlowState>;
  unblock(input: { cwd: string; id: string }): Promise<FlowState>;
  check(input: { cwd: string }): Promise<FlowCheckResult>;
}
```

Гейты (health, tracker) - инжектируемые зависимости сервиса: CLI подключает
реальные, тесты - фейковые.

## 15. Acceptance criteria (production v1)

- `flow init --title` и `flow init --issue` создают корректный пакет; NNN растёт.
- Переходы вне state machine отклоняются с внятной ошибкой.
- `freeze` падает на пустых AC; после freeze ручная правка AC валит `check`/гейты/переходы.
- `ac update` - единственный путь изменить AC после freeze; события в history+journal.
- `implemented` требует in-progress + PR url; only-flow-manager политика зашита в скилы.
- `complete`: 3 гейта; fail возвращает в in-progress с fix-нотами; pass - done.
- `--comment` постит краткий комментарий в issue; без issue - подсказка про тикет.
- `flow check` ловит повреждённый checksum и битую структуру across all flows.
- Без gh: локальный режим, PR-гейт skipped (кроме отсутствия pr.url), никаких крашей.

## 16. Implementation phases

### Phase 1 - v1 production (implemented)

- [x] `src/flow/`: types, store, state machine, scaffold+templates, context
  collection, gates, github TrackerAdapter, service (инжектируемые deps);
- [x] CLI `gd-metapro flow` (все команды section 8);
- [x] init-интеграция (`--no-tasks`, структура, manifest, скилы flow/init/manage/complete);
- [x] тесты: state machine, freeze/tamper+check, полный happy-path c issue-комментарием,
  fail-path (возврат в in-progress), block/unblock, adapter parsing.

### Phase 2 - integrations

- Notion/Jira адаптеры; flow board артефакт (`data/tasks/artifacts/latest.md`);
- глубокая интеграция с memory (ingest итогов flow) и wiki (ссылки);
- метрики цикла (lead time, число возвратов из completion).

## 17. Decision record

V1-V10 (пользователь) + research + D1-D8 (интервью) - см.
[brainstorm.md](brainstorm.md). Отклонений от рекомендаций нет.
