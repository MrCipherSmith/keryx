# Keryx Improvements 1 — Shared Agent Context, память и оркестрация

**Статус:** research complete, packages proposed

**Дата:** 2026-08-14

**Worktree:** `keryx-improvements-1`

**Область:** SAC и его реальные интеграции с Context Operations, Flow, Harness/session, CLI, MCP, Security, Wiki, Memory, Skills, collaboration, worktrees, policy experiments, graph/wiki.

## 1. Итог в одном абзаце

Shared Agent Context (SAC) — актуальная и концептуально сильная идея: отделить временные доказуемые факты, текущее состояние работы и проверенное долговременное знание; выдавать агенту не весь проект, а небольшой permission-aware контекст; возвращать результат сессии не автоматической записью, а reviewable proposal. Это хорошо совпадает с современным context engineering. Однако текущая реализация значительно сильнее как набор safety-контрактов и локальных механизмов, чем как завершённый рабочий контур. Главные проблемы не в одном `src/sac`, а на стыках: policy candidate меняет метаданные receipt, но не фактический выбор контекста; все элементы overview по умолчанию mandatory; Flow/Wiki/Memory/Skill читаются частично через файловые эвристики; session archive копируется verbatim до security-minimization; accepted artifact не возвращается автоматически в workspace; четыре из шести proposal kinds неожиданно превращаются в Skills; session/workspace/worktree не связаны; collaboration write path не доступен пользователю; документация и graph/wiki отстают от кода. Рекомендация: сохранить FWK и owner boundaries, но временно остановить усложнение learned-policy, исправить P0-семантику и безопасность, затем сделать lifecycle автоматически связным и только после измеримого выигрыша расширять multi-agent coordination.

### Метод исследования

- Прослежены нормативные документы SAC, public guide и phase reports.
- Построены три реальные runtime-цепочки по source: read, promotion и collaboration/worktrees.
- Применены пять независимых brainstorm-перспектив: Pragmatist, Innovator, Critic, Security Analyst и UX Advocate.
- Для критичных утверждений сформулированы falsifiers/acceptance tests, а гипотезы отделены от подтверждённых code paths.
- Выводы сопоставлены с актуальными primary/official sources и свежими research benchmarks по context engineering, memory, multi-agent coordination, identity, provenance и security.
- Изменения кода не выполнялись; результат — analysis и будущие requirement packages.

## 2. Что это концептуально

SAC — не ещё одна память и не ещё один task tracker. Это слой входа и возврата контекста:

- **Facts** — временные утверждения, действительные только при наличии видимого evidence, revision и времени жизни.
- **Work** — read-only проекция единственного владельца состояния работы, то есть Flow.
- **Know-how** — долговременное знание, принятое владельцем Wiki, Memory или Skills.
- **Workspace** — permission-aware набор ссылок на источники; не копия источников.
- **Overview/read** — bounded assembly с trace и receipt.
- **Proposal/review/accept** — управляемая promotion-граница от результата сессии к owner-controlled knowledge.

Правильная ментальная модель:

```text
Session / Flow / project artifacts
            |
            v
     SAC workspace references
            |
            v
 Context Operations assembly -> FWK overview/read -> agent
            |
            v
 session wrap-up -> immutable proposal -> review -> guarded owner writer
            |
            v
      Wiki / Memory / Skills
```

SAC полезен не потому, что «помнит всё», а потому, что должен отвечать на четыре вопроса: что сейчас известно, откуда это известно, что сейчас делается, и какое знание действительно разрешено переиспользовать.

## 3. Оценка актуальности и подхода

### 3.1 Актуальность: высокая, но при строгом фокусе

Современные агентные системы ограничены не только размером контекстного окна. Проблемы возникают от шума, устаревших фактов, смешения доверенного и недоверенного контента, отсутствия provenance и накопления «памяти», которую никто не проверял. Поэтому идея small high-signal context + progressive disclosure + explicit memory lifecycle актуальнее, чем бесконтрольное увеличение prompt.

SAC особенно полезен для:

- долгих задач, которые переходят между сессиями и людьми;
- незнакомых компонентов, где важны owner scope, решения и known gotchas;
- нескольких агентов с независимыми подзадачами;
- regulated/security-sensitive проектов, где важны evidence, identity и audit;
- worktree-based параллельной разработки.

SAC менее полезен для коротких одноразовых задач, маленьких репозиториев и полностью последовательной работы, где стоимость создания и сопровождения workspace выше стоимости повторного поиска.

### 3.2 Что в подходе хорошо

- FWK предотвращает превращение текущего статуса в вечный факт и transcript summary — в безусловную память.
- Local-first и off-by-default уменьшают blast radius.
- Источники остаются у владельцев: Flow, Wiki, Memory, Skills.
- Progressive retrieval соответствует принципу «минимальный полезный контекст сейчас, детали по запросу».
- Trusted `ActorContext`, realpath containment, local-stdio-only MCP и deny HTTP задают правильную security-базу.
- Proposal lifecycle с append-only intent, idempotency и owner receipt — сильнее типичной «агент сам записал memory» реализации.
- Candidate policy не может расширить baseline authorization и выключен по умолчанию.

