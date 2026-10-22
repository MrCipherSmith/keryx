# One /connect modal with Connected and Add provider tabs

Status: draft
Source: operator request, Telegram message 219474 (2026-10-22), answers to poll 248

## Problem

Connecting a model provider is split across two commands that open different dialogs. `/connect` lists only the providers that already work, with [Test] and [Disconnect] per row. `/provider` is a separate step-by-step wizard (list of every known provider, base URL, key or device login, models, model pick) and has no Test button: a bad key shows up only as a failed `/models` call. The operator has to know which command does which, and a provider added in one dialog is tested in the other.

## Expected Outcome

`/connect` is the only command. It opens one modal titled "Providers" with two tabs.

- Tab "Connected": what `/connect` shows today (rows, [Test], [Disconnect], pick a provider then a model), plus an [Add provider] button that switches to the second tab.
- Tab "Add provider": every known provider, each with [Connect] and [Test]. [Connect] collects the key or runs the device login, checks `/models`, then returns to the first tab. It does not switch the session.

`/provider` is removed. Telegram gets the same two-part flow with buttons; [Connect] there runs the device login where a provider offers one, and never takes a key in chat. Release: a separate release right after merge (operator, poll 249).

## Outcome criteria

- An operator adds a new provider, tests it and sees it listed under Connected without leaving `/connect` or typing a second command.
- `/provider` is gone from the command menu, help, README and docs site.

## Out of Scope

- `/search-provider` and `/search-connect` (web search providers).
- Disconnect, key entry or URL editing from Telegram (flow 387 AC4 keeps them in the shell).
- Changing what Test measures, the catalog cache or the profile refresh behind it.
- Putting wizard steps (key, URL, device login) inside the tab body: they stay separate dialogs that return to the tabbed modal.

## Effects

- Запрос (дословно): «Синхронизируйся с main. Изучи как работают команды /providers и /connect, я хочу объединить их. То есть 1 команда, 1 модалка и 2 табы. На первой connect как сейчас + кнопка add provider который переключает на следующую табу, на второй провайдеры где можно подключить и проверить конеекшн,» (message 219474)
- Эффект (формализация агента): одна команда `/connect` открывает модалку из двух табов; `/provider` удалён; на втором табе у каждого провайдера [Connect] и [Test].
- Как наблюдать (предложение агента): открыть `/connect` в живой оболочке с пустым config-каталогом, добавить локальный OpenAI-совместимый провайдер на втором табе, нажать [Test], увидеть его на первом табе.
