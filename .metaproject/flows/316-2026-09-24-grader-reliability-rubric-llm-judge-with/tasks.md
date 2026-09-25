# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | Judge core, eval engine trial records and regrade, gate hardening (judge.ts, eval.ts, gate-policy.ts + gate fixtures) |
| T6 | implement | CLI judge adapter: model-eval-judge.ts, skills eval --judge, skills judge-check --record |
| T7 | implement | Migrate ts-js-node evals.json (5 skills) to rubric judge scenarios with calibration |
| T8 | implement | Migrate react evals.json (5 skills) to rubric judge scenarios with calibration |
| T9 | implement | Migrate python evals.json (4 skills) to rubric judge scenarios with calibration |
| T10 | implement | Migrate go evals.json (4 skills) to rubric judge scenarios with calibration |
| T11 | test | Integrity guard I6-I9 and anti-gaming harness over recorded verdicts, plus opt-in live test |
| T12 | verify | Live calibration: judge-check --record for all 18 skills, every canned verdict correct |
| T13 | verify | Honest gate run: 18 skills via real CLI with runner+judge DeepSeek, eval.json from raw outputs only |
| T14 | verify | AC9 evidence: re-grade recorded DeepSeek outputs of the three zero-scoring suppression scenarios under the old graders |
| T15 | implement | Apply gate outcome: stability, agent pairs via agents generate, manifests, agent-refs notes, shipped-state tests |
| T16 | docs | Docs: W1/W2, CLI reference, rubric-authoring and anti-gaming guide |
| T17 | review | Adversarial review (opus) incl. judge-gaming attempts; fix loop |
| T18 | verify | PR CI green and merge into feat/agent-platform-expansion |
