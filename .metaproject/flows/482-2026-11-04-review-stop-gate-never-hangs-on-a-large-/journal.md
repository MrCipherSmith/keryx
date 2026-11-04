# Flow Journal

- 2026-11-04T07:17:01.660Z - flow created
- 2026-11-04T07:20:13.658Z - task-added: T5: Mutation pass: skip nested git checkouts in copyTree, owner marker, sweep stale scratch; help + guide text (AC5, AC6)
- 2026-11-04T07:20:16.764Z - task-added: T6: Before/after measurement of one gate evaluation on a fixture with large scratch + nested worktree (AC8)
- 2026-11-04T07:20:23.028Z - frozen: 8 criteria; checksum recorded
- 2026-11-04T07:20:30.104Z - started
- 2026-11-04T07:20:34.040Z - task-done: T1: Collect remaining context
- 2026-11-04T07:20:37.572Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-04T07:21:04.220Z - task-attempt: T2: started (attempt 1) — 482-T2
- 2026-11-04T07:21:07.037Z - task-attempt: T5: started (attempt 1) — 482-T5

## Notes

- Operator decisions (2026-11-04): delete the leftover `mutate-scratch` on the main checkout (done: 5.8 GB → 968K,
  the hung session resumed at 07:10:54Z); fix the gate and the mutation pass (this flow). Completion outcome per the
  operator's standing rule: PR, merge when CI is green (A).
- Execution metrics: no (operator default).
- T2 and T5 dispatched in parallel to two task-implementer workers in this worktree: disjoint files
  (gate: completion-gate.ts, agent.ts and their tests; mutation: mutate.ts, mutate.test.ts, review.ts help, guide).
- T6 baseline, old code (main checkout `src/`, identical to origin/main for the gate files), fixture with one open
  package and 30 000 files under `.metaproject/data/review/mutate-scratch/keryx-mutate-AS0xE6/tree/.claude/worktrees/…`
  (fixture: `evidence/make-fixture.py <root> 30000 [package]`; measurement: `bun evidence/measure-gate.ts <src-root>
  <fixture-root> <label>`, both in this flow folder): pass 1 **96 433 ms**, hash cache 0 → 4096; pass 2 **18 550 ms**, cache full
  at 4096, every file re-read; signature 2 239 902 chars. Extrapolated to the incident's 287 188 files: ~15 min per stop.
- T2 worker: STATUS DONE. Added `AgentDeps.reviewGateState` (test seam, default the real scan) — accepted: it is the
  only deterministic way to prove the turn signal reaches the scan (AC4 red was `Received: undefined`). Note: one flat
  directory still costs a single `readdir` before the budget stops the walk.
- T5 worker: STATUS DONE_WITH_CONCERNS. Concerns, decided: (1) an unmarked pre-change leftover goes only after 6 h —
  as specified, continue; (2) a `.git` file whose path has an unrelated `modules` segment is treated as a submodule and
  copied — old behaviour, continue; (3) `bail status parity: early failure plus later hang is killed` fails locally
  (`timeout` vs `killed`) — reproduced identically on origin/main code from the main checkout, so pre-existing and
  environment-bound (Defender/Zscaler on this machine slow every process start); CI decides.
- Orchestrator verification: `bun test --timeout 30000` on the three touched files → 111 pass, 2 fail under load
  (the bail-parity test above, and `a SIGTERM during a run removes the scratch copy`, which passed on the rerun alone →
  load race, not a regression); rerun of mutate.test.ts alone → 51 pass, 1 fail (bail parity only). `bun run typecheck`
  → exit 0.
- Orchestrator edits: guide sentence reworded; `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md`
  mirrored from the bundled copy (both were byte-identical at HEAD, blob 47ac8e7).
