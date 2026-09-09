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
