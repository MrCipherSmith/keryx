# Plan

1. `isPrBound` in `complete-head-gate.ts`: kind `pr` or a PR URL ref; used by the gate and by the `--head` check in `managed.ts`.
2. Autonomous prompt: skill path and shell guard escape (`autonomous-profile.ts`).
3. Loop-guard stop named first in the summary reason (`autonomous-progress.ts`, `autonomous-run.ts`).
4. Docs: cli-reference, review-with-a-record, autonomous-review, README.

## Risks

- A PR URL in the ref of a non-PR package now asks the tracker; an unreachable tracker is only a warning, as before.
- Not touched: hash-budget guard (not confirmed).
