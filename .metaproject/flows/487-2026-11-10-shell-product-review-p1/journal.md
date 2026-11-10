# Flow Journal

- 2026-11-10T17:10:03.872Z - flow created
- 2026-11-10T17:10:32.155Z - origin-set: unknown -> agent-finding; source: Keryx Shell product review in this Codex chat, PTY and code evidence (Track the five reproduced P1 findings)
- 2026-11-10T17:10:32.380Z - task-added: T5: Preserve model context and reset the TUI on session switch
- 2026-11-10T17:10:32.610Z - task-added: T6: Restore draft on route dismissal and default shell approval to denial
- 2026-11-10T17:10:32.844Z - task-added: T7: Interrupt active Agent and Chat turns with Escape
- 2026-11-10T17:10:33.237Z - task-added: T8: Repeat all five P1 scenarios in an isolated PTY
- 2026-11-10T17:10:33.486Z - frozen: 5 criteria; checksum recorded
- 2026-11-10T17:10:33.720Z - started

## Implementation on hold

The operator asked to continue collecting live review evidence and postpone fixes. No source or test changes were made and no implementation tasks were dispatched.
- 2026-11-10T17:11:23.991Z - blocked: Operator requested a review and evidence collection phase before starting fixes

## Baseline review evidence

Replayed the five P1 scenarios on the installed 0.4.25 release in isolated PTYs with a loopback provider. The provider received 202 request messages after interactive resume versus 210 after startup resume from identical 208-message sessions, counting the system message and new prompt. Captured 20 PNG frames covering the five P1s, slash selection, narrow settings, light status and onboarding. The PNG archive is attached in the Codex chat. Computer Use denied access to iTerm2, so the frames use terminal cells captured in tmux.

## Продуктовое ревью Shell, второй проход

Версия 0.4.25, macOS, отдельные живые PTY в tmux. Основной размер 132×40. PNG отрисованы из захваченных кадров терминала. Модель, MCP и Telegram обслуживали локальные стенды. Для Telegram использовался реальный loopback-интерфейс keryx serve с FakeBotApi. Папки, записи и файл для проверки разрешений были временными.

### R2-01 · P1 · Очередь и события задач переходят в новый диалог

1. Открыть два Agent Shell в одном репозитории и назвать их `review-red` и `review-blue`. В `review-blue` отправить обычное сообщение, чтобы у исходного диалога были история и ID.
2. В `review-red` ввести `/bus pause @review-blue --scope turns --ttl 2m Synthetic hold`. В `review-blue` отправить `QA_QUEUED`, увидеть `q1`, затем ввести `/new`.
3. В `review-red` ввести `/bus resume`. После обновления lease запрос уходит модели и записывается в архив нового ID. В исходном архиве его нет. Кадры 14, 15, 17 и 19.
4. Вариант с задачей. Разрешить агенту запустить `sleep 35`, дождаться переноса в фон, выполнить `/new`, затем `/tasks` и `/tasks kill <task_id>`. Старый процесс виден и останавливается из нового диалога. Его событие завершения само запускает ход модели в новом ID. Кадры 98–100.

Идея. Хранить ID владельца у очереди и событий завершения. При создании нового диалога показать ожидающую работу и дать явный выбор для переноса. Если фоновая задача переживает переключение, её уведомление должно оставаться привязанным к исходной сессии.

### R2-02 · P2 · Chat показывает ID другой сессии

Запустить Chat и Agent для одного проекта и хранилища. Отправить разные запросы, завершить ход в Agent последним, затем вызвать `/status` в Chat. На стенде Chat показывал собственный контекст около 49 токенов, но заголовок `QA_TOOL_BG` и ID с окончанием `9e98dbdc` принадлежали Agent. Экран предлагает `c copy id` для этого значения. Буфер обмена iTerm2 не проверялся. Кадры 64–66.

Идея. Брать идентичность и счётчики из одной текущей сессии. Если у Chat нет сохраняемого ID, скрыть действие копирования.

### R2-03 · P2 · /schedule принимает флаг Bun за исполняемый файл проекта

