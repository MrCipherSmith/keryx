# Docs ↔ code audit — 2026-11-16 (v0.4.31)

Сверка пользовательской документации, инструкций для агентов и CHANGELOG с кодом на `main` @ `5f9a13b2`.

## Охват и метод

| Участок | Файлы | Находок |
|---|---|---|
| README, ч.1 | `README.md:1–602` | 9 |
| README, ч.2 | `README.md:603–1246`, `action.yml`, `package.json` | 14 |
| CHANGELOG | `[Unreleased]`, 0.4.20–0.4.31 + структура всего файла | 14 |
| docs/docs | 19 страниц верхнего уровня + `mkdocs.yml` | 27 |
| Гайды | `docs/docs/guides/*.md` (30) | 17 |
| Инструкции агентов | `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.metaproject/{index,routing,README}.md`, `llms.txt`, `modules/*`, `rules/*`, `skills/catalog.md`, `data/testing/context.md` | 15 |

Не входили: `docs/requirements/**` (591 файл — спецификации и планы, а не описание текущего поведения), `docs/decisions`, `docs/research`.

Механические проверки — зелёные:

- `bun run docs:check`: 0 битых относительных ссылок из 2153; retired-spellings — 0 undeclared; `cli-reference` покрывает все зарегистрированные команды; `commands-by-task` и `help-groups` проходят.
- `agent-catalogue-xref`, `enforcement-claims`, `cli-docs-structure` проходят.
- Управляемые блоки `keryx:index` в `CLAUDE.md`/`AGENTS.md` байт-в-байт совпадают с генератором; все пути SKILL.md в `catalog.md` существуют.

Поэтому все находки ниже — смысловые: документ описывает поведение, которого в коде нет (или оно другое). Находки, отмеченные ✔, перепроверены вручную после агентов; остальные подкреплены ссылкой на код агентом-аудитором.

## Сводка по приоритету

### P0 — пользователь, следуя документу, получит ошибку

| # | Где | Расхождение | Правда в коде |
|---|---|---|---|
| 1 ✔ | `README.md:98` | `keryx auth login <provider>` — «subscription login … or API key» | Без device-code/OAuth команда завершается «has no subscription login. Use an API key» (`src/commands/auth.ts:79`). Подписочный вход есть только у grok, openai-codex, github-copilot. |
| 2 ✔ | `.metaproject/index.md:14` (генератор `src/lib/templates.ts:401`) | «current work state → `keryx flow status`» | Без id: «Missing flow id», exit 1. Нужно `keryx flow list` → `flow status <id>`. |
| 3 ✔ | `.metaproject/README.md:23` (`templates.ts:1930`) | `keryx gdgraph query "module pipelines"` | `query` принимает только `cycles`/`orphans`; для поиска — `gdgraph find`. |
| 4 ✔ | `CHANGELOG.md:131` | Upgrade note: `serve --models` | `Unknown option: --models`; флаг у `keryx hub machine configure --models`. |
| 5 | `README.md:576`, `README.md:1047` | codex write: «0.159.2 up to 0.160.0» / «refused when older than 0.159.0» | `dispatch.ts:104`: `min 0.159.2, before 0.160.0, exact [0.164.0]`. |
| 6 | `action.yml` vs `README.md:1172–1185` | README описывает только `model-api-key`, `max-diff-bytes`, `post` | Есть `api-key-env` (default `ANTHROPIC_API_KEY`), `provider`, `model`, `github-token`, `keryx-version`. С не-Anthropic ключом action без `api-key-env` не заработает. |
| 7 | `docs/docs/hooks.md:104–106` | пример: проектный файл отключает `keryx.ctx-guard` | Проект не может выключить встроенный гейт (`src/harness/hooks/config.ts` ~455), user-scope требует ключ `acknowledge`. |
| 8 | `modules/tasks.md:29` (`src/flow/templates.ts:124`) | `keryx flow block|unblock <id>` | `block` требует `--reason "<why>"` (`src/commands/flow.ts:1607`). |

### P1 — вводит в заблуждение / описывает устаревшее устройство

**Харнесс и агент**

