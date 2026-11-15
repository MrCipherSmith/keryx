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

**backend** (4 cases). A small NestJS + TypeORM service (`services/orders-api`) added on top of `main` at the base commit; b01 (API contracts), b02 (DTOs) and b03 (database and migrations) each add a feature with planted defects, 21 in all; b04 is a clean control. Scored like seeded (recall out of 21, valid, noise, decoy, control findings). Use it for `review-backend` and the `api-contracts`, `nestjs-dto` and `database-patterns` rules. The case commits live on branches `bench-seeds/backend-*`; the diffs in `suites/backend/diff/` hold the same change if those refs are lost.

**frontend** (4 cases). A small React + MobX + Ant Design app (`apps/orders-web`) added on top of `main` at the base commit; f01 (stores), f02 (components) and f03 (TypeScript and stories) each add a feature with planted defects, 24 in all; f04 is a clean control. Scored like seeded (recall out of 24). Use it for `review-frontend` and the `mobx-store-template`, `code-style-patterns` and `storybook-guidelines` rules. The case commits live on branches `bench-seeds/frontend-*`; the diffs in `suites/frontend/diff/` hold the same change.

**testing** (4 cases). Tests for the two small apps (`services/orders-api`, `apps/orders-web`) on a base commit that holds both; t01 (API unit tests), t02 (web unit tests) and t03 (Playwright e2e) carry planted test defects, 24 in all; t04 is a clean control. Scored like seeded (recall out of 24). Use it for `review-testing-practices` and the testing rules. The case commits live on branches `bench-seeds/testing-*`; the diffs in `suites/testing/diff/` hold the same change. Truth: `bench-archive/2026-11-15/tbench/truth/tNN.json` and `tNN.decoys.json`.

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

`setup --cases c06,c07,...` runs only the named cases. Use it when a change touches one topic: for security, c06 c07 c09 c10 c11 hold the security findings; for async and races, c12 c13.

## Truth and keys: where they are and why they are not here

The planted defects, decoys and the history findings are the answer key. They are kept out of `main` so a reviewer working in a checkout of `main` cannot read them. They live on the research branch (`research/part2-data`) under `bench-archive/2026-11-14/`:

- seeded truth: `qbench/truth/qNN.json` and `qNN.decoys.json`
- backend truth: `bench-archive/2026-11-15/bbench/truth/bNN.json` and `bNN.decoys.json`
- frontend truth: `bench-archive/2026-11-15/fbench/truth/fNN.json` and `fNN.decoys.json`
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

Backend suite (2026-11-15), 3 reps, means per rep (recall out of 21):

| Arm | Recall | Valid | Noise | Decoy | Control findings |
|---|---|---|---|---|---|
| A: `review-backend` as on main, no rules | 17.83 | 5.33 | 7.33 | 1.0 | 3.33 |
| B: `review-backend` reading `api-contracts`, `nestjs-dto`, `database-patterns` (shipped) | 20.33 | 4.67 | 6.67 | 0.67 | 2.67 |

The gain is mostly b02 (DTOs): 4.17 to 6.33 of 7.

Frontend suite (2026-11-15), 3 reps, means per rep (recall out of 24):

| Arm | Recall | Valid | Noise | Decoy | Control findings |
|---|---|---|---|---|---|
| A: `review-frontend` as on main, no rules | 19.67 | 4.67 | 8.67 | 0.33 | 5.33 |
| B: `review-frontend` reading `mobx-store-template`, `code-style-patterns`, `storybook-guidelines` (shipped) | 23.0 | 3.33 | 5.67 | 0 | 3.0 |

Per case, A to B: f01 (stores) 7.17 to 8, f02 (components) 6.33 to 7, f03 (TypeScript and stories) 6.17 to 8 of 8.

Other lenses pointed at the rules (2026-11-15), 2 reps each. Arm A is the lens as on main with no rules; arm B is the lens that reads the rules (shipped):

| Lens, suite | Arm | Recall | Valid | Noise | Decoy | Control findings |
|---|---|---|---|---|---|---|
| `review-frontend-conventions`, frontend (/24) | A | 18.75 | 3 | 9.5 | 1.5 | 5 |
| | B | 23.0 | 6 | 6.5 | 0 | 5 |
| `review-performance`, frontend (/24) | A | 9.5 | 5 | 5.5 | 0 | 2.5 |
| | B | 20.75 | 3 | 8 | 0.5 | 2.5 |
| `review-architecture`, backend (/21) | A | 15.0 | 4.5 | 11 | 1.5 | 4.5 |
| | B | 17.75 | 9 | 10 | 2 | 4.5 |

`review-performance` gains most because the rules carry the store and render rows it had no checklist for; its noise rises by 2.5 per rep. `review-style` was not measured.

Testing suite (2026-11-15), 2 reps, means per rep (recall out of 24):

| Arm | Recall | Valid | Noise | Decoy | Control findings |
|---|---|---|---|---|---|
| A: `review-testing-practices` as on main, no rules | 22.5 | 5.5 | 6.5 | 0.5 | 6 |
| B: `review-testing-practices` reading `tdd-workflow`, `playwright-testing` (shipped) | 23.25 | 3.5 | 6.5 | 0 | 4.5 |

Both arms are near the ceiling, so this suite separates them weakly; B never took a decoy and raised fewer findings on the clean control.

SOLID and architecture rules (2026-11-15), seeded suite, 2 reps. Arm A is the lens and its rules as on main; arm B is this change:

| Lens | Arm | Recall /24 | Valid | Noise | Decoy | Control findings |
|---|---|---|---|---|---|---|
| `review-clean-code` | A | 22.0 | 2 | 10.5 | 0 | 5.5 |
| | B | 22.75 | 2 | 8 | 0 | 5.5 |
| `review-style` | A | 22.5 | 2 | 13 | 0 | 7.5 |
| | B | 18.75 | 2.5 | 10 | 0 | 5 |

`review-style` B misses more than A only on what it no longer owns: the LSP override, constructor I/O, the branch chain, the magic literal, mixed I/O and the stale comment now belong to `review-clean-code`, which still finds them. Both lenses report less noise.

Highload lens and `concurrency-patterns` (2026-11-16), 2 reps. Arm A is `review-highload` (471 lines) with its rules as on main; arm B is the 328-line lens that points at `api-contracts`, `error-handling`, `async-patterns`, `database-patterns` and the new `concurrency-patterns`:

| Suite, cases | Arm | Recall | Valid | Noise | Decoy | Control findings |
|---|---|---|---|---|---|---|
| backend b01, b03 + control b04 (/14) | A | 13.75 | 4.5 | 5.5 | 1.5 | 4 |
| | B | 13.5 | 4.5 | 4.5 | 1.5 | 3 |
| history c12, c13 (/5) | A | 0.5 | | | | |
| | B | 0.75 | | | | |

The trim loses no recall within run-to-run variation (one b01 item, 0.25 per rep) and reports less noise. History c12/c13 (races) stays at the floor for both arms, so it cannot separate them; a dedicated concurrency suite would be needed for that.

History suite: one general reviewer against the fixed blocker/major findings found 14 match + 6 partial of 46, about 37%.

## Notes

- The seeded and history briefs are in `suites/<suite>/`. `cases.json` lists each case's base, head and kind (seeded, control, history).
- Python 3 standard library only; run with `python3 -I` so a stray module in the current directory is not imported.
