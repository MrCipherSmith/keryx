# rules-ab: A/B bench for review rules and lenses

Compares two or more versions ("arms") of a reviewer's rule and skill files by running the same reviewer on the same code changes and counting what it finds. `bench.py` prepares inputs and scores outputs. It never dispatches an agent: reviewers and judges are agents that read the task files the script writes.

## Suites

**seeded** (5 cases). Four commits on one base (`757090dc9`), each with planted code-quality defects (q01-q04, 24 planted defects in all), plus q05, a clean control with none. A reviewer arm is measured on:

- recall: planted defects found (match = 1, partial = 0.5) out of 24;
- valid: real problems it reported that were not planted;
- noise: findings that are not real, not introduced by the change, or pure taste;
- decoy: justified code reported as a defect;
- control findings: anything reported on q05 (should be near zero).

Use it for the clean-code lens and its rules. Run at least 3 reps: single runs vary.

**history** (13 cases). Past review packages: for each, the base and head commits and the 46 blocker/major findings that were later confirmed and fixed. One general reviewer reads each change cold. It measures recall against real, already-fixed defects: how much of what reviews historically had to catch a single pass catches. There is no decoy or noise measure here.

## Procedure

1. Prepare one directory per arm: a `SKILL.md` (the lens) plus any rule files that arm should read. Keep arms identical except for what you are testing.
2. `python3 -I bench/rules-ab/bench.py setup --suite seeded --arm A=<dirA> --arm B=<dirB> --reps 3`
   Writes `.work/<run>/` (run defaults to the suite name; use `--run NAME` for several runs): `tasks/` (one reviewer task per case, arm and rep), `runs.json` (shuffled dispatch order), `out/`, `worktrees.sh`. For history it also regenerates each case diff from its two commits. It prints the worktree commands.
3. Materialise the case worktrees: run the printed `git worktree add` commands (or `sh .work/<run>/worktrees.sh`). Reviewers read these checkouts.
4. Dispatch reviewers: one agent per task file in `runs.json`, in that order, each told to follow its task file. Each writes its JSON to the `out` path in the task.
5. When every output exists: `python3 -I bench/rules-ab/bench.py judges --suite seeded --truth <truth dir>`
   Builds blind judge inputs (`judge/hNN.in.json`: truth, decoys, candidate findings; arm and rep hidden, ids shuffled) and judge task files, and writes the id-to-arm key to `.work/<run>/sealed/key.json`.
6. Dispatch judges: one agent per `judge/hNN.task.md`. Judges must not read `sealed/`. Each writes `judge/hNN.out.json`.
7. `python3 -I bench/rules-ab/bench.py score --suite seeded` prints per arm: recall per rep and mean, cands, valid, noise, decoy, control findings, and mean recall per case. Same formulas as the original runs.
8. Remove the case worktrees (`git worktree remove`) when done. `.work/` is git-ignored.

History runs use `--suite history` the same way; `score` prints match / partial / miss and found %.

## Truth and keys: where they are and why they are not here

The planted defects, decoys and the history findings are the answer key. They are kept out of `main` so a reviewer working in a checkout of `main` cannot read them. They live on the research branch (`research/part2-data`) under `bench-archive/2026-11-14/`:

- seeded truth: `qbench/truth/qNN.json` and `qNN.decoys.json`
- history truth: `bench/truth/cNN.json` (findings with reviewer names stripped; the full corpus is `bench/corpus.json`)
- old arm keys: `sealed/`

Check that branch out in a separate directory and pass it with `--truth <that checkout>/bench-archive/2026-11-14` (or the `qbench/truth` or `bench/truth` folder itself), or set `KERYX_BENCH_TRUTH`. Never place the checkout inside a reviewer's snapshot. New runs' sealed keys stay in `.work/<run>/sealed/` and are not committed.

## Cost per arm

- seeded: 5 cases x reps reviewer runs, plus as many judge runs (3 reps: 15 + 15).
- history: 13 reviewer runs + 13 judge runs per rep. History diffs are large (up to about 340 KB), so these runs are slower and more expensive than seeded ones.

## Past results (2026-11-14)

Seeded suite, 3 reps, means per rep (recall out of 24):

| Arm | Recall | Valid | Noise |
|---|---|---|---|
| QB: current lens | 22.33 | 6 | 12.67 |
| QN: new rules | 22.17 | 5 | 11.67 |
| QD: + old-debt rule | 22.0 | 6 | 8.33 |
| QE: + I/O-with-transform row (shipped) | 22.67 | 7.0 | 9.33 |
| QF: 220-line decision-table lens | 23.0 | 7.67 | 9.33 |

History suite: one general reviewer against the fixed blocker/major findings found 14 match + 6 partial of 46, about 37%.

## Notes

- The seeded and history briefs are in `suites/<suite>/`. `cases.json` lists each case's base, head and kind (seeded, control, history).
- Python 3 standard library only; run with `python3 -I` so a stray module in the current directory is not imported.
