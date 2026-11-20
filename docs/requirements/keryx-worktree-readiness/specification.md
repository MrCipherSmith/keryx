# Спецификация · Готовность worktree
Version: 0.1.2

Статус: draft, ничего не реализовано. Ссылки на код описывают **текущее** состояние `origin/main` на 2026-11-21 (`b51319327`).

## 1. Идентичность модуля

- Новый модуль keryx `src/worktree/` (planned) и группа команд `keryx worktree` (planned; сегодня такой команды нет, `src/cli-registry.ts` упоминает worktree только в `doctor` и шине).
- Расширения: `src/flow/schema.ts` (головная ветка), `src/testing/` (базовая линия, нестабильные тесты), хранилища `.metaproject` (политика §5).
- Поверхность Desktop: детали flow, футер сессии, вкладка Info.

## 2. Текущее состояние

| Что | Где сейчас |
|---|---|
| Создание worktree | `src/commands/trigger-dispatch.ts:852-854`, `src/harness/child/git-worktree-port.ts:42` (`--detach`), `src/review/layers.ts:491`, изоляция подагента `src/agents/generate.ts:340` |
| Основной checkout и общий git-каталог | `resolveGitCommonDir`, `resolveMainCheckoutRoot` — `src/lib/git-worktrees.ts:25-57`; `src/lib/clone-scope.ts:12-34` |
| Данные в общем git-каталоге | номера flow `<common>/keryx/flow-ids/` — `src/flow/allocation.ts:53-69`; шина `<common>/keryx/bus/` — `src/bus/paths.ts:64` |
| Хранилище в основном checkout | журнал решений — `src/decisions/store.ts:26-36` |
| Хранилища от текущего каталога | flows `src/flow/store.ts:8`, память `src/memory/store.ts:48` (записи в `.metaproject/memory/` в git; игнорируются только `data/memory/{index,embeddings,artifacts}`), активное ревью `src/review/active-review.ts:9`, обучение `src/learning/paths.ts:63` (корень от вызывающего) |
| Ветки flow | `baseBranch` — `src/flow/types.ts:266`; PR — `src/flow/schema.ts:162-170`; головной ветки и пути worktree нет |
| Проверка базы | `baseBranchCondition` — `src/flow/service.ts:2569-2624` |
| `git merge-tree` | не используется нигде |
| Проверки | `keryx test` — `src/commands/test.ts:23-58`; `src/testing/service.ts`; AC `exec`/`invariant` — `src/flow/ac-kinds.ts`, `src/flow/check-ac.ts`; базовая линия оценок — `src/health/baseline.ts` (не pass/fail) |
| Копирование `.env`, CoW, порты | не найдено |
| Desktop | `apps/desktop/src-tauri/src/gitinfo.rs:33-92` распознаёт связанный worktree; `apps/desktop/src/session/GitStatus.tsx:57-68` показывает ветку/worktree/PR/CI; `apps/desktop/src-tauri/src/flows/mod.rs:44` и `flows/parse.rs:110` несут `base_branch`, ветки и worktree flow нет; меню Run — только подкоманды keryx (`apps/desktop/src/project/projectCommands.ts:14-21`) |

## 2а. Требования ↔ разделы

| R | Разделы |
|---|---|
| R1 | §4, §6 |
| R2 | §3, §4, §7.1 |
| R3 | §3, §4, §7.2 |
| R4 | §3, §4, §7.3 |
| R5 | §5.1, §5.2, §5.4, §6 (`link`, `promote`) |
| R6 | §5.3 |
| R7 | §7.4 |
| R8 | §6, §7.5 |
| R9, R10 | §6, §7.6 |

## 3. Структура хранения

| Данные | Путь | В git |
|---|---|---|
| Конфигурация проекта | `.metaproject/worktree.config.json` | да |
| Журнал портов клона | `<common-dir>/keryx/worktree-ports.jsonl` + `.lock` | нет (вне рабочей копии) |
| Реестр связей | `<common-dir>/keryx/checkouts/<checkout-key>.json` | нет |
| Окружение worktree | `<worktree>/.keryx/worktree.env` (порты, путь дома) | нет: `.keryx/` вносится в `<common-dir>/info/exclude` (как `src/lib/git-local-ignore.ts`), tracked `.gitignore` не меняется |
| Хеш lock-файлов | `<worktree>/.keryx/deps.json` | нет |
| Базовая линия flow | `<common-dir>/keryx/flow-baseline/<flow-id>.json` | нет (вне рабочей копии) |

