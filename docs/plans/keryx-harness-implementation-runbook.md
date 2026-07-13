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
| 9 | W9 Branching+compaction | B-01…B-02 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | flow 012; TDD RED→GREEN. B-01 `src/harness/branch/branch.ts` — append-only branch-metadata (fork/leaf/immutableAncestorIds inclusive via parentEventId; deep-frozen, mutation throws); pure forkBranch; atomic switch = pointer reassignment; **no-merge-v1** (mergeBranches всегда rejected, без мутаций). B-02 `compaction.ts` — typed compaction-entry (provenance sourceEntryIds→derivedEntryId, summaryHash=sha256(summary)); PURE append-only DERIVED; **evidence-preservation** (история/evidence не удаляются, assertEvidencePreserved→EvidenceDeletionError; недоверенный summary не промоутится); rebuild bounded context (SC_R07). AC1–AC5 ✅; T9 CLEAN — **4 инварианта** (no-merge-v1, no-evidence-deletion, no-untrusted-promotion, no-history-mutation). `tsc` clean, `bun test` **844/0** (817+27); deps `{}`; reuse-only (W7/W8/W5/W6/contracts unmodified). Frozen/src/eval/src/contracts/ADR не тронуты. Health WARN 78. Модели: B-01/B-02/review — Opus, тесты — Sonnet. |
| 10 | W10 Guarded mutation | M-01…M-02 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | flow 013; TDD RED→GREEN. **Первый выход за read-only, SECURITY-critical, fail-closed.** M-01 `src/harness/mutation/{fingerprint,approval,guard}.ts` — canonical action-fingerprint; `checkApproval` fail-closed (single-use/stale/expired/denied/headless НИКОГДА не valid); path-traversal/symlink/shell-injection/private-egress/credential deny + fail-closed scan; composes W3 `decide`. M-02 `execute.ts` — trusted-local+valid approval → monitored mutation через FAKE adapter + execution-receipt+evidence; unattended-untrusted blocked без isolation; indeterminate → needs-reconciliation → W8 recoverFrom blocked-unknown-outcome. **T9 SECURITY: fail-closed инвариант ДОКАЗАН** (adapter недостижим на любом negative). AC1–AC5 ✅. `tsc` clean, `bun test` **899/0** (844+55); deps `{}`; NO real fs (fake adapter); reuse-only (W3/W8/W5/W6/contracts unmodified). Frozen/src/eval/src/contracts/ADR не тронуты. Health WARN 78. **Deferred → W15 (hardening, fail-closed не нарушен):** SSRF/loopback-substring heuristic; NaN-date fail-closed. Модели: M-01/M-02/review — Opus, тесты — Sonnet. Fake mutation adapter (real-fs отложен). |
| 11 | W11 Flow integration | FI-01…FI-02 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | flow 014 (commit `d2f8ca4`, option B); TDD RED→GREEN. **D-02 integration seam: harness ⟷ Task Manager без второго координатора.** FI-01 `src/harness/flow/managed-flow-port.ts` — `ManagedFlowPort.completeFromGate` мапит harness `CompletionGateResult`+evidenceRefs+runLink в РОВНО один `FlowService.taskDone(...)` (pass→completed, fail→failed, blocked→blocked); импортирует только types (`../../flow/types`)+`../completion/gate`, НЕ `src/flow/store`; harness НИКОГДА не пишет flow.json. src/flow — минимальное ADDITIVE расширение `taskDone` optional `evidenceRefs?`/`runLink?` (guard `!== undefined`; W2 behavior + все 34 prior flow-теста зелёные, backward-compatible). FI-02 `src/harness/flow/parity.ts` (`completionParity`/`isFailureDisposition`) — ОДИН координатор владеет retries/review-fix/completion: harness gate ⟺ TM task completion (parity), **failing gate НИКОГДА не даёт completed task (failure-disposition safety, 3 слоя)**, no-duplicate-coordinator (spy: ровно один taskDone, fetch недостижим), TM-migration детерминирована до интеграции. **T8 review — clean, 0 concerns:** D-02 доказан, additive-only, безопасность failure-disposition подтверждена non-vacuous real-FlowService+spy тестами. AC1–AC5 ✅. `tsc` clean, `bun test` **924/0** (899+25); deps `{}`; NO real fs (TM own store, harness не пишет flow.json); reuse-only (W5/W6/W7/W8/contracts unmodified). Frozen/src/eval/src/contracts/ADR не тронуты. Health WARN 78 (score 91). Модели: FI-01/T8/review — Opus, FI-02 тесты — Sonnet. |
| 12 | W12 Child agents | CA-01…CA-02 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | flow 015 (commit `550f372`, option B); TDD RED→GREEN. **Делегирование дочерним агентам — SECURITY-critical fail-closed inheritance.** CA-01 `src/harness/child/contract.ts` — адаптер над каноническими `subagent-dispatch`/`subagent-result` (`.metaproject/core/gdskills/contracts/`) + frozen `harness-child-contract-extension` метаданные (parent/session/attempt/branch/context/policy fingerprints, budgetReservation, durableResultArtifact); STATUS-first проза → канонический `subagent-result` ДО persistence; round-trip identity + transport parity (CLI ⟺ JSONL-RPC); extension валидируется frozen-схемой (reuse src/contracts). CA-02 `src/harness/child/{isolation,spawn}.ts` — изолированный child-контекст/сессия (append-only в родительскую сессию, child не мутирует parent state/evidence); **budget ⊆ parent fail-closed**; **policy fail-closed на ТРЁХ слоях** — trustMode не шире, per-capability defaults contained БЕЗУСЛОВНО (deny<ask<allow), isolation не понижается — child не может получить authority, запрещённую родителем (SC_R08_ROLE_CANNOT_ESCALATE/ADR-0004); out-of-enum profile → fail-closed. NEEDS_CONTEXT/blocked/failed → parent как `EvidenceRecord`; **parent владеет completion через W11 ManagedFlowPort — child НИКОГДА не пишет flow.json (D-02)**; prior attempts immutable (reuse W8); детерминизм (injected id/clock). **Review (contract+security/logic) нашёл и починил fail-OPEN в policy-inheritance** (per-capability check был gated на равный trust-rank → escalation; тест 3.3 давал untrusted-parent→trusted-local-child с бОльшими правами) — исправлено на unconditional containment + hardening на out-of-enum; adversarial re-review: bypass не найден. AC1–AC5 ✅. `tsc` clean, `bun test` **991/0** (924+67); deps `{}`; NO real fs; reuse-only (W5–W11 + src/contracts + канонические схемы unmodified). Frozen/src/eval/ADR не тронуты. Health WARN (score 91). **Release-tag boundary:** @release-2 child acceptance-сценарии (SC_R08_CHILD_DISPATCH/NEEDS_CONTEXT) НЕ гейтятся здесь — валидируются на границе Release 2. Модели: CA-01/CA-02 impl + review — Opus, тесты — Sonnet. |
| 13 | W13 Parallel scheduling | PA-01 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | flow 016 (commit `8ec1016`, option B); TDD RED→GREEN. **Bounded ready-set wave scheduler над child-графом (highload).** PA-01 `src/harness/parallel/scheduler.ts` — PURE детерминированный `planWaves(tasks, {maxConcurrency, parentRemaining})`: (1) **bounded waves** — dependency-satisfied ready-set, cap = maxConcurrency, стабильный порядок (by taskId), deps резолвятся строго в более ранней волне; (2) **aggregate reservations** — fold reused W12 `inheritBudget` по бегущему `remaining`, декрементящемуся ЧЕРЕЗ волны, Σ грантов ≤ parent remaining (fail-closed на breach; инвариант Σ+remaining=parent, remaining≥0 — доказан review); (3) **cancellation** — cancelled task + транзитивные dependents (fixpoint closure) исключены; (4) **loop detection** — tasks остались, ready-set пуст → cycle → deny, без partial waves; (5) **fail-closed на degenerate maxConcurrency** (<1/нецелое → deny вместо бесконечного цикла — найдено в highload review, DoS-liveness). Детерминизм (no Date.now/Math.random, stable sort, no real async); scheduler — pure function, НЕ пишет flow.json, parent владеет completion через W11 ManagedFlowPort (D-02). **Review (highload+security): budget-ceiling over-grant path НЕ найден, cycle detection sound обе стороны; 1 CONCERN (maxConcurrency≤0 infinite loop) — исправлено guard'ом + 3 теста.** AC1–AC5 ✅. `tsc` clean, `bun test` **1008/0** (991+17); deps `{}`; NO real fs/async; reuse-only (W5–W12 + inheritBudget composed not rewritten). Frozen/канонические схемы/src/eval/src/contracts/ADR не тронуты. **Release-tag boundary:** @release-2 `SC_R08_BOUND_PARALLEL_WAVE` (future concurrent coordinator) НЕ гейтится здесь. Модели: PA-01 impl + review — Opus (highload), тесты — Sonnet. |
| 15 | W15 Security hardening | H-01…H-02 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | flow 017 (commit `de46260`, option B); TDD RED→GREEN. **Cross-cutting hardening + закрытие отложенных @release-0 концернов (security).** H-01 (additive, fail-closed): (1) **SSRF/private-egress** `guard.ts` — декодирует encoded IPv4 (flat decimal/hex/octal, dotted mixed-radix + short forms, IPv4-mapped IPv6) и проверяет ВСЕ приватные диапазоны (loopback, 10/8, 172.16-31, 192.168/16, link-local+metadata 169.254/16, CGNAT 100.64/10, 0.0.0.0) → encoded cloud-metadata `169.254.169.254` и приватные формы denied до decide(); (2) **NaN-date fail-closed** `approval.ts` — unparseable/NaN expiresAt/now → invalid (не fail-open); (3) **SC_R18_UNREGISTERED_EXTENSION_DENIED** — новый `src/harness/extension/registry.ts` fail-closed registerExtension (нет pinned manifest+capability grant → deny, без discovery-time authority); (4) **SC_R16_BUDGET_RESERVATION** — новый `src/harness/budget/reconcile.ts` planned/reserved/consumed/remaining/reliability reconcile, fail-closed на over-consume; (5) recovery/replay/migration/perf hardening-suites (test-only regression-lock): W8 crash/torn-write + outcome-unknown блокирует unsafe retry + immutable attempts, W7 replay effect-free, schemaVersion migration детерминирована+fail-closed, детерминированные SLO-bounds; red-team lock W10/W12/W13 fail-closed инвариантов. H-02 — новый `docs/decisions/keryx-harness/H-02-deferred-extension-capability-contract.md` (deferred extension grants+isolation БЕЗ включения; @release-2 сценарии как later scope; frozen ADR не тронуты). **Review (security): no HIGH-severity fail-open; единственная находка (encoded non-loopback SSRF residual — metadata IP в decimal/hex) исправлена в волне** (generalized decoder + 17 тестов). AC1–AC5 ✅. `tsc` clean, `bun test` **1114/0** (1008+106); deps `{}`; NO real fs/network/SDK; только guard.ts+approval.ts изменены (additive), новый код под src/harness/{extension,budget}/. Frozen/канонические схемы/src/eval/src/contracts/ADR-0001..0004 не тронуты. **Deferred (не гейтились):** RP-01/real-provider negative-семейства H-01 → re-run после W14; @release-2 extension-сценарии → задокументированы в H-02. Модели: H-01 impl+review — Opus (security), тесты — Sonnet, H-02 docs — Sonnet. |

