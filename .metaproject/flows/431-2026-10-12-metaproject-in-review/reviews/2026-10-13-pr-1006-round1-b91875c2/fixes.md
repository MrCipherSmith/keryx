# PR 1006 round 1 — fixes

Reviewed head `b91875c2`. Group 1 (blocker and majors) is commit `326a6516`; group 2 (minors, infos, docs) is `22eda636`; the survivor-killing tests are the two commits after it. The frozen acceptance criteria are untouched; AC14 and AC15 stay operator live runs.

## Blocker and majors (all fixed)

| Id | Result | Evidence |
|----|--------|----------|
| R1-01 | fixed | memory index is written under the package dir (`indexDir`), not the project working copy; test pins the path; mutant f04 killed |
| R1-02 | fixed | refresh holds a file lock, graph is built in a staging dir and published atomically with rollback; readers refuse while the lock is held; mutants f02, f03 killed |
| R1-03 | fixed | graph is always built in a clean detached worktree at the PR head, never the live tree; mutant f05 killed |
| R1-04 | fixed | one head source (input, then manifest `target.head`, then checkout), recorded in `layers.json`; head and base pass `assertGitRevision`; mutants f01, f06, f07 killed |
| R1-05 | fixed | `mergeFindings` ranks blocker/major/minor/info, old names kept as aliases; mutant f09 killed |
| R1-06 | fixed | an answer survives a chunk being recorded DONE and is dropped for a different plan; mutant f14 killed |
| R1-07 | fixed | `recordChunk` runs under a file lock; mutant f10 killed |
| R1-08 | fixed | the orchestrator skill passes `--package` and runs `layers block`, `chunks` and the coverage gate (skill and reviewer-input schema, both trees) |
| R1-09 | fixed | paths in command hints are shell-quoted; control characters refused; mutants f19, f22 killed |
| R1-10 | fixed | `--waive-coverage` is a human-confirmation command in `command-risk.ts`; the waiver quote must carry the operator's own words (minimum length, flag text stripped); a failed close restores research.json; mutants f15, f16, f17, f18 killed |
| R1-11 | fixed | AC1 isolation test (`layers-isolation.test.ts`) can fail |
| R1-12 | fixed | tests over `review complete` with and without the waiver (`managed.test.ts`) |
| R1-13 | fixed | the TUI refresh runs in a child process and is guarded against double starts (`review-layers-actions`, tests added) |
| R1-14 | fixed | the eight reviewer skills are trimmed; ceilings only move down and equal the shipped line counts; changelog corrected in group 2 |
| R1-15 | fixed | the previously unpinned layers behaviours are asserted in `layers.test.ts` / `layers-isolation.test.ts` |

## Minors and infos

| Id | Result | Note |
|----|--------|------|
| R1-16 | partial | refresh failure cleanup fixed. Skipped: the worktree is still created under the OS tmp dir and a SIGKILL leaves it; pruning stale `keryx-layers-*` dirs is a follow-up |
| R1-17, R1-18, R1-19 | fixed | atomic `chunk-pass.json`; replan before any pass is recorded; `files` and truncation bounded (mutant f21 killed) |
| R1-20 | skipped | quadratic truncation loop; measured 0.3 s on the real graph, not hot at current scale |
| R1-21 | skipped | no freshness short-circuit on explicit refresh; an explicit refresh is meant to rebuild |
| R1-22 | fixed, one half declined | import-closure guard now starts from every new module and the commands; `gdgraph/enrich` is tree-sitter extraction with no model call, so the guard stops at `wiki/enrich` and `wiki/deep-enrich` |
| R1-23 | fixed | `--package` confinement tested end to end for layers refresh/status, chunks plan and coverage (outside dir, symlink, `../`); mutant f26 killed |
| R1-24 | fixed | four hand-rolled readers replaced by `readJsonFileOr` |
| R1-25 | skipped | splitting `computeCoverage` is a refactor of the AC9/AC10 gate; better in its own PR |
| R1-26 | fixed | `DONE_WITH_CONCERNS` finishes a chunk; a chunk is split once; mutants f11, f12 killed |
| R1-27 | skipped | dispatcher refactor of `runChunks`/`runLayers`; behaviour unchanged |
| R1-28 | fixed | one shared `resolvePackageDir`/`wantsHelp` |
| R1-29 | fixed | unused `readChunkPass` removed |
| R1-30 | skipped | the layers block is advisory; recording read failures in the block is a follow-up |
| R1-31, R1-38, R1-39 | fixed | cli-reference, README, help text and guides list `--package`, split the layers synopsis, and say start, attach, ingest |
| R1-32 | fixed | the `c` action is described as recording the estimate and the next chunk, not running |
| R1-33 | skipped | moving the constant risks the import cycle it was moved to avoid |
| R1-34 | skipped | single-source generation of the 16 block copies; the identity test stays |
| R1-35 | skipped | moving the projection out of `src/tui` is a refactor |
| R1-36 | fixed | `FIRST_FILES` shared |
| R1-37 | fixed | `base` renamed `partial` |
| R1-40 | skipped | CHANGELOG stays under Unreleased until the tag |
| R1-41 | fixed | `saveRoutingConfig` behaviour noted in the changelog |
| R1-42 | fixed | `readToolLog` resolves real paths and requires a regular file; mutants f24, f25 killed |
| R1-43 | fixed | an empty or blank log is unknown, not zero; mutant f23 killed |

## Mutation pass

`keryx review mutate` over 26 mutants of the new guards (spec `research-evidence/mutants-r1fix.json`, results `mutate-r1fix-pass1.json` is the first run's output).

- Pass 1: 18 killed, 8 survived (f03, f06, f07, f08, f11, f12, f14, f24).
- Added tests: publish rollback, manifest head shape, layers.json version, option-like head and base, `DONE_WITH_CONCERNS`, the single split, an answer for a changed plan, a FIFO tool log.
- Passes 2 and 3 on the survivors (`mutants-r1fix-survivors.json`): all 8 killed. The first survivor run of f12 still survived because my test hit the "not-run" branch; the final test drives parent fail, child DONE, parent fail, which reaches the guard.
- Final: 26 of 26 killed, no equivalent survivors.

Note: `keryx review mutate` refuses a narrow `--test` command on its copy (baseline exited 1); the full focused command passes there, so it was used.

## Not run

The broader suite showed two failures in `hostile cwd ... live keryx shell --print` (30 s timeouts). They sit outside the files touched here.
