# Context

## Repository and Delivery

- Worktree: `/Users/tsaitler.aleksandr/goodea/keryx/.worktrees/tui-foreground-operation-cancellation`
- Branch: `fix/tui-foreground-operation-cancellation`
- Recorded base branch: `main`
- Base commit at creation: `09e8555c9079c3142125799c9e560e65d1eeae01` (`origin/main`)
- Operator-confirmed completion: create PR, review/fix until clean, merge into `main`, push, then complete the flow.
- Execution metrics: enabled by the operator.

## Live Reproduction

- Session: `eb5de48c-4bf1-454a-994c-d487fa69fce4`
- Project: `/Users/tsaitler.aleksandr/Presight/Vantage/vantage-frontend`
- Symptom: wiki enrichment held the TUI busy; `/interrupt` and Queue → Force did not stop it, and subsequent input was offered Queue/Side-1 again.
- The observed run later completed 53 pages with no reported failures; the defect is cancellation/lifecycle behavior, not the final enrichment result.

## Verified Architecture

- `src/tui/tui-shell.ts` creates `mainTurnAbortController` only for `runAgentTurn`. `/interrupt` and `forceMainQueue` target only that controller.
- The wiki-enrich hard pre-router calls `startBusy()` and `wikiEnrich()` in a detached async path with no controller and a separate finalizer that does not drain forced/FIFO input.
- `src/wiki/enrich.ts` has no inbound signal; `mapPool` keeps scheduling, and model/persistence paths do not observe cancellation.
- `src/harness/provider/types.ts` and concrete adapters already support `AbortSignal`, but `runModelTurn` does not accept or forward it.
- `src/wiki/deep-enrich.ts` owns a timeout controller; external cancellation must be composed with it without changing timeout fallback semantics.
- Busy `/exit` and renderer teardown do not cancel the foreground operation, allowing stale callbacks/finalizers after UI destruction.

## Queue and Persistence Invariants

- At most one foreground operation is active.
- Only the matching operation's finalizer may clear its controller/spinner.
- Force removes the selected queued item and runs it exactly once, before FIFO, only after the previous operation settles.
- Abort stops new page scheduling and blocks post-abort writes/model-output acceptance.
- Pages fully committed before abort remain valid; unstarted/cancelled pages are not recorded as completed or failed.
- Resume/checkpoint state must never claim a page whose write did not complete.
- Exit cancels foreground work, preserves background-job sweep ordering, and never drains queued work into a destroyed renderer.

## Command Semantics

- Natural-language requests may use the interactive picker and safe defaults.
- Explicit `keryx wiki enrich` syntax must not silently discard `--page`, `--limit`, `--resume`, `--dry-run`, `--concurrency`, `--provider`, `--model`, or `--force`.
- Prefer a shared parser/typed command plan over reconstructing options in the TUI.

## Testing Context

- Framework: Bun (`bun:test`), co-located `*.test.ts` files.
- Relevant suites: `src/tui/tui-shell.test.ts`, `src/tui/main-queue.test.ts`, `src/tui/busy-dispatch.test.ts`, `src/wiki/enrich.test.ts`, `src/wiki/enrich-rlm.test.ts`, `src/wiki/deep-enrich.test.ts`, `src/harness/provider/single-turn.test.ts`.
- Use controlled streams/signals rather than wall-clock sleeps.
- Baseline Code Health before dependency installation: WARN, score 94; required TypeScript source unavailable. Re-run after installing worktree dependencies.

## Prior Decisions and Alternatives

- Chosen: one reusable foreground-operation lifecycle plus end-to-end cooperative cancellation.
- Rejected: a wiki-only controller, because it duplicates lifecycle/queue logic and invites the same defect for the next in-process operation.
- Rejected: an OS child process, because it loses integrated picker/progress semantics and expands process/persistence concerns.
- Relevant accepted memory: installed `keryx` may be stale, so verification must exercise the branch source; fix rounds require their own review.

## Context Sources

- Graph: `keryx gdgraph find/affected` (graph had no useful edges for the large TUI closure; source was verified directly).
- Wiki: `architecture/background-jobs.md`, `components/src-tui.md`, `components/src-wiki.md`, `components/src-harness-provider.md`.
- Memory: accepted TUI lessons and stale-installed-binary constraint.
- Testing: `.metaproject/data/testing/context.md` plus `keryx test related`.
- Workers: validated dispatches `219-context` (Luna) and `219-analysis` (Terra), both `STATUS: DONE` and read-only.
