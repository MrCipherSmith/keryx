# Keryx Project Agent Harness — Implementation Runbook

> Операционный ранбук для поэтапного запуска имплементации harness через
> `flow-orchestrator`. Здесь же — **живой стейт-трекер**. Запускаешь фазу →
> после завершения обновляешь таблицу «Стейт» (или просишь агента обновить её).

- **Спецификация (заморожена, не переизобретать):** [`docs/requirements/keryx-project-agent-harness/`](../requirements/keryx-project-agent-harness/)
  — `implementation-plan.md` (16 волн, DAG), `specification.md`, `prd.md`,
  `acceptance.feature` (73 Gherkin), `schemas/` (35 схем).
- **Handoff/провенанс:** ветка `origin/feature/keryx-harness-docs` →
  `.metaproject/jobs/requirements-remediation--keryx-project-agent-harness/flow-orchestrator-handoff.md`.
- **Статус имплементации на старте:** 0% (пакет — только спека).

---

## Как запускать

1. Открой **новую сессию** `claude` в корне основного репозитория:
   `/Users/Goodea/goodea/keryx` (worktree на `main`, где лежит спека).
2. Поставь модель сессии **Opus 4.8** (`/model`).
3. Скопируй промт нужной фазы из раздела [Фазы](#фазы) и вставь.
4. Агент сначала покажет план и список тасков — подтверди, затем исполнение.
5. После завершения фазы — обнови [Стейт](#стейт-progress-tracker).

**Правила для всех фаз** (агент обязан соблюдать):
- Hard-gate: прочитать `.metaproject/index.md` в корне worktree до любых действий.
- Ветка: `feature/keryx-harness-impl` от `main`; работа в отдельном worktree;
  в `main` напрямую не коммитить.
- Только одна волна за flow (скоуп фазы). Волны вне скоупа не трогать.
- TDD: `tests-creator` → `task-implementer` → `code-verifier`.
- Воркеры — через контракты `subagent-dispatch` / `subagent-result`.
- Состояние работы — только через `keryx flow`; `flow.json` и замороженные
  acceptance-критерии руками не править.
- После волны — health-гейт (`keryx health run`) и краткий статус.

---

## Model Policy (глобально)

| Класс задачи | Модель | Примеры |
|---|---|---|
| Оркестрация + «тяжёлое» | **Opus 4.8** | оркестратор; `kind=implement/logic/review`; всё в `src/harness`, `src/eval`; provider/tool-порты; контракт-валидатор |
| Среднее | **Sonnet** | тесты, схемные негативы/мутации, неочевидные рефакторы |
| Механическое | **Haiku 4.5** | docs-заморозки решений, генерация/проверка фикстур, миграции, перемещение файлов, обновление импортов |

---

## Стейт (progress tracker)

Легенда: ⬜ не начато · 🔄 в работе · ✅ готово · ⏸ заблокировано

### Release 0 — offline read-only vertical slice

| Фаза | Волна | Таски | Осн. модель | Статус | Ветка/PR | Дата | Заметки |
|---|---|---|---|---|---|---|---|
| 1 | W1 Решения | D-01…D-04 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-12 | flow 003; 4 ADR + `decision-registry.md` + `research-ledger.md` в `docs/decisions/keryx-harness/`; AC1–AC5 ✅; T9 consistency-review PASS, contradiction-check NO-CONTRADICTION; OPEN-1…OPEN-4 сохранены; frozen requirements пакет не тронут. Health WARN — pre-existing `src/**` churn, не от W1 (docs-only). Осн. модель de-facto: оркестратор+D-02/03/04 — Opus, D-01 — Haiku 4.5. |
| 2 | W2 Task Manager | TM-01…TM-03 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-12 | flow 004; TDD RED→GREEN. TM-01 [additive-fields spec](../decisions/keryx-harness/TM-01-task-manager-evolution.md) (7 опц. полей, schemaVersion 1→2 read-time migration, backward-compat matrix, 8 OPEN); TM-02 `src/flow/migration.test.ts`+`disposition.test.ts` (RED); TM-03 `src/flow/{types,store,service,machine}.ts`+`commands/flow.ts` (GREEN). AC1–AC5 ✅; T8 review PASS; D-02 инвариант сохранён (writeFlow только в TM save/init, runLink не присваивается). `tsc` clean, `bun test` 554/0; flows 001–003 flow.json не тронуты. Health WARN 90 (↑89), только service.ts complexity +4 (аддитивно). Модели: оркестратор/TM-03/review — Opus, TM-01 — Haiku, TM-02 — Sonnet. 2 LOW-ноты отложены (unreachable-branch в check(); новые флоу рождаются v1-on-disk). |
| 3 | W3 Перенос corpus | EV-01 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-12 | flow 005; `git mv` corpus.ts/gate.ts/+тесты `src/harness/`→`src/eval/` (renames, 0 ins/0 del — история сохранена); `src/harness/` освобождён под рантайм (W5+). Внутр. импорты не менялись (та же глубина); внешний импортёр `src/security/detect/mcp.test.ts`→`src/eval/*`. AC1–AC5 ✅; T7 review CLEAN; `bun test` 554/0 (baseline parity), `tsc` clean. Живые доки (architecture/modules/fixtures README)→`src/eval/`; [EV-01-corpus-relocation.md](../decisions/keryx-harness/EV-01-corpus-relocation.md) резолвит ADR-0001 **OPEN-4 = direct rename**; frozen requirements/ADR-0001 не тронуты. |
| 4 | W4 Контракты | C-01…C-03 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-12 | flow 006; TDD RED→GREEN. C-01 [contract-inventory.md](../decisions/keryx-harness/contract-inventory.md) (34 схемы + registry, $id/owner/persistence/migration, 0 пропусков); C-02 `src/contracts/{validator,resolver,keyword-coverage}.ts` — детерминированный валидатор БЕЗ внешних deps (deps={}), покрывает весь used-keyword set + cross-file/local $ref/$defs; C-03 `src/contracts/fixtures.test.ts` (6 матриц, 79 тестов). AC1–AC5 ✅; T8 review CLEAN + **enforcement proof** (каждый keyword реально отклоняет невалидное). `tsc` clean, `bun test` **633/0** (554+79). Frozen requirements/ADR не тронуты; src/harness/ пуст. Health WARN 89 (+2 findings в src/contracts — branchiness валидатора). Модели: оркестратор/C-02/review — Opus, C-01 — Haiku, C-03 — Sonnet. Инцидент: C-01 воркер записал в неверный worktree → перемещено; добавлен worktree-guard. |
| 5 | W5 Порты | P-01…P-02 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-12 | flow 007; TDD RED→GREEN попортно. P-01 `src/harness/provider/` (ProviderPort: 8 events/9 errors/4 attempt-outcomes/9 caps, sequence+attempt-scope, unknownExtensions, toolCallExecutable-гейт); P-02 `src/harness/tool/` (ToolDefinition/Registry+snapshot/registryHash/ExecutorPort, validateToolCall 3-stage, ToolExecutionState). **Границы (T9 proof):** 0 provider-SDK-импортов в порту; модель без прямого fs/shell (только invoke, за гейтом). Валидатор переиспользован: W4 `validateAgainstSchema` + аддитивный `validateAgainstSchemaObject` (inline; `src/contracts` diff additive-only). AC1–AC5 ✅ (AC4/AC5 амендились через `flow ac update` — журнал); T9 review CLEAN. `tsc` clean, `bun test` **677/0** (633+44); deps `{}`. Frozen requirements/src/eval/ADR не тронуты. Health WARN 90 (без findings в src/harness). Port-only (провайдер/tools — W6). Модели: оркестратор/P-01/P-02/review — Opus, тесты — Sonnet. |
| 6 | W6 Fake-провайдер | F-01…F-02 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | flow 008; TDD RED→GREEN. F-01: 8 transcript-фикстур (`src/harness/provider/fixtures/transcripts/`) + `FakeProvider` (`fake-provider.ts`) поверх ProviderPort — replay raw→normalized офлайн/детерминированно (malformed→provider_error+partial trail; unknown→unknownExtensions; cancellation→без model_end). F-02: `FakeReadOnlyTool`+`FakeToolExecutor` (`fake-tool.ts`) поверх tool-порта — hash-bound `outputHash` (стабилен, instance-independent), гейт `validateToolCall` (unregistered/invalid→reject), read-only. AC1–AC5 ✅; T10 review CLEAN; детерминизм/офлайн доказаны (node:crypto, fixed createdAt, throwing fetch не вызывается). `tsc` clean, `bun test` **703/0** (677+26); deps `{}`; reuse-only (W5 порты + src/contracts не тронуты). Health WARN 90 (без findings в src/harness). Модели: оркестратор/F-01/F-02/review — Opus, фикстуры — Haiku, тесты — Sonnet. **Субстрат для W7 (Release 0 slice).** |
| 7 | W7 Release 0 slice | R0-01…R0-03 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | **🎯 Release 0 достигнут** (по frozen AC1–AC6). flow 009; 5 суб-срезов TDD RED→GREEN: S1 startup/floor/manifest (18), S2 append-only session (14), S3 policy allow/ask/deny+fail-closed (28), S4 completion-gate+evidence+redaction (21), S5 run-loop+CLI/JSONL-RPC parity+effect-free replay (13). `runOffline` собирает context→FakeProvider→policy→FakeToolExecutor→redact→session+evidence→budget/loop→completion→run-output. AC1–AC6 ✅; T15 review CLEAN на границах (no network/fs-write/subprocess/clock/random; reuse-only W4/W5/W6 unmodified). `tsc` clean, `bun test` **797/0** (703+94), deps `{}`. Frozen requirements/src/eval/src/contracts/ADR не тронуты. Health WARN 90. **Deferred (вне frozen AC):** SC_R12_TRANSIENT_RETRY → W8 (attempts/resume); SC_R16_BUDGET_RESERVATION reconciliation → follow-up/W16. Модели: всё Opus, тесты Sonnet. **→ Далее W16 (E-01…E-03) release-evidence.** |

### Release 1 — resume / branching / mutation / flow / child / parallel

| Фаза | Волна | Таски | Осн. модель | Статус | Ветка/PR | Дата | Заметки |
|---|---|---|---|---|---|---|---|
| 8 | W8 Durable resume | RS-01…RS-02 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | flow 011; TDD RED→GREEN. RS-01 `src/harness/resume/{fingerprint,store,resume}.ts` — reconstruct leaf по worktree/toolchain fingerprints, immutable attempts (stale→new), evidence не дублируется, approval+evidence переживают resume (SC_R05/SC_R11); `runWithResume` — pure wrapper (W7 run.ts не тронут). **SC_R12_TRANSIENT_RETRY закрыт** (retryable→новый attempt в reservation, bounded). RS-02 `recovery.ts` — pure `recoverFrom`: crash-pre→safe; crash-post+effect-confirmed→reconciled; +indeterminate/missing→**blocked-unknown-outcome**; torn-write→last valid; cancellation→resumable; isolated-replay→deferred (SC_R17). AC1–AC5 ✅; T9 CLEAN (no findings). `tsc` clean, `bun test` **817/0** (797+20); deps `{}`; reuse-only (W7/W5/W6/contracts unmodified). Frozen/src/eval/src/contracts/ADR не тронуты. Health WARN 78. Модели: RS-01/RS-02/review — Opus, тесты — Sonnet. SessionStore real-fs адаптер отложен. |
| 9 | W9 Branching+compaction | B-01…B-02 | Opus | ⬜ | — | — | — |
| 10 | W10 Guarded mutation | M-01…M-02 | Opus | ⬜ | — | — | approval-flow |
| 11 | W11 Flow integration | FI-01…FI-02 | Opus | ⬜ | — | — | требует W2 |
| 12 | W12 Child agents | CA-01…CA-02 | Opus | ⬜ | — | — | — |
| 13 | W13 Parallel scheduling | PA-01 | Opus | ⬜ | — | — | — |
| 15 | W15 Security hardening | H-01…H-02 | Opus | ⬜ | — | — | reviewer: security |

### Release 2+ и сквозное

| Фаза | Волна | Таски | Осн. модель | Статус | Ветка/PR | Дата | Заметки |
|---|---|---|---|---|---|---|---|
| 14 | W14 Real providers | RP-01 | Opus | ⬜ | — | — | реальные SDK-адаптеры |
| 16 | W16 Docs/evidence | E-01…E-03 | Sonnet | ✅ (R0) | `feature/keryx-harness-impl` | 2026-07-13 | **Release 0 evidence** (граница R0). flow 010; docs+reviews only (без рантайм-кода). E-01 [evidence-matrix](../decisions/keryx-harness/E-01-release0-evidence-matrix.md) (18 rows capability→source/test/commit) + research-ledger + decision-registry + migration-notes; E-02 [7-lens review](../decisions/keryx-harness/E-02-release0-review-package.md) → **NO BLOCKER/P0/P1, GO**; E-03 [flow-orchestrator-handoff](../decisions/keryx-harness/flow-orchestrator-handoff.md) (DAG/AC/gates/constraints/deferred, next=W8). AC1–AC4 ✅; T8 verify CLEAN (30/30 paths, 7/7 commits; frozen+ADR untouched). `bun test` 797/0, `tsc` clean, deps `{}`. **Deferred (3):** SC_R12_TRANSIENT_RETRY→W8, SC_R16_BUDGET_RESERVATION→follow-up, SC_R18_UNREGISTERED_EXTENSION_DENIED→H-02/W15. Модели: E-01/E-03 Sonnet, E-02/verify Opus. **Запускать снова на след. границе (после W15).** |

---

## Фазы

Каждый промт самодостаточен: он ссылается на этот ранбук (Model Policy + правила)
и жёстко задаёт скоуп своей волны. **Открывай новую сессию под каждую фазу.**

### Фаза 1 — W1 Решения (D-01…D-04)

```
Прочитай docs/plans/keryx-harness-implementation-runbook.md (разделы "Как запускать",
"Model Policy", "Стейт") и соблюдай все правила оттуда.

Запусти имплементацию Keryx Project Agent Harness через flow-orchestrator.
СКОУП ЭТОГО FLOW: только Фаза 1 = Волна W1 — заморозка решений D-01, D-02, D-03, D-04
(Release 0 boundary, ownership-матрица, security-профили, provider/branch/child-модели).
Другие волны НЕ трогать.

Источник истины (заморожен): docs/requirements/keryx-project-agent-harness/ —
implementation-plan.md (§W1), specification.md, prd.md, acceptance.feature.
Ветка feature/keryx-harness-impl от main, работа в worktree, main не коммитить.
Модели по Model Policy ранбука (решения-доки — Haiku/Sonnet, спорные — Opus; оркестратор — Opus).

Покажи план и список тасков W1 до старта исполнения. После завершения обнови в ранбуке
таблицу "Стейт": Фаза 1 → ✅, проставь ветку и заметку.
```

### Фаза 2 — W2 Task Manager prerequisite (TM-01…TM-03)

```
Прочитай docs/plans/keryx-harness-implementation-runbook.md и соблюдай его правила и Model Policy.

flow-orchestrator, СКОУП: только Фаза 2 = Волна W2 — эволюция Task Manager:
TM-01 (аддитивные поля task/run-link), TM-02 (миграционные/переходные фикстуры),
TM-03 (implement: сервис/CLI + миграция; harness остаётся только producer'ом evidence).
Обратная совместимость обязательна. Другие волны не трогать.

Требования: docs/requirements/keryx-project-agent-harness/implementation-plan.md (§W2),
specification.md. Ветка feature/keryx-harness-impl (продолжай существующую), worktree, не в main.
TDD: tests-creator → task-implementer → code-verifier. TM-03 — Opus, TM-01 docs — Haiku, TM-02 тесты — Sonnet.

Покажи план и таски W2 до исполнения. После завершения обнови "Стейт": Фаза 2 → ✅.
```

### Фаза 3 — W3 Перенос corpus-эвалуатора (EV-01)

```
Прочитай docs/plans/keryx-harness-implementation-runbook.md и соблюдай его правила и Model Policy.

flow-orchestrator, СКОУП: только Фаза 3 = Волна W3, таск EV-01 (implement):
перенести текущий fixture-corpus эвалуатор из src/harness/ в src/eval/ (corpus.ts, gate.ts,
их тесты), обновить все импорты и доки, СОХРАНИТЬ зелёные corpus-гейты. Цель — освободить
src/harness/ под будущий рантайм. Ничего кроме переноса и совместимости.

Требования: implementation-plan.md (§W3), R0-01. Ветка feature/keryx-harness-impl, worktree, не в main.
TDD/верификация обязательны: до и после переноса corpus-тесты и block-D-corpora тесты зелёные.
Модель: Opus (затрагивает src/eval, src/harness). Обновление импортов — можно Haiku.

Покажи план и compatibility-map до исполнения. После завершения обнови "Стейт": Фаза 3 → ✅.
```

### Фаза 4 — W4 Контракт-реестр, валидатор, фикстуры (C-01…C-03)

```
Прочитай docs/plans/keryx-harness-implementation-runbook.md и соблюдай его правила и Model Policy.

flow-orchestrator, СКОУП: только Фаза 4 = Волна W4:
C-01 (docs: зарегистрировать каждый durable/public payload и envelope со стабильным $id,
owner, persistence, migration policy — contract-inventory без пропусков),
C-02 (implement: Draft 2020-12 валидатор ИЛИ доказать покрытие каждого используемого keyword'а
детерминированным валидатором),
C-03 (test: positive/negative/mutation/migration/fixture-hash матрицы для каждого семейства схем).
Схемы-источник: docs/requirements/keryx-project-agent-harness/schemas/ (35 шт). Другие волны не трогать.

Ветка feature/keryx-harness-impl, worktree, не в main. C-02 — Opus, C-03 — Sonnet, C-01 docs — Haiku.
Покажи план и таски W4 до исполнения. После завершения обнови "Стейт": Фаза 4 → ✅.
```

### Фаза 5 — W5 Provider и tool порты (P-01…P-02)

```
Прочитай docs/plans/keryx-harness-implementation-runbook.md и соблюдай его правила и Model Policy.

flow-orchestrator, СКОУП: только Фаза 5 = Волна W5:
P-01 (implement: provider-neutral request/event/error/capability порты, attempt-scoped стримы,
неизвестные расширения; НИ ОДИН provider-SDK-тип не пересекает порт),
P-02 (implement: tool definition/registry/call порты со схемой, budget, cancellation, provenance,
replay-метаданными; прямой доступ модели к fs/shell невозможен).
Скоуп по schemas/ (harness-*, tool-*, model-*, provider-descriptor, policy-*). Другие волны не трогать.

Ветка feature/keryx-harness-impl, worktree, не в main. Обе задачи — Opus. TDD обязателен.
Покажи план и таски W5 до исполнения. После завершения обнови "Стейт": Фаза 5 → ✅.
```

### Фаза 6 — W6 Fake-провайдер и fake-tools (F-01…F-02)

```
Прочитай docs/plans/keryx-harness-implementation-runbook.md и соблюдай его правила и Model Policy.

flow-orchestrator, СКОУП: только Фаза 6 = Волна W6:
F-01 (детерминированный fake-провайдер поверх provider-порта из W5; транскрипты по
fake-provider-transcript.schema.json), F-02 (fake-tools поверх tool-порта).
Никаких реальных SDK/сети. Скоуп по schemas/fixtures/ и replay-*. Другие волны не трогать.

Ветка feature/keryx-harness-impl, worktree, не в main. Реализация — Opus, фикстуры — Haiku, тесты — Sonnet.
Покажи план и таски W6 до исполнения. После завершения обнови "Стейт": Фаза 6 → ✅.
```

### Фаза 7 — W7 Release 0 read-only vertical slice (R0-01…R0-03)

```
Прочитай docs/plans/keryx-harness-implementation-runbook.md и соблюдай его правила и Model Policy.

flow-orchestrator, СКОУП: только Фаза 7 = Волна W7 — собрать офлайн read-only вертикальный срез:
R0-01…R0-03 (запуск run'а поверх fake-провайдера и fake-tools: context-manifest → provider-порт →
tool-порт с policy allow/ask/deny → append-only session-записи → completion только при прохождении
required evidence и gates → resume/replay без дублей и live side-effects).
Проверить по acceptance.feature (сценарии Release 0). Другие волны не трогать.

Это ГРАНИЦА РЕЛИЗА: после неё запусти Фазу 16 (W16 E-01…E-03) для release-evidence.
Ветка feature/keryx-harness-impl, worktree, не в main. Всё — Opus, кроме доков (Sonnet).
Покажи план и таски W7 до исполнения. После завершения обнови "Стейт": Фаза 7 → ✅ и отметь "Release 0 достигнут".
```

### Фазы 8–16 (Release 1 / 2+ / сквозное)

Промты для этих фаз генерируются, когда закрыт Release 0 (чтобы учесть реальные
контракты/эвиденс из W1–W7). Шаблон для любой из них:

```
Прочитай docs/plans/keryx-harness-implementation-runbook.md и соблюдай его правила и Model Policy.

flow-orchestrator, СКОУП: только Фаза <N> = Волна <WX> — таски <ID…>.
(Скопируй Objective/Depends/Contracts/Evidence этой волны из
docs/requirements/keryx-project-agent-harness/implementation-plan.md — исполнять их дословно.)
Проверить связанные сценарии в acceptance.feature. Другие волны не трогать.

Ветка feature/keryx-harness-impl, worktree, не в main. Модели по Model Policy.
Покажи план и таски до исполнения. После завершения обнови "Стейт": Фаза <N> → ✅.
```

> **W16 (E-01…E-03)** — запускать на каждой границе релиза (после W7, после W15 и т.д.),
> а не один раз.

---

## Как обновлять стейт

После завершения фазы попроси агента (или сделай вручную):
1. В нужной таблице «Стейт» поставь статус ✅ (или 🔄/⏸).
2. Впиши ветку/PR и дату (сегодня — абсолютной датой).
3. Короткая заметка: что вышло, какие evidence/gate прошли, что перенесено в следующую фазу.

Порядок исполнения по DAG: **1 → 2 → 3 → 4 → 5 → 6 → 7** (Release 0), затем
Release 1 (8→13, 15) с учётом зависимостей, W14 — последней, W16 — на каждой границе.
