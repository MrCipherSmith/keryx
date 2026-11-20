# Спецификация · Готовность worktree
Version: 0.2.0

Статус: draft, ничего не реализовано. Ссылки на код описывают состояние `origin/main` на 2026-11-21.

## 1. Идентичность модуля

- Новый модуль keryx `src/worktree/` (planned) и группа команд `keryx worktree` (planned; сегодня такой команды нет, `src/cli-registry.ts` упоминает worktree только в `doctor` и шине).
- Расширения: `src/flow/schema.ts` (головная ветка), `src/testing/` (базовая линия и повтор, только отчёт), проверка `worktrees` в `keryx doctor`.
- Поверхность Desktop: детали flow, футер сессии, вкладка Info.

## 2. Текущее состояние

| Что | Где сейчас |
|---|---|
| Создание worktree | `src/commands/trigger-dispatch.ts:852-854`; изоляция подагентов — `WorktreePort` и `provisionWorktrees` в `src/harness/child/worktree.ts:105-124`, адаптер `git worktree add --detach` — `src/harness/child/git-worktree-port.ts:42`; временные копии ревью — `src/review/layers.ts:491` |
| Основной checkout и общий git-каталог | `resolveGitCommonDir`, `resolveMainCheckoutRoot` — `src/lib/git-worktrees.ts:25-57`; `src/lib/clone-scope.ts:12-34` |
| Данные в общем git-каталоге | номера flow `<common>/keryx/flow-ids/` — `src/flow/allocation.ts:53-69`; шина `<common>/keryx/bus/` — `src/bus/paths.ts:64` |
| Хранилище в основном checkout | журнал решений — `src/decisions/store.ts:26-36` |
| Хранилища от текущего каталога | flows `src/flow/store.ts:8`; память `src/memory/store.ts:48` (записи в `.metaproject/memory/` в git; игнорируются только `data/memory/{index,embeddings,artifacts}`); активное ревью `src/review/active-review.ts:9`; обучение `src/learning/paths.ts:63` |
| Пользовательская область | память `~/.keryx/memory` — `memoryRootFor("user")`, `src/memory/store.ts:51-64`; обучение `scope: "user"` — `src/learning/store.ts:91-99`; перенос обучения project → user — `keryx learn promote <id>` (TTY и подтверждение) |
| Ветки flow | `baseBranch` — `src/flow/types.ts:266`; PR — `src/flow/schema.ts:162-170`; головной ветки и пути worktree нет |
| Проверка базы | `baseBranchCondition` — `src/flow/service.ts:2569-2624` |
| `git merge-tree` | не используется |
| Виды критериев | `src/flow/ac-kinds.ts:1-29`: вид `exec`/`invariant` только сообщается и ничего не блокирует; действовать по нему может только будущий W1 [слоя приёмки](../keryx-acceptance-layer/README.md) после гейта G1. `keryx flow check-ac` — суждение модели, команд не запускает (`src/flow/check-ac.ts:1-19`) |
| Проверки | `keryx test` — `src/commands/test.ts:23-58`; `src/testing/service.ts`; базовая линия `keryx health` — оценки, не прохождение тестов (`src/health/baseline.ts`) |
| `keryx doctor` | уже есть проверка `worktrees` (`src/cli-registry.ts:269`) |
| Копирование `.env`, CoW, порты | не найдено |
| Desktop | `apps/desktop/src-tauri/src/gitinfo.rs:33-92` распознаёт связанный worktree; `apps/desktop/src/session/GitStatus.tsx:57-68` показывает ветку/worktree/PR/CI; `apps/desktop/src-tauri/src/flows/mod.rs:44` и `flows/parse.rs:110` несут `base_branch`; меню Run — только подкоманды keryx (`apps/desktop/src/project/projectCommands.ts:14-21`) |

## 2а. Требования ↔ разделы

| R | Разделы |
|---|---|
| R1 | §4, §6 |
| R2 | §3, §4, §7.1 |
| R3 | §3, §4, §7.2 |
| R4 | §3, §4, §7.3 |
| R5 | §5.1, §5.2, §5.4, §6 (`promote`) |
| R6 | §5.3 |
| R7 | §7.4 |
| R8 | §6, §7.5 |
| R9, R10 | §6, §7.6 |

## 3. Структура хранения