`checkout-key` — sha256 канонического пути `git rev-parse --git-dir` worktree, первые 16 hex. Путь — вход для разрешения, а не идентичность (см. §5.4).

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
  "sharedStores": "default",
  "baseline": { "enabled": true, "timeoutSeconds": 900 }
}
```

Без файла: `envFiles` — найденные `.env*` кроме `.example`/`.sample`/`.template`; `dependencies` — `node_modules` при наличии `package.json`, команда установки по lock-файлу (bun/npm/pnpm/yarn); портов нет; `sharedStores: "default"` — политика §5.2; `baseline` — включена для flow с `exec`-критериями тестов, тайм-аут 900 с на команду.

## 5. Ссылка на metaproject

### 5.1 Связь

Связь создаёт только команда, которую запускает владелец: `keryx worktree create` или `keryx worktree link` (а также действие пользователя в Desktop). Подготовка без `link` связи не создаёт. Запись (схема [schemas/checkout-link.schema.json](schemas/checkout-link.schema.json)):

```json
{ "version": 1, "checkoutKey": "3f9c…", "worktree": "/abs/path", "home": "/abs/main-checkout", "createdAt": "2026-11-21T10:00:00Z", "flowId": "512" }
```

Полномочие даёт команда владельца, а не расположение каталогов. `home` — `resolveMainCheckoutRoot()` в момент команды; перед записью выполняется проверка идентичности клона: `home` и worktree имеют один и тот же `git rev-parse --git-common-dir`, `home` — не bare и содержит `.metaproject/index.md`. Не прошла проверка — связь не пишется. keryx в worktree находит запись по `checkoutKey`. Нет записи — связи нет, всё как сегодня. Запись с недоступным `home` — связь неисправна: предупреждение, работа только с локальными данными; `keryx doctor` называет причину.

Worktree, которые keryx создаёт сам (подагенты с `isolation: "worktree"`, `keryx trigger run`, временные копии базовой линии), связи не создают и не наследуют: доступ не передаётся по цепочке. Им даются только строки §5.3 без дома. Владелец может связать такой worktree командой `link`.

### 5.2 Политика хранилищ (по умолчанию)

Связь даёт **чтение** домашних данных. Запись в связанном worktree остаётся локальной. Перенос локальных данных в дом — только командой владельца `keryx worktree promote` (§6): она показывает новые записи и переносит выбранные.

| Хранилище | Чтение в связанном worktree | Запись | Почему |
|---|---|---|---|
| tracked-часть `.metaproject/` (index, routing, rules, skills, wiki, закоммиченные flow, закоммиченная память `.metaproject/memory/`) | worktree | worktree (через git ветки) | ветка может их менять; попадает в дом через слияние |
| Незакоммиченные записи памяти дома (`.metaproject/memory/` в рабочей копии дома, не в git) | worktree + дом, без дублей по id, с пометкой источника | worktree | уроки, ещё не закоммиченные в доме, видны агенту |
| Индекс и эмбеддинги памяти (`data/memory/{index,embeddings,artifacts}`) | worktree (перестраиваются локально) | worktree | зависят от набора записей ветки |
| Обучение (`data/learning/*`), активное ревью (`data/review-active/`) | worktree + дом | worktree | общие по смыслу, но запись в дом — только через `promote` |
| Журнал решений (`data/decisions/`) | как сегодня (`src/decisions/store.ts:26-36`) | как сегодня | существующее поведение, пакет его не меняет |
| `runtime/`, `data/ac-check/`, артефакты gdctx/gdwiki, история health/testing, `core/**/*.ts` | worktree | worktree | зависят от кода ветки, восстанавливаются; дом не читается |
| Flows | пакет из ветки; если пакета нет в ветке — из дома, только чтение | worktree | состояние flow в git ветки; второго источника правды нет |
| Номера flow, шина, порты, базовая линия | общий git-каталог | общий git-каталог | машинные данные клона, как сегодня у номеров flow и шины |

Конфигурация может выключить чтение из дома для отдельных хранилищ (`"sharedStores": { "memory": "local" }`). Включить чтение из дома для строки `runtime/`… и разрешить прямую запись в дом нельзя.

### 5.3 Агенту — корень и индекс

- Сессия `keryx shell`/`keryx acp`, подагент с `isolation: "worktree"`, внешний агент и `keryx trigger run` в worktree получают в стартовом контексте строки: абсолютный корень worktree, путь `<worktree>/.metaproject/index.md` и (при связи) путь дома с пометкой «только чтение».
- Хук ориентации keryx и `keryx doctor` выводят связь.
- Правило «прочитать index в корне worktree перед первым действием» уже есть в правилах проекта; пакет гарантирует, что агент знает абсолютный корень.

### 5.4 Совместимость с SAC RP-08

[RP-08](../shared-agent-context-collaboration-worktrees/README.md) (future) вводит Project/Clone/Checkout, read-only базу и приватные оверлеи. Он запрещает выводить доступ из соседства каталогов или общего владения ФС, изменять чужой checkout и автоматически публиковать данные в базу. Этот пакет:

- создаёт связь только командой владельца; общий git-каталог служит лишь проверкой идентичности клона (§5.1), а не источником полномочий; связь не наследуется;
- команды этого пакета читают дом и никогда не пишут в него автоматически: локальная запись — аналог приватного оверлея, `promote` — явная, просматриваемая публикация по команде владельца;
- журнал решений, номера flow и шину не меняет: это существующее поведение, появившееся до RP-08;
- использует `checkoutKey` как локальный ключ. При реализации RP-08 он заменяется на `CheckoutId`, связь — на членство в Project, `promote` — на `overlay.publish`, а таблица §5.2 — на конфигурацию базы и оверлеев.

## 6. Поверхность CLI (planned)

| Команда | Что делает |
|---|---|
| `keryx worktree create <name> [--base <ref>] [--branch <b>] [--flow <id>] [--path <dir>] [--no-link]` | `git worktree add` + `prepare` + `link`; при `--flow` записывает головную ветку и путь в `flow.json` |
| `keryx worktree prepare [--only env,deps,ports] [--json]` | подготовка текущего worktree; идемпотентна; связи не создаёт |
| `keryx worktree link [--home <dir>]` | создаёт связь текущего worktree с домом после проверки идентичности клона (§5.1) |
| `keryx worktree promote [--store memory,learning,review-active] [--dry-run]` | показывает локальные записи, которых нет в доме, и переносит выбранные; без интерактива — только `--dry-run` |
| `keryx worktree status [--json]` | связь, порты, состояние зависимостей, `.env`-файлы (имена, не содержимое) |
| `keryx worktree check [--target <ref>] [--json]` | проверка конфликтов (§7.5) |
| `keryx worktree remove <name> [--keep-branch]` | предупреждает о непереносённых локальных записях, освобождает порты, удаляет запись связи, вызывает `git worktree remove`; грязный worktree не удаляет без `--force` |
| `keryx test baseline capture [--flow <id>]` | базовая линия (§7.6) |
| `keryx test baseline show [--flow <id>] [--json]` | показать базовую линию и сравнение |

Все команды отказываются вне git-репозитория. Ни одна не делает `git stash`, `git add -A`, commit или push.

## 7. Контракты данных

### 7.1 `.env`-файлы

Копирование только из дома в worktree того же клона. Перед копированием — `git check-ignore -q <file>` в worktree; неигнорируемый файл пропускается с сообщением. Существующий файл в worktree не перезаписывается без `--force`. Права копии — как у оригинала. Содержимое нигде не выводится.

### 7.2 Зависимости

```ts
interface DepsRecord { dir: string; lockHash: string; method: "clone" | "install" | "skipped"; at: string }
```

`lockHash` — sha256 содержимого lock-файлов по порядку. Порядок: если `<worktree>/<dir>` есть и `lockHash` совпадает — `skipped`. Иначе, если в доме есть `<dir>` и ФС поддерживает CoW — `cp -c -R` (macOS) или `cp -R --reflink=auto` (Linux), затем `install`, если хеш дома отличается. Иначе — `install`. Отказ CoW не ошибка.

### 7.3 Порты

Запись журнала: `{ checkoutKey, name, port, at, released? }`. Выделение под блокировкой: первый порт диапазона, не занятый живой записью и свободный по `bind` на 127.0.0.1. Запись считается живой, пока существует worktree её `checkoutKey`. Результат — строки `PORT=5201` в `.keryx/worktree.env`. Desktop и `keryx` подставляют этот файл в окружение команд, запускаемых в worktree.

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

### 7.6 Базовая линия и нестабильные тесты

```ts
interface Baseline {
  flowId: string; baseCommit: string; capturedAt: string;
  checks: Array<{ command: string; exitCode: number; failures: string[] | null; failureCount: number | null }>;
}
interface CheckComparison {
  command: string; before: number | null; after: number;
  newFailures: string[]; flaky: string[]; blocking: boolean;
}
```

- Захват: временный `--detach` worktree на `baseCommit` (как `src/review/layers.ts:491`) с подготовкой §7.2, команды проверок проекта, затем удаление. Тайм-аут на команду. Сбой захвата не блокирует flow, сравнение тогда работает как сегодня.
- Имена упавших тестов разбираются из вывода bun test, vitest, jest, node:test, pytest, go test; неизвестный формат — только код выхода и `failures: null`.
- Нестабильность: красный прогон повторяется один раз только для упавших тестов (если раннер это умеет) или целиком. Прошёл — все упавшие `flaky`. Другой набор — разница `flaky`, пересечение остаётся падением.
- `blocking = after > before || newFailures.length > 0` (без учёта `flaky`). Гейт `exec`-критерия flow использует `blocking`, когда базовая линия есть.

## 8. Точки интеграции

| С чем | Как |
|---|---|
| `keryx trigger run` | создание worktree переходит на `src/worktree` (create + prepare) |
| Подагенты `isolation: "worktree"` | после `git worktree add` получают строки §5.3 (корень и index worktree); связи и чтения из дома нет (§5.1) |
| `keryx flow start` | в worktree записывает `headBranch`, запускает захват базовой линии в фоне |
| `keryx flow check-ac` | для `exec`-критериев тестов использует сравнение §7.6 |
| `keryx doctor` | раздел worktree: связь, порты, исправность |
| Desktop: детали flow | блок «Перед слиянием» из `keryx worktree check --json` |
| Desktop: футер сессии | в worktree — значок конфликтов/пересечений рядом с веткой; Info — порты и дом |
| Desktop: меню Run | команды в worktree получают `.keryx/worktree.env` |
| [Рабочие панели](../keryx-desktop-workspace-panels/README.md) | вкладка «Изменения» показывает изменения этого worktree |

## 9. Критерии приёмки

| AC | Проверка |
|---|---|
| AC1 | `create` + `prepare` на фикстуре: `.env` скопирован, неигнорируемый `.env.local` пропущен и назван, содержимое не в выводе |
| AC2 | CoW-копия `node_modules` на APFS; повторный `prepare` — `skipped`; изменённый lock — `install` |
| AC3 | Два worktree получают разные порты; `remove` первого освобождает порт; порт, занятый чужим процессом, пропускается |
| AC4 | В связанном worktree `keryx memory search` находит незакоммиченный урок дома с пометкой источника; новый урок пишется в worktree; в доме он появляется только после `promote`; без связи — только локальные записи; `home` недоступен — предупреждение и локальная работа |
| AC5 | Ни одна команда этого пакета, кроме `promote`, не пишет в рабочую копию дома (существующий журнал решений `src/decisions/store.ts` — вне пакета и не меняется); worktree подагента не получает связи; строка `runtime/`… §5.2 никогда не читается из дома, даже при попытке конфигурации; `link` отказывает, если `git-common-dir` дома и worktree различаются |
| AC6 | Подагент в worktree получает две строки §5.3 в стартовом контексте (корень и index worktree), без дома |
| AC7 | `flow.json` без `headBranch` читается; `create --flow` записывает оба поля |
| AC8 | `worktree check` на фикстуре: правка файла в цели после базы → файл в `conflicts`; второй flow правит тот же файл → в `overlaps`; git < 2.38 → `conflicts: null` и предупреждение |
| AC9 | Базовая линия с одним заранее падающим тестом: «было 1, стало 1», не блокирует; новое падение блокирует и названо; тест, прошедший при повторе, — `flaky`, не блокирует |
| AC10 | Ни одна команда пакета не вызывает `git stash`, `git add`, `commit`, `push` (проверка по тесту-обёртке над git) |
| AC11 | `bun test src/worktree src/testing src/flow`, `bun run typecheck` без ошибок |

## 10. Решения к заморозке

| # | Вопрос | Предложение |
|---|---|---|
| P1 | Где реестр связей | общий git-каталог, как шина и номера flow |
| P2 | Flows в связанном worktree | пакет из ветки; чтение из дома только при отсутствии пакета в ветке |
| P3 | Запись в дом | только `promote` по команде владельца; при RP-08 заменяется на `overlay.publish` |
| P4 | Диапазоны портов по умолчанию | без портов, пока проект не назвал их в конфигурации |
| P5 | Базовая линия по умолчанию | включена для flow с `exec`-критериями тестов; выключатель в конфигурации проекта |
| P6 | `create` связывает по умолчанию | да, с `--no-link` для отказа; `prepare` не связывает |
