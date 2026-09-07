# Жизненный цикл знаний, кэшей и связанных изменений
Version: 0.1.3

Статус: **spec ready**. Технические контракты — **proposed**; их runtime-реализация этим пакетом не подтверждается.

## Статус и owners

Spec ready. Ниже предлагается конкретный файловый протокол для AFC-08..10/21/25..30; реализация должна подтвердить его fault-injection проверками. Существующие SAC proposals/revisions/owner writers и provenance расширяются; новый generic knowledge writer не создаётся.

| Артефакт | Источник истины | Мутация/retention |
|---|---|---|
| Wiki/Memory/Skills Markdown | Соответствующий owner | Versioned write, ACL/security/CAS; история сохраняется по policy |
| Flow state | Flow | Только действующий Flow API/CLI; handoff хранит ссылку |
| SAC proposal/revision/preview/receipts | SAC и source owner в своей области | Immutable revision, scoped replay/recovery; не raw transcript |
| Graph/testing/section/reverse-link indexes | Производные от source | On-demand refresh, replace snapshot; не возвращают удалённое знание |
| Ctx intermediate handles | Управляемый временный store | Scope, sourceVersion, expiry и tombstone-aware resolve |
| Handoff | SAC bounded projection + source refs | Explicit creation; права не выдаёт, source drift проверяется при resume |
| Consumer read history | Opt-in diagnostics | Изоляция caller/session, ограниченная retention, не pure recall |
| Forget tombstone | Source owner | Opaque locator/revision/action и scope; без удаляемого текста/цитат/хеша секрета |

Предлагаемое расположение производных файлов — существующие `data/<module>` и `runtime/<module>` namespaces, а не новая каноническая база. Transaction journal принадлежит coordinator/SAC, staged target bytes — owner; окончательный layout закрепляется в migration inventory до кода. Кэши по умолчанию локальные и disposable; security evidence, tombstones и recovery intent не удаляются правилом очистки обычного cache. Retention values фиксируются policy/profile до включения persistence, unlimited по умолчанию запрещён.

## Происхождение утверждения

Assertion хранит type (`observation`, `hypothesis`, `decision`, `instruction`), source status, author, точный locator/fragment/version, scope, constraints, acceptance basis и confirming participant. Unknown source явно null + причина, не выдуманный ref. Ограничение использует `sourceStatus=known|unknown`, `source=SourceRef|null` и обязательный `unknownReason` при unknown; его текст сохраняется при search/compression/handoff. Такой unknown не становится доказательством разрешения. Exact fragment — range/section/version и доступная цитата; цитата может быть ограничена policy, но нельзя выбросить обязательную оговорку и объявить запись полноценной.

Search → compression → handoff сохраняет эти поля семантически и ссылочно, не только title. Provenance lookup повторно проверяет source availability/version. Редактура source не переписывает прошлое происхождение; создаёт новую версию/связь. Git timestamp и content digest не заменяют author authority. Полномочия проверяются trusted boundary, а не сохранённой записью.

## Changeset и optimistic concurrency

Вход [change-set.schema.json](schemas/change-set.schema.json): immutable SAC `proposalId/proposalRevision`, `workspaceId`, `changes[]` с owner logical target, `expectedVersion` (null только для create-if-absent), operation, proposed content/evidence, preview binding и idempotency key. Target paths разрешает owner registry; клиент не передаёт произвольную filesystem destination. Пример [changeset](examples/change-set.json) синтетический.

Семантика change operation: `create` создаёт target только при отсутствии (`expectedVersion=null`); `replace` меняет существующий target; `archive` сохраняет content и переводит существующий target в архив. `supersede` уточняет уже существующего преемника `targetRef`, а `supersedesRef` указывает предшественника. Изменение статуса/ссылки предшественника обязательно передаётся отдельным `replace` с его базовой версией в том же changeset; validator отвергает неполную пару. Для нового преемника используются `create` нового и `replace` старого с owner-валидируемой связью. Каждая затронутая запись имеет собственную базу, self-supersession и циклы замены отклоняются.

Version — opaque owner revision, связанная с content digest; публичная `Version:` Markdown отдельно остаётся human version и сама по себе не защищает concurrency. Смена bytes внешним редактором инвалидирует базу, даже если он забыл поднять Version. Conflict возвращает текущую доступную revision и diff reference, но не скрытые targets. Повтор старого full replacement с подставленной новой версией запрещён протоколом клиента: необходимо перечитать и пересобрать правку.

### Предлагаемый atomic protocol для согласованных Keryx writers

