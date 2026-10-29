# Keryx: wiki, SAC/Slate и OpenSpec → Flow → код → знания

Дата: 2026-10-25, Asia/Muscat. Job: `wiki-openspec-flow-research`. Scope: исследование текущего состояния двух явно указанных пользователем checkout, без изменения функциональности, wiki approvals, OpenSpec artifacts или Flow. Дополнительная статистика отключена по просьбе пользователя.

## Снимки и граница достоверности

- Keryx: `/Users/Goodea/goodea/keryx`, `main`, `1b7852748055d264d046092612fe3190fc82f70a`, установленная CLI `0.3.130`.
- Vantage frontend: `/Users/Goodea/work/vantage-frontend`, `develop`, `037e059292a64978bc11f386c114413a82ef252f`.
- Поведение проверено чтением текущих исходников. Тесты/CI, OpenSpec validate/archive, wiki verify/refresh/enrich, SAC review и переходы Flow не выполнялись. Прочитанные тесты являются существующим покрытием, а не свежим PASS.
- Graph обоих checkout обновлён для навигации. Keryx build завершился с parser warnings; graph включает backup/review-копии. Все существенные выводы проверены по root source, не по вложенным копиям. Созданы job и disposable ctx/graph artifacts; исходники не изменены.

## Вывод

Нужен не новый параллельный процесс, а расширение существующих owners и lifecycle. В Keryx уже есть детерминированная wiki-справка, model enrichment, provenance/freshness, локальная история, SAC proposal/review/owner routing, Flow state/gates и confirmation seam. Однако accepted metadata, provenance stamp и protected human decision не тождественны. Hub должен сохранить эти seams и добавить серверную версионность, identity и отдельный review точной ревизии.

## Wiki: что происходит сейчас

| Механизм | Реальная ответственность | Что изменить для Hub |
|---|---|---|
| `sync --apply` | Ветка gdwiki вызывает collect/index, без enrich или редакторского review: [sync.ts](/Users/Goodea/goodea/keryx/src/commands/sync.ts:557) | Отделить local derivative rebuild от team synchronization; запускать impact/review как отдельную операцию |
| collect / refresh | Graph-owned scaffold/Reference; prose остаётся отдельным владельцем: [service.ts](/Users/Goodea/goodea/keryx/src/wiki/service.ts:335), [refresh.ts](/Users/Goodea/goodea/keryx/src/wiki/refresh.ts:202) | Переиспользовать producers и page invariants, записывать immutable KnowledgeRevision |
| enrich | Модель пишет prose; draft→accepted запрещено, но page/force могут выбрать accepted и сохранить прежний Status/provenance: [selection](/Users/Goodea/goodea/keryx/src/wiki/enrich.ts:300), [writer](/Users/Goodea/goodea/keryx/src/wiki/enrich.ts:898) | Новая prose revision не наследует approval старого digest; режим Hub генерирует proposal, а не молча меняет approved baseline |
| verify | Записывает VerifiedAt/VerifiedScope, требует допустимый source/graph; не проверяет смысл и identity reviewer: [refresh.ts](/Users/Goodea/goodea/keryx/src/wiki/refresh.ts:383) | Использовать scope/source attestation, но не считать её human approval |
| freshness | Измеряет code drift и пишет отчёт/очищает очередь: [run.ts](/Users/Goodea/goodea/keryx/src/wiki/freshness/run.ts:33), [persist](/Users/Goodea/goodea/keryx/src/wiki/freshness/run.ts:89) | Использовать impact/revalidation signals; не смешивать с редакторским принятием |
| history | Хранит prior bytes/manual detection/versions локально с retention: [history.ts](/Users/Goodea/goodea/keryx/src/wiki/history.ts:30) | Сохранить local undo; серверная история должна иметь собственную сохранность/retention |

Важная корректировка предыдущего обсуждения: текущий enrich не сам повышает страницу до accepted. Но инструкция gdwiki советует агенту выставить accepted после enrichment: [skill](/Users/Goodea/goodea/keryx/.metaproject/skills/gdwiki/SKILL.md:165). Это документированный процесс агента, а не независимый human gate. При переделке менять и skill, и writer, чтобы не получить новую версию prose со старым accepted.

