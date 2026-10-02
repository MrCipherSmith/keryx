# Flow Journal

- 2026-09-28T22:38:15.355Z - flow created
- 2026-09-28T22:38:53.812Z - frozen: 13 criteria; checksum recorded
- 2026-09-28T22:38:54.154Z - started
- 2026-09-28T23:55:00.000Z - AC9 format ergonomics (the awkward lines). The marker held on all 13 lines, six of which are honestly awkward:
  - AC2 has the literal text `[verify: …]` in its prose. It only works because the parser masks inline code spans, so the sentence had to keep it in backticks.
  - AC3 needed a long parenthetical, "(written and green before any other code in this flow)", inside the criterion, because the ordering constraint has no field of its own.
  - AC4 is an `invariant`, and the criterion states an invariant ("no code path refuses") that the command can only sample; the file it points at is the closest thing to a proof.
  - AC7 is a `governance report` criterion with a compound claim (coverage per flow AND a legacy flow reads unclassified); one marker cannot point at both halves.
  - AC9 is `none`, and its reason is a whole clause. An em dash is required and easy to mistype as a hyphen, which the parser rejects by design.
  - AC12 is an exec of `grep -q 'not measured —' …`: it carries an em dash and a single-quoted string inside a backticked command, the widest line in the file.
  Review of the PR found the parser accepted a marker followed by a code span (masked text anchor); fixed. One process lesson: I ran only the affected test files before pushing and CI caught two help-output pins (cli.test.ts) that a new subcommand and a new help paragraph must join.
  Decision recorded: the verification field lives in the PRD contract (spec table and prd R4), not the Specification contract; both bundled and .metaproject copies say so.
- 2026-09-28T23:53:12.343Z - task-done: T1: Collect remaining context
- 2026-09-28T23:53:12.705Z - task-done: T2: Implement per plan
- 2026-09-28T23:53:13.055Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-28T23:53:13.391Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-28T23:53:15.771Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/792 (warning: PR is not a draft) (base: main)
- 2026-09-28T23:54:23.610Z - ac-confirmed: AC1: ac-kinds.test.ts: all four markers plus an unmarked line report the five kinds with counts and records; flow ac kinds verified live on the branch (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:23.890Z - ac-confirmed: AC2: ac-kinds-errors.test.ts: second marker, exec/invariant without a backticked command, bare none each name the criterion id and exit non-zero; review round added trailing-content cases (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:24.051Z - ac-confirmed: AC3: ac-kinds-corpus.test.ts written first against the real corpus: zero parse errors, every unmarked criterion unclassified; a checked-in fixture set covers CI where flow dirs are untracked (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:24.212Z - ac-confirmed: AC4: ac-kinds-never-gates.test.ts: an all-none flow freezes, confirms and completes exactly like an unmarked twin; gate files fail the test if absent or if they reference a kind (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:24.374Z - ac-confirmed: AC5: check-ac.test.ts: tokens and classification receive the text without the marker, facts are byte-identical; review round extended it to the question sent to the model (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:24.529Z - ac-confirmed: AC6: ac-reseal.test.ts: mutating a kind and re-updating changes checksum and acKinds; review round made acReseal re-derive acKinds too (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:24.684Z - ac-confirmed: AC7: governance.test.ts: coverage line per flow; a flow predating the field reads fully unclassified, an unfrozen flow reads not frozen yet (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:24.842Z - ac-confirmed: AC8: read against the diff: rule and docpack SKILL state the per-requirement verification field and the Verify phase fails a requirement without it, naming it; field placed in the PRD contract per the spec after review; both copies identical (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:24.996Z - ac-confirmed: AC9: journal entry lists the six awkward lines (AC2, AC3, AC4, AC7, AC9, AC12); AC9 itself is an honest none (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:25.155Z - ac-confirmed: AC10: typecheck clean; src/flow suite green on the branch and in CI (typecheck-and-tests passed, 18/18 checks on b1fa4d32) (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:25.311Z - ac-confirmed: AC11: read against the diff: PRD success contract split into release and outcome lists, outcome criteria name an observation or declare not measured, Verify fails a package with no outcome list and accepts an all-not-measured one (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:25.463Z - ac-confirmed: AC12: grep of the package PRD passes: the outcome list has honest not measured entries with reasons (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:25.617Z - ac-confirmed: AC13: ac-kinds-surface.test.ts asserts the rendered AC-tab rows and the distribution line; review round added the not-frozen-yet label (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-28T23:54:31.928Z - completing
- 2026-09-28T23:54:35.990Z - completion-attempt-recorded: attempt 1: failed
- 2026-09-28T23:54:35.991Z - completion-failed: review: 2 of 5 conditions failed — head-commit (violated): the latest round ran against 8352f04ff50b10bba76ee0a72da9b74d2a150f2d, but the PR head is b1fa4d325199062f7c0649621d12a4bfd3b9273b. A clean round against a stale SHA proves nothing about what will merge — re-run the round. | external-comments (unobserved): the external-comment collection did not run: nothing records whether anyone commented on MrCipherSmith/keryx#792 (`.metaproject/reviews/pr-comments/MrCipherSmith__keryx__792.json` does not exist). Zero collected comments and no collection at all are different facts, and only one of them is clean. Run `keryx review comments collect --repo MrCipherSmith/keryx --pr 792 --sha <pr-head>`, or inject `FlowServiceDeps.externalCommentsGate` with a collector of your own.
- 2026-09-28T23:55:01.044Z - completing: merged commit: d454c3a8f08140bca720576735aad7b1368aa8e9
- 2026-09-28T23:55:05.171Z - completion-attempt-recorded: attempt 2: passed
- 2026-09-28T23:55:05.173Z - done: all gates passed
- 2026-10-01T12:22:18.829Z - renumbered: 361 -> 379: duplicate id with a flow from another clone (main holds 360-365); housekeeping
