# Архитектурный аудит Keryx v0.2.80

Дата аудита: 2026-09-06  
Проверенный revision: `d0a2a011df93c2459cb4329a7dc152fb0fe625a6` (`main`)  
Режим: полный аудит текущего проекта, не diff-review  
Вердикт: **REQUEST_CHANGES / DONE_WITH_CONCERNS**

## Область и метод

Проверены границы модулей и направление зависимостей, жизненный цикл генерируемых артефактов, соблюдение схем, масштабируемость графа/wiki/testing-подсистем и практическая полезность Metaproject-навигации. Исходный граф был перестроен родительским процессом непосредственно перед аудитом: 1 172 узла, 3 515 рёбер, 50 неразрешённых импортов; tree-sitter недоступен, поэтому часть импортов получена fallback-парсером. Wiki freshness: 50 страниц, 34 fresh, 12 affected, 4 not-code-scoped.

Проверка шла от графа и wiki к исходникам. Любое утверждение, полученное из графа или документации, сверялось с кодом. Для проверки поведения текущего исходного дерева использовался `bun ./src/cli.ts`, поскольку сохранённое проектное ограничение предупреждает, что глобально установленный `keryx` может отставать от рабочего дерева.

## Сильные стороны

- Точка входа `src/cli.ts` остаётся маршрутизатором: команды перечислены в явной таблице, а бизнес-операции вынесены в `src/commands` и feature-модули. Это делает поверхность CLI обозримой.
- Форматы межпроцессного обмена и результаты агентов описаны JSON Schema; проверки контрактов централизованы, а тесты защищают полноту ключевых полей. Это хорошая основа для машинно-проверяемых orchestration-потоков.
- Граф сохраняет provenance, показывает неразрешённые импорты и отличает dynamic imports. Wiki freshness публикует ограничения анализа вместо безусловного заявления о свежести.
- Потоки review/flow содержат явные состояния, контроль acceptance criteria и review gates. В архитектуре CLI это практичнее, чем вводить тяжёлый DI-контейнер или переносить NestJS-паттерны.
- Отсутствие runtime dependencies в пакете снижает supply-chain поверхность и упрощает установку CLI.

## Findings

### ARCH-001 — Кэш тестового контекста пересекает границы worktree и остаётся валидным после их удаления

**Severity:** major  
**Тип:** дефект  
**Confidence:** high

**Доказательство.** `src/testing/service.ts:23-32` перечисляет исключаемые каталоги, но не исключает `.worktrees` и вложенные git worktree. Рекурсивный обход `src/testing/service.ts:388-408` поэтому индексирует их как часть основного проекта. `ensureContext()` в `src/testing/service.ts:319-328` принимает существующий JSON без проверки fingerprint рабочего дерева или существования файлов. Затем `src/testing/service.ts:620-636` и naming-эвристика `src/testing/selection.ts:19-36` выбирают пути из кэша без `existsSync`; выбранные пути передаются runner в `src/testing/service.ts:739-776`.

Текущий `.metaproject/data/testing/context.json` содержит 1 570 тестовых файлов, из них 1 041 относятся к двум каталогам `.worktrees/full-review-remediation` и `.worktrees/project-skill-reviewers`, которых уже нет в файловой системе. Вызов текущего source API `findRelatedTests(cwd, "src/cli.ts")` вернул, среди прочего, несуществующие `.worktrees/full-review-remediation/src/cli.test.ts` и `.worktrees/project-skill-reviewers/src/cli.test.ts`.

**Сценарий.** Разработчик создаёт worktree с другой веткой, запускает анализ тестов, затем удаляет worktree и выполняет `keryx test related src/cli.ts` или scoped test в основном checkout.

**Последствие.** Команда предлагает или запускает тесты удалённой ветки. Проверка может завершиться ошибкой из-за несуществующих путей либо создать ложное впечатление, что проверяется текущая ветка. Это нарушение границы проекта и жизненного цикла производного артефакта.

**Исправление.** Вынести единый walker для graph/testing/wiki; исключать `.worktrees`, `.claude/worktrees` и каталоги с `.git`-файлом. Записывать в testing context revision/fingerprint входных файлов и автоматически пересобирать stale context. Перед возвратом naming matches отфильтровывать несуществующие пути. Добавить интеграционный тест: создать вложенный worktree, построить context, удалить worktree, убедиться, что related/scoped selection не возвращает его файлы.

**Class scope.** Проверены все места загрузки и потребления `TestingContext`: `src/testing/service.ts:319`, `src/testing/service.ts:327`, `src/testing/service.ts:620`, а также оба механизма выбора в `src/testing/selection.ts` и import-based lookup `src/testing/service.ts:665-693`. Последний уже проверяет существование файлов; дефект остаётся в naming/cached пути.

