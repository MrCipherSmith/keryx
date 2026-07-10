# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Execution order (TDD): T1 → T3 → T2 → T5 → T6 → T7 → T8 → T4 → T9.

| ID | Kind | Title | Covers AC |
|----|------|-------|-----------|
| T1 | context | Collect remaining context (done inline in context.md) | — |
| T3 | test | FAILING build-level + unit tests: Maven Java fixture, Python fixture, TS/JS byte-identical regression, metric n/a + unresolved-edge | AC1,AC2,AC4,AC5,AC7 |
| T2 | implement | Resolver abstraction + Java Maven resolver + metric fix (first increment) | AC1,AC5,AC8 |
| T5 | implement | Gradle source-root resolver (Groovy + Kotlin DSL) | AC1,AC7 |
| T6 | implement | Python resolver + relative-import extraction fix (`__init__.py`, `from . import`) | AC2 |
| T7 | implement | Seed tree-sitter-java/python grammars in src/assets/seed.ts | AC6 |
| T8 | implement | Dead-code decision: wire or remove detectSupportedLanguages/renderGdgraphConfig | AC10 |
| T4 | review | code-verifier + review-orchestrator + E2E on example-backend | AC3,AC4,AC9,AC10 |
| T9 | docs | Update requirements package status, roadmap line, version bumps | — |