1. Preview: owner renders immutable proposal revision, проверяет syntax/links/lifecycle/security, формирует base/digests и полный diff. SAC связывает preview с evidence/policy revisions. Review/authorization берётся из действующей политики; отсутствие нового запроса к человеку не означает пропуск policy.
2. Prepare: coordinator получает exclusive record locks в каноническом порядке `(owner, logicalTarget)`; создание использует lock на отсутствующий target ID. Независимые записи не используют глобальный счётчик. **Внутри lock** каждый owner заново сверяет expectedVersion, source digests, permissions и preview binding. Один mismatch отменяет весь prepare, ни один target не публикуется.
3. Stage: каждый owner пишет staged bytes, backup/base и prepared receipt в свой journal area. SAC сохраняет durable intent с полным set/binding. Flush/durability и атомарные rename/pointer primitives документируются для поддерживаемой платформы. Если требуемая гарантия недоступна, apply отказывает, не downgrade.
4. Apply barrier: все Keryx readers/writers этих записей участвуют в transaction barrier. Пока intent pending, они не возвращают смешанный набор новых/старых записей: ждут bounded время либо `transaction-pending`. Владельцы применяют staged bytes и receipts; coordinator не пишет owner data напрямую.
5. Commit: только после всех durable target receipts и workspace link-back фиксируется единый commit marker; then readers снимают barrier и видят coherent result. SAC accepted/success публикуется после полного outcome. Failure до этого не выдаётся как успешное частичное обновление.
6. Recovery: crash до durable intent → очистить только собственный staging; crash с pending intent → по durable prepare/base/stage восстановить весь old set или завершить весь new set до снятия barrier; выбор записывается один раз. Crash после commit marker → идемпотентно восстановить receipt/link-back, не повторять изменение. Нет достаточных доказательств recovery → blocked/incomplete, readers не объявляют consistency.

Это предлагаемая реализация атомарной видимости для **участвующих Keryx операций**, не обещание multi-file filesystem transaction для произвольного внешнего редактора. Некооперирующий writer может изменить bytes вне locks; обнаружение digest mismatch останавливает публикацию/recovery и требует разрешения конфликта. Чтение директории сторонней программой во время файлового apply не получает такую гарантию.

Lock lease не отбирается только потому, что истёк таймер: active owner может быть медленным. Owner identity включает process-start/boot identity; stale lock требует подтверждения отсутствия владельца и проверки journal. Символические ссылки в lock/staging paths также проверяются. Timeout возвращает безопасный retryable outcome. Долгий независимый changeset не блокирует unrelated records.

Idempotency связывается с `(owner/workspace/proposal/revision/operation)` и полным render/base binding по существующему SAC integrity contract. Клиентский key — correlation input; trusted service выводит canonical scope, сравнивает binding. Тот же key и другое содержимое → `idempotency-binding-conflict`. Receipt от другого workspace не переиспользуется. Дубли успешного запроса возвращают прежний durable outcome, независимо от нового process correlation ID.

## Init/update/rules lifecycle

Общий planner строит pair `index.md/routing.md`, managed rules blocks, module flags и hooks. Init/update/rules sync/rules distill задают разные намерения одному writer. Preview перечисляет create/update/conflict/skip и expected base digest. Short index и full router записываются согласованно; security module flag и пользовательские rules не теряются. Consumers orient/catalog/update messages ссылаются на новый owner содержимого.

План имеет stable step IDs и input fingerprints. Apply проверяет preview bases, сохраняет completed/failed/pending и безопасно продолжает после crash. Идемпотентные уже выполненные шаги не дублируют hooks. Этот lifecycle обещает честный partial report и safe resume, **не общий rollback всех файлов**. Pair routing integrity — отдельный обязательный invariant; partial hook setup не скрывается за «всё обновлено».

## Handoff и продолжение

Схема [handoff](schemas/handoff.schema.json), [пример](examples/handoff.json): goal, task/workspace/checkout scope, snapshot, constraints, permissionEvidenceRefs, accepted decisions, verifiedResults с проверяемыми revisions, openQuestions, sources. SAC хранит bounded package/ref; он не второй Flow и не копия чата. Versioned source refs раскрываются по правам следующего caller.

Resume сравнивает snapshot с текущим checkout/config/source inventory и возвращает changed/missing/unknown, affected assertions/tests. Проверка недоступна — unknown; не молчаливое использование прежнего PASS. При смене checkout нужен явный resolver project/clone/checkout mapping; соседство директорий не даёт authority. Consumer получает ограничения и confirmers даже при кратком handoff; если обязательная evidence недоступна, пакет неполон для действия.

## Архивирование, замена и забывание

Archive сохраняет содержимое в истории, исключает из default recall. Supersede добавляет versioned связь к действующей записи. Forget по явному запросу либо заранее заданной policy удаляет выбранное содержимое из заявленного managed scope.

Forget preview перечисляет разрешённые source records, known wiki fragments, indexes, caches, handles, persisted handoffs и derivatives по provenance. Commit сначала создаёт content-free tombstone/deny epoch, чтобы parallel query/cache rebuild не восстановил запись, затем owner очищает source и все доступные derivatives. Каждый resolver сверяет tombstone при выдаче. После очистки выполняется residual verification по inventory и known links; отчёт перечисляет checked/failed/unreachable/remaining без удаляемого текста. Ошибка store → incomplete, не «забыто везде». Tombstone/receipt не содержат цитаты или content hashes, позволяющие восстановить секрет.

Scope полноты — известные управляемые данные. Внешние копии, уже переданный агенту контекст, смысловой пересказ без provenance и Git-history не обещаются стереть. История Git переписывается только отдельной явно разрешённой операцией. Imported old cache также проверяет tombstones прежде использования; очищенный источник не воскресает после rebuild/restart. Для archive/supersede destructive forget не запускается автоматически.