Подробности и прочитанные проверки: [wiki-findings.md](/Users/Goodea/goodea/keryx/.metaproject/jobs/wiki-openspec-flow-research/wiki-findings.md).

## Flow: сохраняем владельца, усиливаем authority

Freeze записывает AC checksum; обновление AC аннулирует прежние подтверждения: [freeze](/Users/Goodea/goodea/keryx/src/flow/service.ts:1041), [acUpdate](/Users/Goodea/goodea/keryx/src/flow/service.ts:1327). Это готовая основа для привязки версии OpenSpec к критериям.

`acConfirm` принимает заявленную identity и пишет подпись, но сам не аутентифицирует человека: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:1245). Completion под lock записывает результаты gates и возвращается в in-progress при fail: [complete](/Users/Goodea/goodea/keryx/src/flow/service.ts:1459).

Confirmation уже имеет TTL/single-use/Flow+AC+target binding и terminal/TUI/remote-card UX. Исходник прямо оговаривает ограничение same-user shell и отсутствие доказательства human identity: [confirm-token.ts](/Users/Goodea/goodea/keryx/src/flow/confirm-token.ts:1). Gate opt-in: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:499). Также разные completion gates могут наблюдать разные PR heads при конкурентном push: [service.ts](/Users/Goodea/goodea/keryx/src/flow/service.ts:521).

Для Hub нужны authenticated principals/scopes и package, закрепляющий один code/spec/criteria subject. Не переносим local token file как доказательство недоступного агенту human authority. Flow остаётся единственным владельцем завершения; SAC/OpenSpec task checkboxes не создают второй setter done.

Подробности: [flow-findings.md](/Users/Goodea/goodea/keryx/.metaproject/jobs/wiki-openspec-flow-research/flow-findings.md).

## Workspace, Slate и proposals: готовая основа, но другая семантика

Workspace — контейнер ссылок/ACL, не копия wiki: [workspace-service.ts](/Users/Goodea/goodea/keryx/src/sac/workspace-service.ts:20). FWK объединяет Facts, Work и Know-how, ссылаясь на владельцев; accepted trust пока извлекается из Markdown status, не из отдельного серверного решения: [fwk-service.ts](/Users/Goodea/goodea/keryx/src/sac/fwk-service.ts:789).

Slate содержит Anchors, Course/flowRef, Seeds, private Notes и harness Trail: [slate.ts](/Users/Goodea/goodea/keryx/src/session/slate.ts:76). Это частный рабочий контекст агента, не code checkpoint и не общая спецификация. Wrap-up группирует Seeds и создаёт proposals, а не принимает их: [machine-wrap-up.ts](/Users/Goodea/goodea/keryx/src/sac/machine-wrap-up.ts:801). `/goal --auto` уже создаёт/freeze/start Flow по goal и связывает Course, но не импортирует нормативные OpenSpec requirement revisions: [goal-command.ts](/Users/Goodea/goodea/keryx/src/commands/goal-command.ts:301).

Proposal lifecycle содержит immutable revisions, review, durable write-intent, owner writer и receipts с idempotency: [proposal-lifecycle.ts](/Users/Goodea/goodea/keryx/src/sac/proposal-lifecycle.ts:188). Это основной кандидат для развития KnowledgeReview; CAS/staging концепции полезны, но серверный recovery должен повторно проверять базу после crash: [proposal-evidence.ts](/Users/Goodea/goodea/keryx/src/sac/proposal-evidence.ts:222).

Два ограничения для OpenSpec/wiki adapter:

