# Спецификация · Рабочие панели и внимание
Version: 0.1.1

Статус: draft, ничего не реализовано. Ссылки на код ниже описывают **текущее** состояние `origin/main` на 2026-11-21 (`b51319327`), от которого отталкивается работа.

## 1. Идентичность модуля

- Приложение: `apps/desktop` (Tauri 2 + React), клиент `keryx acp --profile shell`.
- Новые части: модуль внимания в веб-слое, две вкладки боковой панели (`changes`, `files`), индикатор контекста в композере, вложения-комментарии и вложения-изображения.
- Изменения keryx: путь промпта ACP для изображений (§6.5). Остальное — только приложение.
- Решения пакета (§9) получат номера после D-15 в [decisions.md](../keryx-desktop-client/decisions.md) при заморозке.

## 2. Текущее состояние, на которое опираемся

| Что | Где сейчас |
|---|---|
| Метки сессий `busy`, `waiting`, `running` | `SessionMark` — `src/session/reducer.ts:663`, сборка `sessionMarks` — `:751`; `waiting` из `src/session/dialogQueue.ts:54` |
| Конец хода | `src/session/useAcpSession.ts:609-628` (busy → false в `finally` после `session/prompt`) |
| Активность проекта на рельсе | `src/shell/projectRail.ts:73-81`, Rust `src-tauri/src/projects.rs:41` |
| Группы сессий | `src/session/sessionGroups.ts:9` (Pinned), `groupSessions` `:45-60`; меток не получает |
| Вкладки боковой панели | `SIDE_TABS` — `src/panels/SidePanel.tsx:12-17`; тип и белый список продублированы в `src/lib/prefs.ts:65-66` |
| Git | `src-tauri/src/gitinfo.rs`: `git rev-parse` (распознать worktree) и `git status --porcelain=v2 --branch`, из списка файлов — только счётчик `changed` (`:27`), тайм-аут 3 с, `GIT_OPTIONAL_LOCKS=0` |
| Дифф | `src/components/unifiedDiff.ts` — разбор и статистика, без комментариев |
| Вложения композера | `ComposerAttachment` — `src/session/Composer.tsx:41`, чипы `:293-295` (текст про элементы страницы); хранилище пиков `src/panels/elementPicks.ts`; блок `picksBlock` `:118-122` (`resource`, `_meta.keryx.untrusted: true`); отправка `src/session/SessionView.tsx:162-171` |
| Чтение файлов | `src-tauri/src/fs.rs` — только ACP-обработчик `fs/read_text_file` для агента: `confine` (`:80`), корень git (`:111`), лимит 8 МиБ. Команд для React нет |
| Картинки проекта | `local_image` — `src-tauri/src/images.rs:91-97`, ограничен корнем панели и папкой скриншотов, 15 МиБ |
| Подсветка | `src/components/highlight.ts` (highlight.js core + набор языков) |
| Попап `/` | `Composer.tsx:125`, только команды |
| Использование контекста | `usage_update` — `reducer.ts:375-384`, `Usage` `:99-108`; метр только в `SessionInfoPanel.tsx:70-71, :144` |
| `/compact` | keryx: `src/acp/shell-commands.ts:42`, раннер `src/acp/shell-command-runners.ts:162`; во время хода отклоняется (`src/acp/server.ts:2130-2162`) |
| Изображения в промпте | keryx: `promptCapabilities.image: false` — `src/acp/protocol.ts:498`; блок заменяется текстом — `src/acp/prompt-content.ts:84-85`; OpenAI-адаптер не сериализует изображения запроса (`src/harness/provider/openai/openai-provider.ts:451-453`); в Anthropic-адаптере поддержки не найдено |
| Плагины Tauri | только `dialog` и `opener`; `capabilities/default.json` без уведомлений |
| Настройки | `Prefs` — `src/lib/prefs.ts:40-63`; вкладки Settings — `src/shell/SettingsView.tsx:29-34` |

## 3. Структура хранения

Новых файлов на диске проекта нет. Вложения-изображения не пишутся в репозиторий.

| Данные | Где |
|---|---|
| Настройки внимания | `Prefs.attention` в локальном хранилище веб-слоя (как остальные `Prefs`) |
| Черновые замечания к строкам | в памяти окна, по `cwd` (как пики), очищаются после отправки |
| Вставленные изображения | в памяти окна до отправки; при отправке — base64 в ACP-блоке, на диск не пишутся |

## 4. Конфигурация

```ts
// src/lib/prefs.ts — расширение Prefs (planned)
interface AttentionPrefs {
  notify: boolean;       // системные уведомления, по умолчанию true
  sound: boolean;        // звук, по умолчанию true
  badge: boolean;        // счётчик в Dock, по умолчанию true
}
type SidePanelTab = "terminal" | "browser" | "activity" | "info" | "changes" | "files";
```