Из корня тестового репозитория запустить глобально установленный `keryx shell`. Ввести `/schedule --name fixture-review --every "every 4 hours" --rates 1,1 --ceiling 0.01 --provider anthropic --model claude-sonnet-4-6 -- Read fixture only`. Preflight сообщает, что `--no-env-file` находится внутри проекта, и предлагает глобальную установку. Повтор через прямой запуск Bun над тем же установленным файлом даёт тот же отказ. В профиле также отсутствовала учётная запись Anthropic, это отдельный отказ. Расписание не устанавливалось. Кадры 42–43.

Идея. Проверять исполняемый файл и путь к скрипту отдельно от аргументов. В выводе разделить бюджет, учётные данные и диагностику раннера.

### R2-04 · P2 · Work → Jobs плохо управляется с клавиатуры и неверно записывает причину остановки

Запустить фоновый `sleep 35`. Открыть карточку Work, вкладку Jobs и строку процесса. Вложенная вкладка Output видна, но стрелки переключают внешние вкладки или оставляют Output. Открыть Meta мышью. Нажатие `k` оставляет `Status running`. Нажатие `[ Kill ]` действительно останавливает процесс, после чего Meta показывает `Kill reason model`, хотя кнопку нажал оператор. Кадры 05–08.

Идея. Дать вложенным вкладкам собственный видимый фокус и клавиатурный путь до остановки. Записывать действие кнопки с причиной `operator`. Различать остановленную и упавшую задачу в кратком счётчике.

### R2-05 · P2 · Chat обещает отложить команду, но её нужно повторить

Запустить медленный ответ в `--chat`. Отправить два обычных сообщения и ввести `/new` до завершения стрима. Интерфейс пишет `command deferred`. После двух ответов диалог не сбрасывается. Обычные сообщения действительно проходят FIFO. Кадры 60–62.

Идея. Уточнить, что команда сейчас отклонена, и сохранить её как черновик для повторного запуска. Визуально отличать ожидающие сообщения от уже обработанных.

### R2-06 · P3 · Telegram смешивает настройку канала с доступностью и неверно описывает закрытие темы

Включить `/remote-control review-topic`, открыть Remote и остановить тестовый serve. Через две секунды модалка и верхняя строка сайдбара показывают `offline`, нижняя строка Telegram ещё показывает `connected`. При открытии `/channels` уже виден отказ `keryx serve is not running`. Строка канала опрашивается раз в 10 секунд. Кадры 54–57.

При включении темы транскрипт обещает `closing the shell deletes the topic`. После `/exit` FakeBotApi зарегистрировал закрытие темы и ни одного удаления. Кадры 93 и 101.

Идея. Развести «канал настроен» и «доставка доступна» и синхронно обновлять статус при обрыве. Для завершения Shell использовать «тема архивируется».

### R2-07 · P3 · Причина запроса разрешения для MCP вводит в заблуждение

Подключить локальный fixture `echo-server.ts` и вызвать `use_tool` для его `echo` с `readOnlyHint`. До подтверждения Shell показывает `destructive command — no mode lifts this`. Явное подтверждение вернуло только переданный текст, а отказ на `write_note` остановил вызов. Консервативное требование подтверждения для MCP задано осознанно. Проблема в подписи причины. Кадры 24–27.

Идея. Писать, что инструмент внешнего MCP требует подтверждения, и отдельно указывать, что сервер заявил режим чтения.

### R2-08 · P3 · Ошибка формата запроса направляет в настройки доступа

На локальном OpenAI-совместимом endpoint вернуть HTTP 400 для одного запроса. После сообщения об отказе Shell советует переподключиться и проверить аккаунт, доступность модели и политики доступа. В исходниках этот совет общий для authentication и invalid_request. Переключение на вторую модель и следующий корректный запрос успешно выполнены. Кадры 30–32.

Идея. Для HTTP 400 показывать, как скорректировать запрос или параметры, когда провайдер сообщает об этом. Совет переподключиться оставить для отказов авторизации и доступа.

### Покрытие и ограничения