- Нынешний wiki writer создаёт новую accepted decision page `decisions/sac-<id>.md` из note/evidence; он не является writer patch существующей страницы: [wiki-owner-writer.ts](/Users/Goodea/goodea/keryx/src/sac/wiki-owner-writer.ts:30).
- `ownerFor` отправляет wiki-update в wiki, memory-entry в memory, остальные kinds, включая contract-change, в skill: [proposal-lifecycle.ts](/Users/Goodea/goodea/keryx/src/sac/proposal-lifecycle.ts:847). Нужен отдельный типизированный spec owner, а не использование текущего fallback как готовой OpenSpec интеграции.

Human confirmation floor и token реально существуют в контролируемом native shell path; локальная OS identity/файлы не являются серверной protected team identity. HTTP MCP SAC propose/review сейчас запрещён: [tools.ts](/Users/Goodea/goodea/keryx/src/mcp/tools.ts:360). Для Hub нужны новый аутентифицированный adapter и server-side policy, а не простое снятие этого запрета. Одобряемый digest должен включать итоговые bytes/note/target/base, а не только proposal ID.

Подробности: [sac-findings.md](/Users/Goodea/goodea/keryx/.metaproject/jobs/wiki-openspec-flow-research/sac-findings.md).

## Vantage: реальная исходная ситуация

OpenSpec настроен `spec-driven`: [config](/Users/Goodea/work/vantage-frontend/openspec/config.yaml:1). Найдены 43 change directories, без root baseline specs и archive. Это не доказательство, что все 43 нереализованы: выбранное изменение уже имеет код. Числовая версия CLI не доказана, CLI в текущем PATH отсутствует; адаптер нельзя считать протестированным для произвольной latest версии.

Локальные правила требуют учитывать OpenSpec при review, но в исследованных `.metaproject` scopes не найдена автоматическая связь выбранного change с Flow. Единственный найденный Flow 001 относится к другой задаче. [Подробный scope и источники](/Users/Goodea/goodea/keryx/.metaproject/jobs/wiki-openspec-flow-research/vantage-findings.md).

## Один пример: add-inflight-request-guard, #8013

Требование: тест падает, если после теста/DOM cleanup остался незавершённый axios request; diagnostic содержит method/path. Сценарии: unawaited request, awaited action, abort, поздний ответ, который не должен обвинить следующий тест: [spec](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/specs/test-tooling/spec.md:5).

Код уже существует: wrapper `Axios.prototype.request`, Set in-flight requests, cleanup и afterEach assertion: [implementation](/Users/Goodea/work/vantage-frontend/src/test/msw/in-flight.ts:25), [check](/Users/Goodea/work/vantage-frontend/src/test/msw/in-flight.ts:46). Есть setup hook и test cases: [setup](/Users/Goodea/work/vantage-frontend/src/test/vitest.setup.ts:51), [tests](/Users/Goodea/work/vantage-frontend/src/test/msw/in-flight.test.ts:30).

`tasks.md` отмечен [x], но DoD сохранил исторические «No test files found» и «Today: 0» для hook: [tasks](/Users/Goodea/work/vantage-frontend/openspec/changes/add-inflight-request-guard/tasks.md:21). Не выдаём эти записи за текущий test result. Связанная wiki `src-test-msw` имеет accepted, но guard не описывает: [page](/Users/Goodea/work/vantage-frontend/.metaproject/wiki/components/src-test-msw.md:5). Сохранённый freshness report старше исследуемого HEAD и для страницы unknown; не превращаем его в актуальное измерение.

Ниже — предлагаемый Keryx2 проход на реальном примере, не утверждение, что такой Flow был выполнен:

| Шаг | Агент/сервис | Подтверждение пользователя |
|---|---|---|
| 1. Прочитать spec и сопоставить реализацию | Фиксирует change/spec digest, code subject и Open Issues; отмечает найденные расхождения | Определить утверждённый scope, включая отсутствие обещания покрыть fetch |
| 2. Подготовить Flow | Создаёт proposed mapping scenario→AC→planned check; существующий change tasks ссылается на Flow | Принять критерии/нормативные изменения до freeze; уже данная авторизация может покрыть этот шаг, не нужен повторный вопрос о том же |
| 3. Выполнить работу локально | В новой задаче пишет код/тесты; для сегодняшнего reconciliation сверяет уже имеющееся. Slate — черновой контекст; code revision — отдельный subject | Не требуется подтверждать каждое чтение/тест; разрешения инструментов действуют по локальной политике |
| 4. Проверки | Выполняет согласованные checks; сохраняет actual results/subject/provenance; противоречивый DoD предлагает исправить | Изменение требований/waiver требует отдельного полномочия; агент не убирает неудобный сценарий ради PASS |
| 5. Wiki proposal | Обновляет Reference детерминированно; предлагает prose о guard, lifecycle, diagnostic и scope. Сопоставляет её с конкретным кодом и evidence | Review exact wiki revision; можно на том же экране, что и код, но решение имеет отдельный scope |
| 6. Поставка и приёмка | Готовит diff/Evidence/package; Git delivery и post-merge subject следуют принятому deliveryContract | Авторизовать публикацию/merge по политике; финально принять конкретный пакет. Документный approval не заменяет acceptance Flow |
| 7. Синхронизация | После подтверждённых receipts продвигает принятые знания, context cache и OpenSpec state по владельцам | Не требуется повторное принятие неизменившегося документного digest; смена текста/subject требует новой оценки |

Для этого примера wiki должна отличать строгий unmatched-network guard от in-flight guard, описать реальные условия работы axios wrapper и явно сохранить пределы покрытия. Архив OpenSpec/baseline не создаётся автоматически только потому, что tasks отмечены [x]; существующую организацию specs следует сначала согласовать. Read/import и suggested deltas достаточно для первого adapter slice.

## Проектируемые сущности и переход

Минимум: `SpecRef` → frozen `Flow criteria revision` → `CodeRevision` + `Evidence` → `KnowledgeProposal(baseDocumentRevision, proposedDigest)` → `KnowledgeReview(authenticated actor, decision, digest)` + отдельная `CodeApplicabilityAttestation` → owner write receipt. UI может собрать действия в один review, но права и результаты не смешиваются.

Разделить принятый текст и применимость к коду. Machine-only Reference refresh может иметь отдельную ограниченную policy; prose revision никогда не наследует approval старой prose автоматически. Начать с существующих local services за интерфейсами store/owner, а не переписывать всё до интеграционного спайка.

## Следующий ограниченный срез

Подключить один OpenSpec change read-only, построить предложенную связь сценариев с Flow AC и один proposal к существующей wiki странице. Отобразить diff и human approval точной версии; после принятия вызвать owner writer с expected base revision и сохранить receipt. Не включать сразу полноценную двустороннюю tasks/archive sync, новый VCS и серверное исполнение приложения.

## Проверка и routing

Независимая bounded проверка источников и границ утверждений сохранена в [verification-report.md](/Users/Goodea/goodea/keryx/.metaproject/jobs/wiki-openspec-flow-research/verification-report.md); консолидированный контекст — [ai/context.md](/Users/Goodea/goodea/keryx/.metaproject/jobs/wiki-openspec-flow-research/ai/context.md). Основные спорные claims повторно сверены с root source, адресуемость ссылок проверена; это не code quality gate. Уточнение guard: очистка регистрации не отменяет запросы и не обещает отсутствие всех побочных эффектов позднего ответа; abort должен завершиться до assertion.

Живой [артефакт Keryx 2.0](https://chatgpt.com/space/page_684c206031708191a81dac2c18eee1ad) обновлён до v0.12: решения K2-78–K2-82, существующие механизмы/reuse, реальный пример и agent/human boundaries. Сохранение проверено чтением заголовков, версии и history entry. Продолжение реализации не запускалось.

`graph_used`: yes, оба проекта; freshness/backup limitations выше. `wiki_used`: yes, index/architecture/module/freshness artifacts. `ctx_used`: read/rg/run; точные диапазоны дочитаны bounded nl/sed. `raw_rg_used`: no. Memory search выполнен, релевантных accepted entries не найдено. Нет утверждения о PASS тестов/health/CI. Дополнительная статистика не собиралась; служебные timestamps job CLI остаются частью lifecycle.
