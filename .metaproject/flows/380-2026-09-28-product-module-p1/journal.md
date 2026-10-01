# Flow Journal

- 2026-09-28T23:11:49.372Z - flow created
- 2026-09-28T23:55:16.280Z - frozen: 11 criteria; checksum recorded
- 2026-09-28T23:55:20.261Z - started
- 2026-09-29T01:10:00.000Z - GATE G1 (AC10). The number, read with `keryx product open` on this repository's real corpus at main d38649b8 (0.3.30): 423 intents indexed (347 flows, 76 requirements packages), 0 parse failures, 130 entries with no extractable intent statement. Closed in code: 309. Never checked for effect: 309 of 309. Breakdown: no outcome criterion stated 309, criterion stated but never observed 0, observed 0. Reading: the number is tautological on this corpus. No flow written before this module states an outcome criterion and no journal carries an `outcome-observed:` line, so every closed intent lands in the first bucket. It says the instrument did not exist, not that the intents failed to work. Reported to the operator on the helyx channel before anything beyond P1 was built. Nothing further (map, admit, the product-admit skill, integration lines) is built; that is the operator's decision.
  Design decision (mine, overrulable): an observation is a line beginning `outcome-observed:` at column 0 of the flow's journal.md. Journal event lines start with `- `, so they never match by accident.
  Review of PR #793 found seven issues (two major: staleness was mtime and count only, and index validation too shallow; all fixed in d2c60a8c): staleness is now a sha256 content fingerprint stored in the index.
- 2026-09-29T00:57:03.570Z - ac-confirmed: AC1: index.test.ts: fixture set always, real corpus when present; live run 423 intents, 0 failures, 130 without a statement, second run byte-identical (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:03.865Z - ac-confirmed: AC2: open.test.ts; live run lists 309 closed unobserved intents with flow and outcome text (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:04.021Z - ac-confirmed: AC3: staleness.test.ts: content fingerprint; older-mtime edit, rename, missing and malformed index all fail naming keryx product index; touch alone is not stale (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:04.177Z - ac-confirmed: AC4: disposable.test.ts: delete and rebuild gives an equivalent index; live run deleted the data dir afterwards (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:04.330Z - ac-confirmed: AC5: never-gates.test.ts: lifecycle with an empty index, import scanner over src/flow and governance with self-tests (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:04.483Z - ac-confirmed: AC6: no-model.test.ts: static audit of src/product non-test files (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:04.635Z - ac-confirmed: AC7: observation.test.ts: outcome-observed line at column 0 removes a flow from the open list (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:04.789Z - ac-confirmed: AC8: bulk-budget.test.ts: one module, only index and open registered, no skill or subagent added (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:04.946Z - ac-confirmed: AC9: product-open-surface.test.ts asserts the painted rows and the never-checked header; /product wired for idle and busy (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:05.101Z - ac-confirmed: AC10: gate G1: the journal entry holds the number 309 of 309 (0 criterion stated, 0 observed) and the operator was told on the helyx channel before anything beyond P1; honest kind none (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:05.265Z - ac-confirmed: AC11: typecheck clean, src/product suite green, CI 18/18 on d2c60a8c, README, docs cli-reference, module page, CHANGELOG 0.3.30 and version bump present (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T00:57:05.418Z - task-done: T1: Collect remaining context
- 2026-09-29T00:57:05.574Z - task-done: T2: Implement per plan
- 2026-09-29T00:57:05.726Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-29T00:57:05.881Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-29T00:57:08.282Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/793 (warning: PR is not a draft) (base: main)
- 2026-09-29T00:57:09.777Z - completing
- 2026-09-29T00:57:13.687Z - completion-attempt-recorded: attempt 1: passed
- 2026-09-29T00:57:13.688Z - done: all gates passed
- 2026-10-01T12:22:19.211Z - renumbered: 362 -> 380: duplicate id with a flow from another clone (main holds 360-365); housekeeping