### 3.3 Главный концептуальный риск

Система может стать дорогим coordination bureaucracy: отдельный registry, receipts, proposals, activity, policy corpus, readiness playbook и ручные links существуют, но агент всё равно должен искать workspace ID через shell, вручную указывать его в каждом вызове и отдельно регистрировать принятый knowledge. Если SAC не уменьшает time-to-context и повторное исследование измеримо, архитектурная корректность не превращается в продуктовую ценность.

## 4. Карта фактической интеграции

| Узел | Реальная связь с SAC | Сильная сторона | Разрыв |
|---|---|---|---|
| Workspace registry | `WorkspaceService`, `.metaproject/workspaces/<id>/workspace.json`, CLI create/list/show/add-resource | typed refs, ACL, atomic writes, realpath/no-follow | полностью ручная регистрация; нет archive/member/session binding UX |
| Context Operations | `assembleAndRecordContext`, traces и access receipt ledger | один canonical assembly trace | selection policy фактически не применяется; tokens/time фиктивны |
| Flow | первый resource kind=`flow` читается как JSON | SAC не пишет Flow | нет owner facade; только первый Flow; lossy status mapping |
| Facts | evidence resources читаются и хешируются | evidence-linked output | positional IDs, expiry=9999, unpinned change остаётся fresh |
| Know-how | Wiki/Memory/Skill Markdown читается и проверяется regex `Status: accepted|reviewed` | accepted-only намерение | файловая эвристика вместо owner API; applicability не вычисляется |
| CLI | `keryx workspace ...` | полный локальный operator surface | docs drift; нет collaboration record/member/list tool for agent |
| MCP | `sac.overview/read/propose/review/collaboration`, HTTP denied | stdio parity и transport guard | registry дублирует CLI wiring; remote identity отсутствует |
| Shell/Harness | `workspace_overview`, `workspace_read` в agent tool array | живой агент может читать SAC | только read; workspace ID каждый раз; discovery через `shell_exec` |
| Session | `exportSessionMarkdown` → workspace session-evidence | hash-bound evidence source | verbatim archive копируется до security scan; нет session binding |
| Proposal lifecycle | immutable proposal, write intent, decision, idempotency | сильная crash/replay модель | mutable note sidecar; self-review; target intent неявен |
| Memory owner | canonical `writeCanonicalEntry` | переиспользует native guard/write path | создаёт draft boilerplate; не auto-link в workspace |
| Wiki owner | direct `writeFileAtomic` + `guardOutput` | security seam присутствует | нет canonical body-write API; обход owner service abstraction |
| Skill owner | `createProjectSkill` | canonical creation/catalog path | decision/risk/follow-up/contract-change попадают в Skills |
| Collaboration | references + `activity.jsonl`; service имеет `record` | metadata-only замысел | CLI/MCP предоставляют только overview; nested validation слабая |
| Security | schema validators, strict-guard type, guarded writers | правильные fail-closed contracts | local compositions передают hard-coded pass, не live decision |
| Policy experiment | pinned artifacts, corpus, sandbox, readiness, kill switch | сильная integrity mechanics | candidate не изменяет selected manifest; baseline subset проверка сомнительна |
| Graph/Wiki | используются как основной navigation layer проекта | хорошая meta-архитектура | `src/sac` отсутствует/устарел в graph/wiki |

## 5. Три реальных end-to-end пути

### 5.1 Получение контекста агентом

1. Человек создаёт workspace и вручную добавляет resources.
2. Агенту сообщают workspace ID либо он запускает `keryx workspace list` через `shell_exec`.
3. Agent tool/CLI/MCP создаёт новый `createLocalFwkReadService`.
4. Локальный authorization server выдаёт actor от OS user.
5. SAC читает manifest, затем напрямую читает evidence, первый Flow JSON и Markdown know-how.
6. Все не объявленные optional элементы становятся required.
7. Context Operations assembly выбирает элементы в исходном порядке.
8. SAC возвращает FWK manifest и на каждый read синхронно дописывает hash-linked receipt.

Вывод: путь рабочий, но bounded overview фактически не является progressive ranking/retrieval — это ordered packing со всеми mandatory элементами.

### 5.2 Promotion результата сессии

1. CLI/MCP получает явные workspace ID, proposal kind и session ID.
2. Весь session Markdown экспортируется в workspace как evidence.
3. Hash evidence попадает в immutable proposal.
4. Опциональный note записывается отдельным mutable sidecar после proposal.
5. Тот же local owner/editor может выполнить review.
6. Kind преобразуется в owner: `wiki-update -> wiki`, `memory-entry -> memory`, всё остальное `-> skill`.
7. Owner writer повторно проверяет evidence hash, создаёт target artifact и receipt.
8. Proposal становится accepted, но target resource не добавляется обратно в workspace.

