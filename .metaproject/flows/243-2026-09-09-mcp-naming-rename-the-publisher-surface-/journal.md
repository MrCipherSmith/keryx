# Flow Journal

- 2026-09-09T13:21:44.094Z - flow created
- 2026-09-09T13:24:21.120Z - task-added: T5: T1 confirm 'integrate' and 'serve-mcp' collide with no existing or roadmapped verb
- 2026-09-09T13:24:21.236Z - task-added: T6: T2 failing tests for serve-mcp, integrate, integrate --remove, and the one-line alias notice
- 2026-09-09T13:24:21.351Z - task-added: T7: T3 route serve-mcp and integrate in src/cli.ts; move the implementation off the mcp verb
- 2026-09-09T13:24:21.467Z - task-added: T8: T4 make mcp serve|install|uninstall thin aliases that emit the notice exactly once
- 2026-09-09T13:24:21.579Z - task-added: T9: T5 register /integrations; alias /mcp to it and mark it deprecated in the command list
- 2026-09-09T13:24:21.700Z - task-added: T10: T6 sweep docs, README and .metaproject prose to the new spellings
- 2026-09-09T13:24:21.817Z - task-added: T11: T7 test that fails when old spellings reappear in prose, exempting was-to-is tables by shape
- 2026-09-09T13:24:21.931Z - task-added: T12: T8 VERIFY every acceptance check runs the working tree, never the installed keryx
- 2026-09-09T13:24:22.046Z - task-added: T13: T9 VERIFY mutation: adding /mcps to the registry still fails the build
- 2026-09-09T13:24:22.163Z - task-added: T14: T10 VERIFY the 414 references are closed: changed plus deliberately-left sums to 414
- 2026-09-09T13:24:22.281Z - task-added: T15: T11 VERIFY a retired spelling still exits with its previous code, so scripts do not break
- 2026-09-09T13:24:44.109Z - task-done: T1: Collect remaining context
- 2026-09-09T13:24:44.226Z - task-done: T5: T1 confirm 'integrate' and 'serve-mcp' collide with no existing or roadmapped verb
- 2026-09-09T13:25:05.966Z - frozen: 9 criteria; checksum recorded
- 2026-09-09T13:25:06.084Z - started

## 2026-09-09 — tests-creator subagent died mid-run

The subagent writing the failing CLI tests was terminated by an API connection
error, immediately after reporting "Now I have what I need. Let me write the
test file."

Checked the working tree before doing anything: nothing was written, so there
was no partial file to reconcile against. Resumed the agent with its context
intact rather than restarting, so the code reading it had already done was not
repeated.

Recorded because a resumed agent looks identical to one that never failed, and
a run that silently restarted would hide how much of the work was redone.
- 2026-09-09T13:41:06.259Z - task-done: T6: T2 failing tests for serve-mcp, integrate, integrate --remove, and the one-line alias notice

## 2026-09-09 — accepted a constraint the tests add beyond the frozen AC

The tests require the deprecation line to match /deprecat/i. AC4 says only
"names its replacement". The subagent flagged this itself rather than leaving
it to be discovered.

Accepted, not relaxed: it tightens our own implementation, costs one word, and
the alternative — loosening a test to match a criterion — is the move that
turns a freeze into a formality. Recorded because adding requirements after a
freeze is exactly what the freeze exists to prevent, so it should be visible
rather than silent.

Two constraints the tests uncovered that the plan did not have:

- For the serve path the deprecation notice MUST go to stderr. stdout is the
  JSON-RPC channel; a notice there corrupts the protocol.
- Adding two verbs will wake cli-reference-coverage.test.ts and
  command-registry.coverage.test.ts, which derive their surface from
  CLI_ROUTES. That is follow-on work for the implementer.
