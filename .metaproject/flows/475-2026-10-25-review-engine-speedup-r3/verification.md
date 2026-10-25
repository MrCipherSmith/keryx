# Verification — flow 475 (review-engine-speedup R3: E4.1–E4.4, C1–C5)

Acceptance by the `Verification:` fields of the package, run on copies of four closed vantage-frontend review packages
(#8174, #8111, #8158, #8086) with the build from this worktree (`bun run src/cli.ts review next --package .metaproject/reviews/pkg`,
cwd inside the copy). Baselines were taken on the same copies with the main build before the change. The originals were
fingerprinted (path, size, mtime of every file) before and after: all four unchanged (`ff2c4f2a0a71`, `1d613954068f`,
`3cf7d48c6a31`, `380ed2cbfcc1`).

## Result per package

| Package | Baseline (main) | This build | Idempotent (read-only x2) |
|---|---|---|---|
| #8174 | 8 dispatches: backend `[missing]`, logic, performance, security-code, vantage-core, vantage-domains, vantage-testing `[missing]`, vantage-frontend `[retry]` | 3 dispatches: backend `[missing]`, security-code `[retry]` (3 open questions), vantage-frontend `[retry]` (1 open question); no `notRun` | identical text |
| #8111 | done | done, identical to baseline | identical |
| #8158 | done | done, identical to baseline | identical |
| #8086 | 1 dispatch (`review-regression`, 5 slices left) | the same 1 dispatch, byte-identical to baseline; no `rejected` line | identical |

#8174 reads: the six spurious `[missing]` of the baseline are gone (logic, performance, vantage-core, vantage-domains,
vantage-testing, and the stale security-code wave). `review-backend` stays `[missing]`: it has no reply at all.

After `--apply` on a separate copy of #8174 the first call differs from the next (see "Findings"), and two calls after it
are identical in text and in `--json`.

## Findings the text did not predict

1. **#8174 is 3 dispatches, not 1.** AC8's wording says "the one reviewer that is truly missing remains". Two more stay
   open for a real reason, not an accounting one: the `w1` replies of `security-code` and `vantage-frontend` hold string
   `needs_context` questions that no later wave answered. The baseline hid the security-code ones because its newest
   file (`w3`) had none. The ledger already counts such a question as open, so the two now agree.
2. **A repeated `next` after `--apply` is not identical to the first `--apply` call.** A dispatch that needs `--apply`
   (re-cut slices) or hands out context questions marks its reply `processed`; the next call no longer repeats the
   questions. This is the existing design (a reply is counted once). Read-only repeats, and any two calls after `--apply`,
   are identical. Not marking such replies `processed` was rejected: every `--apply` would then spend another attempt.
3. **Several finished waves landing together were read as a stall.** The late-result collector credits every
   driver-named reply to the first one evaluated, so the second and third reply of a batch showed "nothing new", and the
   third pushed the reviewer to `Not run` (MAX_STALLED_RESULTS = 2) although it still owed a wave. Found on a copy of #8086
   with its `retry-state.json` removed (7 waves of `architecture`). Fixed in `review-next.ts`: once the batch has moved
   coverage, stalls restart for the next reply of the same batch; test `wave order: several finished waves landing together…`
   fails without the fix. With the fix the same experiment gives no false `Not run`.
4. **Slice-less `DONE` on #8086** (`review-clean-code`, `review-layout`, 4 files). With the package's own state they are
   not reported: their hashes are already in `processed`, and their coverage comes from the other waves. With the state
   removed they are listed as `rejected`, as designed (that experiment is not an acceptance run: without the state the
   `w1` replies of #8086, which are in several shapes, cover nothing by themselves, so the owed list is longer).
5. **Object `needs_context` exists on #8174 only in a `.prev2` file** (`security-code-w1.prev2.txt`). The `.prev` exclusion
   removes it from `next`, so C3 on this package is checked on a synthetic reply (unit tests), not on a live one.
6. `rejected` lines are printed on every call while the slice-less reply stays in `raw/`, also when other replies cover the
   reviewer's slices (a reply that was never counted is never marked `processed`). No closed package shows it.

## Requirements and how they were accepted

| Requirement | Evidence |
|---|---|
| C1 wave order, all valid replies, idempotent | `review-next.test.ts` "wave order" (3), "idempotent"; #8174 copy: 8 → 3, no spurious `[missing]` |
| C2 `*.prev*.txt` out of selection | "prev files"; #8174 has 13 such files of 67, none is chosen |
| C3 object `needs_context` | `needsContextQuestions` + tests in `retry-plan`, `retry-eval`, `ledger` ("needs_context") |
| C4 / E4.4 slice-less reply rejected with a reason | "without slices" (2); text and `--json` carry `rejected` |
| C5 no `notRun` where slices are covered; old-format state | "old-format state"; the four copies carry no `notRun` |
| Escalations from every reply | "escalations from every reply" |

Tests: 170 in the four related files, `bun run typecheck` clean, `src/gdskills` and `src/review` suites (13146 tests) green.
Six of the new `review-next` tests fail on the old `review-next.ts` (verified by restoring it); "idempotent" and "old-format
state" pass on both, as those properties already held for the shapes they build.

## Could not be checked

- A live review round: no reviewer was dispatched; every result is from files on disk.
- The TUI: no new surface (AC11); `parity.test.ts` and `review-panel.test.ts` pass, no live TUI was opened.
- `keryx review ledger build` still reads `*.prev` files (outside R3 by decision of poll 300).
- AC12 names `src/commands/review-next.test.ts`, which does not exist in this branch (it arrives with PR #1083); `bun test`
  treats it as a filter and passes.
- A merge with PR #1083 in `review-next.ts` is expected to conflict and was not tried.

## Discrepancies between the documents and the code

1. `next` kept one reply per reviewer by mtime (`latestResults`); the function is replaced by `collectReplies`. Line numbers
   of 0.3.131 do not apply.
2. The package speaks of six spurious `[missing]` and one truly missing reviewer. The baseline on the copy has seven
   `[missing]` (six covered, `backend` truly missing) and one `[retry]`; the result keeps two more open for real questions
   (finding 1).
3. Object `needs_context` entries exist on #8174 only in a `.prev2` file (finding 5).
4. The baseline on #8174 has no `notRun` already; the C5 clause "no reviewer becomes `notRun`" is a guard against a
   regression, and the old-format state did not throw on any of the four copies. The hardening
   (`normalizeRetryState`) covers shapes the copies do not contain (missing or mistyped fields) and is tested on synthetic state.
5. The wave number is in the file name (`-w<n>.txt`) and in the driver's `wave`; a few raw files have neither
   (`review-architecture-w3-slice-04.txt`, `review-architecture.result.json`) and are ordered by mtime.
6. The late-result collector and `next` both count a reply, which is the cause of finding 3; the package text treats them
   as one count.
