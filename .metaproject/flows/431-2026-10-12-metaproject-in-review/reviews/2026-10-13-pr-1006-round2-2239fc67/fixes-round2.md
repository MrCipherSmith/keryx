# PR 1006 round 2: fixes

Head at the start of the round: `2239fc67`. Every id below is fixed unless marked skipped. The round-2 package
(`report.md`, `findings.json`) is committed unedited.

## Majors

| Id | Status | What changed | Evidence |
|---|---|---|---|
| R2-01 | fixed | `completeManagedReview` restores `research.json` on every failure path after the waiver is recorded, not in one branch | `src/review/managed.ts`; managed close tests |
| R2-02 | fixed | `loadPackageGraph` and `layersCurrent` check that the graph directory exists, matches `build.json` and holds a non-empty `nodes.jsonl` | `src/review/layers.ts` (`graphIntact`); `layers-current.test.ts`, `layers.test.ts` |
| R2-03 | fixed | The head is resolved to the full commit once (`resolveCommit`); the worktree HEAD is compared with that spelling | `layers.ts`; `layers-round2.test.ts` (short sha, branch name) |
| R2-04 | fixed | The truncation loop also drops `files`, measures the block with its truncation record, and removes entries in batches that cannot overshoot | `src/review/layers-payload.ts`; `layers-payload.test.ts` |
| R2-05 | fixed | `touchesCoverageWaiver` decides on parsed words: split quotes, `$'…'`, backslashes, line continuations, env prefixes, `bash -c`, `eval`, nesting, and any `review complete` word holding an expansion. `runComplete` also requires a terminal for the waiver | `src/lib/command-risk.ts`; `command-risk-review-floor.test.ts` (27 spellings) |
| R2-06 | fixed | The flow review gate no longer applies the coverage completeness gate to rounds that are already closed | `src/flow/review-gate.ts`; flow gate tests |
| R2-07 | fixed | `layers`, `chunks` and `coverage` subcommands are in the trust-routine and automatic-review lists, each bound to the package; `--answer` and `--quote` are refused | `trust-routine-command.test.ts`, `automatic-review.test.ts` |
| R2-08 | fixed | The refresh removes its worktree, staging directory and lock on SIGINT/SIGTERM; the next refresh sweeps old keryx checkouts and recovers a half-published graph | `layers.ts`; `layers-round2.test.ts` (signal, sweep, recovery) |
| R2-09 | fixed | `makeLayersRefreshRunner` is a testable factory, covered by a real child process; children are killed on TUI exit | `src/tui/review-layers-actions.ts`; `review-layers-actions.test.ts` |
| R2-10 | fixed | `ensurePackageLayers` wait-timeout branch tested (`waitMs`) | `src/commands/review-layers.test.ts` |
| R2-11 | fixed | A stale refresh lock is tested end to end | `layers-round2.test.ts` |

## Minors and infos