- Живая сессия защищена от захвата. Проверены отказ в интерактивном picker, режим read-only и запуск отдельного fork. Исходный Agent остался в своей сессии.
- Agent Bus доставил синтетическое сообщение. Для обычной очереди проверены редактирование с сохранением позиции, Force с остановкой активного хода и последующий FIFO.
- На локальном MCP проверены ответ разрешённого вызова и отказ для пишущего вызова. Первые тестовые профили обнаружили глобальные MCP-настройки IDE, после чего они были отключены в конфигурации стенда. Кадры с пользовательским списком интеграций исключены.
- С FakeBotApi прошли входящее сообщение, ответ в тему, восстановление после перезапуска serve и отказ по кнопке Deny. Тестовый файл остался прежним. Также проверены состояние offline и архивирование темы.
- Одноразовый /goal прошёл до ответа модели, но заглушка не выполнила привязку рабочего пространства. Автономный цикл, настоящие OAuth, GitHub, Telegram, внешние агенты и запуск системного таймера не входили в подтверждённое покрытие.
- Архив второго прохода содержит 48 PNG. Доступ Computer Use к iTerm2 был заблокирован. Использовался отдельный живой Shell, кадры его PTY сохранены отдельно от первой серии.
- 2026-11-10T17:57:43.864Z - unblocked: resumed as in-progress
- 2026-11-10T17:57:44.320Z - task-attempt: T6: started (attempt 1) — S01 and S02 only, with red-green regressions and a live PTY pass

## T6 · Проверка S01 и S02

Код и регрессии сохранены в `58790c9c5`. Новые тесты воспроизвели выбор `Allow once` по Enter и отправку в Side‑1 по Esc до правок. После правок оба сценария проходят. Тест S02 также проверяет точное восстановление многострочного текста с пробелами, фокус поля и оба явных маршрута.

- **S01 / AC5.** Запустить Shell в `--ask` и отправить `QA_TOOL_FILE` тестовому провайдеру. Дождаться `Allow shell command?` для `printf fixture > qa-file.txt`. В отдельных запросах нажать Enter и Esc. В обоих случаях провайдер получил отказ, а файл сохранил `original`. В третьем запросе выбрать `Allow once` и подтвердить Enter. Провайдер получил один успешный результат, файл стал `fixture`. Пустой Enter в режиме `--no-tui` тоже дал отказ. Выбор по умолчанию · [Отказ по Enter](evidence/pty/02-s01-bare-enter-denied.png) · [Явное разрешение](evidence/pty/05-s01-explicit-command-ran.png)
- **S02 / AC3.** Отправить `QA_LONG`. Во время стрима набрать `QA_DRAFT_ONLY`, нажать Enter и закрыть меню `Main agent is busy` клавишей Esc. Текст вернулся в поле, текущий стрим продолжился, очередь и число запросов к провайдеру остались прежними. При повторной отправке и явном выборе `Main queue` появилась запись `q1`, затем сообщение отправилось один раз после завершения стрима. В отдельной сессии явный выбор `Side-1` дал один ответ Side‑1 во время основного стрима. Меню · [Черновик после Esc](evidence/pty/07-s02-escape-restores-draft.png) · Main queue · Side‑1

Shell запущен из исходников в изолированных tmux PTY 120×36 с локальным Ollama-совместимым провайдером. PNG получены из ANSI-кадров этих PTY. Архив из 12 PNG сохранён в материалах локального прогона

TypeScript и ESLint изменённых файлов прошли. Широкий набор TUI, readline и проверок разрешений дал 2634 успешных теста из 176 файлов. Для этого прогона использовался `GIT_CONFIG_GLOBAL=/dev/null`, чтобы хук из глобального Git-шаблона не отклонял коммиты с тестовыми авторами во временных репозиториях. Общий прогон T8 остаётся открытым для оставшихся трёх P1.
- 2026-11-10T18:07:33.246Z - task-done: T6: Restore draft on route dismissal and default shell approval to denial
- 2026-11-10T18:13:35.600Z - task-attempt: T5: started (attempt 1) — Restore full session context and replace the TUI surface on successful switch
- 2026-11-10T18:13:36.031Z - task-attempt: T7: started (attempt 1) — Route Escape to active Agent and Chat streams when available

## T8 · Повторный прогон всех пяти P1

Запуск из исходников в отдельных tmux PTY 120×36. Данные сессий изолированы, ответы и вызовы инструментов задаёт локальный Ollama-совместимый провайдер. PNG собраны из ANSI-кадров терминала. Архив из 29 PNG сохранён в материалах локального прогона

