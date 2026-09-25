# Flow 317 / PR #702 — review round 2 (narrow verification)

Checkout: /Users/Goodea/goodea/keryx-ape-317-gfu, branch flow/317-grader-fu,
HEAD 2a83439e (round 1 was at 153e29f6).

Scope: the single commit after round 1,
"fix(learning): e2e test computed the observation date from the real
clock" (`src/learning/e2e.test.ts`). CI's `typecheck-and-tests` failed at
round 1's head on an unrelated, pre-existing test
(`learning e2e: ... a failing-then-passing bun test pair ...`) that hardcodes
`now: () => "2026-09-24T00:00:0Xz"` to write an observation file, but reads
it back via `new Date().toISOString()` (the real wall clock) to compute the
date — a one-day drift the moment the real calendar date moves past the
hardcoded one. Nothing in flow 317's own diff touches this file or its
dependencies; confirmed unrelated with `git log -p -- src/learning/e2e.test.ts`
against the round-1 diff (no match).

## Verification

- Reproduced the failure locally before the fix: `ENOENT` on
  `.../observations/2026-09-25.jsonl` (today) because the file was written
  under `2026-09-24.jsonl` (the mocked date).
- The fix derives `today` from the same mocked date (`"2026-09-24"`)
  instead of `new Date()` — the minimal, correct fix; no test assertion
  weakened, no skip/retry added, the test still genuinely proves the e2e
  learning pipeline.
- With the fix reverted, the test fails (ENOENT as above); with the fix,
  it passes: `bun test src/learning/e2e.test.ts` -> 1 pass, 0 fail.
- `bun run typecheck`: exit 0. `bunx eslint src/learning/e2e.test.ts`: 0
  problems.
- Full CI on PR #702 at this head: all checks pass, including
  `typecheck-and-tests` (11484 pass / 13 skip / 0 fail, up from 11483/13/1).

No new findings. Round 1's 0 blocker / 0 major / 0 minor / 0 info stands.

```keryx:findings
[]
```