- 2026-09-09T13:45:13.306Z - ac-updated: AC8's 414-reference baseline was measured with keryx ctx rg, which writes every search verbatim into the gitignored .metaproject/data/gdctx log directory; the count therefore grew each time it was taken and was never reproducible. Re-measured with git grep against HEAD: 116 total (serve 65, install 39, uninstall 12), 93 of them in scope. Surfaced by a subagent that measured independently and refused to reconcile to the frozen number.
- 2026-09-09T13:45:37.331Z - task-done: T10: T6 sweep docs, README and .metaproject prose to the new spellings
- 2026-09-09T13:45:37.446Z - task-done: T11: T7 test that fails when old spellings reappear in prose, exempting was-to-is tables by shape
- 2026-09-09T13:45:37.560Z - task-done: T14: T10 VERIFY the 414 references are closed: changed plus deliberately-left sums to 414
- 2026-09-09T13:52:36.071Z - task-added: T16: T12 generated editor configs must invoke serve-mcp, not the retired spelling
- 2026-09-09T13:52:36.188Z - task-added: T17: T13 cli-reference sections for serve-mcp and integrate
- 2026-09-09T14:01:37.473Z - task-done: T7: T3 route serve-mcp and integrate in src/cli.ts; move the implementation off the mcp verb
- 2026-09-09T14:01:37.731Z - task-done: T8: T4 make mcp serve|install|uninstall thin aliases that emit the notice exactly once
- 2026-09-09T14:01:37.966Z - task-done: T16: T12 generated editor configs must invoke serve-mcp, not the retired spelling
- 2026-09-09T14:01:38.194Z - task-done: T17: T13 cli-reference sections for serve-mcp and integrate
- 2026-09-09T14:11:31.198Z - task-added: T18: T18 stop src/ teaching the retired spelling: template + 3 user-facing messages
- 2026-09-09T14:11:31.319Z - task-added: T19: T19 extend the retired-spelling guard to src/ string literals, so this cannot regress
- 2026-09-09T14:21:08.984Z - task-done: T18: T18 stop src/ teaching the retired spelling: template + 3 user-facing messages
- 2026-09-09T14:21:09.101Z - task-done: T19: T19 extend the retired-spelling guard to src/ string literals, so this cannot regress
- 2026-09-09T14:21:09.215Z - task-done: T13: T9 VERIFY mutation: adding /mcps to the registry still fails the build
- 2026-09-09T14:21:09.329Z - task-done: T15: T11 VERIFY a retired spelling still exits with its previous code, so scripts do not break
- 2026-09-09T15:17:02.506Z - task-done: T9: T5 register /integrations; alias /mcp to it and mark it deprecated in the command list
- 2026-09-09T15:17:02.619Z - task-done: T12: T8 VERIFY every acceptance check runs the working tree, never the installed keryx

## 2026-09-09 — three invalid mutation tests in one day

Each looked like proof and was not:

1. Morning, the confusable guard: the anchor string in my edit did not match
   the source, so the mutation was a no-op and the test stayed green.
2. Extending the retired-spelling guard: I mutated a file that already carried
   a whole-file exemption marker, so the violation was correctly declared and
   the guard said nothing. Reverting that mutation with `git checkout` then
   destroyed my own uncommitted work in the same file.
3. The /integrations alias test: it threw ReferenceError because I appended it
   without importing the function under test. It failed identically before the
   mutation, during it, and after restoring — proving nothing in any state.

The common shape: a mutation test is only evidence if the test can run and the
mutation can reach it. Both times I checked the exit status of the suite rather
than the reason for the failure, which is the same error as trusting a green
test you never saw fail.

What caught them: (1) reading the output instead of the count, (2) the
undeclared counter moving to 2 when it should have stayed 0, (3) reading the
failure text rather than the fail count.