| Данные | Путь | В рабочей копии |
|---|---|---|
| Конфигурация проекта | `.metaproject/worktree.config.json` | да, в git |
| Метка checkout | `<worktree-git-dir>/keryx/checkout.json` (`<worktree-git-dir>` — `git rev-parse --git-dir` worktree, то есть `<common>/worktrees/<name>/`) | нет |
| Окружение worktree | `<worktree-git-dir>/keryx/worktree.env` (порты) | нет |
| Хеш lock-файлов | `<worktree-git-dir>/keryx/deps.json` | нет |
| Журнал портов клона | `<common-dir>/keryx/worktree-ports.jsonl` + `.lock` | нет |
| Базовая линия flow | `<common-dir>/keryx/flow-baseline/<flow-id>.json` | нет |

Всё, что пакет пишет о конкретном worktree, лежит в его собственном git-каталоге. Ничего не попадает в рабочую копию, поэтому не нужны ни `.gitignore`, ни `info/exclude`: отслеживаемый `.keryx/sandbox-policy.json` и остальной `.keryx/` не затрагиваются. `git worktree remove` удаляет git-каталог worktree вместе с меткой.

**Метка checkout.** `{ "version": 1, "checkoutId": "<uuid v4>", "createdAt": "…", "flowId": "512" }` (схема [schemas/checkout.schema.json](schemas/checkout.schema.json)). `checkoutId` — случайный, а не хеш пути: git переиспользует путь `worktrees/<name>` после удаления, и хеш унаследовал бы чужие записи. Запись журнала портов с `checkoutId`, которого нет ни в одном живом `<common>/worktrees/*/keryx/checkout.json`, считается освобождённой.

## 4. Конфигурация

Схема: [schemas/worktree-config.schema.json](schemas/worktree-config.schema.json).

```json
{
  "version": 1,
  "envFiles": [".env", ".env.local"],
  "dependencies": [
    { "dir": "node_modules", "lockfiles": ["bun.lock"], "install": "bun install --frozen-lockfile" }
  ],
  "ports": { "web": { "env": "PORT", "range": [5200, 5299] }, "api": { "env": "API_PORT", "range": [8200, 8299] } },
  "prepare": { "rebuildIndexes": ["memory"] },
  "baseline": { "enabled": true, "timeoutSeconds": 900, "commands": ["bun test src"] }
}
```

Без файла: `envFiles` — найденные `.env*` кроме `.example`/`.sample`/`.template`; `dependencies` — `node_modules` при наличии `package.json`, команда установки по lock-файлу (bun/npm/pnpm/yarn); портов нет; `rebuildIndexes` — `["memory"]`; `baseline` — включена, тайм-аут 900 с на команду, команды — как у `keryx test run` (§7.6). Нижняя граница диапазона портов не больше верхней (проверяет загрузчик; JSON Schema этого не выражает).

## 5. Metaproject в worktree

### 5.1 Что worktree получает и чего не получает

- **Из git ветки:** вся отслеживаемая часть `.metaproject/` — index, routing, rules, skills, wiki, закоммиченные flow и закоммиченные записи памяти `.metaproject/memory/`.
- **Восстанавливается на месте при подготовке:** производные данные, которых нет в git, — индекс памяти (`keryx memory index`), по конфигурации ещё другие индексы. Они строятся из файлов ветки и принадлежат worktree.
- **Не читается из другого checkout:** данные metaproject и хранилища — незакоммиченные записи, `runtime/`, `data/learning/`, `data/review-active/`, `data/ac-check/`, артефакты gdctx/gdwiki, история проверок соседнего или основного checkout. Пакет их не открывает ни на чтение, ни на запись. Единственное чтение из основного checkout — копирование перечисленных `.env`-файлов, каталогов зависимостей и lock-файлов при `prepare` по команде владельца (§7.1, §7.2); это не данные metaproject.
- **Общие данные проекта и пользователя:** то, что должно пережить worktree, переносится в пользовательскую область (`~/.keryx/memory`, обучение `scope: "user"`) командой владельца (§5.2) или коммитится в ветку как обычные записи памяти.
- **Без изменений:** журнал решений (`src/decisions/store.ts`), номера flow и шина — существующее поведение.

### 5.2 Перенос выводов: `keryx worktree promote`

Команда владельца. Показывает новые локальные записи worktree, которых нет в ветке-базе: незакоммиченные записи памяти и принятые записи обучения проектной области. Выбранные переносит:

