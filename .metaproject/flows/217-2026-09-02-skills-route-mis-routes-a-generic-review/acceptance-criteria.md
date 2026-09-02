# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A trigger whose meaningful tokens reduce to fewer than two no longer fires via the order-free token test; `review-frontend` does not claim a trigger hit on the query `review`, where before the change it did.
- AC2: `keryx skills route "сделай мне полное ревью без исправления"` returns `review-orchestrator` as top-1. Before the change it returned `review-frontend` and did not list the orchestrator in the top ten.
- AC3: `keryx skills route "do a full review without fixing"` still returns `review-orchestrator` as top-1 — the English case that already worked is not regressed.
- AC4: A request naming a specialist still reaches that specialist: `frontend review` / `фронтенд ревью` returns `review-frontend` as top-1, and `review the MobX store` does not return `review-orchestrator` as top-1.
- AC5: `RU_SYNONYM_PREFIXES` covers `полн`, `напиш`, `начн`, `исправ`, `найд`, `объясн`, and `напиши тесты для этого модуля` no longer returns a `review-*` skill as top-1.
- AC6: A routing corpus of at least 30 (query, expected top-1) pairs, at least a third of them Russian, runs as a test over the real `BUNDLED_GDSKILLS` catalog and passes. The test fails if the catalog is empty or the corpus is smaller than declared.
- AC7: `keryx orient` reads a `UserPromptSubmit` JSON payload from stdin and appends a routing block naming the top skill and the runner-up.
- AC8: `keryx orient` output differs between a review request and `what is 2+2`; before the change the two were byte-identical.
- AC9: With absent, empty, non-JSON, or JSON-without-a-prompt stdin, `keryx orient` exits 0 and its output is byte-identical to the pre-change output.
- AC10: When no skill scores above the floor, no routing block is emitted at all — the hook stays silent rather than guessing.
- AC11: `bun run typecheck` is clean and `bun test src/gdskills src/commands src/ctx --timeout 30000` passes with no failures introduced by this branch.