Вывод: транзакционная часть сильная, но product semantics и data minimization слабее lifecycle mechanics.

### 5.3 Межсессионная и multi-agent работа

1. Workspace manifest может содержать session/worktree references.
2. Collaboration overview показывает references и activity.
3. Однако session не привязан к workspace, sibling worktree обычно не проходит root containment, а production surface для `CollaborationService.record` отсутствует.
4. Поэтому реальный handoff происходит вне SAC: человек передаёт ID/ссылки в prompt или вызывает низкоуровневый код.

Вывод: collaboration сейчас преимущественно contract skeleton, а не законченный agent coordination plane.

## 6. Подтверждённые проблемы

### P0 — корректность и честность поведения

#### C-01. Candidate policy не меняет фактический context selection

`resolvePolicySelection` возвращает только `policyRef/policyRevision`. `FwkReadService.resolve` строит тот же `candidates` и передаёт их в `assembleAndRecordContext`; `selectedIds` candidate нигде не применяются. В результате можно увидеть receipt с candidate policy, но получить byte-equivalent manifest baseline.

Пример falsifier: candidate выбирает только `fact-a`, baseline — `fact-a` + `fact-b`; e2e-тест должен проверять различие manifest, а не только policy metadata.

#### C-02. Baseline subset gate построен на candidate IDs

Runtime/readiness формирует `BaselineSelection.selectedIds` из `evaluation.candidateSelectedIds`. Проверка «candidate является subset baseline» при таком входе близка к тавтологии и не доказывает containment относительно независимо вычисленного baseline.

#### C-03. Overview не bounded по полезности

Формула `required.has(id) || !optional.has(id)` делает каждый элемент mandatory, если внешний caller не передал optional. CLI/MCP/harness не позволяют передать required/optional. При 33 элементах и default `maxItems=32` результат — `context_overflow`, а не 32 наиболее полезных элемента + explicit omission.

#### C-04. `workspace_read` почти не раскрывает detail

Read фильтрует тот же уже компактный объект. Fact возвращает statement вида `Evidence reference <uri>`, Know-how — metadata без body. Это addressed filtering, а не progressive disclosure содержимого.

#### C-05. Freshness optimistic

Unpinned evidence получает текущий hash как revision и сразу сравнивается с ним же; expiry установлен на 9999 год. Изменение файла между reads даст новый hash и снова `fresh`, а не «source changed since observed revision».

#### C-06. IDs позиционные и могут поменять смысл

`fact-0`/`knowhow-0` зависят от порядка resources. После вставки или удаления старый ID может указывать на другой artifact. Receipt/replay и agent follow-up становятся ненадёжными.

#### C-07. Work projection неполная

Используется первый Flow; все task status кроме `done` становятся `next`; blocked task details и несколько flows теряются. Это не удовлетворяет строгой семантической эквивалентности source Flow.

#### C-08. Policy receipts имеют фиктивную стоимость

Каждый receipt пишет `tokens: 0`, `elapsedMs: 0`, `toolCalls: 1`. На таких данных нельзя честно оптимизировать context efficiency или обучать advisor.

### P0 — безопасность и governance

#### S-01. Hard-coded strict pass вместо live security policy

CLI/FWK/proposal/collaboration compositions создают объект `strict/pass/local-offline-v1`. Structural guard есть, но реальное решение актуальной Security config не вычисляется на read boundary.

#### S-02. Raw session archive сохраняется до minimization

`exportSessionMarkdown` копирует все роли и сообщения verbatim в `.metaproject/workspaces/.../session-evidence/` обычным `writeFile`. Это evidence, а не Know-how, но секреты/PII всё равно уже persist. Запрет «raw transcript не становится knowledge» недостаточен: нужен запрет небезопасной persistence вообще либо отдельная encrypted/TTL evidence zone.

#### S-03. Mutable note не связан с review integrity

`<proposal>.note.txt` создаётся после immutable proposal и читается owner writer в момент accept. Изменение note между propose и review меняет target artifact, хотя reviewer формально принимал другой набор байтов.

#### S-04. Self-review фактически разрешён

Local OS UID создаёт одного subject/owner; member-management surface отсутствует; reviewer может совпадать с proposer. Формулировка «human/independent review» не обеспечена механизмом.

#### S-05. Collaboration metadata валидируется только сверху

Проверяются top-level keys, но не exhaustive schema nested `reference`/`handoff`. Вложенные forbidden keys или malformed kind/payload combination могут пройти.

#### S-06. Fail-open Security engine нельзя считать production guard

Базовый `guardOutput` в advisory или при exception разрешает write. SAC docs требуют strict enforced; композиция должна явно доказать, что production path не деградировал к общему fail-open поведению.

