# Keryx Context Operations — Implementation Plan
Version: 1.1.0

## High-level plan

Delivery is split into five dependent waves. Every wave must end with tests and
evidence, not only with code.

## Detailed plan

### Wave 0 — product and contract foundation

- [ ] Freeze the package and its schemas as the design baseline.
- [ ] Add the `context` capability descriptor, a default-off config, and
  init/update wiring, without changing the disabled floor.
- [ ] Add the fixture corpus `fixtures/context-operations/cases.json`: project
  queries, expected mandatory items, permitted source kinds, poisoned and stale
  cases, and byte/token/item overflow cases.
- [ ] Restore the dev-checkout invocation (`bun ./src/cli.ts` or equivalent) in
  the agent guidance; never require a global `keryx` without a fallback.

### Wave 1 — deterministic assembly vertical slice

- [ ] Create `src/context/{types,config,planner,service}.ts` with no optional
  dependencies.
- [ ] Produce candidates from memory, wiki, skills, rules, flow and quality.
- [ ] Implement the budget, the mandatory-policy reservation, `context_overflow`,
  and the score explanation.
- [ ] Persist the redacted manifest and trace under `data/context/`.
- [ ] Add the `context assemble` and `context explain` CLI commands.
- [ ] Write unit, schema, no-network, disabled-floor, replay, and
  overflow-preservation tests.

### Wave 2 — governance and feedback

- [ ] Implement the append-only feedback ledger behind `security.guardOutput`.
- [ ] Add an explicit review/promotion workflow into memory, with no auto-accept.
- [ ] Add a freshness/staleness detector keyed on source hash and version.
- [ ] Add a retention/pruning command for generated `data/context` only.

### Wave 3 — MCP parity and evaluations

- [ ] Add read-only MCP tools once the service facade has stabilised.
- [ ] Create normalized CLI/MCP parity fixtures.
- [ ] Implement `context eval` with top-k, provenance and policy metrics, plus a
  baseline comparison — and **no marketing claims**.
- [ ] Wire the corpus gate into CI.

### Wave 4 — optional intelligence and adapters

- [ ] Add local semantic rerank over the candidate pool, through the Capability
  Seam.
- [ ] Add graph-proximity rerank where the gdgraph artifacts are valid.
- [ ] Implement the schema-defined adapter SPI, starting with a read-only
  external adapter fixture rather than a production network integration.
- [ ] Consider Graphiti, Cognee and OpenViking only after the Wave 3 evals.

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