- обучение — существующим `keryx learn promote <id>` (project accepted → user candidate, TTY и подтверждение);
- память — копией записи в `~/.keryx/memory` (`memoryRootFor("user")`) под файловой блокировкой, с пометкой исходного проекта и ветки; запись в git ветки владелец делает обычным коммитом.

Без TTY работает только `--dry-run`. `keryx worktree remove` перечисляет непереносённые записи и не удаляет worktree без `--force`, если они есть.

### 5.3 Агенту — корень и индекс

- Сессия `keryx shell`/`keryx acp`, подагент с `isolation: "worktree"`, внешний агент и `keryx trigger run` в worktree получают в стартовом контексте две строки: абсолютный корень worktree и путь `<worktree>/.metaproject/index.md`.
- Хук ориентации keryx и проверка `worktrees` в `keryx doctor` показывают, что текущий каталог — worktree, его `checkoutId` и состояние подготовки.
- Правило «прочитать index в корне worktree перед первым действием» уже есть в правилах проекта; пакет гарантирует, что агент знает абсолютный корень.

### 5.4 Соотношение с SAC RP-08

[RP-08](../shared-agent-context-collaboration-worktrees/README.md) (future) вводит Project/Clone/Checkout, read-only базу и приватные оверлеи. Он запрещает читать чужой оверлей по общему расположению репозитория (MW-02 в его `metrics-and-validation.md`), изменять чужой checkout и автоматически публиковать данные в базу.

Этот пакет **не реализует** RP-08 и **не заявляет** соответствия ему. Он держится в стороне от запретов:

- не читает и не пишет данные metaproject и хранилища другого checkout (MW-02 говорит о чтении оверлея); копирование `.env` и зависимостей из основного checkout по команде владельца — чтение обычных файлов проекта, не оверлея; данные worktree остаются в worktree и его git-каталоге;
- перенос в общую область — только командой владельца и только в пользовательскую область, а не в базу проекта и не в другой checkout;
- `checkoutId` — локальная метка для портов и диагностики, не идентичность доступа.

Известное расхождение, которое остаётся: пользовательская область `~/.keryx/memory` не делится по проектам так, как база RP-08. Это существующее поведение `memoryRootFor("user")`, пакет его не меняет. При реализации RP-08 `promote` должен перейти на `overlay.publish` в базу проекта, а `checkoutId` — на `CheckoutId`.

## 6. Поверхность CLI (planned)

| Команда | Что делает |
|---|---|
| `keryx worktree create <name> [--base <ref>] [--branch <b>] [--flow <id>] [--path <dir>]` | `git worktree add` + `prepare`; при `--flow` записывает головную ветку и путь в `flow.json` |
| `keryx worktree prepare [--only env,deps,ports,indexes] [--json]` | подготовка текущего worktree; идемпотентна; пишет метку checkout |
| `keryx worktree promote [--store memory,learning] [--dry-run]` | перенос выводов в пользовательскую область (§5.2) |
| `keryx worktree env` | печатает `export`-строки портов для `eval` в терминале |
| `keryx worktree exec -- <cmd>` | запускает команду в worktree с портами из `worktree.env` |
| `keryx worktree status [--json]` | метка, порты, состояние зависимостей, `.env`-файлы (имена, не содержимое), непереносённые записи |
| `keryx worktree check [--target <ref>] [--json]` | проверка конфликтов (§7.5) |
| `keryx worktree remove <name> [--keep-branch] [--force]` | предупреждает о непереносённых записях, освобождает порты, вызывает `git worktree remove`; грязный worktree не удаляет без `--force` |
| `keryx test baseline capture [--flow <id>]` | базовая линия (§7.6) |
| `keryx test baseline show [--flow <id>] [--json]` | базовая линия и сравнение, только отчёт |

Источник `.env` и зависимостей — основной checkout (`resolveMainCheckoutRoot()`): владелец сам запускает команду, а копируются только перечисленные файлы. Все команды отказываются вне git-репозитория. Ни одна не делает `git stash`, `git add`, commit или push.

## 7. Контракты данных

### 7.1 `.env`-файлы

Копирование только из основного checkout в worktree того же клона. Перед копированием — `git check-ignore -q <file>` в worktree; неигнорируемый файл пропускается с сообщением. Существующий файл в worktree не перезаписывается без `--force`. Права копии — как у оригинала. Содержимое нигде не выводится.

### 7.2 Зависимости

```ts
interface DepsRecord { dir: string; lockHash: string; method: "clone" | "install" | "skipped"; at: string }
```

