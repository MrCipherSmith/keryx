STATUS: DONE

Verdicts (claims block as returned; reasoning abbreviated by the evaluator, citations verbatim):

- F-007 upheld — commit 887ffb1ac intent ("only review-auto answers from the memory and grants", agent.ts:5570) is contradicted by the unguarded delegate (5821) and write (5868) reads; the shell read (5686) has the guard, so the fix is consistent.
- F-008 upheld — nothing marks answering a policy-tagged question outside an AutomaticReviewRun as intended (agent.ts:2497-2503 excludes only automatic-review turns); reachable; skips arbiter and journal.
- F-009 downgraded major -> minor — intent_signals: d9ccfb6ce (commit message: refusals leaked between tests; runner-only second preload), src/lib/test-preload-hooks.ts:4 (process-wide memory reset per test); practice_sources: Bun docs — Test runner lifecycle hooks via preload; Meszaros, xUnit Test Patterns — Fresh Fixture / Interacting Tests. Remaining defect: the preload itself is unpinned (M25/M26 survived).
- F-011 upheld — the disclaimer at ask-user-tool.ts:162 is the documented guarantee (permission-modes.md); M18 survived; suggested assertions are sound.
- F-012 challenged — intent_signals: src/review/review-system.ts:90 (non-shell calls keep the exact hash as their spelled key), src/commands/agent.ts:5574, 5688, 5821 (every read checks the spelled key). Question: "The exact-fingerprint recording looks redundant … so M10 seems equivalent. Treat it as an equivalent mutant (or remove the redundant line), or keep the finding and require a test?" Options: "dismiss — equivalent mutant; optionally drop the redundant exact-fingerprint recording" / "uphold — keep the finding and require a test that tells the two recordings apart".

Summary: 5/5 judged; 3 upheld, 1 downgraded (cited), 1 challenged, 0 owner-decision. Only git log/blame/show and file reads were run.
