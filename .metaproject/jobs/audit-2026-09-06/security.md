# Аудит безопасности Keryx v0.2.80

База аудита: `main`, `d0a2a011df93c2459cb4329a7dc152fb0fe625a6`. Проверялся полный текущий проект, а не diff. Исходники и тесты не изменялись.

Статус: **DONE_WITH_CONCERNS**. Статический обзор выявил один прямой дефект изоляции файловой системы и один опасный разрыв между заявленным и фактическим trust boundary MCP HTTP. Установленное дерево зависимостей не проходит `bun audit`. Платформа остановила углублённую фазу, поэтому ниже отделены подтверждённые чтением кода дефекты от непроверенных live-границ.

## Findings

### SEC-001 — blocker, high confidence — лексическая проверка путей пропускает symlink за разрешённый root

**Где:** `src/mcp/resources.ts:168-190,196-217`; `src/mcp/dispatch.ts:110-117`; `src/harness/tool/metaproject-adapter.ts:141-151,214-252,417-429,627-650`.

**Проблема.** MCP resources, harness `read_wiki` и `skill_load` проверяют только лексический `resolve`/`relative`, а затем читают файл через `stat`/`readFile`, которые следуют по символической ссылке. В тех же исходниках уже есть правильный примитив: `resolveContainedPath` канонизирует root и target через `realpath` (`src/lib/contained-path.ts:78-105`), а builtin `read_file` применяет эквивалентную realpath-проверку (`src/harness/tool/builtin/interactive-tools.ts:35-69,132-160`).

**Сценарий и влияние.** Репозиторий, полученный от недоверенного автора, может содержать ссылку под разрешённым wiki/memory/artifacts root или файл `SKILL.md`, ведущий за пределы проекта. Когда MCP-клиент или агент читает такой ресурс как обычный проектный контекст, процесс читает внешний локальный файл. Для MCP resources результат дополнительно минует redaction-путь инструментов: `dispatchCallTool` редактирует tool output (`src/mcp/dispatch.ts:82-100`), а `dispatchReadResource` возвращает ресурс напрямую (`src/mcp/dispatch.ts:110-117`). Это нарушает заявленную гарантию локальной изоляции и может раскрыть данные хоста или передать внешнее содержимое как инструкции агента.

**Проверка.** Подтверждено site-check: все читающие ветви перечислены через `keryx ctx rg`, затем сопоставлены с существующим корректным `resolveContainedPath`. Исполняемое воспроизведение не запускалось после ограничения платформы.

**Исправление.** Перед каждым чтением разрешать реальный root и реальный target общим containment helper, проверять regular file после канонизации и использовать уже проверенный путь для открытия. Применить это к трём классам MCP resources, `read_wiki` и discovery/load `SKILL.md`. Добавить регрессии для внешней symlink-ссылки и разрешённой внутренней ссылки; отдельно прогнать resource output через тот же redaction gate, что и tool output.

**Class scope.** Sites: MCP `artifacts|wiki|memory` resource resolver/read; harness `read_wiki`; harness skill catalog/load. Enumeration: `keryx ctx rg "readFile\\(.*SKILL\\.md|readFile\\(target|resolveConfined|confineToWiki|realpath"` плюс чтение всех найденных adapters и dispatchers.

### SEC-002 — major, high confidence — opt-in MCP HTTP может стать внешним endpoint без аутентификации

**Где:** `src/mcp/config.ts:72-82`; `src/mcp/server.ts:136-153`; `src/mcp/transport/http-sse.ts:21-45`; `src/mcp/dispatch.ts:103-117`; `src/mcp/tools.ts:549-568`.

**Проблема.** Документация transport называет bridge localhost-only и прямо указывает отсутствие auth, но loader принимает любую строку `http.host`; сервер без дополнительной проверки передаёт её в `listen`. Capability flag и `--http` являются двумя opt-in условиями, однако они не подтверждают внешний bind и не добавляют principal/authentication policy. При этом resource endpoints доступны по HTTP, а общий реестр содержит `security.scan`, помеченный `mutating: true`, без transport guard и без containment для `path`.

**Сценарий и влияние.** Если проектная конфигурация задаёт wildcard/public host и оператор запускает opt-in MCP HTTP, любой сетевой клиент, достигший порта, получает доступ к выставленным wiki/memory/artifacts resources и части tools. Это может раскрыть проектный контекст; `security.scan` также позволяет удалённо инициировать чтение произвольного пути процессом и перезапись security-report artifact. Предусловие существенно: MCP HTTP выключен по умолчанию и требует явного запуска, поэтому уровень ниже blocker.

**Проверка.** Подтверждено site-check по единственному config loader, единственному HTTP listener и registry/dispatch. Сетевой listener не запускался.

**Исправление.** Жёстко отклонять non-loopback host в MCP config/startup либо перенести на MCP тот же двойной acknowledgement и bearer-auth pipeline, который реализован для `keryx serve`. До появления authenticated principal policy разрешать по HTTP только явно безопасный allowlist read-операций; запретить `security.scan` и все `mutating` tools на уровне общего dispatcher, а входные пути ограничивать project root.

**Class scope.** Sites: MCP config merge; MCP HTTP startup/listener; resources dispatch; MCP tool registry/dispatcher. Enumeration: `keryx ctx rg "mergeMcpConfig|HTTP/SSE|localhost only|context?.transport|mutating" src/mcp` и чтение всех HTTP-specific guards в registry.