`lockHash` — sha256 содержимого lock-файлов по порядку. Порядок: если `<worktree>/<dir>` есть и `lockHash` совпадает — `skipped`. Иначе, если в основном checkout есть `<dir>` и ФС поддерживает CoW — `cp -c -R` (macOS) или `cp -R --reflink=auto` (Linux), затем `install`, если хеш основного checkout отличается. Иначе — `install`. Отказ CoW не ошибка.

### 7.3 Порты

Запись журнала: `{ checkoutId, name, port, at }`. Выделение под блокировкой: первый порт диапазона, не занятый записью живого `checkoutId` (§3) и свободный по `bind` на 127.0.0.1. Результат — строки `PORT=5201` в `<worktree-git-dir>/keryx/worktree.env`. Порты получают: команды меню Run в Desktop, `keryx worktree exec -- <cmd>` и терминал после `eval "$(keryx worktree env)"`. Команда, запущенная в обычном терминале без этого, портов не получает — файл лежит вне рабочей копии и никакой инструмент его сам не читает.

### 7.4 Головная ветка flow

`flow.json` (planned) получает необязательные поля:

```ts
headBranch?: string;   // например "feat/x"
worktree?: string;     // абсолютный путь, диагностический
```

Старые flow без полей валидны. `worktree` — подсказка, не идентичность.

### 7.5 Проверка конфликтов

```ts
interface MergeCheck {
  head: string; target: string; mergeBase: string;
  targetAhead: number;                 // git rev-list --count mergeBase..target
  conflicts: string[] | null;          // git merge-tree --write-tree --name-only --no-messages; null — git < 2.38 или сбой
  overlaps: Array<{ kind: "flow" | "pr"; id: string; branch: string; files: string[] }>;
  checkedAt: string;
}
```

Пересечения: файлы `git diff --name-only mergeBase..head` против тех же списков для головных веток открытых flow (поле `headBranch`) и открытых PR проекта (через уже используемый доступ к GitHub). Без сети — только flow, с пометкой. Рабочая копия и индекс не меняются. Опроса в фоне нет: проверка при открытии деталей flow, по кнопке и при новом коммите ветки.

### 7.6 Базовая линия и нестабильные тесты (только отчёт)

```ts
interface Baseline {
  flowId: string; baseCommit: string; capturedAt: string;
  checks: Array<{ command: string; exitCode: number; failures: string[] | null; failureCount: number | null }>;
}
interface CheckComparison {
  command: string; before: number | null; after: number;
  newFailures: string[]; flaky: string[]; regressed: boolean;
}
```

- Команды: `baseline.commands` из конфигурации (§4); без неё — команда, которую выполняет `keryx test run` по `.metaproject/testing.config.json`. Нет ни того, ни другого — базовая линия не снимается, отчёт говорит почему.
- Захват: временный `--detach` worktree на `baseCommit` (как `src/review/layers.ts:491`) с подготовкой §7.2, команды, затем удаление временного worktree. Тайм-аут на команду.
- Фон: `keryx flow start` запускает отдельный процесс `keryx test baseline capture --flow <id>`, который живёт без родителя; блокировка на flow (`<common-dir>/keryx/flow-baseline/<id>.lock`), лог — `<id>.log` рядом. `flow complete`, повторный `capture` и `keryx worktree remove` останавливают идущий захват и удаляют временный worktree. `baseline show` сообщает состояние: `running`, `done`, `failed`, `skipped`. Сбой захвата ничего не останавливает.
- Имена упавших тестов разбираются из вывода bun test, vitest, jest, node:test, pytest, go test; неизвестный формат — только код выхода и `failures: null`.
- Нестабильность: красный прогон повторяется один раз только для упавших тестов (если раннер это умеет) или целиком. Прошёл — все упавшие `flaky`. Другой набор — тесты, упавшие только в одном прогоне, `flaky`; упавшие в обоих остаются падением.
- `regressed = after > before || newFailures.length > 0` (без учёта `flaky`).
- **Только отчёт.** `keryx test baseline show`, `keryx test run` и Desktop показывают сравнение. Ни этот пакет, ни `keryx flow check-ac` ничего по нему не блокируют: виды критериев сегодня только сообщаются (`src/flow/ac-kinds.ts`). Право блокировать по `exec`-критерию появится только у W1 слоя приёмки после гейта G1; тогда W1 сможет брать `regressed` вместо голого кода выхода. Это зависимость W1 от этого пакета, а не наоборот.

