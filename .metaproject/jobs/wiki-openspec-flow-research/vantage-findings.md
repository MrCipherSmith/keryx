# Vantage: фактическая связь OpenSpec, кода, wiki и Flow

Дата наблюдения: 2026-10-25 (Asia/Muscat). Корень: `/Users/Goodea/work/vantage-frontend`; ветка `develop`; HEAD `037e059292a64978bc11f386c114413a82ef252f`. Исследование read-only; тесты, OpenSpec apply/archive/sync, wiki verify и переходы Flow не запускались. Исключение — штатные disposable-артефакты `keryx ctx`. Вложенные `.review-pr-*` не используются как доказательство состояния основного приложения.

## Что существует сегодня

- OpenSpec настроен как `schema: spec-driven`: [config.yaml](/Users/Goodea/work/vantage-frontend/openspec/config.yaml:1). Контекст и authoring rules описывают proposal, изменения требований, роли, наблюдаемые результаты, happy/edge scenarios и Open Issues. Ссылки на код должны использовать файл/символ, а не строки: [config.yaml](/Users/Goodea/work/vantage-frontend/openspec/config.yaml:14).
- В корневом `openspec/` находятся README, config и changes. Наблюдались **43 каталога изменений**. `openspec/specs/` и `openspec/changes/archive/` отсутствуют. Поэтому нельзя показать реально выполненный здесь переход delta → архив → базовый нормативный spec. Наличие каталога в changes не доказывает, что работа ещё не реализована: выбранный пример уже имеет код и отмеченные задачи.
- Локальная конвенция: proposal → необязательный design → tasks с checkbox → `specs/<capability>/spec.md` с ADDED/MODIFIED/REMOVED/RENAMED Requirements: [README](/Users/Goodea/work/vantage-frontend/openspec/README.md:14). Документ предписывает `openspec validate <change-id> --strict` перед push и прямо говорит, что CI пока specs не проверяет: [README](/Users/Goodea/work/vantage-frontend/openspec/README.md:47).
- Числовая версия OpenSpec не установлена по репозиторию: CLI внешняя глобальная зависимость `@fission-ai/openspec`, не project dependency ([README](/Users/Goodea/work/vantage-frontend/openspec/README.md:64)); `openspec --version` в этой среде вернул `command not found`. Это не означает, что CLI отсутствует у разработчиков.
- Интеграция с агентскими правилами уже есть: [CLAUDE.md](/Users/Goodea/work/vantage-frontend/CLAUDE.md:7) требует поднимать расхождения spec/code в PR. Метапроектный [reviewing.mdc](/Users/Goodea/work/vantage-frontend/.metaproject/rules/project/core/reviewing.mdc:32) включает owning OpenSpec design/tasks/Open Issues в owner intent. Это документированная интеграция review-контекста, а не найденная автоматическая привязка OpenSpec к Flow или wiki.

## Один реальный сквозной пример: add-inflight-request-guard

Изменение привязано к issue **#8013**: [proposal](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/proposal.md:3). Scope умеренный: общий Vitest guard, диагностирующий axios-запросы, оставленные тестом незавершёнными.

| Слой | Наблюдаемое доказательство |
|---|---|
| Нормативное требование | Vitest SHALL завершать такой тест ошибкой с методом/путём pending request: [delta](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/specs/test-tooling/spec.md:5). |
| Сценарий | Dana вызывает `PipelineStore.onUnmount`, оставляет DELETE незавершённым; ошибка принадлежит этому тесту, следующий начинает с пустой регистрацией: [scenario](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/specs/test-tooling/spec.md:11). Happy path awaited — строка 18; abort — 23; late response — 28. |
| Реализация | Обёртка `axios.Axios.prototype.request` регистрирует запрос до interceptor, удаляет после settlement: [in-flight.ts](/Users/Goodea/work/vantage-frontend/src/test/msw/in-flight.ts:25). `afterEach` считывает labels, очищает Set и проверяет пустоту: [guard](/Users/Goodea/work/vantage-frontend/src/test/msw/in-flight.ts:46). |
| Подключение | Импорт и единственный вызов `failOnRequestsInFlight()` в общем setup: [vitest.setup.ts](/Users/Goodea/work/vantage-frontend/src/test/vitest.setup.ts:5), [вызов](/Users/Goodea/work/vantage-frontend/src/test/vitest.setup.ts:51). |
| Проверяемость | Реальные test cases: ожидаемая ошибка/diagnostic — [test](/Users/Goodea/work/vantage-frontend/src/test/msw/in-flight.test.ts:30), awaited — 45, abort — 51, late response — 66, async interceptor — 87. В этом исследовании тесты не выполнялись; наличие tests не доказывает green HEAD. |
| Локальная документация | README описывает guard: [MSW README](/Users/Goodea/work/vantage-frontend/src/test/msw/README.md:32). |
| Wiki | Есть [src-test-msw.md](/Users/Goodea/work/vantage-frontend/.metaproject/wiki/components/src-test-msw.md:5), `Status: accepted`; однако она описывает старый strict-network guard и STOMP, а `in-flight` вообще не упоминает. Changelog страницы датирован 2026-09-18: [строка 93](/Users/Goodea/work/vantage-frontend/.metaproject/wiki/components/src-test-msw.md:93). Это существующая связанная страница модуля, а не уже готовое описание выбранного изменения. |

