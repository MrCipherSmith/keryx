# Flow Journal

- 2026-10-10T21:17:59.701Z - flow created
- 2026-10-10T21:18:37.575Z - frozen: 7 criteria; checksum recorded
- 2026-10-10T21:18:37.698Z - started
- 2026-10-10T21:18:37.820Z - task-done: T1: Collect remaining context
- 2026-10-10T21:18:37.942Z - task-done: T2: Implement per plan
- 2026-10-10T21:18:38.062Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-10T21:18:38.182Z - task-added: T5: Parser, ac kinds counts, ac confirm warning (AC1-AC4)
- 2026-10-10T21:18:38.302Z - task-added: T6: Skills failure-scenario line, sync-status share, docs (AC5 AC6)
- 2026-10-10T21:18:38.425Z - task-added: T7: Run every AC command and AC7 invariant
- 2026-10-10T21:19:12.133Z - task-attempt: T5: started (attempt 1) — 423-T5
- 2026-10-10T21:19:12.267Z - task-attempt: T6: started (attempt 1) — 423-T6

## Lane results and verification (2026-10-10)

- T5 (DONE): syntax `[verify: exec|invariant \`<cmd>\` · sensitive: revert|mutation|failure-scenario]`, ASCII `;` also accepted; a note on `judged`/`none`, an unknown value, a wrong key or an empty note is a parser error (reads `unclassified`). `AcKindReport.sensitivity = {proven, unproven, byValue}`; `ac kinds` text and `--json` carry it. `ac confirm` warns after a successful confirm when a noted criterion's `--note` has no sha/path/URL token; command layer only. sync-status line after the unclassified line, no threshold.
- T6 (DONE): one sentence appended to the criteria rule in flow-init step 7 and both flow-orchestrator copies (694 lines, at the ceiling); phrases pinned; cli-reference and CHANGELOG.
- Typecheck (first time in this program with node_modules linked into the worktrees): found a TS2345 in flow 422's `verify-kind-creation-paths.test.ts` (readonly argv); fixed on the 422 branch (98471d768) and merged here. `tsc --noEmit` exit 0.
- T7, with `GIT_TEMPLATE_DIR` set: AC1 19/0; AC2 67/0; AC3 in the AC2 run; AC4 6/0; AC5 7940/1 (the known clean-main failure: retired rule in a read-only dir); AC6 41/0; import-policy, ac-kinds surface, governance, docs, cli-reference coverage 91/0; AC7 diff empty.
- 2026-10-10T21:26:23.353Z - task-done: T5: Parser, ac kinds counts, ac confirm warning (AC1-AC4)
- 2026-10-10T21:26:23.498Z - task-done: T6: Skills failure-scenario line, sync-status share, docs (AC5 AC6)
- 2026-10-10T21:26:23.622Z - task-done: T7: Run every AC command and AC7 invariant
- 2026-10-10T21:26:23.750Z - task-attempt: T4: started (attempt 1) — review round 1
- 2026-10-10T21:28:04.468Z - task-added: T8: Fix review round 1 findings (RL-1..3, T1..T6)
- 2026-10-10T21:28:04.602Z - task-attempt: T8: started (attempt 1) — 423-T8
- 2026-10-10T21:33:49.877Z - task-attempt: T4: failed (attempt 2) — round 2: RL2-1..3 minor, all evidence-heuristic false positives/negatives; round-1 findings all fixed
- 2026-10-10T21:38:38.500Z - task-attempt: T8: started (attempt 2) — 423-T8 round 2: evidence rule redesigned (filesystem paths)

## Re-plan: evidence check (2026-10-11)

Three review rounds in a row found new false positives/negatives in the inferred evidence check of `ac confirm` (round 1: `n/a`, `defaced`; round 2: all-digit numbers, prose triples, `README.md`, Windows paths; round 3: case-insensitive filesystem matching `license`/`install`, Markdown links, `~/`, nested workspace roots). Guessing evidence from free text does not converge. Operator decision (2026-10-11, asked in session): replace inference with an explicit label. The warning is silent when the note contains `evidence: <ref>` with a non-empty ref other than `n/a`/`none`/`-`; no filesystem, sha or URL guessing. Skills and docs tell the writer to use the label. Trade-off accepted: a label can be written formally, but it is visible and a human can check it.
- 2026-10-11T07:27:53.446Z - task-attempt: T4: failed (attempt 3) — round 3: 4 minor, all in the inferred evidence check; re-planned to explicit evidence: label (operator decision)
- 2026-10-11T07:27:53.608Z - task-attempt: T8: started (attempt 3) — 423-T8 round 3: explicit evidence: label

