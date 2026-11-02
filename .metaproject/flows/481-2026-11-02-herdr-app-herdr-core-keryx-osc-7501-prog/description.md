# Herdr app (herdr-core): статус keryx через OSC 7501, запись в programs.json, оркестрация через hc

Status: formalized
Source: user request in session 2026-11-02 ("запускай flow под пункт 1,2,3" после разбора https://herdr.dev/)

## Problem

Herdr разделился на две программы: десктопное приложение **Herdr app** и фоновый
рантайм **herdr-core** (`hc`), в котором живут терминалы и агенты. Старый
терминальный Herdr TUI остался отдельным продуктом, агентов с новым приложением
он не делит.

keryx интегрирован только со старым TUI (`src/tui/herdr-report.ts`, flow 124):
ждёт `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` и шлёт JSON
`pane.report_agent` в сокет панели. В новом Herdr ничего из этого нет:

- core кладёт в терминал только `HC_TERMINAL_ID` (плюс `HC_SOCKET` и др.);
- статус core читает **только** из OSC 7501, который программа печатает в свой
  терминал (`ESC]7501;state=…:app=…ESC\`); per-agent интеграций и хуков core не
  принимает (herdr-core `CONTRIBUTING.md`);
- во встроенной таблице программ herdr-app (`defaults/programs.json`, ~120
  записей) нет `keryx`.

Итог: в новом Herdr панель keryx — обычная программа без статуса. Нет
уведомлений «done/needs you», `hc wait` и `hc send --wait` не видят конца хода,
шаблоны herdr-core (`~/.config/herdr-core/templates/*.md`) не могут запустить
keryx как агента (по умолчанию ждут первый 7501-отчёт 30 с и не отправляют
задачу), keryx нет в меню «+» приложения. И keryx-агент не умеет пользоваться
`hc` для делегирования, а ответы дочерних агентов (`<hc from="…">…</hc>`)
приходят в его ввод как обычный текст пользователя.

## Expected Outcome

1. **Статус (п.1).** `keryx shell` (OpenTUI и readline fallback, если он
   поддерживает текущий репортер) под herdr-core (`HC_TERMINAL_ID` задан)
   печатает OSC 7501 с `app=keryx`: `idle` когда composer готов к вводу,
   `working` во время хода, `done` в конце хода, `error` при падении хода,
   `blocked` с `kind=permission|question` и текстом (`msg`, base64) на
   approval-карточке и вопросе, `clear` при выходе. Escape-последовательность не
   портит кадр OpenTUI. Старый репортер для Herdr TUI продолжает работать
   (по `HERDR_ENV`), оба независимы.
2. **Herdr app (п.2).** Есть способ (команда keryx и/или документация)
   добавить запись `keryx` в `~/.config/herdr-app/programs.json` (имя, иконка,
   `run`), не ломая чужие записи; keryx появляется в меню «+» и со своей иконкой.
   Подготовлен материал для upstream-PR в `herdr-app/defaults/programs.json`.
3. **Оркестрация через hc (п.3).** keryx работает как дочерний агент
   herdr-core: шаблон(ы) `~/.config/herdr-core/templates/keryx*.md` запускают
   keryx, core дожидается его готовности и отправляет задачу; keryx как
   родитель знает, как делегировать через `hc` (навык/инструкция, доступная
   агенту в keryx shell под herdr-core), и распознаёт входящие
   `<hc from="…">` как отчёт дочернего агента, а не как инструкцию пользователя.
   Точный объём п.3 фиксирует plan.md после брейншторма.

## Outcome criteria

- Живой прогон под herdr-core: `hc get <t>` для терминала с keryx показывает
  `status.app = keryx` и правильное слово состояния на каждом этапе хода.
- Шаблон herdr-core с keryx стартует, и `first_message.sent = true`.

## Out of Scope

- Изменения в herdr-core / herdr-app (кроме подготовки upstream-PR с записью в
  `defaults/programs.json` — отправка PR отдельным решением владельца).
- Удаление интеграции со старым Herdr TUI.
- Свой клиент OpenRPC API herdr-core (подписка на события, attach) — keryx
  пользуется только OSC 7501 и CLI `hc`.
- Мод (gpui-kit JS) для Herdr app.
