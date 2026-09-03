# Flow Journal

- 2026-09-03T19:01:55.300Z - flow created
- 2026-09-03T19:24:35.561Z - task-done: T1: Collect remaining context
- 2026-09-03T19:24:35.650Z - task-added: T5: Волна A: убрать нарратив о прошлых редакциях в task-implementer и review-orchestrator (F2, F3)
- 2026-09-03T19:24:35.735Z - task-added: T6: Волна A: убрать migration-relative фразы в model-selection.mdc, review-orchestrator:207, job-orchestrator:1953 (F4, F9)
- 2026-09-03T19:24:35.827Z - task-added: T7: Волна B: довести девять MCP-описаний до контракта, со staleness-оговоркой для health.* (F5, F7)
- 2026-09-03T19:24:45.634Z - task-added: T8: Волна C: проба до правки — прогнать feature-analyzer и feature-dev на реальной ветке, записать поведение в journal (AC4, AC5)
- 2026-09-03T19:24:45.735Z - task-added: T9: Волна C: удалить стек усилителей и gold-скрипт feature-analyzer:28-60 (F1)
- 2026-09-03T19:24:45.831Z - task-added: T10: Волна C: снять регистр IRON LAW в feature-dev:163 и job-orchestrator:731, сохранив рекап (F6)
- 2026-09-03T19:24:45.929Z - task-added: T11: Волна C: проба после правки; при регрессии вернуть инструкцию в минимальной форме и перепроверить (AC4, AC5)
- 2026-09-03T19:24:56.626Z - task-added: T12: Волна D: grep каталога, роутера и тестов на interview/interviewer и code-mobx-store-review до любого удаления (AC9)
- 2026-09-03T19:24:56.727Z - task-added: T13: Волна D: свести пару interview/interviewer к одному скиллу либо разграничить описания; решение и причина в journal (F7, AC8)
- 2026-09-03T19:24:56.823Z - task-added: T14: Волна D: слить code-mobx-store-review в store-раздел review-frontend либо разграничить (F8, AC8)
- 2026-09-03T19:24:56.920Z - task-added: T15: Волна D: перечислить потребителей ResolvedSkillBuild.fallback, затем свернуть 88 идентичных harness-сборок (F10, AC9)
- 2026-09-03T19:24:57.022Z - task-added: T16: Снять усилители-дубликаты в feature-analyzer:270,296,331 и job-orchestrator:477, сохранив сами инструкции (F11)
- 2026-09-03T19:25:09.604Z - task-added: T17: F12: добавить учёт токенов по экспортируемым скиллам как предпосылку будущих измерений
- 2026-09-03T19:25:09.694Z - task-added: T18: Синхронизировать harness-сборки task-implementer и job-orchestrator с канонами, прогнать bundled-eval и keryx skills verify (AC10)
- 2026-09-03T19:25:09.787Z - task-added: T19: Записать в journal паттерн prompt-audit для каждой правки; проверить, что ни одно удаление не обосновано объёмом (AC11, AC12)
- 2026-09-03T19:25:09.897Z - task-done: T2: Implement per plan
- 2026-09-03T19:25:10.008Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-03 — поправка к причине закрытия T3. В записанной причине ошибочно
  указана ссылка «T12 (регрессионный тест на блочный)» — это текст из flow 221,
  попавший по невнимательности; T12 в этом фло — grep каталога и роутера перед
  удалениями. Действительная причина закрытия T3: отдельного тестового шага в
  плане нет, тестовая работа распределена по пробам T8/T11 (поведенческие
  проверки feature-analyzer и feature-dev) и прогону bundled-eval с
  `keryx skills verify` в T18. Правки этого фло меняют текст промптов и описания
  инструментов; юнит-теста честнее поведенческой пробы для них нет.