### Release 2 — Стейт (отдельный трек, план в E-03-release1-handoff §4 AC-R2-1…R2-5)

| Волна | Что | Сценарии | Статус | Ветка/PR | Дата | Заметки |
|---|---|---|---|---|---|---|
| **R2-1** | **extension-execution** (registered extension → bounded policy-governed authority) | SC_R08_CHILD_DISPATCH_CANONICAL_RESULT, NEEDS_CONTEXT_ADAPTER, EXTENSION_ESCALATION (CA-01) | ✅ | `feature/keryx-release2-extension-exec` | 2026-07-13 | flow 023 (option B, PR в main). Новый `src/harness/extension/execute.ts` (композиция W12 contract/isolation + W15 registry + W10 approval + W8 immutable + src/contracts). **`dispatchExtension`** — зарегистрированный extension + coordinator reserved budget → canonical `subagent-dispatch` (валидируется схемой, `allowed_actions` = grant, bounded) + STATUS-first → canonical `subagent-result` ДО persist (reuse `parseChildResult`). **`evaluateExtensionGrant`** *(KEY security negative)* — requested ⊆ granted → ok; broader tools/provider = escalation, требует **все три**: `policyDecision:allow` ∧ provenance ∧ valid W10 approval; без любого → **deny, no silent authority gain**; out-of-enum capability → fail-closed. **`retryWithContext`** — NEEDS_CONTEXT → тот же dispatch id, add-only названный artifact, prior attempt immutable (reuse W8). **Review (security/contract): CLEAN, no HIGH** — adversarial escalation-анализ: bypass не найден (3 последовательных AND-гейта; denied result без capabilities; real W10 `checkApproval`). AC1–AC5 ✅. `tsc` clean, `bun test` **1233/0** (1210+23); deps `{}`; additive-only (единственная правка prior — `isKnownCapability` export в isolation.ts); D-02 (extension не пишет flow.json); frozen/канонические схемы/src/eval/src/contracts/ADR не тронуты; без соавторства. Модели: impl+review — Opus, тесты — Sonnet. |
| **R2-2** | **registered-extension provenance** | SC_R18_REGISTERED_EXTENSION_PROVENANCE, EXTENSION_ESCALATION (H-02) | ✅ | `feature/keryx-release2-ext-provenance` | 2026-07-13 | flow 024 (option B, PR в main; от main с R2-1+R2-4). Новый `src/harness/extension/provenance.ts` (композиция W15 registry + R2-1 `evaluateExtensionGrant` + W12 `childProvenance` + W7 `Provenance` + W10 approval — **0 правок prior-модулей**, чистый reuse через import). **`registerExtensionWithProvenance`** — `registerExtension` ok → `ExtensionProvenanceRecord`: pinned `manifestHash` + `grantId` + `capabilities` (**свежая копия гранта, authority НЕ шире** — alias-immune) + `Provenance` (derived trust, `provenanceId` из idSeq, taint-линки); deny регистрации → propagate, без record. **`evaluateRegisteredExtensionCapability`** *(negative, registry-side)* — capability в гранте → ok; вне гранта → **deny/ask** (verbatim делегирование R2-1 `evaluateExtensionGrant`: policy+provenance+valid-approval); out-of-enum fail-closed; no silent gain. **Review (security/contract): CLEAN, no findings** — authority-not-widened доказан (mutation грант-массива не течёт в record), escalation adversarial: bypass не найден. AC1–AC5 ✅. `tsc` clean, `bun test` **1276/0** (1254+22); deps `{}`; D-02 (не пишет flow.json); frozen/канонические схемы/src/eval/src/contracts/ADR не тронуты; без соавторства. Модели: impl+review — Opus, тесты — Sonnet. |
| **R2-3** | **bound-parallel-wave над registered extensions** | SC_R08_BOUND_PARALLEL_WAVE | ✅ | `feature/keryx-release2-bound-wave` | 2026-07-13 | flow 025 (option B, PR в main). Новый `src/harness/extension/bound-wave.ts` — **`planExtensionWave`** (композиция W13 `planWaves` + R2-1 `dispatchExtension` + W12 `inheritBudget` + W15 registry + W7 evidence/W12 `childResultToEvidence` + W8 immutable). Принимает набор REGISTERED-extension wave-тасков (`{taskId; dependsOn; registration; capabilityGrant; budgetRequest; + dispatch-контекст}`) + `PlanWavesConfig {maxConcurrency; parentRemaining}`: (1) **registered-only fail-closed ПЕРВЫМ** — любой `registration.ok===false` → deny всего плана (нет частичного binding незарегистрированного extension); (2) маппит в `ChildTask[]` и делегирует всё расписание REUSED `planWaves` — **concurrency ceiling** (3 ready + max 2 → нет волны >2) и **aggregate budget** (Σ ≤ parentRemaining, fail-closed; cycle/degenerate → deny) пропагируются verbatim; (3) на каждый scheduled task — canonical dispatch через REUSED `dispatchExtension` (bounded к grant, его собственный fail-closed — вторая линия); (4) **per-attempt evidence isolation** — у каждого attempt свой distinct `EvidenceRecord` (свежий `childResultToEvidence`, не aliased, immutable). Чистая детерминированная функция (injected id/clock; без Date.now/Math.random/real-async; возвращает план, без side-effects). **Review (highload/security): PASS, все 9 adversarial-чеков** — концм. ceiling не обходится, budget не re-grant-ится, unregistered не bind-ится (partial-leak нет), evidence не aliased, guard на divergent taskId fail-closed. AC1–AC5 ✅. `tsc` clean, `bun test` **1265/0** (1254+11); deps `{}`; **reuse-only** (planWaves/execute.ts/isolation.ts/spawn.ts/evidence — 0 правок, `git diff` пустой); D-02 (не пишет flow.json); frozen/канонические схемы/src/eval/src/contracts/ADR не тронуты; без соавторства. Модели: impl+review — Opus, тесты — Sonnet. |
| **R2-4** | **Interactive CLI / TUI adapter** | **SC_R13_TUI_DEFERRED** | ✅ | `feature/keryx-release2-tui` | 2026-07-13 | flow 022 (option B, PR в main). **Provider/model selection как в opencode, без хардкод-дефолта.** `src/commands/select.ts`: `detectProviders` (ollama `/api/tags` через injected fetch → chat-модели, embed исключён, unreachable→**fail-soft** «not available»; anthropic — только если `ANTHROPIC_API_KEY` в env, статический список, **0 сетевых вызовов**; fake всегда) + `pickProviderModel` (нумерованный readline-пикер, re-prompt на invalid, EOF→fallback). Голый `keryx` → детект+пикер; `keryx --provider X [--model Y]` / `keryx shell …` → пропуск пикера (`--flag` первым аргументом роутится в shell). Additive `shell.ts`: слэш `/models` (переключить модель), `/provider` (пере-выбор), `/connect` (подсказка про `ANTHROPIC_API_KEY` — **ключ НЕ хранить/не вводить**); убран хардкод ollama/llama3.1; полиш (пустая строка между тёрнами, провайдер/модель в баннере). **Reuse-only:** flow-021 `runShell` core + W14/W20 провайдеры + W15/W20 egress-guard **не изменены**; egress остаётся loopback-gated (chat fail-closed), детект fail-soft. **Review (security/UX/contract): CLEAN, no HIGH** — нет хардкод-дефолта, credential никогда не пишется в вывод/на диск/в returned shape, no runtime-contract change (адаптер над существующими портами — SC_R13_TUI intent). **Live smoke:** голый `keryx` → «Select a provider: 1.ollama 2.fake» → «Select a model: 1.llama3.1:latest» → чат «Capital of France?» → «Paris.» (реальный Ollama). AC1–AC5 ✅. `tsc` clean, `bun test` **1231/0** (1210+21); **deps `{}`** (node:readline stdlib, БЕЗ TUI-фреймворка — решение пользователя: вариант A). D-02; frozen не тронут; коммит без соавторства. Модели: impl+review — Opus, тесты — Sonnet. **Полноэкранный TUI (Ink и т.п.) — отдельное будущее решение про зависимость.** |
| R2-5 | real-subprocess executor (закрывает F-1 / SC_R04 live) | SC_R04 live enforcement | ⬜ | — | — | независима |

