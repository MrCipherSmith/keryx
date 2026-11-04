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
2. `findReviewGateState(cwd, since, named, { signal, now })` passes the signal to the walks and checks it around
   `scanRoot` / `reviewCompletionBlockers`.
3. `holdReviewGate` passes the turn's `signal`, returns `false` (no nudge) when the turn is aborted before or after the
   scan. Both call sites (text-only stop, no-progress stop) go through it.

### B. Mutation pass (`src/review/mutate.ts`)

The design was narrowed after the round-1 review (see AC5/AC6 and journal.md); this describes the code at head.
The flow's recorded title and task T5's title (flow.json, tasks.md) keep the original "nested checkouts" wording:
they record what was planned, and no flow command renames them.

1. `copyTree` leaves out only a linked worktree: a subdirectory whose `.git` file names an admin directory that holds a
   `commondir` file, or a path ending `.git/worktrees/<name>` (either slash). Submodules, paths a `.gitmodules` of the
   walk lists, embedded clones (a `.git` directory) and unreadable or malformed gitfiles are copied. The repository's own
   scratch directory is never copied, and it is swept in `--scratch tmp` mode too.
2. After `mkdtemp`, inside the scope whose cleanup removes the scratch, write `<scratch>/owner.json` `{ pid, startedAt }`
   and touch it every heartbeat while the pass runs.
3. Before `mkdtemp`, sweep the operator's own directories in `scratchBase` (and the repository's scratch): entries named
   exactly `keryx-mutate-` + 6 alphanumerics, real directories owned by the current uid. One with a marker is judged by
   its heartbeat: removed when the marker is older than 10 minutes whatever the pid says, or when the pid is dead and the
   marker is older than two heartbeats. One without a usable marker is removed after 6 h. Keep a live owner (including
   `EPERM`), a fresh unmarked one, and any other name.
4. Help text (`src/commands/review.ts`) and `docs/docs/guides/review-with-a-record.md` say what is skipped and swept.

## Trade-offs

- A truncated signature cannot see progress beyond the budget, so the stall counter may stop the gate a little early on a
  huge package. That degrades toward "the turn ends", never toward a hang; the operator is at the keyboard.
- Leaving out only linked worktrees rather than every nested checkout keeps every file a test may read (a submodule or an
  embedded clone is part of the tree under review); a linked worktree is a second working copy of a repository.

## State × event matrix

Not applicable — no UI or held state; the gate is a pure evaluation per stop and the sweep is a one-shot filesystem step.

## Verification

- Unit tests red-first for each criterion (`src/review/completion-gate.test.ts`, `src/commands/agent-review-gate.test.ts`,
  `src/review/mutate.test.ts`).
- T6: before/after measurement of one gate evaluation on a fixture repo with a large `mutate-scratch` and a nested
  worktree, old code (main checkout) vs new code (this worktree).
- CI runs the full suite on the PR.