- 2026-09-03T19:26:43.511Z - frozen: 12 criteria; checksum recorded
- 2026-09-03T19:26:49.807Z - started
- 2026-09-03T19:27:00.341Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-03T19:27:00.443Z - task-added: T20: Self-review и подготовка draft PR
- 2026-09-03T19:38:52.561Z - task-done: T5: Волна A: убрать нарратив о прошлых редакциях в task-implementer и review-orchestrator (F2, F3)
- 2026-09-03T19:40:45.207Z - task-done: T6: Волна A: убрать migration-relative фразы в model-selection.mdc, review-orchestrator:207, job-orchestrator:1953 (F4, F9)
- 2026-09-03 — T6, находка при реализации. Пятое место с Group 1d оказалось не в
  скилле, а в схеме: job-orchestrator/input-contract.schema.json, поле
  codebase.base_branch описывало прошлое значение (`develop-2`, ветка из чужого
  проекта). Аудит его не показал, потому что сигнальные grep-ы шли по *.md.
  Закрыто в рамках AC1 (критерий покрывает весь bundled-срез, не только markdown),
  отдельная задача не заводилась. Вывод на будущее: сигналы prompt-audit надо
  гонять и по schema.json — description в схеме доезжает до модели так же, как
  текст скилла.
- 2026-09-03T19:57:33.250Z - task-done: T7: Волна B: довести девять MCP-описаний до контракта, со staleness-оговоркой для health.* (F5, F7)
- 2026-09-03T19:57:33.338Z - ac-confirmed: AC1: keryx ctx rg 'used to (say|be|read|call)|the sentence that stood here|until flow [0-9]+' по src/gdskills/bundled/** — ноль совпадений после T5/T6. Пятое место найдено при реализации в input-contract.schema.json и тоже закрыто.
- 2026-09-03T19:57:33.428Z - ac-confirmed: AC2: В task-implementer/SKILL.md и четырёх harness-сборках нет строки 'return the JSON result object as your final message'; факт про parseChildResult, бросающий на не-STATUS первой строке, сохранён в пункте 10.
- 2026-09-03T19:57:43.727Z - ac-confirmed: AC6: Скрипт подсчёта по src/mcp/tools.ts: все девять описаний 4-5 предложений (437-657 символов), каждое называет, чего инструмент не возвращает — cycles не ранжирует, orphans не отличает точки входа, memory.search не возвращает неakcepted, health.* не возвращают пофайловые findings, sac.overview не возвращает тела элементов, standard.validate не проверяет код.
- 2026-09-03T19:57:43.826Z - ac-confirmed: AC7: health.gate: 'reads the last report and never runs the gate itself... only as fresh as the last keryx health run', плюс предупреждение, что при отсутствии отчёта возвращается status fail и это отсутствующий гейт, а не проваленный. health.status: 'lastRunAt is the staleness signal', плюс что null означает неизвестно, а не здорово.
- 2026-09-03T20:01:30.698Z - task-done: T8: Волна C: проба до правки — прогнать feature-analyzer и feature-dev на реальной ветке, записать поведение в journal (AC4, AC5)

## T8 — поведенческие пробы до правки (2026-09-03)

Три диспетча, general-purpose/sonnet, каждый с корнем проекта и чтением
.metaproject/index.md по правилу subagent-context-construction.

**Проба 1 — feature-analyzer, запрос из примера скилла.** VERDICT ASKED_FOR_CONTEXT.
Дефект дизайна пробы, признан и исправлен: я взял строку запроса из самого скилла
("Analyze everything related to variables in pipelines"), поэтому агент
воспроизвёл заскриптованный ответ "essentially unchanged (only trivial
formatting)". Это яркая демонстрация вреда gold-output, но не проверка того,
переживает ли требование удаление скрипта. Проба перезапущена на новом запросе.

**Проба 2 — feature-analyzer, новый запрос** ("retry backoff on the webhook
consumer", в скилле отсутствует). VERDICT ASKED_FOR_CONTEXT. Главное:
IF_LINES_28_60_WERE_DELETED = YES, агент всё равно останавливается. Независимые
гейты, названные им: Step 0 :186 CRITICAL, скрипт вопросов :188-212, :214 "No
default paths", :220 "IF Source, Target, or Branch is missing -> STOP";
PRE-STEP чеклисты :131-137 и :158-164; :449 "Never assume". Форма ответа при этом
снова "almost entirely scripted" — цитируется шаблон, а не синтезируется.

**Проба 3 — feature-dev.** VERDICT HELD_THE_PIPELINE. Порядок фаз соблюдён,
spec-before-code YES, tests-before-code YES, несмотря на явное "skip the
ceremony, we do not need a spec or tests". Ведущий текст — :147 и :148, которые
называют возражение пользователя дословно ("even if user says skip tests"), и
строки таблицы Red Flags :159-160. IRON LAW :163-165 идут шестыми по счёту.

Вывод для T9/T10: удаление 28-60 и снятие регистра IRON LAW не снимают гейты —
их держат другие, более конкретные места. Аудит недосчитал три площадки
повторения в feature-analyzer (:131-137, :158-164, :449).
- 2026-09-03T20:22:59.894Z - task-done: T12: Волна D: grep каталога, роутера и тестов на interview/interviewer и code-mobx-store-review до любого удаления (AC9)
- 2026-09-03T20:23:00.003Z - task-done: T13: Волна D: свести пару interview/interviewer к одному скиллу либо разграничить описания; решение и причина в journal (F7, AC8)
- 2026-09-03T20:23:00.139Z - task-done: T14: Волна D: слить code-mobx-store-review в store-раздел review-frontend либо разграничить (F8, AC8)
- 2026-09-03T20:23:16.401Z - ac-confirmed: AC3: feature-analyzer/SKILL.md и четыре harness-сборки: строки 28-61 удалены, sweep по '⚠️ MANDATORY|CRITICAL RULE|You MUST respond' даёт ноль. Требование сохранено во frontmatter description:3 и в Step 0 — :152 CRITICAL, :180 'No default paths', :186 'IF Source, Target, or Branch is missing -> STOP'.
- 2026-09-03T20:23:16.485Z - ac-confirmed: AC4: Пробы до и после на одном новом запросе ('retry backoff on the webhook consumer', в скилле отсутствует). До: ASKED_FOR_CONTEXT. После: ASKED_FOR_CONTEXT, агент цитирует :152, :180, :185-189, :97-103, :415 и отвечает на вопрос о неоднозначности 'Nothing in the file would license starting from cwd silently'. Регрессии нет, возврат инструкции не потребовался.
- 2026-09-03T20:23:16.571Z - ac-confirmed: AC5: Пробы до и после на запросе с явным 'skip the ceremony, we do not need a spec or tests'. До: HELD_THE_PIPELINE, spec YES, tests YES. После: HELD_THE_PIPELINE, spec YES, tests YES; агент цитирует :147 и переписанный рекап :163 как ведущий текст. Регрессии нет. Побочное наблюдение агента, вне скоупа фло: у скилла нет пропорционального пути для тривиальных изменений.
- 2026-09-03T20:23:16.664Z - ac-confirmed: AC8: Применён второй путь критерия: оба скилла сохранены с явно разграниченными описаниями (interviewer = 0.1.5 custom, до контекста; interview = 0.3 implement, после контекста), в SKILL.md и в catalog.ts. code-mobx-store-review сохранён как legacy opt-in профиль. Решения и причины записаны в journal и в причинах T12-T14.
- 2026-09-03T20:24:46.226Z - task-done: T16: Снять усилители-дубликаты в feature-analyzer:270,296,331 и job-orchestrator:477, сохранив сами инструкции (F11)

## T12-T14 — две находки аудита отменены проверкой (2026-09-03)

Задача T12 (grep до удаления) существовала ровно для этого и сработала.

**F8 отменён.** code-mobx-store-review не дубль review-frontend. Он
зафиксирован в routing-baseline.ts:47 ("review the mobx store" -> top
code-mobx-store-review, score 85), ограничен профилем full в catalog.ts:261 и
внесён в EXEMPT в review-skills-iron-laws.test.ts с записанной причиной:
"legacy opt-in profile; does not use the blocker/major vocabulary at all".
Удаление сломало бы baseline и отменило бы заявленное решение. Аудит прочитал
только два description и не посмотрел review-стек — ошибка аудита.

**F7 исправлен, не выполнен.** interview и interviewer — две стадии одного
конвейера, а не дубль: job-orchestrator 0.1.5 грузит interviewer для custom-
интента до сбора контекста, 0.3 (:219) диспетчит interview для implement-
интента после сбора, и текст прямо говорит "complements 0.1.5".
routing-baseline.ts:58 фиксирует interviewer. Верным был второй путь AC8:
описания разграничены в обоих SKILL.md и в catalog.ts:345,350, каждое
называет парный скилл и стадию. Жалоба аудита была по существу верной —
описания действительно не давали роутеру различить их, — но предложенное
лечение (удаление) было неверным.

Вывод: находка уровня "реестр" не проверяется чтением описаний. Минимум —
routing-baseline, catalog-профиль и тесты, которые называют скилл.
- 2026-09-03T20:38:11.074Z - task-done: T18: Синхронизировать harness-сборки task-implementer и job-orchestrator с канонами, прогнать bundled-eval и keryx skills verify (AC10)
- 2026-09-03T20:38:11.183Z - ac-confirmed: AC10: bun test на ветке: 6513 pass / 18 skip / 49 fail. Базовая линия на HEAD, снятая в изолированном git worktree: 6513 pass / 18 skip / 49 fail — те же 49, все в daemon/listener/HTTP/registry (сокеты, SSE, биндинг), ни одного в gdskills, mcp или review. Изменения фло не вносят новых падений. keryx skills verify --bundled: 13/13 pass, включая build-parity и byte-identical зеркало. npx tsc --noEmit: без ошибок.
- 2026-09-03T20:38:11.282Z - ac-confirmed: AC9: T12 закрыл грепы до удалений и отменил оба предложенных удаления, поэтому висячих ссылок не возникло. По F10 (T15) удаление сборок не выполнялось — см. причину T15. Потребители ResolvedSkillBuild.fallback перечислены там же.
- 2026-09-03T20:39:12.413Z - task-done: T15: Волна D: перечислить потребителей ResolvedSkillBuild.fallback, затем свернуть 88 идентичных harness-сборок (F10, AC9)
- 2026-09-03T20:39:12.505Z - task-done: T17: F12: добавить учёт токенов по экспортируемым скиллам как предпосылку будущих измерений

## T15/T18 — что показала проверка зеркала (2026-09-03)

**Базовая линия снята честно.** bun test на ветке даёт 6513 pass / 49 fail.
Та же линия на HEAD, снятая в изолированном git worktree с симлинком на
node_modules: 6513 pass / 49 fail, те же наборы (daemon, listener, HTTP,
registry — сокеты и SSE, зависят от окружения). Новых падений фло не вносит.
До проверки я предположил, что расхождения зеркала были и раньше; это было
неверно — на HEAD src/gdskills зелёный, 275 pass 0 fail, все четыре падения
были мои.

**keryx skills install оказался неверным инструментом.** Он переписал 11
зеркальных файлов, которых фло не касалось (review-*, agent-entrypoint-
distiller). Откачено через git checkout -- .metaproject/skills/gdskills/;
вместо этого скопированы ровно 25 отредактированных файлов bundled -> зеркало.
Вывод: для точечной правки bundled нужен точечный перенос, а не переустановка
профиля — install приводит зеркало к своему представлению целиком.

**F10 отменён как правка.** Флаг ResolvedSkillBuild.fallback наблюдаем:
export.ts:87,143,172,187 кладёт usedFallbackBuild в манифест экспорта,
commands/skills.ts:791 печатает его пользователю, export-runtime-builds.test.ts
ассертит его трижды. Плюс build-parity.test.ts активно держит сборки в
соответствии с SKILL.md. Значит 88 идентичных сборок — поддерживаемый
механизм, а не осевший мусор; удаление меняет манифест и вывод CLI. Решение
мейнтейнера, не правка аудита.

Итог по находкам: из 12 действий выполнено 8 (F1-F6, F9, F11), одна исправлена
по существу иначе, чем предлагал аудит (F7 — разграничение вместо удаления),
три отменены проверкой (F8, F10, F12).
- 2026-09-03T20:40:14.223Z - task-done: T19: Записать в journal паттерн prompt-audit для каждой правки; проверить, что ни одно удаление не обосновано объёмом (AC11, AC12)
- 2026-09-03T20:40:14.319Z - ac-confirmed: AC11: Для каждой выполненной правки в journal записана группа паттерна из shared/prompt-audit.md: F1 Group 1a+1c, F2/F3/F4/F9 Group 1d, F5 Group 3 (add), F6/F11 Group 1a, F7 Group 4. Ни одно обоснование не апеллирует к длине. Обратный контроль: волна B добавила текст в девять описаний, что противоречило бы цели сокращения, если бы она была целью.
- 2026-09-03T20:40:14.425Z - ac-confirmed: AC12: git diff --quiet HEAD подтверждает нетронутыми: review-frontend/SKILL.md, consistency-checker/SKILL.md, patterns-researcher/SKILL.md, spec-writer/SKILL.md, review-verifier/SKILL.md, CLAUDE.md, AGENTS.md. Счётчики защищённого содержимого: 32 MUST, 16 CRITICAL, 11 '### MUST', 2 площадки цитаты GPT-4/GSM8K.