### Release 2+ и сквозное

| Фаза | Волна | Таски | Осн. модель | Статус | Ветка/PR | Дата | Заметки |
|---|---|---|---|---|---|---|---|
| 14 | W14 Real providers | RP-01 | Opus | ✅ | `feature/keryx-harness-impl` | 2026-07-13 | flow 018 (commit `109c63c`, option B); TDD RED→GREEN. **Первый реальный провайдер (Anthropic Messages API) за W5 ProviderPort — тонкий fetch/SSE, БЕЗ SDK → `deps` ОСТАЁТСЯ `{}`.** Решения (утв.): (1) Anthropic Messages API; (2) тонкий HTTP/fetch без SDK; (3) записанные SSE-transcripts (как W6). RP-01 `src/harness/provider/anthropic/`: `anthropic-provider.ts` (`AnthropicProvider implements ProviderPort` — `describe()` + `descriptorDocument()` валидируется `provider-descriptor.schema.json` с `remoteState.storage/retention/continuation=false` → **storage off by default**; `stream()` мапит `NormalizedRequest`→wire + нормализует SSE→точную `NormalizedEvent`-последовательность; `opts.signal` отменяет) + pure `sse.ts` (incremental parser). **Capability gate:** живой fetch ТОЛЬКО за явным grant (network+apiKey); нет grant → fail-closed, без сети. **Guarded egress:** base-URL host через reused W15 predicate (добавлен минимальный additive `isPrivateEgressHost` export в guard.ts — без изменения поведения); private/loopback/metadata (вкл. encoded/IPv4-mapped) → fail-closed. **Provider negatives → 9-kind taxonomy:** 401 authentication, 400 invalid_request, 429 rate_limit(+retryAfterMs), 529 overloaded, 5xx unavailable, malformed/torn SSE, AbortSignal cancelled — fail-closed, без spurious model_end. **Credential:** apiKey никогда не persist/log; redacted (exact-match scrub) из каждого error message — **доказано тестом, echoing key в error body**. **Весь тест-сьют OFFLINE/детерминирован** (записанные transcripts + injected/mocked fetch; живой вызов за capability-флагом, НИКОГДА в CI; FakeProvider — дефолт). Нет утечки SDK-типа через ProviderPort. **Review (provider/contract/security): no HIGH; 2 LOW (redaction-механизм wording + недоказанный redaction-путь) закрыты в волне** (AC2 amended + echo-тест). AC1–AC5 ✅ (AC1/AC2 amended: bare NormalizedEvent — не durable harness-event envelope, W6 precedent; descriptorDocument bridge). `tsc` clean, `bun test` **1150/0** (1114+36); **deps `{}`** (без SDK); единственная правка prior-модуля — additive guard.ts export. Frozen/канонические схемы/src/eval/src/contracts/ADR не тронуты. D-02 (adapter не пишет flow.json). **🎯 Последняя impl-волна трека.** Модели: RP-01 impl + review — Opus (provider/contract/security), тесты — Sonnet. **Далее:** re-run W16 (Release 1 evidence) + re-run H-01 provider negative-семейств на границе Release 1. |
| 16 | W16 Docs/evidence | E-01…E-03 | Sonnet | ✅ (R0 + R1) | `feature/keryx-harness-impl` | 2026-07-13 | **Запускается на каждой границе релиза.** **① Release 0** (flow 010): E-01 [evidence-matrix](../decisions/keryx-harness/E-01-release0-evidence-matrix.md) (18 rows) + E-02 [7-lens review](../decisions/keryx-harness/E-02-release0-review-package.md) **GO** + E-03 [handoff](../decisions/keryx-harness/flow-orchestrator-handoff.md); AC1–AC4 ✅, `bun test` 797/0. Deferred→W8/W15. **② Release 1 boundary** (flow 019, commit `fe875ff`, option B): docs+тесты. **(B) H-01 provider negatives** (отложены из W15, зависели от W14) — consolidated OFFLINE red-team над Anthropic-адаптером (`anthropic-negatives.hardening.test.ts`): timeout/stalled-body, rate-limit variants, truncation mid-tool-call, malformed, empty body, encoded-SSRF egress-deny, cancel, auth — все fail-closed. **Сьют нашёл 2 РЕАЛЬНЫХ гепа в W14-адаптере → исправлены в волне (minimal additive, user-approved):** stalled body + deadline abort бросал uncaught AbortError → теперь guarded read → terminal `provider_error{cancelled}`; zero-byte 200 body молча давал 0 событий → теперь `provider_error{malformed}`. **(A) Release 1 evidence:** E-01 [release1-evidence-matrix](../decisions/keryx-harness/E-01-release1-evidence-matrix.md) (capability→source/test/commit для W8–W15+W14; SC_R04 live-process-group F-1 задокументирован как deferred→R2) + E-02 [release1-review-package](../decisions/keryx-harness/E-02-release1-review-package.md) 7-lens **GO (0 BLOCKER/P0/P1; 1 P2 disclosed)** + E-03 [release1-handoff](../decisions/keryx-harness/E-03-release1-handoff.md) (DAG/frozen-AC-proposal/gates/constraints/out-of-scope → Release 2). AC1–AC5 ✅; final verify CLEAN. `bun test` **1160/0**, `tsc` clean, deps `{}`; единственная runtime-правка — additive fail-closed adapter fix; frozen/схемы/eval/contracts/ADR/R0-доки не тронуты. **🎯 Release 1 complete + evidenced + handed off.** **Deferred→Release 2 (@release-2):** SC_R08_CHILD_DISPATCH/NEEDS_CONTEXT/BOUND_PARALLEL_WAVE, SC_R18_REGISTERED_EXTENSION_PROVENANCE, SC_R08/R18_EXTENSION_ESCALATION, SC_R13_TUI, SC_R04 live-subprocess (F-1). Модели: E-01/E-03/H-01-тесты Sonnet, E-02/verify/fix Opus. |

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