## Review rounds

- Round 1 (review-logic on opus, review-testing-practices on sonnet): 3 medium test gaps, 3 low; 2 minor + 1 info logic (evidence heuristic false positives, punctuation, counts not from the `ac kinds` report). Fixed in b0f5af769.
- Round 2 (opus, fix commit): all round-1 findings fixed; 3 minor, all in the evidence heuristic. Redesigned to filesystem paths in ad2f6d1fe.
- Round 3 (opus): 4 minor, again all in the inferred evidence check. Re-planned (see above) to an explicit `evidence:` label, 1d941c3a5.
- Round 4 (opus): approved; 2 minor (placeholders wrapped in punctuation, the `<ref>` template counted). Fixed in ddbb54391; the orchestrator verified every round-4 case by a direct probe of `noteNamesEvidence` and the pinned test table, rather than spending a fifth reviewer round on a two-line change.
- Final verification after ddbb54391: AC suites 8182 pass, 1 fail (the known clean-main failure in `src/gdskills/install.test.ts`); `tsc --noEmit` exit 0; AC7 diff empty.
- 2026-10-11T07:38:28.733Z - task-done: T8: Fix review round 1 findings (RL-1..3, T1..T6)
- 2026-10-11T07:38:28.875Z - task-attempt: T4: started (attempt 4) — round 4 approved; minors fixed and probed
- 2026-10-11T07:38:29.013Z - task-done: T4: Self-review and prepare draft PR
- 2026-10-11T08:29:30.194Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/964 (warning: PR is not a draft)
- 2026-10-11T08:29:30.378Z - ac-confirmed: AC1: evidence: src/flow/ac-kinds.test.ts (accept on exec/invariant, reject on judged/none, old forms unchanged); PR #964 CI green (signed: claude-agent (session 2026-10-11) [stated])
- 2026-10-11T08:29:30.525Z - ac-confirmed: AC2: evidence: src/commands/flow-sensitivity.test.ts ac kinds text and --json counts; PR #964 CI green (signed: claude-agent (session 2026-10-11) [stated])
- 2026-10-11T08:29:30.724Z - ac-confirmed: AC3: evidence: src/commands/flow-sensitivity.test.ts table-driven ac confirm cases; PR #964 CI green (signed: claude-agent (session 2026-10-11) [stated])
- 2026-10-11T08:29:30.889Z - ac-confirmed: AC4: evidence: src/flow/ac-kinds-never-gates.test.ts noted-vs-plain twin test; PR #964 CI green (signed: claude-agent (session 2026-10-11) [stated])
- 2026-10-11T08:29:31.045Z - ac-confirmed: AC5: evidence: src/gdskills/flow-orchestrator-verify-kind.test.ts and src/flow/templates.test.ts phrase pins, copies byte-identical; PR #964 CI green (signed: claude-agent (session 2026-10-11) [stated])
- 2026-10-11T08:29:31.207Z - ac-confirmed: AC6: evidence: src/commands/research-sync-kinds.test.ts sensitivity share incl. 7-day window and runResearchSync wiring; PR #964 CI green (signed: claude-agent (session 2026-10-11) [stated])
- 2026-10-11T08:29:31.368Z - ac-confirmed: AC7: evidence: git diff of #964 touches no flow dir other than 423 (plus one wiki link fix) (signed: claude-agent (session 2026-10-11) [stated])
- 2026-10-11T08:29:40.996Z - completing
- 2026-10-11T08:29:45.655Z - completion-attempt-recorded: attempt 1: failed
- 2026-10-11T08:29:45.657Z - completion-failed: review: 5 of 5 conditions failed — ingested-round (unobserved): no managed review package exists under `.metaproject/flows/423-2026-10-10-verify-sensitivity/reviews/`. A flow with no recorded review has not been reviewed cleanly; it has not been reviewed. | terminal-dispositions (unobserved): no ingested round to read findings from | head-commit (unobserved): no ingested round to compare against the PR head | external-comments (unobserved): the external-comment collection did not run: nothing records whether anyone commented on MrCipherSmith/keryx#964 (`.metaproject/reviews/pr-comments/MrCipherSmith__keryx__964.json` does not exist). Zero collected comments and no collection at all are different facts, and only one of them is clean. Run `keryx review comments collect --repo MrCipherSmith/keryx --pr 964 --sha <pr-head>`, or inject `FlowServiceDeps.externalCommentsGate` with a collector of your own. | verifier-stats (unobserved): no ingested round to read verification stats from | health: no report; run `keryx health run` first