- ✔ `README.md:331–338` «Turn budgets»: бюджеты 48/40/8 по уникальным сигнатурам заменены лимитом раундов (40 / 200 trust / 200 auto, `src/commands/round-limit.ts:21–24`) + не более 3 попыток на сигнатуру. Раздел противоречит `README.md:517–520`.
- `README.md:509–510`: shell/деструктивные действия «default-deny». Интерактивный shell — `ask` (`profiles.ts:121–128`), `harness exec` — `allow`; deny только в read-only профиле.
- `README.md:573`: «писать могут только `claude-cli` и `codex-cli`». ACP-агент `gemini-acp` пишет в worktree (`registry.ts:102–118`).
- `README.md:582–584`: JSONL/RPC как одна из «четырёх дверей». `runViaRpc` вызывается только из тестов, нет ни CLI-глагола, ни экспорта из пакета.
- `architecture.md:248`, `harness.md:478`: «No shipped path registers a tool». Регистрируют scheduled-задачи (`trigger-agent-task.ts:45`) и ACP (`src/acp/roster.ts:37`); `limitations.md:114,215` противоречит.
- `harness.md:18`: shell — «TUI on the same tool registry». `architecture.md:235–246` прямо говорит, что это две системы (`ToolRegistry` vs `InteractiveTool`).
- ✔ `architecture.md:675` (и `:319`): внешний рантайм «never run against a real process, supervision is unbuilt». Есть `fixtures/external/live/*` и `src/harness/external/supervise.ts`; `harness.md:190` называет прогоны live-verified.
- `limitations.md:18, 48–60`: «модель нужна только пяти командам». Ещё — все `review jev-*`, `learn probe`, `skills judge-check`, `flow check-ac`, `harness run`, `keryx shell`.

**MCP**

- ✔ `README.md:888`: «OAuth и импорт конфигов Cursor/Claude — next». Уже есть `keryx mcp auth|logout` и чтение `~/.cursor/mcp.json`, `~/.claude.json` (`src/mcp-servers/compat.ts`).
- `modules.md:1099–1108`, `architecture.md:134,212`: `mcp serve`/`mcp install` описаны как текущие; это retired-шимы (→ `serve-mcp`, `integrate`), а `keryx mcp` теперь управляет MCP-клиентом.
- `modules/mcp.md:20–39`: нет `opencode`/`vscode`; ручная секция «Session trust» будет стёрта ближайшим `keryx update` (генератор `src/mcp/client-config.ts:536` её не выводит).

**Flow**

- Два списка гейтов завершения противоречат друг другу и коду. `architecture.md:586–597` («source of truth») без `folder-committed`; `modules.md:690–698` без base-branch/tasks/review/security и в другом порядке. Фактический порядок (`src/flow/service.ts`): acceptance-criteria → pull-request/main-merge → base-branch → tasks → owner → folder-committed → review → health → security.

**Jev / review / external**

- `README.md:1018–1025`: EDIT GUARD «молчит, пока не включишь». По умолчанию включён, если `/external` on и Jev-креды есть (`jev-edit-guard-config.ts:47–62`); `README.md:1007` противоречит. **Баг в коде:** `handleInstall` (`review-jev-edit-guard.ts:343`) зовёт `readJevEditGuardEnabled` без `jevAvailable` и всегда печатает устаревшее «will stay silent».
- `README.md:1163`: `review complete` с waivers только через карточку/терминал. Принимает `--answered-by/--answer-text/--question-text` без TTY (`review.ts:605, 4939`).
- `README.md:916–950` `/external`: в дефолтном блок-листе нет `antigravity-cli`; не упомянута третья точка проверки (`src/capability/external-agents.ts:335`).
- `README.md:1043, 871`: domain allowlist «macOS-only». На Linux есть `allowlist` для scheduled agent-task (`trigger/config.ts:147`); macOS-only — только `harness exec --allowed-domains`.
- `README.md:1037`: «Remote approvals need a tool registry» читается как «удалённо инструменты нельзя»; верно только для голого `/v1/turns`.

**Инструкции агентов**

- `CLAUDE.md` «Claude-only rules … deliberately absent from AGENTS.md», но `rules/claude-md.md:24–37` копирует их, а `routing.md:27,78` велит всем агентам грузить `rules/` — Codex их подхватит. Чинить в `renderImportedAgentRules` (`src/lib/templates.ts:1777`).
- `routing.md:99`: «`keryx --help` for the full CLI surface» — не показывает `ctx rg`, `gdgraph find`, `test related`, `wiki ask`…; полный список даёт `keryx commands`.

**Архитектурные описания**

- `architecture.md:78,96`, `modules.md:44`: `CLI_ROUTES` в `src/cli.ts:51`, «~31 verbs», «flat if-chain». Фактически `src/cli-registry.ts:125`, 66 маршрутов, lookup по таблице.
- `architecture.md:99`, `modules.md:1606–1642`: `src/lib` — «шесть модулей, ни от чего не зависит». 208 файлов, импорты в `harness`, `session`, `rules`, `testing`.
- `modules.md:7–9`: «модули не вызывают друг друга напрямую». `architecture.md:513–560` документирует 8 прямых рёбер.
- ✔ `architecture.md:674`: «`gdctx` has no `src/ctx/` dir». Каталог есть (~15 модулей).
- `architecture.md:672`, `modules.md:1327`: у `src/rules/` нет тестов — их 8.
- `architecture.md:378`, `modules.md:1589`: «eight `/v1/remote/*` routes» — их 19 (`serve-server.ts:452`).
- `modules.md:1342–1352`: у `agents` «единственная подгруппа — `bootstrap`»; есть ещё `monitor`, `external …`, `list`, `show`, `export`, `verify`, `generate`.
- `workspace-and-lifecycle.md:214`: в «canonical lists» нет `gdskills import/update`, `memory supersede/transition`.

