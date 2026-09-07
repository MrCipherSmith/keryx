# План реализации и миграции
Version: 0.1.2

Статус: **spec ready**. Технические контракты — **proposed**; их runtime-реализация этим пакетом не подтверждается.

## Статус и правила исполнения

Spec ready. Ни одна волна этим документом не запускается. Порядок — предлагаемая техническая декомпозиция 49 нормативов, без фиктивных дат/оценок трудозатрат. Перед началом каждой волны сверить current HEAD, owner contracts и фактическую доступность возможностей; старый audit не служит новым gate. Managed implementation выполняется через существующий Flow lifecycle, не редактированием Flow JSON.

В каждой задаче: входные требования/acceptance → ограниченный spec/diff → meaningful tests из local testing context → normalized type/lint/test/health outcomes → review → migration evidence. Required failures и INCOMPLETE блокируют release. Нельзя закрыть требование только schema/docs существованием. У каждой строки [матрицы](decision-traceability.md) появится implementation evidence с версией; пока все target changes открыты.

## Волны и зависимости

| Волна | Доставляемое изменение | Зависимости | Exit gate |
|---|---|---|---|
| 0 — baseline и конкретные дефекты | M01 общий writer index/routing для init/update/rules; AFC-16/21 compatibility; M10 caps/stress/optional port/scripts checks | Текущий baseline и inventory | Lifecycle sequences не возвращают большой gate, user flags сохранены; stub budget реально останавливает, script typecheck включён |
| 1 — доверие интерфейсам | AFC-01..03/05/15/17/18 containment/redaction/HTTP/health/scan/Shell parser | 0 только для общего release, fixes могут быть независимы | Cross-adapter negative fixtures, required checks complete; help не инициализирует session |
| 2 — достоверные sources | AFC-06/09..11/13/25 lifecycle, provenance, checkout snapshots, edge types и capability | 1 safe boundaries | Dirty/untracked/worktree/unknown fixtures; source fragment/confirmers сохранены; offline no-download |
| 3 — полезная выдача | AFC-07/12/14/30, M03/M04, W01/W02/W04 sections/ranking/repomap/ctx/envelope | 2 | Deep-section and no-answer corpus, mandatory caveat budget, deterministic CLI/MCP/SDK projection |
| 4 — актуальность и доставка | AFC-08/22/26, M02, W03/W05 reverse bindings/managed sync/needs-review/bootstrap | 2,3 | Unchanged prose, conflict-safe sync, unknown on error, grouped freshness oracle, no duplicate entry |
| 5 — изменения и продолжение | AFC-27..29 CAS/proposals/receipts/recovery/handoff/forget | 1,2,4 | Two-process + crash matrix, coherent multi-record view, no resurrection и scoped resume |
| 6 — композиция и доказательства | AFC-23/31/32, M05..M09, W06 thin SDK/read batch + neutral runner/guards/evals | 3; write batch после 5; experiment после guards | Batch/sequential equivalence, handle isolation; paired resume/reload stable, preregistration и cost accounting готовы |
| 7 — core/Shell migration | AFC-19/20 public seams, import policy, optional client package | 1..3 для seams; client handoff после 5 | Core-only install/build/smoke без model deps; compatibility mapping и отдельный client matrix |
| 8 — обновления и product rollout | AFC-04/24, M11 dependencies all groups, evidence-bound docs/pilots | 1 quality; 7 влияет на package inventory; пилоты после 6 | Compatibility и packaging на каждой группе; claims проверены, pilot gates определены |

W04 в волне 3 выдаёт доступные refs с явной unknown/partial coverage; полнота code/test bindings и окончательная приёмка всего W04 достигаются только после W03 в волне 4. Промежуточная выдача не закрывает полный контракт.

Зависимости означают доступность нужного контракта, не запрет независимого исправления. Например HTTP/help fixes можно подготовить до полного section index. Волна 6 не обязана запускать модели: сначала только offline runner и guard tests. Волны 7/8 не должны блокировать локальный lexical baseline.

## M01 и M10 — точечные задачи первой волны

На указанном baseline точки M01: `src/lib/templates.ts`, `src/commands/init.ts`, `src/commands/update.ts`, `src/commands/rules.ts`, consumers `src/gdskills/catalog.ts` и `src/ctx/orient.ts`. Эти пути — evidence inventory, не требование именно такого layout после refactor. Общее pure render API возвращает оба документа с module flags; общий writer применяет pair. Tests должны проверять short index/full router раздельно, а не закреплять rules table в index.