| Id | Status | Note |
|---|---|---|
| R2-12 | fixed | `ensurePackageLayers` refreshes a record whose graph is `failed` |
| R2-13 | fixed | Every path in a command hint goes through `shellWord` |
| R2-14 | fixed | `git worktree prune` runs only after a failed `worktree add` |
| R2-15 | fixed | The checkout runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false` |
| R2-16 | fixed | `chunks estimate --answer` asks in every permission mode (`touchesChunkEstimateAnswer`, parsed words plus a collapsed-text net) |
| R2-17 | fixed | The waiver quote must be 8 characters of the operator's own words with a letter or digit, after the flag text is removed |
| R2-18 | fixed | Boundary tests at 7 and 8 characters |
| R2-19 | fixed | All writers of the chunk state files take `withChunkStateLock`. `nextChunk` takes it too for a consistent snapshot; two callers can still be handed the same chunk, which the one-at-a-time protocol allows |
| R2-20 | fixed | The TUI treats a failed graph in the child's JSON as a failure |
| R2-21 | fixed | The double-start guard is module level and keyed by package |
| R2-22 | fixed | Truncation cost (see R2-04) |
| R2-23 | fixed | A refresh keeps an intact graph at the same head unless `--force` |
| R2-24 | skipped | The refresh at create time is intended: a package without layers is the failure this PR removes. The wait is bounded and the work is skipped for an intact graph |
| R2-25 | fixed | The lock wait is 16 minutes, longer than the TUI child's 15 |
| R2-26 | skipped | Retention and a graph cache are a feature, out of scope for a fix round; tracked as a follow-up |
| R2-27 | fixed | The base is the manifest's target ref, falling back to `prHead~1` |
| R2-28 | fixed | The "no temp file left" tests were renamed to what they check; no failure injection was added |
| R2-29 | fixed | The `../escape` case now exists as a directory, so confinement is what refuses it |
| R2-30 | fixed | `mergeFindings` unknown-severity, tie and repeated-merge cases |
| R2-31 | fixed | CHANGELOG says the worktree is in the OS temp directory |
| R2-32 | fixed | `--package` in the dispatch-check synopsis |
| R2-33 | fixed | `readChunkLimits` goes through the shared loader. The ceiling is not trust-gated: a committed `routing.config.json` can raise it, capped at 100 |
| R2-34 | fixed | `ensureChunkPlan` comment and behaviour agree: a plan from another dropped set is replaced before any pass, refused after |
| R2-35 | fixed | `manifestHead` reads through `readJsonFileOr` |
| R2-36 | fixed | The tool log is opened non-blocking and refused above 8 MiB |
| R2-37 | fixed | The severity comment says `low` ranks between minor and info |
| R2-38 | fixed | `ChunkRecordResult` type, named lock constant, `recordChunk` split |
| R2-39 | fixed | Only `emptyChunkState` lost its `export`; the estimate is computed once in `chunks next` |
| R2-40 | fixed | The unattended floor refuses the coverage waiver and chunk answer commands |

## Mutation pass

Guards added for the majors (R2-02/03 graph reuse, R2-04 payload, R2-05 and R2-16 command-risk floor, R2-07
automatic review, R2-08 sweep, R2-12/36) were mutated with `keryx review mutate` and the full focused test command
(`src/review`, `src/commands/review-layers`, `review-ledger`, `review-slice-paths`, `reviewer-layer-block`, the review
TUI tests, `src/lib/command-risk`, `trust-routine-command`, `automatic-review`, `src/trigger`, `src/flow`,
`src/tui/review-layers`). Specs: `research-evidence/mutants-r2fix-p0..p3.json`.

| Part | Record | Mutants | Killed | Survived | Timeout |
|---|---|---|---|---|---|
| p0 | `mutation-9` | 23 | 15 | 8 | 0 |
| p1 | `mutation-7` | 22 | 14 | 7 | 1 |
| p2 | `mutation-5` | 22 | 19 | 3 | 0 |
| p3 (re-run of the survivors with the new tests, plus 7 mutants of the new code) | `mutation-10` | 18 | 18 | 0 | 0 |

The 18 survivors of p0..p2 were triaged. Real bypasses and test gaps found by the survivors, all fixed and re-killed in p3:

- **cr7, cr1** (real bypasses): a `$'…'` word inside a double-quoted `bash -c` body, a nested `eval`, and nesting
  deeper than the recursion limit hid `--waive-coverage`. `segmentsOfBothSpellings` now parses the command as written and
  with its ANSI-C words expanded; the collapsed-text net covers depth. Tests: ANSI-C in `bash -c`, quote dance, nested
  `eval`, seven-deep `bash -c`.
- **Line continuation** (found while writing cr7 tests): `--waive-c\<NL>overage` is the flag to the shell.
  `joinContinuations` runs first. Tests: LF and CRLF, for the waiver and the chunk answer.
- **cr13, cr17**: `chunks estimate --answer` inside `bash -c`, with ANSI-C words, answer before verb, and a collapsed-text
  net with the same-command boundary (`;`, `&&` stay prompt-free; `chunks next --answer` stays prompt-free).
- **cr5**: a backtick substitution with no flag text asks. **ar2, ar3**: `chunks estimate` with `--answer` and no `--quote`,
  and `--quote` alone, are refused by automatic review.
- **ly2, ly5, ly7**: `layersCurrent` (graph commit differs from the head; non-empty `nodes.jsonl`; empty graph) and
  `resolveCommit` (only a full sha from git) now have direct tests (`layers-current.test.ts`).
- **ly12, ly13**: the sweep leaves an old worktree alone unless it is a `keryx-layers-*` directory directly under the temp
  directory (`layers-round2.test.ts`).

Survivors accepted as equivalent or redundant, with the reason:

- **cr19** (no ANSI-C escape decodes to a letter of the flag) and **pl3** (batch bound in the payload truncation changes
  speed, not the output): equivalent.
- **ly9** (`sameHead` before `layersCurrent`): `layersCurrent(…, prHead)` already rejects a different head; the guard only
  documents intent.
- **cr3** (plain `includes` on parsed words): covered by the raw-text and collapsed-text nets, which see every spelling the
  parsed words see; kept as the parsed-form statement of the rule.
- **cr8, cr20 and the as-specced anchor of cr17**: the specced anchors no longer exist after `segmentsOfBothSpellings` replaced the single
  expansion; the same behaviour is mutated by cr21 and cr22 (both killed). cr20 (escaping `'` inside an expanded word) is
  covered because the as-written spelling is always parsed too and the collapsed net removes quotes regardless.
- **pl4** (timeout): the mutant removes the empty-list throw and the truncation loop never ends; the timeout is the detection.
- Within cr23..cr26 the `joinContinuations` call in `touchesCoverageWaiver` is overlapped by the same call in
  `segmentsOfBothSpellings`; mutating either alone is not observable, mutating the function (cr23, cr24) is killed.

Parts p0..p2 ran against the code before the last command-risk fix and the new tests; p3 re-ran every surviving
mutant with a still-valid anchor against the final code. A killed mutant stays killed under a superset of tests.
The mutation records `mutation-2..10` in `research-evidence/` include earlier, interrupted runs.

## Open for round 3

- R2-33: the chunk `reviewChunks` ceiling is not trust-gated; a committed `routing.config.json` can raise it, capped at 100.
- R2-19: two concurrent `chunks next` callers can be handed the same chunk (inherent to the one-at-a-time protocol).
- R2-05: a script file or an interpreter one-liner (`python -c`) that builds the flag is out of reach of any text parse;
  `runComplete` therefore requires a terminal for the waiver.
- R2-24 and R2-26 skipped as above.
