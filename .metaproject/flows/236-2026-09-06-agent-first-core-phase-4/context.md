# Контекст этапа 4
Version: 0.1.0

Project: /Users/Goodea/goodea/keryx. Integration branch: codex/agent-first-core; recorded base main@0bc6418fa1a038f8ec909cf949fecba077acf9a4.

Specs: docs/requirements/keryx-agent-first-core/README.md, specification.md, implementation-plan.md, decision-traceability.md and associated contract documents.

Зависимости: этапы 2, 3. Root проверяет delivery evidence каждого prerequisite до dependent implementation: CLI зависит только от задач одного flow, межflow DAG обеспечивается оркестратором явно. Независимый контекст/тест-дизайн можно собрать заранее.

Перед стартом: перечитать index, relevant graph/wiki/memory, current source и testing/health. Historical PASS и старый .worktrees inventory не доказательство текущего состояния. Stats disabled. Workers никогда не меняют flow.json/frozen AC/git; код по непересекающимся ownership.

## Additional observed provenance defect

During authorized parallel reads, service.ts and types.ts ctx read results both reported the same raw/summary identifier `2026-09-06T12-02-33-793Z_read`. Investigation found src/commands/ctx.ts generates IDs solely from millisecond timestamp plus operation kind (line457 at observation) and uses ordinary writes. Two same-kind calls within one millisecond can overwrite each other. Their simultaneous same-ID results must not be cited as independent immutable evidence.

Track collision-resistant artifact IDs and exclusive write behavior in the added task; include deterministic concurrent fixtures under a frozen clock. Existing different-timestamp test/run evidence is not presumed affected, but no general no-collision claim is made for old artifacts. The last graph context was consulted but reported uncommitted files; current targeted source inspection is authoritative. Searches used keryx ctx rg, no bare rg.
