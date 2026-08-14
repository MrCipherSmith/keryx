# Keryx Improvements 1 — план реализации

**Статус:** proposed

**Дата:** 2026-08-14

**Источник:** `../../report/ru/report.md`

## Принцип разбиения

Каждый пакет ниже должен стать отдельным requirements/Flow. Пакеты не следует объединять в один большой SAC v2: correctness, security, lifecycle, memory и multi-agent coordination имеют разные owners, риски и критерии отката.

## Gate 0 — зафиксировать baseline

- Сохранить current behavior corpus для CLI/MCP/shell и proposal lifecycle.
- Добавить failing characterization tests: candidate output unchanged, 33/32 overflow, positional ID drift, changed unpinned evidence, note mutation, accepted target absent from overview, mixed activity ledger, self-review, sibling worktree.
- Привязать текущие test claims к commit/date.
- Не включать learned candidate вне synthetic fixtures.

Exit: каждый обнаруженный дефект либо воспроизводится тестом, либо документирован как product decision.

## Flow 1 — RP-12 Truth Sync

**Размер:** S. **Owners:** Docs, gdgraph, gdwiki, Commands.

- Исправить public guide и phase status language.
- Добавить `src/sac` в graph/wiki и integration edges.
- Добавить executable docs smoke tests.
- Сформировать capability matrix: disabled/local CLI/stdio MCP/shell/HTTP.

Exit: guide commands исполняются; graph impact показывает реальные зависимости.

## Flow 2 — RP-01 Runtime Truth

**Размер:** M. **Owners:** SAC, Context Operations.

- Ввести deterministic retrieval plan с independent baseline.
- Применять selected IDs к assembly.
- Разделить mandatory core и ranked optional items.
- Ввести stable IDs, honest measured/unknown costs, real progressive detail.
- Исправить freshness state для unpinned/changed sources.

Exit: output-changing e2e corpus, budget/property tests, replay-safe IDs.

## Flow 3 — RP-04 Promotion Integrity

**Размер:** M. **Owners:** SAC + Wiki/Memory/Skills/Flow.

- Exhaustive kind/target matrix без fallback-to-skill.
- Owner-rendered preview и digest всех render inputs.
- Удалить mutable unbound note sidecar.
- Явная self-review policy.
- Atomic/idempotent link-back target ref в workspace.
- Scope idempotency key по owner/workspace/proposal/revision и bind recovered receipt к exact intent.
- Сделать recovery независимым от нового process correlation ID; fault injection на каждом crash boundary.
- Валидировать proposal/workspace IDs до path construction и повторно проверять record ownership.
- Proposal inbox/list/show.

Exit: reviewer видит точный preview; mutation/replay/unsupported mapping fail closed; accepted artifact виден в следующем overview.

## Flow 4 — RP-05 Secure Evidence

**Размер:** M–L. **Owners:** Session, Security, SAC.

- Explicit sealed/completed session и structured wrap-up artifact вместо default full transcript.
- Pre-persistence scan/minimization.
- TTL/delete/restricted storage policy.
- Sensitivity/trust propagation.

Exit: zero raw secret/PII persistence corpus; expiry/deletion/recovery tests.

## Flow 5 — RP-06 Live Identity and Guard

**Размер:** M для local, L для remote. **Owners:** Security, MCP, Harness.

- Заменить hard-coded pass на injected live strict provider.
- Зафиксировать local-single-user semantics.
- Добавить delegated agent execution identity и action-bound capabilities.
- Оставить HTTP disabled до полного remote threat-model suite.

Exit: revoke/cross-workspace/replay/confused-deputy tests.

## Flow 6 — RP-02 Source-owned Projections

**Размер:** M–L. **Owners:** Flow, Wiki, Memory, Skills.

- Canonical read-only projection ports.
- Full Flow dispositions/evidence/AC mapping.
- Owner-derived knowledge trust/applicability.
- Canonical Wiki body/decision writer.

Exit: owner format change не ломает SAC; projection fidelity corpus 100%.

## Flow 7 — RP-03 Lifecycle Binding

**Размер:** M. **Owners:** Harness/session, Flow, SAC CLI.

- Persist optional session workspace/flow binding.
- `shell --workspace`, `--session current`, current/list agent tools.
- Workspace derive/create preview from Flow/worktree.
- Completion reminder/proposal без auto-promotion.

Exit: bound session требует zero manual workspace IDs и сохраняет least disclosure.

## Flow 8 — RP-09 Unified Surface

**Размер:** M. **Owners:** Commands, MCP, Harness.

- Единый operation registry.
- Генерация schemas/help/docs/adapters.
- Единые errors, enablement и diagnostics.
- `workspace doctor`, proposal queue, handoff surface.

Exit: semantic parity snapshots и documentation smoke suite.

## Flow 9 — RP-10 Receipt Operability

**Размер:** M. **Owners:** Context Operations, SAC.

- Context capsules/replay/drift.
- Retention, prune, verify, repair, quota.
- Benchmark sync lock; выбрать batching/sampling/durability policy.

Exit: 10k-read benchmark и recovery corpus проходят заданные SLO.

## Flow 10 — RP-07 Memory Lifecycle

**Размер:** L. **Owners:** Memory, Wiki, SAC.

- Ephemeral/working/durable generations.
- Temporal updates, contradictions, tombstones, forgetting.
- Applicability/evidence diversity.
- LongMemEval-style corpus.

Exit: retrieval/update/contradiction/forgetting/abstention metrics проходят фиксированные gates.

## Flow 11 — RP-08 Collaboration and Worktrees

**Размер:** L. **Owners:** Harness, Flow, Git/worktree, SAC.

- Исправить shared activity ledger contract.
- Public handoff writer.
- Reservation TTL и causal event spine.
- Clone-level base workspace + private worktree overlays либо portable bundles.

Exit: multi-worktree handoff и parallel-agent conflict corpus без raw transcript sharing.

## Flow 12 — RP-11 Evaluation and Policy Decision

**Размер:** M–L. **Owners:** Harness/evals, SAC.

- SAC-off/deterministic/candidate baselines.
- Causal ablations и topology selection.
- Shadow policy tournament на real independently verified corpus.
- Формальное решение: оставить learned policy, сузить или удалить.

Exit: candidate имеет статистически и практически значимый output/task benefit без security regression; иначе runtime activation удаляется.

## Stop conditions

- Secret/PII попал в persisted evidence.
- Candidate metadata утверждает policy use без изменения output.
- Accepted knowledge не имеет owner receipt и review-bound digest.
- Remote transport получает workspace discovery без verified scoped principal.
- Новый coordination store дублирует Flow state.

## Рекомендуемый первый milestone

Flows 1–5. Они превращают текущую реализацию из «сильные контракты, неоднозначное поведение» в честный local-single-user core. Lifecycle, memory и multi-agent expansion следует начинать только после измерения этого milestone на реальных задачах.
