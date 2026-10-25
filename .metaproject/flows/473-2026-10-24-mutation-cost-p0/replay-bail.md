# Replay: mutants with and without `--bail` (AC9)

Run 2026-10-24 (second wide attempt 2026-10-25) on commit a78ea8aa (flow 473 branch, docs commit on top of the implementation), `treeHash` 2b67b7a5 for every pass. Machine: 16 cores, load average 3-5 during the three groups below. Bun 1.4.2.

## Method

Mutants were taken from the 73 recorded passes of this repository (`.metaproject/flows/*/reviews/*/research-evidence/mutation-*.json`), one entry per distinct (file, anchor, replacement), only those whose anchor still occurs exactly once on this tree. Per test command, a spread over files: up to 8 recorded-killed and up to 6 recorded-survived mutants. Each group ran twice through the real command, `keryx review mutate --test "<command>" --spec <group> --scratch tmp`: once by default (bail applied) and once with `--no-bail`. Order alternated between groups. Both runs wrote a record; the record of the default run has `bail: true`, the other none; the mutant rows carry the command actually run.

| group | test command | mutants |
|---|---|---|
| 1 | `bun test src/review/replay.test.ts` | 14 |
| 2 | `bun test src/review/ledger.test.ts src/commands/review-slice.test.ts src/commands/review-ledger.test.ts src/flow/verify-exec-files.test.ts` | 14 |
| 5 | `bun test src/review/complete-head-gate.test.ts src/review/evidence-level.test.ts src/review/rebuttal-citation.test.ts src/review/ledger-narrowed.test.ts src/review/ingest-locator-sha.test.ts src/review/research.test.ts src/review/ledger.test.ts src/review/managed.test.ts src/commands/review.test.ts` (9 files) | 10 |

Every mutant, with its status and time in both runs, is in `replay-bail-mutants.md` next to this file.

## Result

- **Status parity: 38 of 38 mutants have the same status with and without bail.** Of them 30 killed and 8 survived. No survivor became killed, no kill became a survivor.
- **True survivors: 7** (survived in the recording and survive now, with and without bail; AC9 asked for at least 3). An eighth survivor was recorded as killed.
- **Time of the killed mutants:** 144.2 s without bail, 93.2 s with bail, a saving of **35%**. AC9 asked for at most half (a saving of 50% or more). **The threshold is not met.**

| group | killed | without bail | with bail | saving |
|---|---|---|---|---|
| 1 | 11 | 22.5 s | 19.2 s | 15% |
| 2 | 13 | 37.3 s | 27.9 s | 25% |
| 5 | 6 | 84.3 s | 46.0 s | 45% |

**Noise.** Each group ran once per mode, so a single run is one sample: a loaded machine (load average 3-5, and other jobs on the box) moves a pass by seconds. The one control available is the survivors, which cost the same in both modes, and they differ by 47.4 s against 50.6 s (about 7%). Read the 15% of group 1 and the 25% of group 2 as being at or near that noise; only the 45% of group 5 is clearly above it. The 35% overall is an estimate from one repetition, not a measured mean.

The saving grows with the width of the suite: a run of 2-3 s is mostly `bun` start-up and file loading, which bail cannot shorten. Survivors cost the same with or without bail (a green run does not stop early), as expected: 47.4 s without, 50.6 s with, noise only.

## What was not obtained

- **Groups on wide commands (the case that carried the analyst's 79%) could not be measured here.** `bun test src/review src/commands/...` (group 3, 7 mutants) and the `trust-routine-command` set (group 4, 14 mutants) have a red baseline on this machine in the scratch copy (group 4: `Flow 441 F-055 ... symlink out of the project` fails; group 3 also red), with `--scratch tmp` and with the default repo scratch. A red baseline stops the pass before any mutant runs, so these groups give no data. This is the environment, not the change: the baseline runs the unchanged command. It was not checked whether the same tests are red on origin/main.
- The recorded-vs-now comparison shows that status itself moves between the recording and now: 10 of 38 mutants differ from their recorded status (9 recorded survived, now killed; 1 recorded killed, now survived). That is the finding behind R3 (do not reuse results blind), not an effect of bail: both runs here agree with each other.

## AC9

Not confirmed. Parity and the survivor count (7 of at least 3) hold; the time threshold (>= 50% saving on killed mutants) does not on narrow and medium commands (35% overall, 45% on the widest group measured). The criterion is not rewritten to fit the result.