**CHANGELOG**

- ✔ Второй `## [Unreleased]` на `CHANGELOG.md:1170` — дубль трёх `Fixed`-пунктов из 0.4.20 (PR #1150).
- `CHANGELOG.md:15` (0.4.30): «Each core rule now ends with `Review severities` … CLI design». ✔ В `cli-interface-design.mdc` таблицы нет; ~20 core-правил без неё.
- `CHANGELOG.md:22`: «quick start in the desktop app» — десктоп-приложения нет; это Hub web «New task» + TUI `/task` (PR #1179).
- Не отражены релизами 0.4.29/0.4.30: PR #1178, #1180–#1183, #1185–#1188, #1190, #1191 (правила; #1186 — резолвер контекста грузит stack и условные core-правила — user-visible), `bench setup --cases`.

**Ошибка в коде, найденная через документацию**

- ✔ `keryx mcp --help` (и `test`/`memory`/`wiki --help`) печатает запасную справку из `src/cli-registry.ts:406` — только retired `mcp serve`/`install`; не видно `add/list/doctor/auth`, `test suggest`, `memory reflect`, `wiki enrich`. Полная страница в `src/commands/mcp.ts:141` не используется. Голый `keryx mcp` запускает deprecated `mcp serve`.

### P2 — неполнота, устаревшие числа, косметика

- Списки провайдеров (`README.md:382`, `harness.md:27`) без `openai`, `gemini`, `openai-codex`, `github-copilot`, `rapid-mlx`.
- Таблица интеграций `README.md:820` без `opencode`, `vscode`, `generic`, `zcode`, `antigravity`; `README.md:851` — `integrate cursor` не берёт `--runtime`.
- `README.md:817`, `modules.md:38`: `sac` тоже opt-in.
- `README.md:925`: `conform`, `ci-triage`, `jev-select` как top-level команды — реально `/conform`, `review ci-triage`, `review jev-select`.
- `README.md:413`: `/session-info` и `/info` «не алиасы» — их просто нет.
- `README.md:139`: `keryx sessions list` не переключает сессию — для этого `keryx shell -r <id>`.
- `README.md:1225`: якорь с em-dash не резолвится на GitHub (`--` в slug).
- `mkdocs.yml:14`: «page missing from nav fails --strict» — неверно без `validation.nav.omitted_files`; вне nav: `jev-in-review.md`, `shell-preservation.md`, `shell-recovery.md`.
- `architecture.md`: съехавшие ссылки на строки (`harness.ts:247→297`, `serve-turn.ts:313→481`, `guard.ts:304→411`), «reviewed for 0.2.157», quality gate без lint, `InteractiveTool` переехал в `src/harness/tool/builtin/interactive-tools.ts`, `allowAutoAccept` теперь читается, memory artifacts больше не коммитятся, `@opentui/core` тоже optional.
- `modules.md:177`: таблица `wiki` без `freshness/refresh/verify/migrate-markers/sections/enrich/history/restore`; `learning.md:70` без `learn probe`; `update --help` не показывает `--no-tasks/--force/--yes/--keep-existing`.
- Устаревшие генерируемые файлы `.metaproject`: `llms.txt`, `README.md` (нет `security`), `data/testing/context.md`, `routing.md` (нет `mcp`, `product.md` недостижим), копия скилла `deprecation-path`. `modules/gdgraph.md:36` — freshness не «last line»; `:61/:65` дубль `summary.md`. `routing.md:108`, `modules/gdctx.md:21` — `queries/` никто не пишет. `modules/security.md:91` — ссылка на несуществующий «specification.md §14».
- CHANGELOG структура: вводный абзац в середине (`:1166`), compare-ссылки обрываются на 0.2.37, 0.4.29 датирован 2026-11-14 (коммит 2026-11-15), даты 0.2.79/0.2.78 идут назад, em-dash vs hyphen в заголовках с 0.3.77, пустой `### Fixed` в 0.2.25, необъяснённые пропуски версий, нет PR-ссылок у 0.4.23–0.4.25, 0.4.29, 0.4.31.

## 6. Гайды (`docs/docs/guides`)

17 расхождений.

**P0 — шаг гайда падает**

| # | Где | Расхождение | Правда в коде |
|---|---|---|---|
| G1 ✔ | `review-with-a-record.md:18` | `keryx review attach --flow 001 --target pull-request --ref 42` | `Invalid --target. Use one of: pr, issue, branch, path, report` → `--target pr --target-ref 42`. |
| G2 | `acp-client.md:49`, `external-agent-write.md:13` | включается `externalAgents.enabled: true` в user config | В проекте с `metaproject.json` нужен ещё `gdskills.external-agents.enabled: true` (`src/capability/external-agents.ts:457`); `keryx update` пишет `false`. Правильный шаг — `keryx agents external enable`. |
| G3 ✔ | `review-arbiter.md:183` | `bun test src/review/arbiter-eval.test.ts` | Файла нет; тест — `src/commands/review-arbiter-eval.test.ts`. |
| G4 | `review-as-a-pr-bot.md:149` | `keryx review complete --finding <id> --disposition <state>` | Обязателен `<review-id-or-path>`, `--evidence` идёт с каждым finding. |
| G5 | `run-in-ci.md:152` | `bun run check:doc-links` как гейт для пользовательского репо | Это скрипт репозитория keryx, у пользователя его нет. |

**P1**

- `permission-modes.md`: противоречит сам себе и коду — `:328` «40 в ask и auto» (auto = 200); ✔ `:53` у сабагентов «10 / максимум 24» (код: 40 / 200, `spawn-subagent-tool.ts:494,497`); `:344` «волны по 10» (пул 16 одновременно, 32 на ход/волну); `:441` `keryx mcp` → `serve-mcp`.
- `autonomous-review.md:22` «`--target pr` — единственная цель» — есть `--target branch --ref <base> [--head]`; `:73` «пять раундов, шесть ревьюеров на волну» — `roundLimit: 1` (новый только при сдвиге head), `waveSize` = 10.
- `drive-keryx-remotely.md:215, 252, 273`: топики «удаляются» — на деле архивируются (`closeForumTopic`), удаляет только Disconnect; `:636` того же гайда говорит правильно. `:476` `choiceTimeoutMs` — не ключ `remote/config.json` (схема его отвергнет).
- `shared-agent-context.md:45`: «полный список — `keryx workspace --help`» — та же проблема registry-fallback, полный только у `keryx workspace help`; `:41` «нет auto-bind» противоречит `:289` и `goal.md:3`.
- `review-with-a-record.md:26–57`: блок «The full surface» устарел (`--ref` — алиас с предупреждением; нет `mutate`, `slice`, `chunks`, `readiness`, `next`, `waive-*`…).
- ✔ `review-with-a-record.md:965–1134` повторяет разделы `:588–953` («Verify the findings…», «Ingest a report…», «Check where one stands», «Complete it…», «Feed what you learned back») — копия при мерже.

Справка CLI неполна и тут: `flow task done --result/--resolved`, `wiki history/restore/freshness/refresh/verify/validate/migrate-markers` работают, но их нет в `--help` — гайды правы, а справка нет.

Не проверено вживую: `herdr.md`, web-UI шаги `team-hub-remote-sessions.md`, поведение Telegram в `drive-keryx-remotely.md`, живые провайдеры `web-search.md`.

## Системные причины

1. **Генераторы — источник дрейфа инструкций.** Почти всё в `.metaproject/` рендерится из `src/lib/templates.ts`, `src/flow/templates.ts`, `src/security/templates.ts`, `src/mcp/client-config.ts`. Правка копии теряется на `keryx update`; чинить шаблоны и перегенерировать.
2. **Нет проверки, что команды из документации исполняются.** Покрытие проверяет, что команда упомянута, а не что пример валиден. Дешёвый тест: вытащить `keryx …` из fenced-блоков README/docs/шаблонов и прогнать через парсер аргументов (`--help`/dry-parse) — поймал бы P0 #2–4, #8, G1, G4.
6. **Запасная справка в `cli-registry.ts` перехватывает `<cmd> --help`** у `mcp`, `workspace`, `test`, `memory`, `wiki`, `flow`, и документация, которая говорит «смотри `--help`», ведёт пользователя к неполному списку. Это одна правка в коде, закрывающая класс проблем.
3. **Числа и ссылки на строки в `architecture.md`/`modules.md`** устаревают с каждым релизом. Убрать номера строк и счётчики либо генерировать их.
4. **Ограничения и «next» не пересматриваются при закрытии фич** (MCP OAuth, live external, Linux allowlist). Добавить в DoD фичи шаг «снять ограничение из `limitations.md`/README».
5. **CHANGELOG пишется в PR, а не при релизе** → дубли `[Unreleased]` и пропуски rules-PR. Проверка в CI: ровно один `[Unreleased]` наверху; PR с `feat:`/user-visible метками без записи — warning.

## Routing audit

graph_used: no (not-relevant — сверка шла от документа к коду, не навигация; граф в этом чекауте не собран) · wiki_used: no (not-relevant) · ctx_used: yes (`keryx ctx rg` у всех аудиторов) · raw_rg_used: yes — точечный `grep`/`sed` по уже найденным файлам при ручной перепроверке.
