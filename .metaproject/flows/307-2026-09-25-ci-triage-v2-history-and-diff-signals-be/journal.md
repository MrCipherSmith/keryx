# Flow Journal

- 2026-09-25T08:57:06.898Z - flow created
- 2026-09-25T08:57:20.168Z - frozen: 10 criteria; checksum recorded
- 2026-09-25T08:57:20.277Z - started
- 2026-09-25 - AC5/AC6 evaluation set: 8 labelled failed CI jobs from
  MrCipherSmith/keryx (4 real-regression, 3 flaky, 1 infra), checked against
  `gh run view --json jobs` and each job's real `--log-failed` text. All 5
  operator-supplied 2026-09-25 labels confirmed correct as given (no relabel
  needed) — evidence: c1/c6 `trigger-dispatch.test.ts:766`
  `providerReportsUsage("deepseek")` expected false, received true; c2b
  `commands.test.ts` "command registry coverage" missing
  `__sandbox-net-forward`; c3 "the core gate and the client matrix between
  them run every test in src/"; c2a/c4 `schedules-sidebar.test.ts` AC11
  (SAME test, two different job-matrix legs — darwin-x64 and linux-x64 — on
  two different runs); c5 `provider-endpoint-retry.test.ts` "timed out after
  5000ms". Two further cases found in CI history, both with clear evidence:
  c6 (35865793959, main directly) is the SAME deepseek regression as c1, one
  push earlier, before the fix — genuine corroborating cross-branch-history
  evidence. c7 (35897000167, "macOS real-host legs") is a self-hosted-runner
  `bun install` failure ("failed to enqueue lifecycle scripts for
  protobufjs: ParserError") — infra, not code.
- 2026-09-25 - AC6 live evaluation against the real runs above (`keryx
  review ci-triage --eval src/commands/fixtures/ci-triage-eval/manifest.json
  --live --repo MrCipherSmith/keryx`, from a scratch project dir with
  `review.jev.ci_triage: true`, `env -u OPENROUTER_API_KEY`, the saved
  OpenRouter key): **before (flow 306, log only): 4/8 = 50% correct,
  $0.000771. after (flow 307, log + signals): 4/8 = 50% correct, $0.000829.**
  Raw accuracy did not improve on this sample — signals fixed one case
  (c3: infra→real-regression, correct; diff proximity/history evidence
  outweighed a thin log excerpt) and broke another (c5: flaky→real-regression,
  now wrong, despite the log's own "timed out after 5000ms" marker firing —
  the rewritten prompt's emphasis on diff-proximity/history for
  real-regression plausibly pulled the model away from a clear timeout
  signal it already had). c1/c6 are the identical underlying regression
  (same test, same root cause, two different CI runs) and Jev answered them
  DIFFERENTLY before signals (c1 correct, c6 wrong — flaky) — a reminder
  that Jev's own answer is not perfectly consistent run-to-run even holding
  the failure constant. No case in this set had deterministic-evidence
  (AC8) fire: none of the 8 cases were ever actually rerun in CI history —
  every real fix landed as a new commit, not a rerun — so the deterministic
  override path is unit-tested (`src/review/ci-triage.test.ts`) but never
  exercised end-to-end against a real historical case here. 17 live Jev
  calls total (1 smoke check + 16 for the 8-case before/after eval),
  combined cost ≈$0.0017, well under the ~60-call/$0.01 budget. Honest
  conclusion: the flow 307 signals give the operator more to look at
  (evidence lines, a same-run/same-head rerun check that AC8 can act on when
  it fires) but did not, on this 8-case sample, move top-1 accuracy — the
  classifier remains a hint, not a diagnosis, exactly as flow 306's own docs
  already said. A larger/live-drawn sample and prompt-wording iteration are
  the obvious next steps, out of scope for this flow's frozen ACs.
- 2026-09-25 - a known signal gap found while building the evaluation set:
  the cross-branch-history signal (AC1(b)) matches candidate runs by JOB
  NAME. c2a/c4 are the SAME test (`schedules-sidebar.test.ts` AC11) failing
  on two DIFFERENT job-matrix legs (`opentui native (darwin-x64)` vs.
  `opentui native (linux-x64)`) across two real runs — the signal as built
  does not correlate them, because it never looks past an exact job-name
  match. Left as a documented limitation (`docs/docs/cli-reference.md`)
  rather than widened, since AC1(b) was scoped to "other recent runs" of the
  same workflow, not a cross-job-leg correlation, and widening it changes
  the read surface AC1 froze.
- 2026-09-25T11:27:12.822Z - task-done: T1: Collect remaining context
- 2026-09-25T11:27:12.947Z - task-done: T2: Implement per plan
- 2026-09-25T11:27:13.060Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-25T11:27:17.323Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-25T11:29:05.930Z - ac-confirmed: AC1: src/review/ci-triage.ts: every signal computed through the read-only CiPort (src/review/ci-port.ts, three-then-six read-only methods, no write) and git show; comment at ci-triage.ts:309 ties this to AC1/AC2 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:06.055Z - ac-confirmed: AC2: src/review/ci-triage.ts:88 buildCiTriageState places the labelled signals block above the redacted log excerpt within the 64k budget; questions rewritten at ci-triage.ts:93,97 to point at it; docs/docs/cli-reference.md:3807-3810 describes the placement (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:06.176Z - ac-confirmed: AC3: src/commands/review.ts:1436 MAX_JOBS_TRIAGED=10; :1461-1470 triages every failedJobs entry by default (jobArg undefined -> filter conclusion==failure), --job narrows to one, notTriaged lists the rest; docs/docs/cli-reference.md:3739,3748-3758 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:06.296Z - ac-confirmed: AC4: src/tui/ci-triage-inspector.ts:50-58 signalLines carries the same deterministic-signal evidence lines the CLI prints into the /ci detail view; verdict stays ADVISORY ONLY (docs/docs/cli-reference.md:3773-3774) (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:06.608Z - ac-confirmed: AC5: src/commands/fixtures/ci-triage-eval/{manifest.json,cases/} holds the labelled redacted fixture set (8 cases, 2026-09-25); --eval implemented at src/commands/review.ts:1441-1444 (runCiTriageEval) and documented docs/docs/cli-reference.md:3745,3859 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:06.727Z - ac-confirmed: AC6: Live --eval run recorded in .metaproject/flows/307-*/journal.md:28-46 (before 4/8=50% $0.000771, after 4/8=50% $0.000829) and honestly stated in docs/docs/cli-reference.md:3835-3857 (Measured accuracy section, same numbers, per-case gaps explained) (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:06.846Z - ac-confirmed: AC7: src/harness/decision/jev-client.ts:176-193 JevAuthRejectedError; :410 throw new JevAuthRejectedError(keyResolution.source, status, text, looksLikeOpenRouterKey(apiKey)) names env var vs saved key and the sk-or- prefix check without printing the key; covered by src/harness/decision/jev-client.test.ts:153-169 for both sources (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:06.969Z - ac-confirmed: AC8: src/review/ci-triage.ts:610-687 job-level deterministic override (matches by jobName, not run level); ambiguity guard :628-654 (sameHeadJobNameAmbiguous when matchingJobs.length>1, no override) and pagination guard :636-645,669-673 (sameHeadCurrentRunMissing when the triaged run's own entry is absent from the paginated runsForHeadSha page) added in PR #713 followups; Jev probabilities still shown beside DETERMINISTIC verdict per docs/docs/cli-reference.md:3812-3816 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:07.284Z - ac-confirmed: AC9: docs/docs/cli-reference.md:3723-3858 review ci-triage section (signals, MAX_JOBS_TRIAGED=10 cap, opt-in gate, deterministic override, known gaps, measured accuracy), all in English; docs/docs/cli-reference.md:3224 ci-triage row in the subcommand table (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:07.402Z - ac-confirmed: AC10: gh pr view 710/713 --repo MrCipherSmith/keryx: both state=MERGED, statusCheckRollup conclusions {SUCCESS,SKIPPED} only (no failures); keryx health run: PASS, project score 94, no gate conditions triggered (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-25T11:29:12.884Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/710 (warning: PR is not a draft) (base: main)
- 2026-09-25T11:34:31.388Z - completing
- 2026-09-25T11:34:35.428Z - completion-attempt-recorded: attempt 1: failed
- 2026-09-25T11:34:35.428Z - completion-failed: owner: no owner set; run `keryx flow owner set <id> --owner "<name>" --reason "<why>"` | review: 1 of 5 conditions failed — head-commit (violated): the latest round ran against 2aaf8372d51e418005f866f630e2943cb307f09c, but the PR head is ca98eadf419ebc00edebbb8c5a39581aa2c67d91. A clean round against a stale SHA proves nothing about what will merge — re-run the round.
- 2026-09-25T11:35:49.296Z - owner-set: not set -> altsay (human accountable for closing flow 307 (matches the owner convention used across this project's other flows))
- 2026-09-25T11:36:56.562Z - completing: merged commit: 2aaf8372d51e418005f866f630e2943cb307f09c
- 2026-09-25T11:37:00.400Z - completion-attempt-recorded: attempt 2: passed
- 2026-09-25T11:37:00.401Z - done: all gates passed