- T6, new code (this worktree), same 30k-file scratch fixture: pass 1 **5 ms**, cache 0 → 2; pass 2 **1 ms**; signature
  266 chars. Budget case (30k files inside the package's `research-evidence/head`): pass 1 4 221 ms, cache 0 → 2032
  (budget hit, truncation marker); pass 2 **49 ms**, nothing re-read.
- 2026-11-04T07:40:57.467Z - task-done: T2: Implement per plan
- 2026-11-04T07:41:05.478Z - task-done: T5: Mutation pass: skip nested git checkouts in copyTree, owner marker, sweep stale scratch; help + guide text (AC5, AC6)
- 2026-11-04T07:41:08.572Z - task-done: T6: Before/after measurement of one gate evaluation on a fixture with large scratch + nested worktree (AC8)
- 2026-11-04T08:59:17.584Z - task-added: T7: Round-1 review fixes: linked-worktree-only skip, owned and heartbeat-aged sweep, repo scratch excluded in tmp mode, gate test and doc gaps
- 2026-11-04T08:59:25.044Z - task-attempt: T7: started (attempt 1) — worker dispatched with fix-spec-r1 (34 round-1 findings, 14 mutation survivors)
- 2026-11-04T09:00:40.527Z - ac-updated: AC5: "The mutation pass copies no nested git checkout: a nested worktree (a `.git` file whose `gitdir:` points at `…/worktrees/…`) and an embedded clone (a `.git` directory) are absent from the scratch copy, while a submodule (a `.git` file pointing at `…/modules/…`) and ordinary directories are copied. · sensitive: revert [verify: exec `bun test src/review/mutate.test.ts`]" -> "The mutation pass copies no linked worktree: a nested directory whose `.git` file points at a linked worktree's git directory (`…/.git/worktrees/…`, also under a path with a `modules` segment, or a git directory holding `commondir`) is absent from the scratch copy, while a submodule (a `.git` file pointing at `…/modules/…`, or a path listed in `.gitmodules`), an embedded clone (a `.git` directory) and ordinary directories are copied as before; the repository's own mutate-scratch is never copied, also with `--scratch tmp`. · sensitive: revert [verify: exec `bun test src/review/mutate.test.ts`]" (Round-1 review of PR 1126: LOGIC-002 and DEG-003 showed an embedded clone or un-absorbed submodule can be a test dependency that base copied, ARCH-001/PERF-004 that a modules path segment let linked worktrees through, LOGIC-001 that tmp mode copied the repo scratch. The skip narrows to linked worktrees, which is what filled the incident checkout.)
- 2026-11-04T09:01:05.601Z - ac-updated: AC6: "Failure scenario — a pass removes scratch left by dead passes: under the scratch base, a `keryx-mutate-XXXXXX` directory whose `owner.json` names a dead pid, or that has no owner marker and is older than the stale age, is removed; one owned by a live pid, a fresh unmarked one, and a non-matching name (`keryx-mutate-test-…`) are kept; every new pass writes its own `owner.json`. · sensitive: failure-scenario [verify: exec `bun test src/review/mutate.test.ts`]" -> "Failure scenario — a pass removes scratch left by dead passes and nothing else: under the scratch base (and the repository's own mutate-scratch when the base is elsewhere), a `keryx-mutate-XXXXXX` directory the operator owns is removed when its `owner.json` names a dead pid and was not refreshed for two heartbeats, when its `owner.json` was not refreshed for the stale heartbeat age whatever its pid, or when it has no readable owner marker and is older than the stale age; one with a fresh heartbeat, a fresh unmarked one, one owned by another user, a non-directory and a non-matching name (`keryx-mutate-test-…`) are kept, and a marker that is a FIFO or oversize does not stall the sweep; every pass writes its own `owner.json` and refreshes it while it runs. · sensitive: failure-scenario [verify: exec `bun test src/review/mutate.test.ts`]" (Round-1 review of PR 1126: SEC-001 (the sweep acted on other users' entries and blocked on a FIFO marker), HL-001 and LOGIC-004 (pid-only liveness never ages out under a PID namespace or pid reuse), LOGIC-001 (tmp mode never swept the repo scratch).)
- 2026-11-04T09:20:42.943Z - task-done: T7: Round-1 review fixes: linked-worktree-only skip, owned and heartbeat-aged sweep, repo scratch excluded in tmp mode, gate test and doc gaps
- 2026-11-04T10:08:04.959Z - task-added: T8: Round-2 review fixes: second abort site, test precision, constants and naming, runMutation helpers, one guide section, flow plan text
- 2026-11-04T10:08:14.913Z - task-attempt: T8: started (attempt 1) — worker dispatched with fix-spec-r2 (14 round-2 minors, TP-003/TP-004/TP-007 partials, cheap infos)
- 2026-11-04T10:58:19.375Z - task-done: T8: Round-2 review fixes: second abort site, test precision, constants and naming, runMutation helpers, one guide section, flow plan text
