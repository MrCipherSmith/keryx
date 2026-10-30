# Hub на geekom

Развёрнуто 25 октября 2026, Asia/Muscat. URL: **https://hub.example.com**. Исходный релиз — `da0c714525121f33fbcf198e43b273dc387cd750`, отдельный Compose project `keryx-team-hub` в `/home/<user>/keryx-team-hub`. Существующие домены, контейнеры и системный cloudflared не перенастраивались. Sudo не использовался; переданный пароль не записывался в файлы или память проекта.

## Как войти сейчас

В своём терминале получите реквизиты через SSH:

```sh
ssh <server> 'cat ~/keryx-team-hub/secrets/browser-access.txt'
```

Откройте URL. Cloudflare Access запросит email **owner@example.com** и одноразовый код из письма. После этого форма Hub попросит **Hub operator token** из защищённого файла. Access-сессия длится один час. Предыдущие логин `aleks` и Gateway password больше не используются. Не передавайте operator token агентам и не вставляйте его в URL. Если после повторных входов появилась 429, подождите несколько минут.

25 октября 2026 выполнен переход с Nginx Basic Auth на Cloudflare Access. Hub реально открылся во встроенном браузере после ввода владельцем одноразового кода. TLS проверяется без отключения проверки сертификата.

## Что защищено и проверено

Hub и шлюз слушают только `127.0.0.1:8787` и `127.0.0.1:8788`. Туннель отдельный: `keryx-team-hub-prototype`, UUID `<CLOUDFLARE_TUNNEL_ID>`. Его единственный hostname — `hub.example.com`, остальные запросы получают catch-all 404. Cloudflared-контейнер получает только credential конкретного туннеля; account-wide cert не смонтирован. `originRequest.access.required: true` включает проверку подписи, issuer и AUD Access JWT до передачи запроса шлюзу. Nginx дополнительно отклоняет отсутствие assertion, но сам его подпись не проверяет.

Все три контейнера работают без root, с read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, лимитами памяти/pids и ограничением логов. Nginx и cloudflared закреплены digest. Секреты в каталоге 700: env и файл реквизитов 600, credential туннеля 400. Неиспользуемый Basic Auth credential больше не монтируется в Nginx. Docker socket и домашний каталог в контейнеры не передавались. Автозапуск — Docker restart `unless-stopped`; Docker service enabled.

Проверки после перехода: анонимные root/API запросы, поддельный JWT assertion и одна Hub cookie без Access дают 302 на `example-team.cloudflareaccess.com`; доступа к origin нет. Локальный edge без JWT с HTTPS forwarding header возвращает 403. После успешного OTP настоящий запрос прошёл JWT-проверку cloudflared; после снятия Basic Auth встроенный браузер загрузил форму Hub, console errors не наблюдались. Hub health — 200, nginx config и tunnel ingress validation — OK, системный cloudflared других приложений — active.

При первоначальном развёртывании также проверены API без Hub session → 401, agent browser login и чужой Origin → 403, operator cookie `Secure; HttpOnly; SameSite=Strict`, restart persistence и session throttle → 429. Эти ограничения Hub не менялись. Создание/приёмка Flow и данные проекта при настройке Access не изменялись.

Ограничение: rate limit привязан к адресу tunnel connector, поэтому разделяется между внешними посетителями; это небольшой частный тестовый инстанс. Hub по-прежнему имеет ограничения прототипа из [handoff](handoff.md): SQLite/один процесс, фиксированные роли и self-reported evidence. Проверка не является аудитом всего сервера; существующие посторонние открытые порты не менялись.

## Cloudflare Access: действующая конфигурация

Приложение `Keryx Team Hub` создано владельцем через браузер с явным подтверждением применения политики. Дополнительная оплата и изменение тарифа не потребовались: использован существующий Zero Trust Free.

