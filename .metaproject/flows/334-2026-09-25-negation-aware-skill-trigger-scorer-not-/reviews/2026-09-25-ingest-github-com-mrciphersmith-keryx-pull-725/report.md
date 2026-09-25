# Flow 334 — PR #725 review summary (rounds 1 and 2)

Two adversarial opus review rounds were run against this PR's diff (full
detail in the flow journal: `.metaproject/flows/334-2026-09-25-negation-aware-skill-trigger-scorer-not-/journal.md`).

- **Round 1** (against the initial diff): 1 blocker, 3 major, 6 minor, 3
  info. All fixed: `USE_INSTEAD_PHRASE` regex correctness/quadratic-
  complexity blocker; circular regression test; self-referential AC2 test;
  apples-to-oranges FP measurement (3 majors); e.g./i.e. handling, "Does
  not X", "(see X)", "(not only X but also Y)" protection, sentence-
  boundary join guard, dead-code removal, docs corrections (6 minors).
- **Round 2** (narrow re-verification of the round-1 fixes): 0 blocker, 0
  major, 3 minor, 3 info. Blocker and majors confirmed fixed against
  deliberately-broken variants. All 3 minors fixed (tighter
  `USE_INSTEAD_PHRASE`, an adversarial timing test, `bundle/external.ts`'s
  own unguarded join); all 3 info items corrected in the journal.
- After PR #719 merged into `main`, the branch was merged and everything
  the bigger catalog could shift was re-measured (ratchet ceiling, stable-
  pack gate, batch-2 pack numbers, a known misroute). Three CI-only issues
  surfaced by the merge (a bundled/`.metaproject` mirror sync gap, a scout-
  threshold-fragile test fixture, and a test timeout) were found and fixed
  directly against CI logs, not guessed at.

At merge time (head `544697fa0abf5b0fd438bfae52b5432d91f1b946`, later
merged as `b722dc52`): 0 blocker, 0 major, nothing outstanding. All CI
checks green. No findings remain to record for this round.

```json keryx:findings
[]
```