| Сценарий | Действия и результат | Кадры |
| --- | --- | --- |
| S01 / AC5 | В `--ask` вызвать команду записи в файл через `QA_TOOL_FILE`. Enter и Esc дали отказ, файл сохранил `original`. Явный выбор `Allow once` дал один успешный результат и записал `fixture`. Пустой Enter в readline тоже дал отказ. | [Enter](evidence/pty/02-s01-bare-enter-denied.png) · [Allow once](evidence/pty/05-s01-explicit-command-ran.png) · readline |
| S02 / AC3 | Во время `QA_LONG` набрать `QA_DRAFT_ONLY` и нажать Esc в меню получателя. Текст вернулся в поле, очередь и число запросов не изменились. При явном выборе Main queue запрос отправился один раз после текущего хода. Явный Side‑1 дал ответ во время стрима Main. | [Esc](evidence/pty/07-s02-escape-restores-draft.png) · Main queue · Side‑1 |
| S03 / AC1 | Подготовить две сессии с одинаковыми 208 сообщениями контекста и 209 записями архива. Открыть одну через `-r`, вторую через `/sessions`, затем отправить контрольный запрос в каждой. Провайдер получил один и тот же упорядоченный префикс из всех 208 сообщений, включая первое. После сохранения в переключённой сессии 210 сообщений контекста и 211 записей архива. Все исходные записи совпали по значениям полей и сохранили порядок. | [Запуск с -r](evidence/pty/13a-s03-startup-full-context.png) · Выбор сессии · [Запрос после переключения](evidence/pty/13d-s03-follow-up-after-switch.png) |
| S04 / AC2 | Получить ответ с блоком кода и ненулевым расходом. Отменить picker и отдельно выбрать сессию, которую держит другой Shell. В обоих случаях старый транскрипт и расход сохранились. При переходе в свободную сессию показались её пять последних запросов, счётчики сбросились, старый расход исчез из футера, `/expand` не нашёл старый блок. | До перехода · Отказ · [После перехода](evidence/pty/16e-s04-destination-preview-and-reset.png) · /expand |
| S05 / AC4 | Запустить медленный ответ в Agent и Chat. Esc прервал оба запроса, провайдер зарегистрировал разрыв каждого, поздний фрагмент не появился. Обе сессии ответили на следующий запрос. В Chat первый Esc при открытом `/theme` закрыл меню и сохранил стрим, второй прервал его. | [Agent после Esc](evidence/pty/17b-s05-agent-interrupted.png) · [Chat после Esc и нового запроса](evidence/pty/18c-s05-chat-follow-up.png) · Закрытие меню во время стрима |

Автоматические регрессии T5 воспроизвели отправку только 200 сообщений и отсутствие целевого превью. В T7 регрессия Chat воспроизвела отсутствие сигнала отмены. Проверки Agent и Chat после правки подтверждают сигнал отмены у провайдера и следующий ответ. Отдельный набор macOS PTY прошёл все 7 проверок. TypeScript и ESLint изменённых файлов прошли.

Широкий набор TUI, сессий, разрешений, readline и Chat завершился с 2679 успешными тестами из 178 файлов. Глобальная Git-конфигурация была отключена только для тестовых процессов, чтобы хук шаблона не блокировал коммиты временных тестовых репозиториев. Локальные коммиты `3cf25647b` (T5), `a111bb965` (T7) и `072cbd226` (стабилизация тестов T8).
- 2026-11-10T18:25:32.622Z - task-attempt: T8: started (attempt 1) — Final live replay of S01–S05 from source. 29 captured PNGs and provider, file and checkpoint assertions recorded.
- 2026-11-10T18:26:59.127Z - task-done: T5: Preserve model context and reset the TUI on session switch
- 2026-11-10T18:26:59.373Z - task-done: T7: Interrupt active Agent and Chat turns with Escape
- 2026-11-10T18:26:59.621Z - task-done: T8: Repeat all five P1 scenarios in an isolated PTY
- 2026-11-10T18:35:36.616Z - task-done: T1: Collect remaining context
- 2026-11-10T18:35:36.861Z - task-done: T2: Implement per plan
- 2026-11-10T18:35:37.091Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-10T18:35:37.319Z - task-done: T4: Self-review and prepare draft PR