### ARCH-002 — Запрос runtime-циклов включает type-only импорты fallback-парсера

**Severity:** minor  
**Тип:** дефект точности архитектурного инструмента  
**Confidence:** high

**Доказательство.** `src/gdgraph/build.ts:239-246` прямо фиксирует, что Bun стирает type-only imports и regex fallback добавляет пропущенные рёбра. Все fallback-only рёбра в `src/gdgraph/build.ts:262-269` получают вид `unknown-static`. В `src/gdgraph/types.ts:25-31` этот вид считается load-order dependency, а `src/gdgraph/query.ts:108-123` исключает из поиска циклов только `dynamic-import`.

Аудит рёбер каждого SCC показал: 9 из 10 выданных `keryx gdgraph query cycles` циклов содержат `unknown-static`. Среди них рёбра из явных type-only импортов: `src/flow/types.ts:1-5`, `src/review/types.ts:1-14`, `src/tui/modal-host.ts:13`. Прямой импорт соответствующих модулей через Bun завершился успешно. Только цикл `wiki/collect → wiki/provenance → wiki/describes → wiki/collect` не содержит `unknown-static`.

**Сценарий.** Агент или разработчик запускает `gdgraph query cycles`, получает формулировку о load-order cycle и планирует рефакторинг одного из девяти type-level SCC.

**Последствие.** Архитектурная диагностика объявляет runtime-риском зависимость, отсутствующую после компиляции. Это снижает precision графа и расходует время/контекст на ложные findings. Обязательного quality gate, блокирующего merge по этому запросу, не найдено, поэтому severity ограничен minor.

**Исправление.** Добавить отдельный `ImportKind` для `type-only`; fallback должен распознавать `import type` и `export type`. Runtime/load-order query должен исключать type-only, а UI — отдельно показывать `runtime`, `type` и `unknown` cycles. Пока tree-sitter недоступен, неизвестные рёбра не следует автоматически называть load-order.

**Class scope.** Проверены создание edge-kind (`src/gdgraph/build.ts:239-269`), семантика типа (`src/gdgraph/types.ts:25-31`) и единственный фильтр cycle query (`src/gdgraph/query.ts:108-123`), затем все 10 SCC сопоставлены с исходными import statements.

### ARCH-003 — Принятые генерируемые wiki-снимки навсегда выпадают из обновления и freshness

**Severity:** major  
**Тип:** дефект жизненного цикла схемы/документации  
**Confidence:** high

**Доказательство.** Генератор project map находится в `src/wiki/service.ts:474-508`. При существующей странице collect пропускает её; даже `--force` обновляет только неизменённую генерируемую страницу со статусом `draft` (`src/wiki/service.ts:792-817`). После перевода в `accepted` машинный снимок становится фактически immutable. Одновременно `Describes: none` трактуется как not-code-scoped (`src/wiki/describes.ts:173-182`), а freshness report делает `continue` без проверки (`src/wiki/freshness/report.ts:183-197`).

Текущий `.metaproject/wiki/architecture/project-map.md:5-7` имеет `Status: accepted`, `Describes: none`. В строках 15-33 он сообщает 685 узлов, 681 файл, 1 502 ребра и 0 unresolved imports; текущий граф содержит 1 172 узла, 1 168 исходных файлов, 3 515 рёбер и 50 unresolved. Тот же класс охватывает три генерируемых snapshot-страницы с `Describes: none`: `project-map.md`, `quality-map.md`, `testing-map.md`. Тест `src/wiki/service.test.ts:121-130` закрепляет пропуск accepted project map, то есть расхождение является результатом действующей политики, а не случайной порчи файла.

**Сценарий.** Агент читает wiki index, видит `accepted` и использует project/quality/testing map для оценки масштаба, качества или тестового покрытия после развития проекта.

**Последствие.** Авторитетно выглядящий контекст занижает размер графа более чем вдвое и скрывает unresolved imports. Freshness не предупреждает об этом, поэтому wiki может ухудшить решение по сравнению с прямым поиском.

**Исправление.** Разделить human-owned prose и machine-owned snapshot/reference block. Обновлять машинный блок независимо от `Status`, хранить `producer`, `producer_revision`/artifact hash и `generated_at`. В freshness добавить категорию `producer-stale`; `accepted` должен замораживать редакционный текст, но не снимок наблюдаемого состояния.

**Class scope.** Полностью перечислены четыре wiki-страницы с `Describes: none`: три генерируемые карты образуют этот класс, четвёртая является decision-page и не должна обновляться как snapshot. Проверены generation, skip-policy и freshness classification.

### ARCH-004 — Wiki freshness запускает Git последовательно для каждой страницы