Settings → Sessions получает блок «Внимание» с тремя переключателями. Белый список вкладок обновляется в обоих местах (`SidePanel.tsx`, `prefs.ts`).

## 5. Поверхность: команды Tauri (planned)

| Команда | Вход | Выход | Ограничения |
|---|---|---|---|
| `git_changes` | `cwd` | `ChangedFile[]` | `git status --porcelain=v2 -z --untracked-files=all`, тайм-аут 3 с, `GIT_OPTIONAL_LOCKS=0`, до 2000 записей с флагом `truncated` |
| `git_file_diff` | `cwd`, `path` | `FileDiff` | `git diff HEAD -- <path>` (для неотслеживаемых — против пустого), путь проходит `confine`, лимит 1 МиБ, двоичные — `binary: true` без текста |
| `project_files` | `cwd`, `query?` | `ProjectFile[]` | `git ls-files -co --exclude-standard -z`, до 20000 путей, поиск по подстроке и началу сегментов на стороне Rust, не больше 200 результатов |
| `project_file_read` | `cwd`, `path` | `FileContent` | тот же `confine`, что у `fs/read_text_file`; текст до 1 МиБ; изображения — через существующий `local_image` |
| `attention_set` | `{ waiting: number }` | — | `Window::set_badge_count` (macOS), `None` при нуле |
| `attention_notify` | `{ title, body, projectCwd, sessionId }` | — | `tauri-plugin-notification`; клик эмитит событие `attention:open` с проектом и сессией |

Права: в `capabilities/default.json` добавляется `notification:default`. Новые команды регистрируются в `src-tauri/src/lib.rs` рядом с `git_info`.

## 6. Контракты данных

### 6.1 Состояние внимания

Модуль `src/session/attention.ts` (planned) — чистая функция над метками всех сессий окна:

```ts
interface AttentionInput {
  marks: Record<string, { projectCwd: string; waiting: boolean; busy: boolean }>;
  shown: { projectCwd: string; sessionId: string } | null;
  focused: boolean;              // document.hasFocus() + событие focus/blur окна
  notified: ReadonlySet<string>; // ключ "<sessionId>:<waitSeq>"
}
interface AttentionOutput {
  waitingCount: number;          // для значка
  notify: Array<{ sessionId: string; projectCwd: string; reason: "waiting" | "turn-ended" | "turn-failed" }>;
}
```

Правила: уведомление о `waiting` — один раз на эпизод ожидания (`waitSeq` растёт при каждом новом ожидании). `turn-ended` — только если сессия не показана или окно не в фокусе. Звук играет веб-слой, если `sound` включён и сработало любое уведомление.

### 6.2 Изменённые файлы и дифф

```ts
interface ChangedFile { path: string; status: "M" | "A" | "D" | "R" | "?"; origPath?: string; staged: boolean }
interface FileDiff { path: string; binary: boolean; tooLarge: boolean; text?: string } // unified diff
```

Рендер — `unifiedDiff.ts` + `highlight.ts`, нумерация строк новой версии. Список виртуализируется при числе файлов > 200.

### 6.3 Замечание к строке и блок отправки

```ts
interface LineComment { path: string; startLine: number; endLine: number; side: "new" | "old"; quote: string; text: string }
```

Отправка: один ACP-блок `resource` с `uri: "keryx-desktop:line-comments"`, `mimeType: "text/markdown"`, текстом-списком `path:start-end` и замечанием пользователя. Метка `_meta.keryx.untrusted` на блок **не ставится**: замечание пишет пользователь. Цитаты из рабочей копии идут в том же запросе отдельным блоком `resource` с `uri: "keryx-desktop:line-comment-quotes"` и `_meta.keryx.untrusted: true` (содержимое файла мог написать агент или третья сторона), каждая — блоком кода с путём и строками. Хранилище замечаний устроено как `elementPicks.ts`, но отдельным модулем. Чипы композера получают тип вложения, и подпись чипов перестаёт говорить только об элементах страницы.

### 6.4 Упоминание `@путь`

Попап композера получает второй триггер: `@` в начале слова. Выбор вставляет `@<относительный путь>` текстом. keryx получает обычный текст и читает файл своими инструментами. Отдельного блока не требуется. Если keryx начнёт разворачивать `@` сам, приложение ничего не меняет.

### 6.5 Изображения (keryx + приложение)

keryx (planned):

1. `src/harness/provider/types.ts` — часть сообщения пользователя типа `image` (`mimeType`, `data` base64).
2. Сериализация в адаптерах, где провайдер принимает изображения (Anthropic, OpenAI). Адаптер без поддержки возвращает ошибку `image_input_unsupported` с именем модели — не обрыв хода.
3. `src/acp/prompt-content.ts` передаёт блок `image` в сообщение вместо текста-заглушки.
4. `promptCapabilities.image` становится `true`, только когда шаги 1–3 есть.

