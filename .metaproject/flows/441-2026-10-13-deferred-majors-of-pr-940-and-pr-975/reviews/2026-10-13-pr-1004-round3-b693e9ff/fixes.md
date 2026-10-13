# Round 3 fixes (PR 1004)

Round 3 is the final round. The fixes below were verified by mutation testing, not by a fourth review.

## Findings

| Id | Result | What changed |
| --- | --- | --- |
| R3-01 | fixed | `trackedFiles` returns `undefined` (walk) only when the root has no `.git` entry. A root with a `.git` entry and a failing `git ls-files` throws. Test: garbage `.git/HEAD` throws "git ls-files failed". |
| R3-02 | fixed | Symlinked-root tests in git mode and walk mode. Mutant S15 (`realRoot` unresolved) is killed. |
| R3-03 | fixed | One `cell()` helper (backslash, pipe, CR/LF) applied to file, old, new and decision in the table, and to file and old in the same-outcome bullets. Tests cover each position. |
| R3-04 | fixed | `isPlainFileUnder` requires `lstatSync(real).isFile()`; a directory and a FIFO are skipped. The FIFO test runs in a child process with a timeout, so a blocking read cannot hang the suite. |
| R3-05 | fixed | Fixture git helper pins `core.excludesFile=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`. |
| R3-06 | fixed | `walkFiles` skips `SKIPPED_DIRS` before pushing. Test: unreadable `node_modules`, `research-evidence` and `drivers` directories are never entered. |
| R3-07 | fixed | Report prose and the test error text say "from the repository root"; `REPORT_PATH` and the flow directory are one constant. |
| R3-08 | fixed | Wording, test names and literals cleaned up. `replay-report.md` regenerated (pipes escaped in bullets); still 19 files, 7 same, 12 differences. |
| R3-09 | skipped | Follow-up: move the replay entrypoint to `scripts/`, tighten the import guard, make `gitOptions` per spawn. |
| R3-10 | fixed | The `GIT_DIR` test is parametrized over `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, in a fixture checkout run in a child process. |

## Mutation result

Passes: `research-evidence/mutation-4` to `mutation-7` (specs `mutants-r4.json`, `mutants-r5.json`, `mutants-r4-env.json`, `mutants-r7.json`). Test command: `bun test src/review/replay.test.ts`. 53 tests, eslint 0, tsc 0.

- mutation-4: 25 mutants (M01-M23, S15, S07). 19 killed, 6 survived: M11, S07, M20, M21, M22, M23.
- mutation-5 (reruns after the tests were reworked): M11, M20, M21, M22 killed. S07 and M23 still alive.
- S07 (`maxBuffer: 1000`): a 40-file listing was not enough, because Bun enforces `maxBuffer` per pipe read and the whole listing arrived in one read. The listing test now creates 600 files (about 66 KB, more than one pipe read). mutation-7: S07 killed. Run by hand too: the suite fails with ENOBUFS.
- mutation-6 (hostile global git config with `excludesFile` ignoring `raw/`, run via `env GIT_CONFIG_GLOBAL=...`): T3 (both fixture pins removed) killed. T1 (global config pin removed) and T2 (`excludesFile` pin removed) survive alone because each pin covers the other. They are equivalent individually and killed together.
- M23 (`GIT_WORK_TREE` dropped from the scrub list) survives and is equivalent: checked by hand, `git -C <root> ls-files` prints the same list with `GIT_WORK_TREE` pointing at an outside directory, a subdirectory or a missing path, because the index does not depend on the work tree. The parametrized test keeps the variable covered, but no assertion can tell the mutant apart. `GIT_DIR` (M21) and `GIT_INDEX_FILE` (M22) do change the listing and are killed.
- Harness note: `keryx review mutate` runs in a scratch copy with no `.git`, so tests against this repository's own checkout walk the directory there. Guards that need a `.git` entry are covered by fixture checkouts the tests create themselves; M20-M22 and S07 were killed by those.

Not fixed: R3-09 (follow-up).
