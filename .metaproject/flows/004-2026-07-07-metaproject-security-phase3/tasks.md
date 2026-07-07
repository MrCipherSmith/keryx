# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `gd-metapro flow task done <id> <taskId>`.

| ID | Kind | Title | Satisfies |
|----|------|-------|-----------|
| T1 | context | Collect context + seams (done in Phase 1) | — |
| T2 | implement | Shared guard `src/security/guard.ts` (guardOutput/redactRaw; disabled=no-op; advisory logs+continues; enforced/ci blocks) | AC1, AC2 |
| T5 | implement | memory ingest + wiki collect seams (check-output target memory/wiki) | AC3, AC4 |
| T6 | implement | testing publish + gdctx raw seams (guard/redact before persist) | AC5, AC6 |
| T7 | implement | flow completion `security` gate (mirror health gate; advisory-pass by default) | AC7 |
| T3 | test | Integration tests: advisory no-op, enforced blocks, disabled no-op; existing suite unchanged | AC8 |
| T8 | docs | security spec/README (Phase 3 shipped), roadmap, docs/docs seam notes | AC9 |
| T4 | review | leak/regression-focused review + code-verifier + draft PR | AC8 |

## Task detail

- **T2:** one helper, uniform semantics; short-circuit when disabled; warning line
  references categories/counts only (no raw content).
- **T5/T6/T7:** minimal guard call at each existing write point; advisory must not
  alter output/flow. gdctx uses `redactRaw` so raw secrets never persist. The flow
  `security` gate mirrors the health gate (advisory → pass with info).
- **T3:** the advisory-no-op regression is the primary assertion; the full existing
  118-test suite must still pass unchanged.
