# Spike S0 — клик по системному уведомлению на macOS

Приложение к `specification.md` §6.1.3 и `implementation-plan.md`, этап 1, шаг 1. Дата: 2026-11-21.

## Вывод

**Путь A (плагин) не годится как единственный:** клик с данными доходит только когда приложение в фоне. Когда Keryx впереди, клик не доставляется вообще, а активация через Dock данных не несёт. **Выбираем путь B**: собственный делегат `UNUserNotificationCenter`. Клик по баннеру он доставил с `projectCwd`/`sessionId` и при приложении спереди, и в фоне. Мера A из §6.1.3 остаётся запасной.

Поправка к предпосылке спека: «на macOS у `tauri-plugin-notification` нет обратного вызова клика» устарело. В версии 2.8.1 на десктопе есть `Notification::on_action` (`actionId = "tap"`) и `NotificationBuilder::extra(...)`, данные приходят в `performed.notification().extra()`. Но, как показано ниже, на macOS этого мало.

## Стенд

Одноразовое приложение Tauri 2 (`spikes/notifspike`, локальная ветка `spike/s0-notif-prototype`, в main не идёт), bundle id `dev.keryx.desktop.notifspike`, продукт «Keryx NotifSpike». Сборка: `tauri build --debug --bundles app --no-sign`. Установленный Keryx.app не затронут. Уведомления запускались скриптом через файл-триггер, каждое событие писалось в лог с меткой времени. Клики делал владелец вручную.

## Результаты

| Случай | Путь A (плагин 2.8.1) | Путь B (делегат) |
|---|---|---|
| Приложение в фоне, клик по баннеру | `tap` + `extra` (project, session) | `didReceive` + `userInfo` (project, session); приложение активируется |
| Приложение спереди, клик по баннеру | **ничего**: только смена фокуса | `didReceive` + `userInfo`; баннер показан делегатом `willPresent` |
| Клик позже из Центра уведомлений | не подтверждено (только активация, без данных) | не подтверждено (клик не дошёл до делегата, см. ниже) |
| Активация из Dock | только `RunEvent::Reopen`, данных нет | то же: `Reopen` без данных |

Что значит «не подтверждено» для третьей строки: в четырёх попытках владелец кликал по самому баннеру раньше, чем срабатывала проверка «позже», а тихая доставка (интерфейсный уровень `Passive`) положила уведомление в Центр, но два клика по нему не дали события ни в одном из путей. Отдельный вывод о Центре уведомлений поэтому делать нельзя; при реализации этапа 1 это проверяется отдельно на подписанной сборке (см. «Риски»).

Значок и звук в той же сборке: `set_badge_count(Some(n))` вернул `Ok`, число на значке в Dock владелец видел; звук `Ping` через путь A слышал. Звук пути B отдельно не подтверждался.

## Почему A не хватает

Плагин на macOS использует `notify-rust` → `mac-notification-sys`: на каждое уведомление живёт поток, ждущий ответа (`wait_for_response`). По наблюдениям клик через него доходит только когда приложение в фоне; причину при активном приложении мы не выясняли (это внутреннее поведение `notify-rust`). Для этапа 1 важен результат: «приложение спереди» не покрыто, а именно там главный сценарий (одно окно в фокусе, ожидание в другом проекте).

## Что нужно для пути B

Зависимости (`Cargo.toml`, только macOS): `objc2 = "0.6"`, `block2 = "0.6"`, `objc2-foundation = "0.3"`, `objc2-user-notifications = "0.3"`.

Вызовы:

1. На старте: `UNUserNotificationCenter::currentNotificationCenter()`, `setDelegate(Some(ProtocolObject::from_ref(&*delegate)))`; делегат хранить живым (центр держит слабую ссылку), `requestAuthorizationWithOptions(Alert | Sound | Badge)`.
2. Делегат (`define_class!`, `NSObject` + `UNUserNotificationCenterDelegate`):
   - `userNotificationCenter:willPresentNotification:withCompletionHandler:` → вызвать обработчик с `Banner | Sound` (иначе баннера при приложении спереди нет);
   - `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:` → прочитать `response.notification().request().content().userInfo()` (`projectCwd`, `sessionId`), открыть сессию, вызвать обработчик.
3. Отправка: `UNMutableNotificationContent` с `title`, `body`, `sound = defaultSound`, `userInfo = {projectCwd, sessionId}`; `UNNotificationRequest::requestWithIdentifier_content_trigger(id, content, None)`; `addNotificationRequest_withCompletionHandler`.
4. Значок: `WebviewWindow::set_badge_count(Some(n))` (Tauri) работает; запасной вариант `UNUserNotificationCenter::setBadgeCount`.
5. Из делегата в остальной код: callback на `AppHandle` (в спайке делегат только пишет в лог); активировать окно нужного проекта и отправить сессию в представление.

Плагин `tauri-plugin-notification` для пути B не нужен.

## Риски и замечания для этапа 1

- **Подпись.** С `--no-sign` Tauri оставляет подпись компоновщика с идентификатором `notifspike-<hash>`, а не bundle id; `requestAuthorization` вернул `granted=false`, `UNErrorDomain` код 1 («notifications not allowed»). После `codesign --force --deep -s - --identifier <bundle id>` разрешение выдано, и всё заработало. Выпускная сборка подписана Developer ID, но этап 1 должен это проверить на ней и на сборке для проверок (CI без подписи путь B не покажет).
- **Центр уведомлений.** Клик по уведомлению, пролежавшему в Центре, на этом стенде не подтверждён (см. выше). Принять в этап 1 проверку на подписанной сборке; если делегат его не получает, остаётся мера A из §6.1.3 для позднего клика.
- **Окно спрятано.** Закрытие последнего окна Tauri завершает приложение; в спайке закрытие заменено на `hide`. Для Keryx это уже решено проектами/хост-окнами, но клик по уведомлению при закрытых окнах нужно проверить отдельно.
- Дублирование: при пути B плагин не используется, так что кликов дважды (плагин и делегат) не будет.

## Решение для заморозки (P6)

Путь B. Мера A — только запасная для позднего клика из Центра, если проверка на подписанной сборке покажет, что делегат его не получает.