## Final review and draft handoff

Reviewed the five frozen criteria on the feature branch against `origin/main` at `947f6d9cf`. The base includes flow 483's changes to turn usage. The operator explicitly requested the standard final review and a draft PR.

Independent reviewers checked session lifecycle, permission and keyboard safety, and regression coverage. The fixes in `5c8358bfa` retire delayed Side-1 work on successful switch, retain the source when a new turn begins during preservation, and keep text typed before the recipient picker appears. A same-session selection leaves the live session open. The macOS regression now exercises an outgoing reasoning block and Escape through the real Agent launcher. The concurrent draft regression uses real OpenTUI key events.

The final live tmux run passed S01–S05. A separate replay with Side-1 still running verified that its old reply never appears in the destination. A held Slate lock let a new main turn start during preservation. The switch refused to adopt the destination and the turn finished in the source.

| Case | Selected evidence from the updated branch |
| --- | --- |
| S01 | [Enter denies](evidence/pty/02-s01-bare-enter-denied.png) · [Allow once](evidence/pty/05-s01-explicit-command-ran.png) |
| S02 | [Draft restored](evidence/pty/07-s02-escape-restores-draft.png) |
| S03 | [Startup resume](evidence/pty/13a-s03-startup-full-context.png) · [Follow-up after switch](evidence/pty/13d-s03-follow-up-after-switch.png) |
| S04 | [Destination preview and zero usage](evidence/pty/16e-s04-destination-preview-and-reset.png) · [Destination after the Side-1 reply window](evidence/pty/19-s04-side-worker-cannot-leak.png) |
| S05 | [Agent interrupted](evidence/pty/17b-s05-agent-interrupted.png) · [Chat follow-up](evidence/pty/18c-s05-chat-follow-up.png) |

Final verification passed 2,687 tests across 179 files and seven macOS PTY checks. TypeScript and changed-file ESLint passed. The general health wrapper's ESLint invocation picked up nested checkout backups and reported an ambiguous TypeScript config root. Running the repo linter with `.worktree-backups/**` and `.metaproject/tmp/**` excluded passed. The test processes used an empty global Git config to isolate fixture commits from local Git hooks.

All eight tasks are done. The flow is awaiting review of its draft PR.

Draft [PR #1160](https://github.com/MrCipherSmith/keryx/pull/1160) targets `main` at published head `43a67e917`. The nine PTY images in the PR were verified over HTTP. The flow remains in progress while the PR is a draft.
- 2026-11-10T18:50:23.434Z - task-added: T9: Fix PR #1160 CI regressions and verify the published head
- 2026-11-10T18:50:39.788Z - task-attempt: T9: started (attempt 1) — Fix startup-prompt source assertions and refresh native command coverage after the Shell changes.
- 2026-11-10T18:53:06.373Z - owner-set: not set -> MrCipherSmith (Operator explicitly assigned flow 487 ownership during the PR #1160 handoff.)

The PR run exposed stale startup routing assertions and native command receipts. The assertions now cover typed routing with the original draft, and the generator reproduced all 147 required command variants. The local terminal matrix passed 2,930 tests.

The follow-up review found a remaining S04 race: with the outgoing Slate lock held, a new prompt could start a turn during a session switch. The switch could then refuse after already archiving the live Slate. The shell now holds the transfer through preservation and visible adoption. A local submission during that interval stays editable in the composer and requires a second Enter after the switch. The allocated macOS PTY regression reproduced an extra provider request on the prior commit. With the fix it observed no request during preservation, retained the draft, and sent it exactly once to the destination after explicit submission. The complete PTY suite passed eight tests, and 367 related tests passed.

The next review checked input that outlives the original session. If the busy recipient choice is delayed, both Main and Side-1 now check the session that owned the draft before dispatch. A stale choice returns the draft without sending it. The regression reproduced a Main delivery on `d23113af`; with the guard both recipient cases preserve the original and newly typed drafts. Telegram commands refused during transfer now return a failure outcome with a retry message. The focused shell and remote router suite passed 297 tests.