- Application ID: `05eca2c6-364e-47ea-ac6f-11bcd9c8b02f`.
- Policy ID: `895839f3-26a6-4367-ba58-59db0bc3a209`.
- Policy: Allow → Include Emails → `owner@example.com`; других правил Allow/Bypass нет.
- Hostname: `hub.example.com`, весь путь.
- Login method: One-time PIN; instant authentication включён.
- Team: `example-team`; application session duration: `1h`; Access cookie HTTP Only включён.
- AUD: `<CLOUDFLARE_ACCESS_AUD>`.

AUD — идентификатор приложения, не секрет и не credential. Cloudflared проверяет его по [официальной конфигурации Access validation](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#access). Не заменяйте проверку подписи простым наличием HTTP-заголовка. Email OTP не является независимым MFA; доступ к почте остаётся частью модели доверия.

Старый account certificate по-прежнему не имеет Access write; его права не расширялись. Управление приложением доступно владельцу в [Cloudflare One](https://one.dash.cloudflare.com/), Access controls → Applications. [Описание email PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).

Предыдущие конфигурации и реквизиты сохранены в закрытой папке `backups/access-migration-<UTC timestamp>/`; её точный путь записан в `~/keryx-team-hub/access-migration-backup-path`. Это резерв для контролируемого отката, а не автоматическое удаление Access. Нельзя отключать Access, пока не восстановлен и не проверен другой внешний барьер.

## CLI и локальные агенты

Публичный адрес теперь требует Cloudflare Access. Текущий CLI не умеет получать Access cookie или передавать service credentials, поэтому для CLI используйте SSH-туннель. Серверные агенты продолжают обращаться к `http://127.0.0.1:8787` с agent Bearer token — их путь не изменён:

```sh
ssh -N -L 8787:127.0.0.1:8787 <server>
```

Затем подключайте checkout к `http://127.0.0.1:8787` по [инструкции коннектора](connector.md). В `KERYX_HUB_TOKEN` передавайте соответствующий **agent token**, полученный владельцем через SSH из защищённого `~/keryx-team-hub/secrets/hub.env`. Не передавайте агенту operator/reviewer credentials. Для команд оператора используйте отдельную оболочку с operator token.

## Управление и резервная копия

На <server>:

```sh
~/keryx-team-hub/hubctl ps
~/keryx-team-hub/hubctl logs --tail 50 hub edge tunnel
```

`hubctl` использует абсолютные пути и физический каталог релиза: логический `cd` через symlink может неверно разрешить относительный env path. Проверены вызов из `/tmp` и restart только edge/tunnel; Hub остался healthy. При ручном запуске используйте `cd -P ~/keryx-team-hub/current`. `current` указывает на `releases/da0c71452`. Начальный консистентный backup: `~/keryx-team-hub/backups/initial-20261025/`, создан при остановленном Hub. Данные находятся в volume `keryx-team-hub_hub-data`; `PRAGMA quick_check` вернул `ok`. Backup отдельно восстановлен в writable tmpfs контейнера без сети: `quick_check` также вернул `ok`; рабочая база не заменялась. Секреты резервируются отдельно в защищённое хранилище; не добавляйте их в репозиторий.

Чтобы закрыть только внешний доступ, остановите **tunnel** этого Compose project:

```sh
~/keryx-team-hub/hubctl stop tunnel
```

Чтобы остановить весь новый инстанс, замените `stop tunnel` на `stop`. Не выполняйте `down -v`: это удалит данные. Не перезапускайте системный `cloudflared.service`: он обслуживает другие приложения.

Конфигурации без секретов сохранены в `deploy/team-hub/geekom/`; для воспроизведения они копируются в **корень выделенного релиза**, а не запускаются из вложенной папки репозитория. Файл `deployment.json` в серверном релизе фиксирует SHA256 source/overrides. Source release зафиксирован; локальные изменения graph/testing/browser артефактов не отправлялись.

Routing audit: `graph_used: yes` (известный source closure; граф сообщил о служебных untracked артефактах), `wiki_used: yes`, `ctx_used: yes`, `raw_rg_used: no`.
