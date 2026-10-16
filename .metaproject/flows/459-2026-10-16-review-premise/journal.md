# Flow Journal

- 2026-10-16T11:39:19.756Z - flow created
- 2026-10-16T11:45:27.901Z - task-done: T1: Collect remaining context
- 2026-10-16T11:45:28.049Z - task-done: T2: Implement per plan
- 2026-10-16T11:45:28.198Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-16T11:45:28.346Z - task-done: T4: Self-review and prepare draft PR
- 2026-10-16T11:45:28.496Z - task-added: T5: L1 code core: premise claims, delete-only merge, held findings in verdict/readiness/gate/dedupe
- 2026-10-16T11:45:28.644Z - task-added: T6: L3 skills: review-premise skill, shared law 4, review-layout no-mirror, Wave D, fix-loop orchestrators
- 2026-10-16T11:45:28.799Z - task-added: T7: L2 operator + CLI: premise-question decision, decide-premise card, flags, tier, catalog, docs
- 2026-10-16T11:45:28.947Z - task-added: T8: Live eval: #7849 fixture + #992/#1005 controls
- 2026-10-16T11:45:29.103Z - task-added: T9: PR review round(s) clean
- 2026-10-16T11:45:29.253Z - task-added: T10: CHANGELOG, release 0.3.121
- 2026-10-16T11:45:29.556Z - frozen: 8 criteria; checksum recorded
- 2026-10-16T11:45:29.707Z - started
- 2026-10-16T11:46:27.181Z - task-attempt: T5: started (attempt 1) — 459-T5 sonnet worktree lane L1
- 2026-10-16T11:46:27.335Z - task-attempt: T6: started (attempt 1) — 459-T6 opus worktree lane L3
- 2026-10-16T12:04:21.666Z - task-done: T6: L3 skills: review-premise skill, shared law 4, review-layout no-mirror, Wave D, fix-loop orchestrators
- 2026-10-16T12:09:31.586Z - task-done: T5: L1 code core: premise claims, delete-only merge, held findings in verdict/readiness/gate/dedupe
- 2026-10-16T12:09:31.742Z - task-attempt: T7: started (attempt 1) — 459-T7 sonnet worktree lane L2
- 2026-10-16T12:43:37.426Z - task-done: T7: L2 operator + CLI: premise-question decision, decide-premise card, flags, tier, catalog, docs
- 2026-10-16T12:43:37.574Z - task-done: T8: Live eval: #7849 fixture + #992/#1005 controls

## 2026-10-16 — AC7 owner decision

Live eval rerun on #992 after the downgrade fix: 3 upheld, F-009 downgraded to minor with cited intent and practice (still in the fix loop), F-012 held as an operator question. Owner (question tool, this session): "Принять как есть" — downgrades need cited evidence and stop at minor (commit 80a16d021); disputed findings are held for the operator. premise-eval.json carries the rerun.

## 2026-10-16 — round 1 premise decisions (owner, question tool)

Round 1 of PR #1043: 39 reviewer dispatches, 168 findings (18 major, 92 minor, 56 info); review-premise (Opus, 3 judges) over the 110 at minor or above: 95 upheld, 4 downgraded with cited evidence, 10 held.
- ARCH-5, CC-1 (split premise.ts): dismiss — keep the verifier's layout.
- CC-6, F-007 (shared record guard): dismiss for this PR — separate task.
- RG8-002 (readiness item 11 waivable): uphold — refuse the waiver for `premise-decisions`.
- clean-code-w5 F-001, style-w4 STY-003, regression-skills RG-003, style-skills F-006, style-w8 F-009: dismiss, the judge's reasons stand.
- core-boundaries-w1 F-003 (owner-decision): the AC7 owner decision is now journaled and premise-eval.json carries the rerun.
Skills fix lane merged (0d38ea4d2): 33 upheld findings fixed or merged into their cluster.

## 2026-10-16 — round 2 (delta c144874..f47ebb0)

13 reviewer dispatches over the fix delta. Prior: 111 closed, 10 partial, 4 open (testing-practices findings that missed the round-1 fix), 0 regressed. New: 3 major (SEC2-001 operator-only guard case/nesting; RG2-001 decide-premise rewrite broke registry trust; LG2-001 read-only keryx-shell child has no git), 31 minor, 19 info. Premise judge: 33 upheld, 1 challenged (cardSafe import) — owner: uphold, moved to src/lib in this PR. Fix lane 3cb8ded48 closed all upheld and every partial/open prior except R2-002 (job-orchestrator rewrap vs ceiling) — owner: move reference text to a SKILL.detail.md.
