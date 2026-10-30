# Team Hub: запуск и проверка прототипа

Team Hub — отдельный сервер общей wiki, спецификаций, Flow, ревизий кода и человеческих решений. Браузер работает с настоящим API и SQLite. Локальные приложения, Docker-среда разработчика и запуск агентов остаются на рабочих машинах. Канонические Hub Flow не синхронизируются с прежними локальными `keryx flow`.

Контракт: [спецификация](specification.md), [API v1](api.md). Интерфейс доступен в корне сервера; `/healthz` открыт без авторизации и возвращает только состояние сервиса.

Рабочие заметки: [распространение, установка для новой команды и MCP-доступ](distribution-notes.md) — предложения для следующих этапов, не текущие возможности релиза.

## Быстрый локальный запуск

Нужны Bun **1.3.14 или новее** и Git. Для MCP нужен зафиксированный SDK; контейнер устанавливает его автоматически, а исходный release — по lockfile (см. [MCP runtime](../hub-mcp/deployment.md)). Без MCP остальные HTTP-пути используют встроенные средства Bun. Из корня репозитория:

```sh
export KERYX_HUB_OPERATOR_TOKEN="$(openssl rand -hex 32)"
export KERYX_HUB_AGENT_TOKEN="$(openssl rand -hex 32)"
export KERYX_HUB_DATA_DIR="$HOME/.local/share/keryx-team-hub-test"
export KERYX_HUB_HOST=127.0.0.1
export KERYX_HUB_PORT=8787
bun run src/hub/main.ts
```