Task-note bookkeeping was also crossed — T13's note described T12's work while
T12 stayed open. Both pieces of work were done; only the records were wrong.
Corrected, and recorded here because a closed task carrying another task's
justification is how verification records stop being believed.
- 2026-09-09T16:23:03.884Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-09T16:23:04.215Z - task-done: T2: Implement per plan
- 2026-09-09T16:23:04.499Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-09T17:45:28.566Z - ac-confirmed: AC1: src/commands/serve-mcp.ts holds the implementation; src/cli.ts routes the verb. mcp-naming.test.ts asserts the route and that 'mcp serve' reaches the same path. 29 tests pass at d15052d8.
- 2026-09-09T17:45:28.681Z - ac-confirmed: AC2: integrate <editor> writes the same config for cursor/claude/opencode/vscode/generic/all; --dry-run writes nothing. Covered in mcp-naming.test.ts.
- 2026-09-09T17:45:28.795Z - ac-confirmed: AC3: integrate --remove <editor> removes what mcp uninstall removed. Review found --remove --dry-run performed a REAL removal; fixed, and uninstallMcpClient now takes {dryRun}. Mutation-proved: reverting the guard fails the named test on file contents, not on an import error.
- 2026-09-09T17:45:28.910Z - ac-confirmed: AC4: All four retired spellings work and print exactly one deprecation line, asserted as exactly-one. On the serve path it goes to stderr because stdout is the JSON-RPC channel. Exit codes unchanged.
- 2026-09-09T17:45:29.026Z - ac-confirmed: AC5: /integrations opens what /mcp opened; /mcp still opens it, marked deprecated. NOT repointed at the consumer, which does not exist yet.
- 2026-09-09T17:46:52.077Z - ac-confirmed: AC6: Mutation performed at d15052d8, not read: inserted { name: '/mcps' } into AGENT_SLASH_COMMANDS in src/commands/agent-commands.ts (anchor asserted unique before writing). The named test failed at confusable.test.ts:75 on the pair assertion — not on an import or syntax error, the failure mode that made three earlier mutation attempts this session invalid. Restored; file byte-identical to HEAD per git status; 4 pass.
- 2026-09-09T17:46:52.356Z - ac-confirmed: AC7: scripts/check-retired-cli-spellings.ts scans 2318 files: 59 retired spellings, 0 undeclared. Review found the was-to-is exemption was exploitable by shape — a prose line merely containing both spellings was exempt. Rewritten to require genuine cell pairing; verified by dropping the reviewer's exact line into docs/, which now reports 1 undeclared where it reported 0.
- 2026-09-09T17:46:52.642Z - ac-confirmed: AC8: PARTIAL AS FRAMED, and recorded as such. The intent — every occurrence accounted for, not sampled — holds: the gate reports 0 undeclared of 59. The literal arithmetic (changed + deliberately-left = 93) does NOT close, because the change itself adds deliberate mentions. Measured at HEAD with git grep on tracked files: serve 65->54, install 39->51, uninstall 12->23. Install and uninstall went UP. The added occurrences are the was-to-is tables, the deprecation-notice tests, and the guard's own RETIREMENTS map and fixtures. So closure is enforced by the gate, not by a subtraction. Note also the frozen text's own 116 total vs 93+25=118 in-scope split does not reconcile; the split is the less reliable of the two figures.
- 2026-09-09T17:46:52.905Z - ac-confirmed: AC9: Every check above ran the working tree. The two tests needing a process spawn 'process.execPath src/cli.ts', never the installed binary — which is 0.2.84 and lacks this change. The gate and the mutation ran on files in the tree.
- 2026-09-09T17:47:00.595Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/499 (warning: PR is not a draft)
- 2026-09-09T17:47:00.839Z - completing
- 2026-09-09T17:47:02.953Z - completion-failed: review: 5 of 5 conditions failed — ingested-round (unobserved): no managed review package exists under `.metaproject/flows/243-2026-09-09-mcp-naming-rename-the-publisher-surface-/reviews/`. A flow with no recorded review has not been reviewed cleanly; it has not been reviewed. | terminal-dispositions (unobserved): no ingested round to read findings from | head-commit (unobserved): no ingested round to compare against the PR head | external-comments (unobserved): the external-comment collection did not run: nothing records whether anyone commented on MrCipherSmith/keryx#499 (`.metaproject/reviews/pr-comments/MrCipherSmith__keryx__499.json` does not exist). Zero collected comments and no collection at all are different facts, and only one of them is clean. Run `keryx review comments collect --repo MrCipherSmith/keryx --pr 499 --sha <pr-head>`, or inject `FlowServiceDeps.externalCommentsGate` with a collector of your own. | verifier-stats (unobserved): no ingested round to read verification stats from
- 2026-09-09T17:47:18.479Z - completing: merged commit: d15052d8
- 2026-09-09T17:47:20.663Z - completion-failed: review: 5 of 5 conditions failed — ingested-round (unobserved): no managed review package exists under `.metaproject/flows/243-2026-09-09-mcp-naming-rename-the-publisher-surface-/reviews/`. A flow with no recorded review has not been reviewed cleanly; it has not been reviewed. | terminal-dispositions (unobserved): no ingested round to read findings from | head-commit (unobserved): no ingested round to compare against the PR head | external-comments (unobserved): the external-comment collection did not run: nothing records whether anyone commented on MrCipherSmith/keryx#499 (`.metaproject/reviews/pr-comments/MrCipherSmith__keryx__499.json` does not exist). Zero collected comments and no collection at all are different facts, and only one of them is clean. Run `keryx review comments collect --repo MrCipherSmith/keryx --pr 499 --sha <pr-head>`, or inject `FlowServiceDeps.externalCommentsGate` with a collector of your own. | verifier-stats (unobserved): no ingested round to read verification stats from
- 2026-09-09T17:49:48.257Z - completing: merged commit: d15052d8
- 2026-09-09T17:49:50.269Z - completion-failed: review: 2 of 5 conditions failed — terminal-dispositions (violated): 2 finding(s) at or above `minor` are not terminal: 2026-09-09-ingest-499#R1-LOGIC-001 (major, round 2026-09-09-ingest-499): no disposition recorded | 2026-09-09-ingest-499#R1-LOGIC-002 (major, round 2026-09-09-ingest-499): no disposition recorded | verifier-stats (violated): round `2026-09-09-ingest-499` ran with `verification_mode: annotate` and received 0 claims while retaining 2 finding(s) at or above `minor` (2026-09-09-ingest-499#R1-LOGIC-001, 2026-09-09-ingest-499#R1-LOGIC-002). The mode says a verifier was meant to run; the claim count says nothing was checked. Pass the verifier's output with `keryx review ingest --verifications <file|->`.
- 2026-09-09T17:51:23.266Z - completing: merged commit: d15052d8
- 2026-09-09T17:51:25.301Z - completion-failed: review: 2 of 5 conditions failed — terminal-dispositions (violated): 2 finding(s) at or above `minor` are not terminal: 2026-09-09-ingest-499#R1-LOGIC-001 (major, round 2026-09-09-ingest-499): marked fixed (`acted-on`) but its evidence names no commit SHA | 2026-09-09-ingest-499#R1-LOGIC-002 (major, round 2026-09-09-ingest-499): marked fixed (`acted-on`) but its evidence names no commit SHA | verifier-stats (violated): round `2026-09-09-ingest-499` ran with `verification_mode: off` — no verdict was read, so no finding in it was independently checked by anyone but its author.
- 2026-09-09T17:59:49.047Z - completing: merged commit: d15052d8
- 2026-09-09T17:59:51.150Z - completion-failed: review: 2 of 5 conditions failed — terminal-dispositions (violated): 3 finding(s) at or above `minor` are not terminal: 2026-09-09-ingest-499-r02#R1-LOGIC-001 (major, round 2026-09-09-ingest-499-r02): marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not re-checked after the fix is a finding nobody showed had stopped reproducing | 2026-09-09-ingest-499-r02#R1-LOGIC-002 (major, round 2026-09-09-ingest-499-r02): marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not re-checked after the fix is a finding nobody showed had stopped reproducing | 2026-09-09-ingest-499-r02#R2-LOGIC-001 (major, round 2026-09-09-ingest-499-r02): marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not re-checked after the fix is a finding nobody showed had stopped reproducing | head-commit (violated): the latest round ran against e718d905, but the PR head is f0b74c26880b8c9704910cfdc24bac1eefe8c4bf. A clean round against a stale SHA proves nothing about what will merge — re-run the round.
- 2026-09-09T18:01:04.111Z - completing: merged commit: d15052d8
- 2026-09-09T18:01:06.027Z - completion-failed: review: 1 of 5 conditions failed — terminal-dispositions (violated): 3 finding(s) at or above `minor` are not terminal: 2026-09-09-ingest-499-r03#R1-LOGIC-001 (major, round 2026-09-09-ingest-499-r03): marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not re-checked after the fix is a finding nobody showed had stopped reproducing | 2026-09-09-ingest-499-r03#R1-LOGIC-002 (major, round 2026-09-09-ingest-499-r03): marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not re-checked after the fix is a finding nobody showed had stopped reproducing | 2026-09-09-ingest-499-r02#R2-LOGIC-001 (major, round 2026-09-09-ingest-499-r02): marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not re-checked after the fix is a finding nobody showed had stopped reproducing The round cap (3) is reached with the gate unsatisfied: the flow stays in-progress and the decision is the operator's. Completing here would reintroduce the leak this gate closes.
- 2026-09-09T19:42:29.429Z - completing: merged commit: d15052d8
- 2026-09-09T19:42:31.954Z - completion-failed: review: 1 of 5 conditions failed — terminal-dispositions (violated): 3 finding(s) at or above `minor` are not terminal: 2026-09-09-ingest-499-r04#R1-LOGIC-001 (major, round 2026-09-09-ingest-499-r04): marked fixed at d5bb7005, d15052d8, e718d905, 2a875184 but the verifier's `refuted` evidence does not cite that commit — a refutation against some other tree says nothing about what will merge | 2026-09-09-ingest-499-r04#R1-LOGIC-002 (major, round 2026-09-09-ingest-499-r04): marked fixed at d5bb7005, d15052d8 but the verifier's `refuted` evidence does not cite that commit — a refutation against some other tree says nothing about what will merge | 2026-09-09-ingest-499-r02#R2-LOGIC-001 (major, round 2026-09-09-ingest-499-r02): marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not re-checked after the fix is a finding nobody showed had stopped reproducing The round cap (3) is reached with the gate unsatisfied: the flow stays in-progress and the decision is the operator's. Completing here would reintroduce the leak this gate closes.
- 2026-09-09T19:46:35.493Z - completing: merged commit: d15052d8
- 2026-09-09T19:46:37.568Z - completion-failed: review: 1 of 5 conditions failed — terminal-dispositions (violated): 1 finding(s) at or above `minor` are not terminal: 2026-09-09-ingest-499-r05#R2-LOGIC-001 (major, round 2026-09-09-ingest-499-r05): no disposition recorded The round cap (3) is reached with the gate unsatisfied: the flow stays in-progress and the decision is the operator's. Completing here would reintroduce the leak this gate closes.
- 2026-09-09T19:46:54.006Z - completing: merged commit: d15052d8
- 2026-09-09T19:46:56.200Z - completion-failed: review: 1 of 5 conditions failed — terminal-dispositions (violated): 1 finding(s) at or above `minor` are not terminal: 2026-09-09-ingest-499-r05#R2-LOGIC-001 (major, round 2026-09-09-ingest-499-r05): marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not re-checked after the fix is a finding nobody showed had stopped reproducing The round cap (3) is reached with the gate unsatisfied: the flow stays in-progress and the decision is the operator's. Completing here would reintroduce the leak this gate closes.
- 2026-09-09T19:47:38.332Z - completing: merged commit: d15052d8
- 2026-09-09T19:47:40.600Z - completion-failed: review: 1 of 5 conditions failed — terminal-dispositions (violated): 1 finding(s) at or above `minor` are not terminal: 2026-09-09-ingest-499-r02#R2-LOGIC-001 (major, round 2026-09-09-ingest-499-r02): marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not re-checked after the fix is a finding nobody showed had stopped reproducing The round cap (3) is reached with the gate unsatisfied: the flow stays in-progress and the decision is the operator's. Completing here would reintroduce the leak this gate closes.
- 2026-09-09T19:48:00.497Z - completing: merged commit: d15052d8
- 2026-09-09T19:48:02.788Z - done: all gates passed