#### S-07. Idempotency/recovery binding недостаточен

Owner receipt path scoped только owner/workspace/user-supplied idempotency key. Повтор того же key для другого proposal может восстановить старый receipt; текущий wrapper способен перебиндить его к новому intent без новой target mutation. CLI/MCP при retry создают новый correlation ID, тогда как approval recovery ожидает исходный, поэтому заявленный crash recovery трудно выполнить операционно. Owner target write и receipt persistence также не являются одной атомарной транзакцией.

#### S-08. Proposal path/workspace binding нужно усилить

Review использует caller `proposalId` при построении file path до полной проверки opaque ID и должен явно доказать, что загруженный proposal принадлежит запрошенному workspace. Нужны traversal/cross-workspace negative tests независимо от существующего schema validation на happy path.

#### S-09. Session evidence не требует sealed/completed session

Текущий legitimacy floor — минимум два archived messages. Отдельного completed/sealed state нет; capability TTL ограничивает использование wrap-up, но не удаляет уже сохранённый transcript.

### P1 — продуктовая семантика и UX

#### U-01. Accepted knowledge не становится доступным в том же workspace

Owner writer создаёт Wiki/Memory/Skill artifact, но acceptance не добавляет target ref в manifest. Следующий overview его не увидит без ручного `add-resource`.

#### U-02. Proposal kind не выражает target intent

`decision`, `follow-up`, `contract-change`, `risk` попадают в Skills. Это загрязняет skill catalog и не соответствует ожиданиям: decision скорее Wiki/ADR, follow-up скорее Flow, risk — Flow/risk register или Wiki, contract change — spec/wiki.

#### U-03. Workspace lifecycle полностью ручной

Нет `shell --workspace`, binding session→workspace, auto-derivation from active Flow/worktree, agent-facing workspace list tool, archive или stale-resource maintenance UX.

#### U-04. Collaboration phase переоценена

`CollaborationService.record` существует, но production CLI/MCP вызывают только overview. Документированный handoff — contract-only walkthrough. Пользователь не может выполнить его end-to-end через выпущенный surface.

Ещё серьёзнее: collaboration service и proposal lifecycle используют один `activity.jsonl`, но collaboration reader принимает только два своих event shape. Proposal lifecycle дописывает в тот же файл proposal/intent/transition records. После первого review `collaboration overview` может перестать читать ledger целиком. Отдельного mixed-ledger e2e-теста не найдено.

#### U-05. Public guide содержит неработающий propose example

Guide показывает `--summary/--evidence`; код требует `--session` и `--note`. Это прямой onboarding failure.

#### U-06. Cross-worktree sharing не соответствует названию

Refs должны realpath находиться внутри текущего root, а storage находится в checkout. Типичный sibling worktree нельзя безопасно сослать, и разные worktree не обязательно видят один workspace state.

#### U-07. Opt-in semantics не едины

Документы описывают SAC как module opt-in/off-by-default, но `workspace` CLI регистрируется как обычная команда, а shell tools добавляются без очевидной runtime-проверки SAC module state. MCP имеет собственный module exposure filter. Пользователь не получает единый ответ, что именно означает disabled: «нет templates», «tools hidden» или «runtime operations denied».

#### U-08. Reviewer не имеет inbox/preview

Нет proposal list/show/queue. Reviewer должен получить ID вне системы; полезный note находится в sidecar и не является частью review digest. Это делает governance формальным, но плохо обозримым.

### P1 — архитектура и эксплуатация

#### A-01. Owner boundaries соблюдены несимметрично

Memory и Skills используют canonical APIs; Wiki пишет body напрямую, Flow/Know-how читаются через raw file formats. Изменения формата owner-модуля могут незаметно сломать SAC.

#### A-02. Операции трижды зарегистрированы

CLI, MCP и Harness повторяют parsing/defaults/composition. Parity tests снижают риск, но новые операции и security changes легко разойдутся.

#### A-03. Каждый read — durable locked write

Access receipt ledger блокируется и дописывается синхронно на overview/read. Нет surfaced retention/prune policy. При agent loops это создаёт contention, disk growth и recovery burden.

#### A-04. Graph/wiki не знают о SAC

Предписанный проектом navigation layer не показывает зависимости `src/sac`, хотя модуль связан с CLI, MCP, Context Operations, Session, Security, Memory, Wiki и Skills. Это повышает риск неполного impact analysis.

#### A-05. Delivery evidence устарело

Документы одновременно приводят 88/88, 103/103 и исторические release claims. Такие totals без commit/tag/date быстро становятся misleading.

#### A-06. Command discovery не отражает SAC

Workspace commands не представлены как полноценный SAC command module в natural-language command registry. CLI, MCP и shell используют разные namespaces (`workspace`, `sac.*`, `workspace_*`), поэтому агенту и человеку трудно обнаружить одну и ту же capability.