**Severity:** minor  
**Тип:** риск масштабируемости  
**Confidence:** high

**Доказательство.** `src/wiki/freshness/report.ts:174-181` последовательно обходит страницы и ожидает оценку каждой. `src/wiki/freshness/page-freshness.ts:65-93` для одной проверяемой страницы отдельно выполняет `git cat-file`, `git log`, а при изменениях ещё и `git diff`. Инструментированный запуск текущего source `runFreshness` на 50 страницах сделал 96 Git-вызовов: 1 `rev-parse`, 8 `diff`, 6 `show`, 44 `cat-file`, 37 `log`. Обычный `bun ./src/cli.ts wiki freshness --json` занял около 1.05 с уже на 50 страницах.

**Сценарий.** Wiki вырастает до 500 страниц или freshness становится обязательным pre-review/pre-commit шагом.

**Последствие.** Сотни/тысячи последовательных process spawn дают линейно растущую задержку. Пользователи могут реже запускать freshness, что усиливает проблему ARCH-003. Текущие ~1.05 с не являются неприемлемой задержкой, поэтому это minor-риск до подтверждения production SLO или большего масштаба.

**Исправление.** Сгруппировать страницы по `Verified` revision. Для группы один раз получать изменённые пути (`git diff --name-only`) и existence/ancestry, кэшировать результаты по revision. Оставшиеся независимые hash-fallback проверки выполнять с ограниченным параллелизмом. Добавить performance regression test с fake GitRunner, ограничивающий число вызовов через количество уникальных revisions, а не страниц.

**Class scope.** Через injected GitRunner посчитаны все Git-вызовы единственного freshness pipeline; иных параллельных/батчевых путей оценки страниц не найдено.

### ARCH-005 — `src/lib` больше не является нижним слоем, хотя документация продолжает задавать такую границу

**Severity:** minor  
**Тип:** архитектурный долг, не доказанный runtime-дефект  
**Confidence:** high

**Доказательство.** `docs/docs/architecture.md` описывает направление `cli → commands → feature → lib` и `src/lib` как нижний слой. Текущий production graph показывает 20 исходящих межмодульных рёбер из `src/lib`, включая 14 в `harness`: `src/lib/serve-turn.ts:22-30` импортирует harness и security, `src/lib/serve-server.ts` — harness, `src/lib/narrate.ts` — commands/harness, `src/lib/templates.ts` — gdskills contracts.

**Сценарий.** Новый код воспринимает `lib` как стабильную общую основу и импортирует serve/template helper, который транзитивно тянет orchestration/harness слой.

**Последствие.** Название и заявленная граница перестают сообщать направление зависимости; возрастает вероятность циклов и сложность выделения библиотечного ядра. Для монолитного CLI это пока стоимость сопровождения, поэтому finding ограничен severity minor.

**Исправление.** Переместить serve/narrate/template orchestration в явные feature-модули (`src/serve`, `src/narration`, либо существующие owners), оставить в `src/lib` только inward-only primitives и добавить архитектурный тест допустимых направлений зависимостей.

### ARCH-006 — Init и update дублируют операции установки с уже различающимся поведением

**Severity:** minor  
**Тип:** архитектурный долг и риск рассинхронизации lifecycle  
**Confidence:** medium-high

**Доказательство.** Операции `installManagedHook` реализованы отдельно в `src/commands/init.ts:1373-1402` и `src/commands/update.ts:1325-1352`. Запись/копирование файлов повторяется в `src/commands/init.ts:1821-1847` и `src/commands/update.ts:1558-1581`; update создаёт parent directory, а init опирается на внешнюю подготовку. Сопоставление helper names выявило шесть пересекающихся lifecycle helper, часть идентична, часть уже расходится.

**Сценарий.** Исправление атомарности, прав доступа или hook reconciliation вносится только в init либо только в update.

**Последствие.** Свежая установка и обновление существующего проекта получают разные гарантии при одной и той же операции; дефект проявится лишь на одном пути.

**Исправление.** Извлечь общий слой reconcile/install primitives и описать init/update декларативными планами с различающимися policy-флагами. Проверять оба пути одними table-driven контрактными тестами.

### ARCH-007 — В wiki-модуле остаётся реальный статический цикл

**Severity:** minor  
**Тип:** архитектурный риск, не доказанный runtime-дефект  
**Confidence:** high

**Доказательство.** Единственный SCC без `unknown-static`: `src/wiki/collect.ts:5` импортирует provenance, `src/wiki/provenance.ts:23` импортирует describes, `src/wiki/describes.ts:26` импортирует collect. Import smoke test проходит, поэтому текущий цикл не ломает загрузку модулей.