### SEC-003 — info, high confidence — установленное дерево зависимостей содержит 28 advisories; достижимость не установлена

`bun audit` завершился с кодом 1: 1 critical, 13 high, 13 moderate, 1 low. Critical/high для `protobufjs` и `sharp` приходят через dev dependency `@xenova/transformers` (`onnxruntime-web` → `onnx-proto` → `protobufjs`; отдельно `sharp`). Optional production dependency `@modelcontextprotocol/sdk` приводит `ip-address` и `fast-uri` с high advisories, а также moderate advisories в `qs`, `@hono/node-server` и `hono`.

Наличие пакета не доказывает достижимый exploit. Статический поиск показал, что MCP SDK загружается лениво в MCP client/server paths, а transformers относится к development/runtime model tooling; конкретные уязвимые API и входные данные в этой ограниченной фазе не трассировались. Рекомендуется обновить lockfile до исправленных совместимых версий, затем отдельно проверить production-only tree и reachability MCP HTTP/client code. Источник результата: `.metaproject/data/gdctx/artifacts/2026-09-05T21-00-56-429Z_run.md`.

## Защитные механизмы, подтверждённые кодом

- `keryx serve` по умолчанию слушает loopback, требует credential и fail-closed отклоняет внешний bind без acknowledgement (`src/lib/serve-config.ts:29-39,181-203`; `src/lib/serve-server.ts:670-706`). Токен не хранится: сохраняются salt и hash в owner-only store; сравнение фиксированного digest выполняется без раннего выхода (`src/lib/serve-credential.ts:1-19,41-50,73-110`).
- Remote profile `unattended-untrusted` требует OS containment, запрещает network и переводит write/shell/delegate в approval (`src/harness/policy/profiles.ts:83-103`). Read-only profile жёстко запрещает write/shell/network/delegate (`src/harness/policy/profiles.ts:53-62`). Policy engine делает deny необратимым, превращает `ask` в deny в headless mode и связывает approval с action fingerprint (`src/harness/policy/engine.ts:12-23,41-73,98-109`).
- Builtin filesystem tools уже используют realpath containment и ограниченное чтение (`src/harness/tool/builtin/interactive-tools.ts:35-69,132-160`); общая библиотека имеет тесты traversal, sibling-prefix и symlink escape (`src/lib/contained-path.test.ts:45-108`). Это также показывает, что SEC-001 исправим существующим проектным паттерном.
- Security config включает secret block, PII/artifact redaction, approval для prompt injection, egress block, отключённое raw retention и checksum (`.metaproject/security.config.json`). Последний сохранённый security report имеет PASS, но датирован 2026-08-22 и содержит один medium PII false positive по repository URL, поэтому он не является доказательством отсутствия секретов в текущем состоянии.

## Существующие регрессии и ограничения проверки

- Текущий функциональный прогон проекта: typecheck PASS; `bun test` — 6897 pass, 18 skip, 0 fail. Узкие guard/CLI suites также прошли (см. `.metaproject/jobs/audit-2026-09-06/functional.md`).
- Исходники тестов покрывают отсутствие bind при missing/mismatched credential и при non-loopback без acknowledgement (`src/lib/serve-server.test.ts:179-280`; `src/commands/serve.process.test.ts:153-194`), realpath containment основного file API (`src/lib/contained-path.test.ts:45-108`) и hard-deny/approval semantics policy engine.
- Нет найденной symlink regression для MCP resources, `read_wiki` или `skill_load`; MCP config test проверяет сохранение loopback default, но не отклонение внешнего host (`src/mcp/mcp.test.ts:80-98`).
- 18 test skips включают host-dependent и opt-in live сценарии: bubblewrap, реальный subprocess/MCP/PTY и network smoke. Поэтому реальное уничтожение process group, OS sandbox на текущем host, live MCP transport и provider egress не подтверждены.
- `RealProcessAdapter` документирован как leader-only при timeout: прямой процесс убивается, grandchild не group-reaped (`src/harness/process/real-process-adapter.ts:38-48,184-214`). Это явное ограничение opt-in real subprocess режима; live-проверка не выполнялась.
- Агент безопасности был прерван платформой с сообщением о возможном киберриске. После первого прерывания основной агент ограничил продолжение статическим анализом; повторный запуск также завершился платформенным ограничением. Исполняемые воспроизведения и сетевые проверки не проводились. SEC-001/SEC-002 основаны на исчерпывающем site-check, но не на runtime proof.
- Наблюдавшийся отдельно `check-output` false positive на дробных метриках может редактировать число внутри JSON и делать JSON невалидным. Это дефект качества детектора/serialization pipeline, а не подтверждённый security exploit; raw результаты в отчёт не включались.
- Lifecycle contamination `wiki ask` (draft/deprecated/conflict/future memory) передана родительскому аудиту как проблема целостности контекста и здесь не дублируется.

## Routing audit

- `graph_used`: yes — свежий graph 1168 nodes / 3515 edges применён для навигации; tree-sitter unavailable, 50 unresolved edges.
- `wiki_used`: yes — index и freshness прочитаны до deep code; 12 affected pages проверялись против исходников.
- `ctx_used`: yes — все поиски и крупные outputs прошли через `keryx ctx rg/read/run`.
- `raw_rg_used`: no.