Приложение: вставка (`paste` с `image/*`) и перетаскивание файла изображения добавляют вложение-изображение с миниатюрой. Лимиты: png, jpeg, gif, webp; до 5 МиБ на файл, до 4 на сообщение. Если `agentCapabilities.promptCapabilities.image !== true`, кнопка отправки неактивна с подсказкой «Этот keryx не принимает изображения — обновите keryx».

### 6.6 Индикатор контекста

Источник — `conv.usage` (`used`, `size`). Показывается, если `size > 0`. Пороги цвета совпадают с метром во вкладке Info (`SessionInfoPanel.tsx`): одна функция порогов на оба места. Подсказка: «Последний вызов: N из M токенов». Меню: «Сжать контекст» отправляет `/compact` через существующий путь команд и неактивно при `busy`. «Подробнее» открывает вкладку Info.

## 7. Точки интеграции

| С чем | Как |
|---|---|
| `useAcpSession` | Источник меток и событий конца хода для `attention.ts`; без новых ACP-методов |
| Рельс проектов | Не меняется; значок Dock суммирует `waiting` по всем проектам окна |
| `GitStatus` в футере | Клик по счётчику изменений открывает вкладку «Изменения» |
| Агентские инструменты панели | Не меняются; агент не управляет новыми вкладками |
| keryx ACP | Изображения — через `promptCapabilities`; совместимость со старым keryx обеспечивает проверка флага |
| [Готовность worktree](../keryx-worktree-readiness/README.md) | Вкладка «Изменения» в worktree flow показывает изменения этого worktree; проверка конфликтов парного пакета показывается в деталях flow и в футере сессии (его спецификация §8), не во вкладке |

## 8. Критерии приёмки

| AC | Проверка |
|---|---|
| AC1 | Окно не в фокусе, сессия запросила разрешение: одно уведомление, значок «1»; клик открывает проект и сессию. Повторная отрисовка того же ожидания второго уведомления не даёт |
| AC2 | Окно в фокусе, показанная сессия закончила ход: уведомления нет. Непоказанная сессия закончила ход: уведомление `turn-ended` |
| AC3 | Выключатели `notify`, `sound`, `badge` действуют независимо и переживают перезапуск |
| AC4 | Ожидающая сессия первой в группе «Ждут вас»; после ответа возвращается в свою группу (Pinned или дневную); свёрнутость группы запоминается |
| AC5 | `git_changes` на фикстуре с M/A/D/R/?/двоичным файлом возвращает все статусы; на 2001 файле — `truncated: true` |
| AC6 | `git_file_diff` и `project_file_read` отказывают для `../x`, абсолютного пути вне корня и символической ссылки наружу |
| AC7 | Два замечания в двух файлах уходят одним блоком `keryx-desktop:line-comments` без пометки `untrusted` и блоком цитат `keryx-desktop:line-comment-quotes` с пометкой `untrusted`; черновики очищаются после отправки и сохраняются, если отправка отклонена |
| AC8 | `@` открывает список путей; ввод сужает список; Enter вставляет `@путь`; Esc закрывает; перетаскивание из дерева вставляет тот же текст |
| AC9 | Индикатор контекста скрыт при `size = 0`; «Сжать» неактивна во время хода и выполняет `/compact` вне хода |
| AC10 | keryx с `image: true` и моделью со зрением: скриншот доходит до модели. keryx с `image: false`: отправка картинки заблокирована с причиной. Модель без зрения: в ленте ошибка `image_input_unsupported`, ход не обрывается молча |
| AC11 | Тесты: `cd apps/desktop && bun test src`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`, `bun test src/acp`; `tsc` и `clippy` без ошибок |

## 9. Решения к заморозке

| # | Вопрос | Предложение |
|---|---|---|
| P1 | Звук по умолчанию | Включён; системный звук уведомления, без своих файлов |
| P2 | Дифф против чего | Против `HEAD` рабочей копии; дифф ветки против базы — в парном пакете |
| P3 | Редактор диффа | Собственный рендер на `unifiedDiff.ts`, без тяжёлых редакторов в бандле |
| P4 | Пометка замечаний к строкам | Замечание без `untrusted`; цитаты — отдельным блоком с `untrusted` |

## 10. Требования ↔ разделы

| R | Разделы |
|---|---|
| R1–R3 | §4, §5 (`attention_*`), §6.1 |
| R4 | §6.1, §7 |
| R5 | §5 (`git_changes`, `git_file_diff`), §6.2 |
| R6 | §6.3 |
| R7 | §5 (`project_files`, `project_file_read`), §6.4 |
| R8 | §6.6 |
| R9 | §6.5 |
| P5 | Хранение картинок | Не на диске; только в сообщении |