M10 — самостоятельная работа с оставшимися benchmark/stress scripts. Удаление неизвестного поля `maxToolCalls` исправляет тип, но не реализует cap. Выбрать и явно назвать поддерживаемый контракт: `maxRounds` ограничивает rounds, `maxToolCalls` — реальные tool invocations; один не представляется другим. Если нужен cap вызовов, провести его через настоящий port и terminal outcome. Исправить ссылку на отсутствующий resolver при stress JSON и nullable/optional port перед containment; подключить scripts к отдельному равноценному typecheck target. Проверять локальным stub, без vendor/model calls и без восстановления private research пакета.

## Миграция контрактов и хранилищ

1. Inventory actual public CLI/MCP/tool descriptors/config/schema versions и их consumers. Зафиксировать compatibility map old→new operation; новые draft names не объявлять поддержанными до реализации.
2. Ввести versioned envelopes и owner adapters как thin projections над единой операцией. Существующая обязательная redaction/policy не отключается для legacy mode. Unsupported major → typed error; deprecated commands получают объявленный срок/версию удаления, выбранные release owner, не произвольную дату в этом плане.
3. Snapshot indexes disposable: новая schema → rebuild из canonical sources. При невозможности rebuild — stale/unknown, не «готово». Markdown migration только preview/CAS; сохранять старые human Version и authored bytes, добавлять стабильные IDs без перенумерации истории.
4. Расширить SAC proposal/preview/revision/receipts, затем подключить coherent read barrier и CAS. До gate multi-record atomic apply недоступен; нельзя объявить его enabled на наборе обычных sequential file writes.
5. Context Operations соседний future пакет обновить версионированно: opt-in recording вместо обязательного trace persistence, core без semantic provider/model config, on-demand snapshots и section evidence. Mandatory items overflow остаётся ошибкой; обычная optional часть может иметь explicit partial. Не создавать конкурирующую context engine.
6. Существующие RP-04/06/08/10 SAC спецификации сопоставить с новым expectedVersion/handoff/loss contract. Сохранить owner writers, protected evidence и действующие review requirements; различия фиксировать amend/addendum, не молча ослаблять.

Rollback до publish может переключить адаптер на прежнюю совместимую проекцию, но не на обход policy. Нельзя откатывать canonical tombstones или committed receipts как cache. После миграции schema новые данные требуют version-aware rollback plan; если безопасного downgrade нет, release предупреждает и отклоняет downgrade.

## Выделение Shell

Сначала dependency inventory: model/provider auth/registry, turn loop, session streaming/compaction, vendor-agent orchestration, TUI/readline относятся к client. Deterministic operations, policies, source owners и budgets размера выдачи остаются core. Model-cost budget/selection не путать с core byte/item budget. Общие независимые primitives можно выделить ниже обоих consumers.

Затем public facade с contract tests и import guards; legacy shell command — compatibility shim, который обнаруживает optional client и даёт понятную инструкцию при отсутствии, без скрытой установки. Package name выбирается release design, отдельный repository необязателен. CLI help core не импортирует client даже лениво до parser validation.

Gate клиента отдельно: TUI и readline, real-provider/tool-calling (только при отдельном разрешении), approval allow/deny/timeout, streaming/cancel/resume, background jobs, child agents и vendor runtime. Документированная/offline проверка не закрывает реальные scenarios. Core gate полностью offline/model-free и не зависит от credentials.

## Все зависимости и дальнейшая поставка

Обновление AFC-04 включает direct/transitive/dev/optional зависимости, не только advisories. До изменения повторить inventory/audit/reachability и определить совместимые версии. Группировать по платформе/feature boundary; major migration получает contract diff и consumer checks. После каждой группы type/lint/tests/build/pack/install + affected optional capability smoke, audit delta и объяснение оставшихся advisories. Не удалять capability ради нулевого audit и не использовать непроверенный override. Ошибка откатывает только собственную группу, не чужие изменения.

До внешнего пилота нужны verified onboarding/core contracts, preregistered полезность и разрешённые данные. Контакты и публикация не входят в автоматическое завершение Flow. Финальный критерий — реализованные и проверенные нормативы, честно указанные ограничения и evidence для фактических продуктовых заявлений.
