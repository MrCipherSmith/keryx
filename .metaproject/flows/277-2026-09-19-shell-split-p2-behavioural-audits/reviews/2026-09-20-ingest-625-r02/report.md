# Managed Review — Flow 277 (shell god-file split, P2)

PR #625, merged as `a97d6629b3ff5e5d0a0826f9e36ef765f0dae432`.

## Scope reviewed

- Full commit diff (`git show --stat a97d6629` plus every changed file).
  Read the complete diff of every PRODUCTION file the commit touches:
  `src/commands/shell.ts` (2 hunks), `src/tui/tui-shell.ts` (6 hunks),
  `src/tui/next-step-suggestion.ts` (1 hunk, new exports), and the new file
  `src/tui/shell-exit.ts` (77 lines, in full).
- Central claim checked directly against the diff, not taken on trust: AC1
  says "every production edit in this flow is one of: an `export` keyword,
  an optional injected dependency whose default reproduces the previous
  behaviour, code moved unchanged behind a new function, or a comment."
  Verified each production hunk against that list:
  - `src/commands/shell.ts`: `async function runAgentRepl` gains `export`
    (no behaviour change); the `rich` parameter type gains an optional
    `write?: (s: string) => void`, and the body changes from
    `const out = (s) => { process.stdout.write(s); }` to
    `const out = rich.write ?? ((s) => { process.stdout.write(s); })` —
    an optional injected dependency whose default is textually the same
    closure as before. The rest of the hunk is JSDoc only.
  - `src/tui/tui-shell.ts`: one hunk is comment-only (the
    `SIDE_WORKER_DENIED_TOOL_NAMES` doc paragraph, :309-234 pre-image).
    Four hunks replace inline statement sequences with calls to two new
    functions imported from `./shell-exit` (`leaveBusThenRelease`,
    `performSlateExit`) and one from `./next-step-suggestion`
    (`buildNextStepPrompt`) — each is "code moved unchanged behind a new
    function", verified by diffing the moved statements against the new
    function bodies (see below), not merely by reading the commit message.
  - `src/tui/next-step-suggestion.ts`: `buildNextStepPrompt` is a
    line-for-line extraction of the closure previously inline in
    `tui-shell.ts`'s `suggestNextStep` — same `.reverse().find(...)` on
    `history`, same `-3000`/`-800` tail slices (now named constants
    `NEXT_STEP_ASSISTANT_TAIL`/`NEXT_STEP_USER_TAIL` with the same
    numeric values), same system-prompt string. Compared character for
    character against the pre-image in the `tui-shell.ts` diff hunk.
  - `src/tui/shell-exit.ts` (new): `leaveBusThenRelease` calls
    `leaveBus()` then `releaseLease()` — matches both replaced call sites
    exactly. `performSlateExit` runs, in order,
    `closeSlate -> sweepJobs -> purgeJobList -> leaveBusThenRelease ->
    detachRenderer -> destroyRenderer`, each async step `await`ed and no
    try/catch — matches BOTH replaced inline sequences exactly (the
    busy-menu `case "exit"` and the `/exit` command bodies were already
    identical to each other before this change; I diffed both pre-images
    against `performSlateExit`'s body to confirm neither reordered
    anything). A throw from any step still aborts the sequence before
    later steps run, exactly as it did when the steps were inline
    statements with no surrounding try/catch (verified against the new
    unit test `src/tui/shell-exit.test.ts:119-135`, which pins exactly
    this with a synthetic throw).
  - The third and fourth `liveBus?.leave()`/`sessionLease.release()` call
    sites (the renderer's synchronous `onDestroy`, and the outer
    `finally`) both become `leaveBusThenRelease({...})` with the same two
    closures — same order, same synchronous-only bodies.
  - No other production file in the diff (checked the full `git show
    --stat` file list) contains a change outside `docs/`, `.metaproject/`,
    or a `*.test.ts` file.
  **Conclusion: AC1's zero-production-behaviour-change claim holds.** Every
  production edit in this commit is one of the four permitted forms, and I
  verified the "code moved unchanged" cases by diffing the moved statements
  against the extracted function bodies myself rather than by trusting the
  commit message's own description of them.
- Read the new test `src/tui/shell-exit.test.ts` in full (136 lines) to
  confirm the ordering and throw-propagation claims are actually asserted,
  not just described in a comment: they are (`:64-99` order and per-pair
  ordering assertions, `:101-117` await-not-fire-and-forget, `:119-135`
  throw-stops-the-sequence).
- Spot-checked (not exhaustively) the converted behavioural tests in
  `src/commands/shell-agent-repl.test.ts` (new, 327 lines) and the trimmed
  `src/commands/shell.test.ts` for internal consistency with the exported
  `runAgentRepl` signature; did not re-run the suite locally (CI is
  recorded green on the PR head, 18/18 checks, per the flow journal and
  AC11).
- Did NOT deeply review the six `src/tui/*.test.ts` files converted from
  file-concatenation/offset audits to `listSourceFiles`-based module scans
  (`session-info.test.ts`, `subagent-inspector.test.ts`, `theme-picker.test.ts`,
  `tui-bus.test.ts`, `tui-session-lease.test.ts`, `tui-shell.test.ts`) beyond
  confirming none of them touches a production file — these are test-only
  changes and the flow's own AC7/AC8/AC9 (CI-verified) cover their
  correctness as scans; a full manual re-derivation of each scan's file set
  was out of scope for this pass.
- Did NOT re-verify every prose claim in the updated
  `source-text-audit-inventory.md` (13 files / 42 sites, the 11 remaining
  named seams, the two seams needing a decision) against the live scan;
  `src/shell-source-audits.test.ts` (unchanged by this commit) is what
  enforces that consistency in CI, and CI is green.

## Findings

None. Every production edit found in the diff is a strict instance of one
of AC1's four permitted forms, verified directly against the code rather
than inferred from the commit message.

```json keryx:findings
[]
```
