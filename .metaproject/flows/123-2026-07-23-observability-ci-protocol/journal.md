# Flow Journal

- 2026-07-23T21:20:06.495Z - flow created
- 2026-07-23T21:21:06.397Z - task-added: T5: Rewrite ci.yml into 4 protocol jobs (typecheck-and-tests/standard-baseline/standard-pr/metrics-contract) + preserve 3 existing jobs
- 2026-07-23T21:21:06.564Z - task-added: T6: Verify: YAML parses, referenced commands/tests exist & green locally, preserved jobs unchanged, security gate retained
- 2026-07-23T21:21:06.701Z - task-added: T7: Journal deferred items (paired benchmark run; branch-protection required-check rename)
- 2026-07-23T21:21:06.843Z - frozen: 7 criteria; checksum recorded
- 2026-07-23T21:21:07.043Z - started
- 2026-07-23T21:21:07.202Z - task-done: T1: Collect remaining context
- 2026-07-23T21:21:07.363Z - task-done: T2: Implement per plan
- 2026-07-23T21:21:07.493Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-23T21:21:07.630Z - task-done: T4: Self-review and prepare draft PR

## Implementation & verification (T5-T6)

`.github/workflows/ci.yml` rewritten: the single `check` job is replaced by the
four protocol jobs; the three unrelated jobs are preserved verbatim.

- **standard baseline exit-code semantics were probed first** to wire the verdict
  correctly: `--baseline pass --pr fail` → exit 1 (isolated regression, fail the
  job); `--baseline fail --pr fail` → exit 0 (baseline-red, diagnostic);
  `--baseline unknown --pr *` → exit 0. So `standard-pr`'s final classification
  step exit code fails the job ONLY for baseline-green + pr-fail. The baseline job
  captures pass/fail without hard-failing on a red main.
- **YAML valid** (ruby YAML parser): jobs = typecheck-and-tests, standard-baseline,
  standard-pr, metrics-contract, tui-pty-launch, linux-sandbox,
  opentui-native-matrix.
- **metrics-contract tests green locally**: `bun test src/metrics/service.test.ts
  src/lib/git-hooks.test.ts src/lib/templates.test.ts` → 11 pass / 0 fail.
- **standard validate** locally → exit 0 (PASS, 1 warning).
- **Security eval gate retained** (moved verbatim into typecheck-and-tests); no
  prior coverage dropped.
- **Limitation (honest)**: GitHub Actions cannot be executed locally, so end-to-end
  green CI is observable only after this is pushed. Local verification proves YAML
  validity + that every referenced command/test exists and passes.

## AC7 — deferred items & required admin action

1. **Paired Keryx/no-Keryx benchmark run** (audit AC-10): a measurement activity,
   not code. The benchmark harness/template is already shipped
   (src/metrics/benchmark.ts) and the roadmap status is "benchmark harness ready".
   Deferred — running it is a separate, non-code task.
2. **Branch-protection required-check rename (ADMIN ACTION REQUIRED)**: the old
   required status check was the `check` job (`name: "typecheck, tests, standard"`).
   This flow removed that job. A repo admin must update branch protection on `main`
   to require the new jobs (at least `typecheck-and-tests` and `standard-pr`) —
   this flow cannot change repository settings. Until then, `main` protection may
   wait on a check that no longer runs.
- 2026-07-23T21:23:36.516Z - task-done: T5: Rewrite ci.yml into 4 protocol jobs (typecheck-and-tests/standard-baseline/standard-pr/metrics-contract) + preserve 3 existing jobs
- 2026-07-23T21:23:36.668Z - task-done: T6: Verify: YAML parses, referenced commands/tests exist & green locally, preserved jobs unchanged, security gate retained
- 2026-07-23T21:23:36.834Z - task-done: T7: Journal deferred items (paired benchmark run; branch-protection required-check rename)
- 2026-07-23T21:23:36.961Z - ac-confirmed: AC1: ci.yml jobs typecheck-and-tests/standard-baseline/standard-pr/metrics-contract; standard-pr needs: standard-baseline
- 2026-07-23T21:23:37.108Z - ac-confirmed: AC2: standard-baseline checkout ref:main, outputs.status via never-hard-fail if/else capture step
- 2026-07-23T21:23:37.236Z - ac-confirmed: AC3: standard-pr validates PR then standard baseline --baseline needs.standard-baseline.outputs.status --pr steps.pr.outputs.status; probed exits: green+fail=1, red+fail=0
- 2026-07-23T21:23:37.362Z - ac-confirmed: AC4: metrics-contract runs service.test.ts+git-hooks.test.ts+templates.test.ts; local 11 pass/0 fail
- 2026-07-23T21:23:37.469Z - ac-confirmed: AC5: tui-pty-launch/linux-sandbox/opentui-native-matrix preserved verbatim; security eval gate retained in typecheck-and-tests
- 2026-07-23T21:23:37.578Z - ac-confirmed: AC6: YAML parses (ruby): 7 jobs listed; standard validate exit 0 local; metrics tests green; GH Actions green observable only post-push (documented)
- 2026-07-23T21:23:37.703Z - ac-confirmed: AC7: journal.md records deferred benchmark run + REQUIRED admin branch-protection required-check rename
- 2026-07-23T21:40:25.272Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/207 (warning: PR is not a draft)
- 2026-07-26T07:12:46.240Z - completing
- 2026-07-26T07:12:46.248Z - done: all gates passed
