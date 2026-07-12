# Keryx Context Operations — Implementation Plan
Version: 1.0.0

## High-level plan

Реализация делится на пять зависимых волн. Каждая волна должна завершаться
тестами и evidence, а не только кодом.

## Detailed plan

### Wave 0 — product and contract foundation

- [ ] Зафиксировать package и schemas как design baseline.
- [ ] Добавить `context` capability descriptor, default-off config и init/update
  wiring без изменения disabled floor.
- [ ] Добавить fixture corpus `fixtures/context-operations/cases.json`: project
  queries, expected mandatory items, allowed source kinds, poison/stale и
  byte/token/item-overflow cases.
- [ ] Восстановить dev-checkout invocation (`bun ./src/cli.ts` или эквивалент)
  в agent guidance; не требовать global `keryx` без fallback.

### Wave 1 — deterministic assembly vertical slice

- [ ] Создать `src/context/{types,config,planner,service}.ts` без optional deps.
- [ ] Реализовать candidates из memory/wiki/skills/rules/flow/quality.
- [ ] Реализовать budget, mandatory-policy reservation, `context_overflow` и
  score explanation.
- [ ] Сохранить redacted manifest/trace под `data/context/`.
- [ ] Добавить CLI `context assemble` и `context explain`.
- [ ] Написать unit, schema, no-network, disabled-floor, replay и overflow
  preservation tests.

### Wave 2 — governance and feedback

- [ ] Реализовать append-only feedback ledger за `security.guardOutput`.
- [ ] Добавить explicit review/promotion workflow в memory, без auto-accept.
- [ ] Добавить freshness/staleness detector на основании source hash/version.
- [ ] Добавить retention/pruning command только для generated data/context.

### Wave 3 — MCP parity and evaluations

- [ ] Добавить read-only MCP tools после стабилизации service facade.
- [ ] Создать normalized CLI/MCP parity fixtures.
- [ ] Реализовать `context eval`, top-k/provenance/policy metrics и baseline
  comparison без маркетинговых claims.
- [ ] Подключить corpus gate к CI.

### Wave 4 — optional intelligence and adapters

- [ ] Через Capability Seam добавить local semantic rerank над candidate pool.
- [ ] Добавить graph-proximity rerank, если gdgraph artifacts валидны.
- [ ] Реализовать schema-defined adapter SPI; начать с read-only external
  adapter fixture, а не production network integration.
- [ ] Рассмотреть Graphiti/Cognee/OpenViking только после Wave 3 evals.

## Dependencies and release gates

| Release | Prerequisite | Exit gate |
|---|---|---|
| R0 | Waves 0–1 | deterministic assembly, schemas, offline tests, no network |
| R1 | Wave 2 | guarded feedback, review promotion, retention evidence |
| R2 | Wave 3 | CLI/MCP parity and CI corpus gate |
| R3 | Wave 4 | capability isolation and adapter provenance tests |

## Explicitly deferred

- Multi-tenant authorization/RBAC and hosted shared memory.
- Autonomous background LLM consolidation.
- Write-through external memory adapters.
- Replacing the Agent Harness session/evidence contracts.
