# Plan

## Approach

### A. Stop gate (`src/review/completion-gate.ts`, `src/commands/agent.ts`)

1. `dirSignature` takes options: an absolute-path `skip` set, a shared file budget, and an `AbortSignal`.
   - `findReviewGateState` skips `<workingRoot>/.metaproject/data/review/mutate-scratch` (reuse `SCRATCH_DIR` from
     `src/review/mutate.ts`; mutate.ts does not import completion-gate, so no cycle).
   - Budget `MAX_SIGNATURE_FILES` per walk (2048). Two walks per stop stay within `MAX_HASHED_FILES` (4096), so an
     unchanged tree is served from the cache on the next stop. When the budget runs out the walk stops and the
     signature carries a deterministic truncation marker (same tree → same signature, so stall detection still works on
     the walked part).
   - The signal is checked before each entry; an aborted signal throws an `AbortError`.
2. `findReviewGateState(cwd, since, named, signal?)` passes the signal to the walks and checks it around
   `scanRoot` / `reviewCompletionBlockers`.
3. `holdReviewGate` passes the turn's `signal`, returns `false` (no nudge) when the turn is aborted before or after the
   scan. Both call sites (text-only stop, no-progress stop) go through it.

### B. Mutation pass (`src/review/mutate.ts`)

1. `copyTree` skips a nested git checkout: a subdirectory with a `.git` directory (embedded clone) or a `.git` file whose
   `gitdir:` does not point into a `modules` directory (a worktree). A submodule (`gitdir: …/modules/…`) is copied.
2. After `mkdtemp`, write `<scratch>/owner.json` `{ pid, startedAt }`.
3. Before `mkdtemp`, sweep `scratchBase`: entries named exactly `keryx-mutate-` + 6 alphanumerics; remove one whose
   owner pid is dead (`process.kill(pid, 0)` → `ESRCH`), or that has no readable owner marker and is older than a stale
   age (6 h). Keep a live owner (including `EPERM`), a fresh unmarked one, and any other name.
4. Help text (`src/commands/review.ts`) and `docs/docs/guides/review-with-a-record.md` say what is skipped and swept.

## Trade-offs

- A truncated signature cannot see progress beyond the budget, so the stall counter may stop the gate a little early on a
  huge package. That degrades toward "the turn ends", never toward a hang; the operator is at the keyboard.
- Skipping nested checkouts rather than `.metaproject/data` keeps every file a test may read.

## State × event matrix

Not applicable — no UI or held state; the gate is a pure evaluation per stop and the sweep is a one-shot filesystem step.

## Verification

- Unit tests red-first for each criterion (`src/review/completion-gate.test.ts`, `src/commands/agent-review-gate.test.ts`,
  `src/review/mutate.test.ts`).
- T6: before/after measurement of one gate evaluation on a fixture repo with a large `mutate-scratch` and a nested
  worktree, old code (main checkout) vs new code (this worktree).
- CI runs the full suite on the PR.