Есть явный повод для reconciliation: задачи отмечены `[x]`, но DoD всё ещё содержит историческое «Today: No test files found» и «Today: 0» при существующих test и hook: [tasks.md](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/tasks.md:21). Эти строки нельзя выдавать за актуальный test result. Open Issues сохраняют вопросы о fetch и числе offenders: [delta](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/specs/test-tooling/spec.md:34).

Freshness artifact от 2026-10-12 для этой wiki-страницы имеет `category: unknown`, `verifiedAt: null`: [latest.json](/Users/Goodea/work/vantage-frontend/.metaproject/data/wiki/freshness/latest.json:6324). Ограничения включают отсутствующий symbol layer: [limitations](/Users/Goodea/work/vantage-frontend/.metaproject/data/wiki/freshness/latest.json:6828). `accepted` нельзя трактовать как подтверждённую актуальность.

## Flow: найденное и отсутствующее

`keryx flow list` показал только **001**, `in-progress`, «Copied step with Dependencies can not be saved», issue #2536 / PR #7097: [flow.json](/Users/Goodea/work/vantage-frontend/.metaproject/flows/001-2026-09-18-copied-step-with-dependencies-can-not-be/flow.json:7). Это другое изменение.

Полный routed search с `--hidden --no-ignore` по `.metaproject/flows`, flow skill, flow-orchestrator skill, data/tasks и wiki не нашёл `openspec`, `8013` или `inflight.request.guard`. **В проверенном объёме не найдена связь выбранного OpenSpec с Flow и автоматическая цепочка specs → Flow → verification → wiki.** Не утверждается отсутствие во всех внешних сервисах или истории Git.

Flow уже предоставляет CLI-owned state, замороженные AC, review/merged-PR/health gates и опциональный confirmation token: [flow skill](/Users/Goodea/work/vantage-frontend/.metaproject/skills/flow/SKILL.md:38), [complete](/Users/Goodea/work/vantage-frontend/.metaproject/skills/flow/complete.md:15). Сам skill предупреждает: token доказывает interactive step, **не человеческую идентичность** ([строка 55](/Users/Goodea/work/vantage-frontend/.metaproject/skills/flow/SKILL.md:55)). Wiki policy отдельно запрещает агенту ставить human provenance за человека: [gdwiki](/Users/Goodea/work/vantage-frontend/.metaproject/skills/gdwiki/SKILL.md:34).

## Предлагаемая интеграция — ещё не реализованный факт

На этом настоящем примере агент уже может собрать requirement/scenario, сопоставить implementation/tests, выявить устаревший DoD и недостающий wiki-текст и подготовить reviewable patch/verification plan. Для демонстрации Keryx2 следует отдельно добавить явную связь `change/capability/requirement/scenario ↔ Flow AC ↔ evidence ↔ wiki revision`, затем предложить пользователю конкретный diff нормативных и наблюдаемых утверждений.

Принятие normative spec, human wiki-verification, публикация shared revision в Hub и окончательная Git-публикация требуют отдельных явно определённых полномочий/подтверждений. Здесь такой сквозной protected gate не обнаружен; существующий Flow token не следует представлять как его готовую реализацию. Архивирование OpenSpec и обновление wiki не должны автоматически следовать из checkbox `[x]` или green тестов.

## Routing audit

- `graph_used`: `keryx gdgraph find openspec` (no-match), `affected src/test/msw/in-flight.ts` (dependent: root `src/test/vitest.setup.ts`). Parent сообщил успешный rebuild. CLI всё равно выводит freshness warning из-за untracked `.review-pr-*`; граф используется лишь как навигация, поведение подтверждено прямыми чтениями root-файлов.
- `wiki_used`: index, `components/src-test-msw.md`, freshness/latest.json; `unknown` сохранён как ограничение, verify не выполнялся.
- `ctx_used`: `read`, `rg --all`, `run`; raw и summaries автоматически сохранены gdctx в `.metaproject/data/gdctx/` целевого репозитория. Все текстовые code searches — routed.
- `raw_rg_used: no`.