## 7. Что говорят актуальные практики и исследования

| Источник | Практика | Следствие для Keryx |
|---|---|---|
| [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | context — конечный ресурс; полезны JIT retrieval, compaction, notes, subagents | FWK актуален, но overview должен ранжировать signal, а read — реально раскрывать detail |
| [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | начинать с простого workflow и добавлять autonomy после evals | policy experiment и coordination plane нельзя расширять до доказанной пользы базового CLI flow |
| [Anthropic: Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | multi-agent полезен при параллелизуемой работе; слаб при плотных зависимостях/shared context | reservations и event spine полезнее «общей памяти для всех»; orchestration должна учитывать topology |
| [OpenAI Agents SDK: Context](https://openai.github.io/openai-agents-python/context/) | local application context отличается от LLM-visible context | workspace/session binding не означает автоматическую передачу всего manifest модели |
| [OpenAI Agents SDK: Sessions](https://openai.github.io/openai-agents-python/sessions/) | session history, compaction и storage — отдельный lifecycle | Session archive нельзя смешивать с durable Know-how; нужны TTL/minimization |
| [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | audience/resource-bound tokens, no token passthrough, short-lived grants | HTTP SAC нужно оставлять disabled, пока нет scoped principal/capability |
| [A2A specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) | Agent Card, task lifecycle, opaque agents, artifacts | future remote collaboration лучше строить поверх task/artifact capabilities, не raw shared transcripts |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) | Entity/Activity/Agent и derivation/attribution/delegation | context capsules и promotion receipts можно моделировать как provenance graph |
| [NIST: agent identity and authority](https://www.nist.gov/news-events/news/2026/02/new-concept-paper-identity-and-authority-software-agents) | workflow-bound identity, scoped authority, continuous authorization | subject от OS UID достаточен только для single-user local mode; нужен capability model до remote/multi-agent writes |
| [OWASP Agentic AI threats](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/) | hijacking, tool abuse, memory poisoning, privilege expansion | untrusted content нельзя сохранять в memory/evidence без scan, provenance и trust label |
| [LongMemEval](https://arxiv.org/abs/2410.10813) | retrieval должен учитывать multi-session, temporal update и abstention | SAC нужны update/contradiction/forgetting tests, не только «нашёл accepted Markdown» |
| [MemoryAgentBench](https://arxiv.org/abs/2507.05257) | retrieval, learning, long-range understanding, selective forgetting — разные способности | Memory eval suite должен быть многомерным; один task-success score недостаточен |
| [MultiAgentBench](https://arxiv.org/abs/2503.01935) | важны topology и collaboration quality | в Keryx нужно измерять duplicate work, handoff loss и coordination overhead |
| [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) | failures возникают в specification, inter-agent alignment, verification, termination | causal events, termination reasons и verifier ownership важнее дополнительного chat bus |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296) | больше агентов не всегда лучше; sequential/dependent tasks деградируют | orchestrator должен выбирать single-agent/sequential/parallel topology по структуре задачи |
| [Beyond Black-Box Benchmarking](https://arxiv.org/abs/2503.06745) | нужен runtime flow observability, не только final score | receipts должны связывать dispatch, retrieval, tool calls, verifier и outcome |

## 8. Предлагаемые независимые requirement-пакеты

### RP-01 — Runtime Truth: честный FWK selection и budget semantics

**Приоритет:** P0. **Размер:** M. **Зависимости:** Context Operations owner.

Требования:

- Candidate/baseline возвращают исполнимый retrieval plan или selected IDs, которые реально ограничивают assembly.
- Baseline вычисляется независимо от candidate report.
- Default overview имеет явный mandatory core и optional ranked items.
- Stable content-addressed/opaque item IDs не зависят от порядка manifest.
- Receipt записывает measured tokens/time либо `unknown`, но не фиктивный ноль.
- `workspace_read` возвращает bounded owner-sanitized detail, а не только ту же metadata.

Acceptance:

- E2E corpus доказывает различие manifest при разных policy selections.
- 33 optional items при budget 32 дают success partial и ровно один omitted ID.
- Перестановка resources не меняет ID.
- Изменение unpinned source создаёт new revision и explicit changed/stale state.

Не включать: learned ranking model. Сначала deterministic planner.

### RP-02 — Source-owned FWK projections

**Приоритет:** P0/P1. **Размер:** M–L. **Зависимости:** Flow, Wiki, Memory, Skills.

Требования:

- Ввести read-only owner ports: `FlowContextProjection`, `KnowledgeProjection`, `EvidenceResolver`.
- Flow owner возвращает canonical completed/next/blocked/evidence и явно обрабатывает multi-flow selection.
- Wiki/Memory/Skills возвращают trust/status/applicability через API, не regex Markdown.
- Wiki получает canonical body-write/decision-write API; SAC direct file write удаляется.
- Contract tests принадлежат owner-модулям и проверяют backward compatibility.

Acceptance: изменение внутреннего file format owner не ломает SAC adapter test; Work равен canonical Flow projection на corpus всех statuses.

### RP-03 — Session–Workspace–Flow lifecycle binding

**Приоритет:** P1. **Размер:** M. **Зависимости:** Harness/session, Flow.

Требования:

- Session может получить immutable optional `workspaceId`/`flowId` при создании или attach.
- `keryx shell --workspace <id>` и agent runtime автоматически передают binding tools, не content.
- Agent получает read-only `workspace_list/current` tool без shell execution.
- Workspace может быть создан/предложен из active Flow/worktree с preview, но не автоматически persist без команды.
- Accepted target ref автоматически добавляется в workspace через отдельный idempotent link intent.
- Archive/close session triggers evidence TTL and proposal reminder, но не auto-promotion.

Acceptance: новый агент входит в bound session и вызывает overview без ручного ID; resume сохраняет binding; unrelated session не получает доступ.

### RP-04 — Promotion Semantics and Integrity

**Приоритет:** P0. **Размер:** M. **Зависимости:** RP-02, Security.

Требования:

- Заменить generic kind→fallback mapping на exhaustive target intent: `wiki-decision`, `memory-note`, `project-skill`, `flow-follow-up` или explicit `owner + artifactType`.
- Proposal содержит digest всех render-affecting inputs, включая note/template version/target intent.
- Owner формирует preview до review; review принимает digest preview.
- Reviewer independence policy конфигурируется: self-review allowed только в declared single-user mode.
- После accept owner target и link-back receipt входят в terminal event.
- Idempotency scope включает owner/workspace/proposal/revision, а recovered receipt содержит и проверяет полную intent binding.
- Recovery переживает новый process/correlation ID через durable operation ID; crash points между owner mutation и receipt append покрываются fault-injection tests.
- Proposal/workspace IDs валидируются до path construction; загруженный record повторно связывается с requested workspace.
- Proposal не может превратить raw session в skill без explicit skill specification и validation.

Acceptance: mutation note после propose отклоняет acceptance; один key для двух proposals не восстанавливает чужой receipt; retry после каждого crash point не дублирует target; path traversal/cross-workspace load deny; каждый kind имеет один ожидаемый owner; rejected/stale ничего не пишет.

### RP-05 — Evidence Minimization and Secure Session Wrap-up

**Приоритет:** P0 security. **Размер:** M–L. **Зависимости:** Security, Session.

Требования:

- Перед persistence session evidence проходит secret/PII/injection scan и minimization.
- Session имеет explicit sealed/completed state; mutable/live session не может выпустить terminal wrap-up capability.
- По умолчанию сохраняется structured evidence manifest + selected excerpts/artifact refs, не полный transcript.
- Full archive допускается только explicit opt-in, encrypted-at-rest либо restricted zone, TTL и delete command.
- Trust/sensitivity labels наследуются при derivation; declassification требует отдельного reviewer capability.
- Prompt/tool output из внешнего источника не может стать Memory без provenance и verifier.

Acceptance: secret/PII fixtures не появляются ни в evidence zone, ни target knowledge, ни receipt; expiry реально удаляет/minimizes artifact и оставляет permitted tombstone.

### RP-06 — Agent Identity, Capabilities and Continuous Authorization

**Приоритет:** P1 до любого remote transport. **Размер:** L. **Зависимости:** Security/MCP/Harness.

Требования:

- Явные modes: `local-single-user`, `local-multi-agent`, `remote`.
- Для mutation выдаются short-lived, audience/resource/action-bound capabilities.
- Authorize-at-use проверяет role revision, task/workflow binding и target owner.
- Proposer/reviewer/owner writer identities и delegation chain попадают в provenance.
- HTTP/remote остаётся hard denied до verifier suite: replay, confused deputy, token passthrough, cross-workspace, revoked capability.
- Hard-coded pass compositions заменяются injected live strict decision provider.

Acceptance: revoked capability отказывает на следующем read/write; capability одного workspace не раскрывает даже наличие другого; same OS UID agents различаются по delegated execution identity.

### RP-07 — Memory Lifecycle: generational memory, contradictions, forgetting

**Приоритет:** P1/P2. **Размер:** L. **Зависимости:** Memory, Wiki, RP-05.

Требования:

- Три поколения: ephemeral session observation → workspace working set с TTL → accepted durable owner knowledge.
- Дедупликация и contradiction set вместо silent overwrite.
- Temporal validity (`validFrom/validTo/supersedes`) и explicit abstention, если актуальная версия не доказана.
- Selective forgetting: expiry, withdrawal, privacy deletion, stale reverse links.
- Accepted knowledge хранит applicability, evidence diversity и source trust.

Acceptance corpus: single-session retrieval, multi-session synthesis, temporal update, contradiction, premise false, forgetting, privacy deletion, abstention.

### RP-08 — Causal Collaboration Spine and Worktree Overlays

**Приоритет:** P2. **Размер:** L. **Зависимости:** Harness/Flow/Git.

Требования:

- Вместо отдельного chat bus — metadata-only causal events: dispatch, reservation, result, handoff, verifier, receipt, proposal.
- Сначала разделить collaboration events и proposal lifecycle ledgers либо ввести единую exhaustive tagged-union schema с tolerant filtering; один consumer не должен падать на record другого owner.
- Intent reservation board с TTL — hint против duplicate work, не lock.
- Worktree overlay: read-only base workspace + private facts/proposals/receipts; merge только reviewable delta.
- Shared storage ownership определяется относительно main repo common dir, а не каждого checkout.
- Collaboration record получает exhaustive nested schema и production CLI/MCP/harness surface.

Acceptance: handoff → propose → review → collaboration read работает в одном mixed lifecycle test; два parallel agents не дублируют зарезервированную область; crash освобождает reservation; sibling worktrees видят base, но не private overlay до publish.

### RP-09 — Unified Operations Registry and Agent UX

**Приоритет:** P1. **Размер:** M.

Требования:

- Описать SAC operations один раз: schema, defaults, risk, transports, authorization, normalization.
- Из registry генерировать CLI help, MCP tools, Harness tools и docs examples.
- Добавить `workspace_current/list`, proposal queue/status, preview/review и explicit error recovery.
- Унифицировать module enablement: одинаковый capability status и deny/enable guidance для CLI, MCP и shell.
- Denied/missing различать для owner diagnostics, не создавая discovery oracle для untrusted actor.
- UX telemetry только metadata: commands-to-first-useful-context, failed setup, stale refs, repeated reads.

Acceptance: contract snapshot доказывает parity всех surfaces; docs command examples исполняются в CI.

### RP-10 — Receipt Operability and Provenance Capsules

**Приоритет:** P1. **Размер:** M–L.

Требования:

- Context capsule фиксирует workspace revision, retrieval plan digest, source revisions, policy/config version и ledger checkpoint.
- Replay показывает drift: source changed, ACL changed, policy changed, selection changed.
- Receipt pipeline получает buffering/batching или async append с defined durability level.
- Retention/prune/verify/repair commands и storage quotas обязательны.
- Provenance model совместим с Entity/Activity/Agent; подписи нужны только при cross-principal trust boundary.

Acceptance: 10k reads benchmark с p95/ledger growth; prune не ломает verified checkpoints; replay не раскрывает raw content.

### RP-11 — Evaluation and Topology-aware Orchestration

**Приоритет:** P1/P2. **Размер:** M–L. **Зависимости:** Harness/Flow.

Требования:

- Baselines: no-SAC, deterministic SAC, candidate SAC.
- Метрики: task success, time/tokens/tool calls, duplicate research, stale-fact errors, handoff loss, unsafe persistence, coordination overhead.
- Causal ablations: убрать memory, provenance, reservations, multi-agent split и измерить вклад.
- Orchestrator выбирает single/sequential/parallel topology по dependency graph и uncertainty.
- Policy tournament работает shadow-only до statistically useful real corpus.

Acceptance: заранее зафиксированный corpus и independent verifier; candidate меняет output; rollback воспроизводим; никакой self-report ground truth.

### RP-12 — Documentation, Graph and Release Truth Sync

**Приоритет:** P0 quick win. **Размер:** S–M.

Требования:

- Добавить `src/sac` и integration edges в graph/wiki.
- Сгенерировать guide commands из executable registry либо выполнять docs snippets в CI.
- Статусы phase разделить на contract-complete, mechanism-complete, usable-surface-complete, production-ready.
- Test totals привязывать к commit/tag/date или не использовать как текущий показатель.
- Создать single architecture page с owner matrix и data-flow diagrams.

Acceptance: `gdgraph affected src/sac/fwk-service.ts` показывает CLI/MCP/ctx/session dependencies; public guide propose command проходит smoke test.

## 9. Приоритет и последовательность

### Wave 0 — немедленная truth correction

- Исправить guide propose syntax и phase/status формулировки.
- Добавить SAC в graph/wiki.
- Зафиксировать, что candidate пока не изменяет context output.
- Либо отключить activation path, либо пометить как metadata-only mechanism до RP-01.

### Wave 1 — P0 correctness/security

- RP-01 Runtime Truth.
- RP-04 Promotion Semantics and Integrity.
- RP-05 Evidence Minimization.
- Live strict policy provider из RP-06.

### Wave 2 — полезный базовый продукт

- RP-02 Source-owned projections.
- RP-03 lifecycle binding.
- RP-09 unified operations/UX.
- RP-10 retention and capsules.

### Wave 3 — память и multi-agent

- RP-07 generational memory.
- RP-08 causal collaboration/worktree overlays.
- RP-11 topology-aware evaluation.

### Wave 4 — только после доказанной пользы

- Real-data policy tournament.
- Remote MCP/A2A identity.
- TUI/IDE visualization.
- Capability-carrying cross-project federation.

## 10. Что стоит упростить, отложить или удалить

- **Отложить Phase 5/6 activation:** сохранить corpus tooling как research harness, но не развивать runtime до output-changing e2e proof.
- **Не считать activity ledger готовой feature:** либо дать реальный handoff surface и schema, либо временно выводить references из workspace/session/Flow без отдельного ledger.
- **Сократить proposal kinds:** explicit owner artifacts лучше generic fallback.
- **Не строить UI сейчас:** плохой workflow в красивом TUI останется плохим workflow.
- **Не строить shared transcript memory:** делиться следует artifacts, decisions, evidence refs и task state, а не всей историей каждого агента.
- **Не вводить глобальную vector DB как default:** сначала owner-owned retrieval, temporal correctness, contradiction handling и evals.
- **Не делать signatures везде:** hash chain достаточен внутри одного trusted local owner; подписи оправданы при переходе trust boundary.

## 11. Дополнительные идеи

- `workspace doctor`: broken refs, stale pins, orphan proposals, ledger size, expired evidence.
- `workspace explain <item-id>`: почему элемент выбран/не выбран, какой policy rule и source revision.
- `workspace replay <receipt>`: reconstruct metadata-only plan и показать drift.
- `workspace propose --preview`: owner-rendered diff до immutable proposal.
- `workspace accept --link-back`: atomic owner write + workspace ref intent.
- `session attach-workspace` и `/workspace` command в shell.
- `context debt` report: resources без revision/expiry/applicability, stale accepted knowledge.
- Evidence diversity score: не давать одному transcript считаться независимым подтверждением нескольких утверждений.
- Negative memory: хранить опровергнутые premises и withdrawn decisions как tombstones, чтобы агент не повторял ошибку.
- Reservation TTL + affected symbols from gdgraph для предотвращения параллельного редактирования одной зоны.
- Context receipt sampling: полный durable receipt только на material decision/mutation, lightweight metrics для repeated identical reads.

## 12. Решения, которые потребуются от владельца

1. Должен ли single-user local mode разрешать self-review, или review всегда должен быть независимым?
2. Что является primary workspace identity across worktrees: git common dir, Flow, project root или отдельный shared store?
3. Какие proposal targets реально нужны в v1: Wiki decision, Memory note, Skill, Flow follow-up?
4. Можно ли сохранять full session archive вообще; если да, при каких TTL/encryption/approval?
5. Должен ли каждый read быть audit-durable, или достаточно sampling/material-event policy?
6. Нужна ли learned policy как продуктовая цель, если deterministic retrieval plan после исправления даёт достаточный результат?

## 13. Проверенные сильные инварианты, которые важно не потерять

- SAC не пишет Flow state.
- SAC не становится владельцем Wiki/Memory/Skills.
- Нет automatic promotion.
- Нет HTTP SAC без verified identity/capability.
- Client payload не задаёт actor/role.
- Owner writes idempotent и receipt-bound.
- Context Operations остаётся владельцем assembly trace.
- Learned candidate не расширяет authorized baseline и не управляет security gates.

## 14. Источники внутри репозитория

Основные документы: `docs/requirements/shared-agent-context/{README,prd,specification,design-rationale,agent-protocol,artifact-lifecycle,metrics-and-validation,implementation-plan,phase-4-usability-report,phase-5-policy-experiment-report,phase-6-real-opt-in-readiness,phase-6b-operator-playbook}.md`, public guide `docs/docs/guides/shared-agent-context.md`.

Основные runtime seams: `src/sac/fwk-service.ts`, `workspace-service.ts`, `proposal-lifecycle.ts`, `session-wrap-up.ts`, `proposal-evidence.ts`, owner writers, `collaboration-service.ts`, `policy-experiment.ts`; `src/ctx/assembly.ts`; `src/commands/workspace.ts`, `src/commands/shell.ts`; `src/mcp/tools.ts`; `src/harness/tool/builtin/workspace-context-tool.ts`; `src/security/**`; `src/session/**`; `src/memory/write.ts`; `src/gdskills/project-skills.ts`.

## 15. Routing audit

- `graph_used`: yes — `gdgraph find/affected`; результат выявил отсутствие/устаревание SAC edges.
- `wiki_used`: yes — index и component pages Context, Flow, Memory, MCP, Security, Agents, Skills.
- `ctx_used`: yes — `keryx ctx rg/read` для docs/code и compact outputs.
- `raw_rg_used`: no.
- Exact raw line windows: `sed` применён только после того, как gdctx compaction скрыла критический surrounding code; это зафиксировано как точечный fallback, не broad navigation.