Откройте [локальный Hub](http://127.0.0.1:8787). Введите значение **operator** token из своей оболочки, чтобы войти человеком. Agent token — отдельное значение для CLI/API агента; браузерные сессии доступны только людям. Не передавайте агенту operator token. При необходимости задайте третий независимый `KERYX_HUB_REVIEWER_TOKEN`. Секреты не коммитьте. Для повторного запуска сохраните их в своём защищённом env-файле: без прежних значений прежняя личность не будет доступна. Браузер получает HttpOnly/SameSite cookie; token не записывается в localStorage.

Переменная `KERYX_HUB_TOKEN` относится к локальному CLI-клиенту, а не к конфигурации сервера. API принимает Bearer token; браузер использует same-origin cookie. Все изменения JSON используют ключ идемпотентности. При неопределённом сетевом результате повтор неизменённой формы в текущей вкладке использует прежний ключ. Перезагрузка страницы теряет эти временные ключи и черновики — сначала проверьте историю перед повторным созданием.

## Контейнер на тестовом сервере

Из корня репозитория:

```sh
cp deploy/team-hub/.env.example deploy/team-hub/.env
chmod 600 deploy/team-hub/.env
```

В `.env` впишите **два разных**, самостоятельно сгенерированных `openssl rand -hex 32` значения. Готовых общих паролей в репозитории нет. Затем:

```sh
docker compose --env-file deploy/team-hub/.env -f deploy/team-hub/compose.yaml up -d --build
docker compose --env-file deploy/team-hub/.env -f deploy/team-hub/compose.yaml ps
curl --fail http://127.0.0.1:8787/healthz
```

По умолчанию порт опубликован только на loopback сервера. Для закрытой проверки откройте SSH-туннель:

```sh
ssh -L 8787:127.0.0.1:8787 user@your-server
```

Для HTTPS задайте `HUB_DOMAIN` с реальным DNS-именем и `KERYX_HUB_PUBLIC_ORIGIN=https://это-имя` без завершающего `/`. Настройте DNS и доступ к портам 80/443, затем включите Caddy:

```sh
docker compose --env-file deploy/team-hub/.env -f deploy/team-hub/compose.yaml --profile https up -d --build
```

Origin должен точно совпадать с адресом браузера; иначе сервер отвергнет cookie-запись. При HTTPS-режиме используйте публичный HTTPS-адрес, включая вход; локальный HTTP-адрес уже не является разрешённым Origin записи. Не публикуйте токены в URL или proxy-логах.

В образе есть Bun, Git, CA и SSH-клиент. Процесс работает пользователем `bun`. Именованный volume `hub-data` хранит `/data`: SQLite и управляемые Git-каталоги. Не запускайте несколько Hub-процессов с одним каталогом данных. Перед резервной копией остановите Hub и сохраните **весь volume**, а также секреты отдельно. `docker compose down` сохраняет volume; `down -v` удаляет данные. Docker daemon на машине разработки может отсутствовать: успешные локальные тесты Bun не означают проверенную сборку контейнера. Статус фактической проверки смотрите в отчёте передачи.

Git delivery использует доступ сервера к указанному репозиторию. Для приватного remote настройте отдельные Git credentials/SSH identity в защищённом read-only mount пользователя `bun` и known_hosts; секреты не помещайте в URL формы или Docker image. Пример не передаёт credentials автоматически. Для первого теста достаточно локального bare remote, доступного серверному процессу, либо отдельного тестового remote. Публикация создаёт ветку, не выполняет merge и не разворачивает приложение. Ссылка на PR показывается только при реальном результате адаптера.

## Проверка в браузере

Проверяйте двумя независимыми сессиями (например, обычное и приватное окно).

- [ ] Operator входит, создаёт проект; после обновления страницы сессия и проект доступны. Sign out завершает сессию.
- [ ] Documents: импортируйте spec с source revision и wiki. Состояние — `unreviewed`, даже если Markdown содержит `Status: accepted`. Откройте исходный текст и digest.
- [ ] Из документа создайте proposal; сравните canonical/proposed source. Человек принимает **точный digest**; версия canonical увеличивается, видны reviewer и время. Второе предложение от старой базы даёт конфликт без потери текста формы.
- [ ] Flows: создайте Flow из spec с критериями по строкам. Человек замораживает критерии, исполнитель запускает работу.
- [ ] Code: создайте ревизию из JSON текстовых файлов или загрузите tracked snapshot через CLI. Проверьте immutable tree, parent, Git base и digest. Бинарные файлы передавайте CLI.
- [ ] В выбранном Flow добавьте self-reported evidence для **точной ревизии**, команду и exit code. Без успешного evidence или при ошибочном check submit должен отказать.
- [ ] Submit for review закрепляет subject. Человек читает evidence, отдельно отмечает acknowledgement происхождения и принимает именно этот subject. Flow становится `done`, появляется receipt.
- [ ] Браузерный вход с agent token отклоняется; агент использует Bearer API/CLI. Прямой вызов freeze/review/accept/select-line/publish с agent token должен возвращать 403; человеческие действия не доступны агенту.
- [ ] Человек выбирает integration revision в Code, публикует её в Delivery. Проверьте реальную ветку/commit на remote. Ошибка Git или конфликт остаются в истории и не показываются как успешная публикация.
- [ ] History отражает действия с серверной личностью. Refresh загружает новые события; это polling/manual refresh, не realtime SSE.
- [ ] Перезапустите Hub с тем же volume: документы, предложения, Flow, evidence, ревизии и history сохраняются; второй человек видит те же данные.
- [ ] Проверьте narrow/mobile окно, длинный путь, пустой проект, сообщение загрузки и сетевую ошибку. Markdown с HTML отображается текстом; пользовательский контент не исполняется.

## Границы прототипа

SQLite рассчитан на один процесс. Нет OAuth/SSO, пользовательского каталога, приглашений, раздельных ACL проектов и публичной регистрации. Operator и reviewer — фиксированные серверные человеческие роли, общий доступ к проектам внутри этого инстанса. TLS и внешний доступ настраивает оператор.

Evidence всегда **self-reported**: сервер не запускает тесты и не подтверждает истинность stdout. Human acceptance фиксирует решение, а не независимый CI PASS. Критерии привязаны к digest spec; изменение принятой spec требует нового актуального Flow вместо тихого изменения замороженных критериев.

Импорт сохраняет идентичность пути, изменения существующего документа становятся proposals. Файлы и API имеют квоты. Symlink/submodule и небезопасные пути отклоняются. В UI редактор ревизий предназначен для явных текстовых изменений; полноценный tracked/binary exchange делает connector. Черновики формы хранятся только в памяти вкладки и очищаются при выходе; обновление данных внутри интерфейса их сохраняет.

Git credentials и remote availability — ответственность тестового окружения. Delivery не предоставляет произвольную shell-команду, модельный runner, облачное исполнение приложения или автоматическое слияние. Этот инстанс не заменяет production authorization, полноценный CI и безопасную организационную политику публикаций.

## Переносимый release и smoke

Упаковать прототип без `.env`, token, node_modules, Git-каталога и пользовательских данных:

```sh
bun scripts/package-team-hub.ts --out /tmp/keryx-team-hub-release --linux-x64
```

Результат: `team-hub-prototype-source.tar.gz`, `team-hub-server-linux-x64`, `team-hub-client-linux-x64`, `SHA256SUMS`. Без `--linux-x64` создаётся только source archive и его checksum. Компиляция использует Bun baseline Linux x64/glibc, может скачать официальный cross-target runtime. Git остаётся отдельной системной зависимостью. Для ARM64 запускайте исходники через Bun или собирайте подходящий target самостоятельно; x64 binary не является ARM64 binary.

Source tar формируется по явному списку: Hub, необходимая Flow machine/types, hub command, инструкции, deploy и release/smoke scripts. Порядок, владельцы, режимы и timestamps нормализованы; при одинаковых исходниках и `SOURCE_DATE_EPOCH` checksum source archive воспроизводится. `SOURCE_DATE_EPOCH` по умолчанию 0. Компилированные executables не заявлены bit-for-bit reproducible между версиями Bun. SHA256 проверяет целостность доставки и не заменяет подпись доверенного издателя.

На сервере проверьте checksum и распакуйте:

```sh
cd /path/to/release
sha256sum -c SHA256SUMS
tar -xzf team-hub-prototype-source.tar.gz
cd team-hub-prototype
bun install --frozen-lockfile --production --ignore-scripts
bun scripts/smoke/team-hub.ts
bun run src/hub/client-main.ts --help
```

Для MCP в распакованном source release сначала выполните `bun install --frozen-lockfile --production --ignore-scripts`; используйте новую папку релиза, не общие зависимости рабочей копии.

Smoke стартует отдельный настоящий сервер с временной SQLite и случайными секретами, проверяет HTTP assets, cookie login/logout, идемпотентный project create, import, запреты агенту, lifecycle Flow с self-reported evidence, точное human proposal review, integration selection и events. Данные удаляются после завершения. Он не обращается к внешнему remote и не запускает модель. Git delivery отдельно покрывается integration tests и проверкой публикации в checklist.

На Linux x64 smoke может запустить скомпилированный сервер:

```sh
bun scripts/smoke/team-hub.ts --server /path/to/release/team-hub-server-linux-x64
/path/to/release/team-hub-client-linux-x64 --help
```

Для обычного запуска binary задайте те же `KERYX_HUB_*` env, что выше, и выполните `./team-hub-server-linux-x64`. Client binary вызывается без префикса `hub`: `./team-hub-client-linux-x64 connect --url ... --project ...`. Он использует отдельный `KERYX_HUB_TOKEN` и запускается из нужного Git checkout. В source package эквивалент — `bun run src/hub/client-main.ts connect ...`.