## 8. Точки интеграции

| С чем | Как |
|---|---|
| `keryx trigger run` | создание worktree переходит на `src/worktree` (create + prepare) |
| Подагенты `isolation: "worktree"` | `provisionWorktrees` (`src/harness/child/worktree.ts`) после `create` вызывает `prepare --only indexes` и передаёт строки §5.3 |
| `keryx flow start` | в worktree записывает `headBranch`, запускает захват базовой линии в фоне |
| `keryx doctor` | расширяется существующая проверка `worktrees`: метка, порты, подготовка, непереносённые записи |
| Desktop: детали flow | блок «Перед слиянием» из `keryx worktree check --json`; сравнение базовой линии из `keryx test baseline show --json` |
| Desktop: футер сессии | в worktree — значок конфликтов/пересечений рядом с веткой; Info — порты |
| Desktop: меню Run | команды в worktree получают `worktree.env` |
| [Слой приёмки](../keryx-acceptance-layer/README.md) | W1 (после G1) может использовать `CheckComparison.regressed`; этот пакет от W1 не зависит |
| [Рабочие панели](../keryx-desktop-workspace-panels/README.md) | вкладка «Changes» показывает изменения этого worktree |

## 9. Критерии приёмки

| AC | Проверка |
|---|---|
| AC1 | `create` + `prepare` на фикстуре: `.env` скопирован, неигнорируемый `.env.local` пропущен и назван, содержимое не в выводе |
| AC2 | CoW-копия `node_modules` на APFS; повторный `prepare` — `skipped`; изменённый lock — `install` |
| AC3 | Два worktree получают разные порты; `remove` первого освобождает порт; новый worktree с тем же именем после удаления получает новый `checkoutId` и не наследует записи; порт, занятый чужим процессом, пропускается |
| AC4 | `prepare` пишет только в рабочую копию worktree и его git-каталог: `git status --porcelain` worktree пуст, а `git status --ignored --porcelain` показывает только скопированные `.env`-файлы и каталоги зависимостей; ответ `git check-ignore .keryx/sandbox-policy.json` не меняется; рабочая копия основного checkout не изменилась; `keryx worktree exec -- printenv PORT` печатает выделенный порт |
| AC5 | `promote --dry-run` перечисляет незакоммиченную запись памяти и принятую запись обучения; `promote` переносит выбранные в пользовательскую область; рабочая копия основного и соседних checkout не изменилась; без TTY запись отказывается |
| AC6 | Подагент в worktree получает две строки §5.3 в стартовом контексте |
| AC7 | `flow.json` без `headBranch` читается; `create --flow` записывает оба поля |
| AC8 | `worktree check` на фикстуре: правка файла в цели после базы → файл в `conflicts`; второй flow правит тот же файл → в `overlaps`; git < 2.38 → `conflicts: null` и предупреждение |
| AC9 | Базовая линия с одним заранее падающим тестом: «было 1, стало 1», `regressed: false`; новое падение — `regressed: true` и названо; тест, прошедший при повторе, — `flaky`. Ни в одном случае `flow check-ac`, `flow ac confirm` и `flow complete` не меняют решения и ничего не блокируют |
| AC10 | Ни одна команда пакета не вызывает `git stash`, `git add`, `commit`, `push` (проверка по тесту-обёртке над git) |
| AC11 | Конфигурация с диапазоном портов, где нижняя граница больше верхней, или с `..` в путях отклоняется загрузчиком с указанием поля |
| AC12 | `flow complete` во время идущего захвата базовой линии останавливает его и удаляет временный worktree; `baseline show` сообщает `failed` или `skipped` с причиной |
| AC13 | `bun test src/worktree src/testing src/flow`, `bun run typecheck` без ошибок |

## 10. Решения к заморозке

| # | Вопрос | Предложение |
|---|---|---|
| P1 | Где данные о worktree | в git-каталоге самого worktree; журнал портов и базовая линия — в общем git-каталоге, как шина и номера flow |
| P2 | Flows в worktree | пакет из ветки; чужие рабочие копии не читаются |
| P3 | Куда переносить выводы | пользовательская область (`~/.keryx/memory`, `learn promote`); при RP-08 — `overlay.publish` в базу проекта |
| P4 | Диапазоны портов по умолчанию | без портов, пока проект не назвал их в конфигурации |
| P5 | Базовая линия | только отчёт; блокирование — дело W1 слоя приёмки после G1 |