**Сценарий.** В одном из модулей появляется top-level initialization, зависящий от импортированного значения, либо эти файлы начинают переиспользоваться отдельно.

**Последствие.** Порядок инициализации становится хрупким, а низкоуровневый parser зависит от orchestration collect.

**Исправление.** Перенести `keyFilesForPage` и общие типы в leaf-модуль без обратной зависимости; вынести parsing `Describes` так, чтобы provenance зависел от parser, но parser не зависел от collect.

## Границы модулей и связность

Основной поток зависимостей соответствует CLI-монолиту: `commands` широко использует `lib` и `harness`, `tui` опирается на harness, wiki — на gdgraph. Это рациональный tradeoff для локального CLI: отдельный DI framework только увеличил бы сложность. Проблема не в количестве импортов как таковом, а в двух нарушениях смысловых границ: generic namespace `lib` владеет orchestration-кодом (ARCH-005), а testing-кэш считает соседние checkout частью проекта (ARCH-001).

Крупные файлы (`tui-shell`, templates, managed review, command handlers) повышают blast radius, однако размер сам по себе не является нарушением SRP. Без отдельного сценария ошибки это наблюдение остаётся риском, а не finding.

## Жизненный цикл и схемы

Runtime-схемы и subagent contracts в целом централизованы и машинно проверяемы. Главный пробел находится рядом со схемами: provenance производных артефактов не всегда участвует в решении «можно ли доверять данным». Testing context не проверяет свой input set, а wiki snapshot теряет связь с producer после принятия. Для обоих случаев нужен единый принцип: generated artifact действителен только при проверяемом source revision/input fingerprint, независимо от editorial status.

## Насколько graph/wiki/keryx помогают по сравнению с обычным поиском

В этом аудите граф дал измеримую локальную пользу: одним запросом сузил проверку до 10 SCC, показал 20 исходящих production-рёбер из `src/lib`, межмодульные направления и affected sets. Wiki быстро дала заявленную слоистую модель и проектные ограничения. Memory предотвратила ошибочную проверку текущего поведения старым установленным бинарником. `gdctx` позволил не загружать большие search/log outputs целиком.

Эта польза ограничена точностью артефактов. Для cycle-query structural precision составила лишь 1/10 подтверждённых runtime SCC: 9/10 результатов содержали fallback `unknown-static`, в том числе type-only imports. Wiki snapshot сообщил 685 узлов против текущих 1 172 и не попал в 12 affected pages из-за `Describes: none`. Граф также явно сообщает 50 unresolved imports и отсутствие tree-sitter, поэтому symbol-level выводы недоступны.

Переданный родительским аудитом парный benchmark на 13 задачах не показал общего выигрыша: recall 0.8031 с Keryx против 0.8288 без него; 0 wins, 12 ties, 1 loss; 1 272 685 против 960 592 tokens (+32.49%); среднее число tool calls 21.08 против 22.62. Эти данные не доказывают бесполезность отдельных функций, но показывают, что текущая комбинация graph/wiki/context не окупает стоимость автоматически. Наблюдения этого аудита объясняют два механизма: ложноположительные структурные связи и stale authoritative context. До исправления ARCH-001..004 Keryx следует использовать как навигационный shortlist с обязательной source verification, а не как источник окончательной истины.

## Приоритет исправлений

1. Исправить изоляцию/freshness testing context (ARCH-001) и добавить provenance invalidation.
2. Отделить type-only edges от runtime cycles (ARCH-002), чтобы вернуть precision ключевому архитектурному запросу.
3. Ввести producer freshness для generated wiki snapshots (ARCH-003).
4. Батчировать Git-запросы wiki freshness (ARCH-004), иначе более строгая проверка свежести плохо масштабируется.
5. Постепенно восстановить смысловые owners для `lib`, init/update и wiki parser (ARCH-005..007).

## Проверка и ограничения

- Выполнены source-level smoke imports для спорных циклов; они не доказывают отсутствие ошибок во всех командах.
- Полный test/lint suite в рамках архитектурного субаудита не запускался; исходники не изменялись.
- 50 unresolved imports и недоступный tree-sitter снижают полноту графа. Все major findings подтверждены прямым чтением кода и воспроизводимым runtime/artifact наблюдением.
- Последний security health artifact имеет advisory age и не использовался как доказательство текущего security-состояния.

## Routing audit

- `graph_used: yes` — первичная навигация, SCC, межмодульные рёбра, affected sets.
- `wiki_used: yes` — index, заявленная архитектура, freshness и generated maps.
- `ctx_used: yes` — все текстовые поиски через `keryx ctx rg`, большие outputs сжимались.
- `memory_used: yes` — учтено ограничение о stale installed binary и урок о проверке findings.
- `raw_rg_used: no`.
