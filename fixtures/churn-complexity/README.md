# Fixture: churn-complexity (Block D · D1)

Deterministic, git-committed acceptance corpus for the git-churn × complexity
**hotspot** signal (`src/health/metrics/hotspot.ts`). Named as the Block-D D1
acceptance gate (AC2, AC3, AC5, AC6, AC17).

## Layout

- `src/*.ts` — four source files with **known** per-function cyclomatic
  complexity (Σ = file complexity):
  - `hot.ts` — complexity 6 (5 branches), **high** churn ⇒ top hotspot.
  - `churny-simple.ts` — complexity 1, **high** churn ⇒ ranks 2nd.
  - `complex-stable.ts` — complexity 6, **low** churn ⇒ ranks 3rd (the
    CodeScene edge: complex but stable is not a hotspot).
  - `cold.ts` — complexity 1, **low** churn ⇒ lowest.
- `churn.json` — the seeded churn map (added+deleted lines per file over the
  window), the deterministic stand-in for a git history so the ranking is
  reproducible byte-for-byte without a nested repo.
- `expected.json` — the expected per-file `{churn, complexity, score}` and the
  full ranking (score desc, path asc).

`score = churn × complexity`. Measured against this labeled data, not asserted
in prose (`F-4`).
