# Flow Journal

- 2026-08-16T11:56:44.340Z - flow created
- 2026-08-16T12:05:15.442Z - task-added: T5: Course + Seeds (SLATE-3 feature half, SLATE-4)
- 2026-08-16T12:05:15.520Z - task-added: T6: Unattended checkpoint interactive gate (SLATE-8, security-sensitive)
- 2026-08-16T12:05:25.069Z - task-added: T7: unattended boolean flag on keryx harness run
- 2026-08-16T12:05:46.039Z - task-done: T1: Collect remaining context
- 2026-08-16T12:05:54.089Z - frozen: 6 criteria; checksum recorded
- 2026-08-16T12:05:54.189Z - started
- 2026-08-16T12:13:27.709Z - task-done: T7: unattended boolean flag on keryx harness run
- 2026-08-16T12:15:16.991Z - task-done: T6: Unattended checkpoint interactive gate (SLATE-8, security-sensitive)
- 2026-08-16T12:17:09.715Z - task-done: T5: Course + Seeds (SLATE-3 feature half, SLATE-4)
- 2026-08-16T12:37:27.852Z - task-done: T2: Implement per plan

## Concerns recorded from worker results (per subagent-status-protocol)

**T6 (interactive gate, DONE):** enforced the interactive gate at a single
layer — `ProposalLifecycleService.review()` only, before actor/role
resolution — deliberately not widening `authorizeSacUse`/`TrustedActorContext`
(many unrelated call sites: `create()`, `list()`, `show()`, `addResource()`,
etc.). Denial reuses the existing `guard_denied` error code (distinguished
from the archived-workspace `guard_denied` case by message text citing
SLATE-8/`interactive: false` explicitly) rather than introducing a new code.
Judged sufficient: AC4-AC6 do not require touching `authorizeSacUse`, and the
narrower change has smaller blast radius. Accepted as-is.

**T5 (Course + Seeds, DONE):** deviated from the dispatch's literal
instruction to route Course's flow-read through `src/sac/fwk-service.ts`.
Investigated and found `fwk-service.ts`'s machinery is workspace-scoped
(requires `workspaceId` + authorized actor, writes an access-receipt per
call) — architecturally wrong for Course, which per spec must work from
`flowRef` alone. Instead built `src/session/slate-course.ts` on
`src/flow/store.ts`'s `readFlow`/`resolveFlowDir` — the same primitives
`keryx flow status` uses — wrapped in a local try/catch, leaving
`fwk-service.ts` (including Phase 1's fix) completely untouched. Judged
correct: matches specification.md's explicit statement that Course must
function without a workspace binding. Accepted as-is.
Separately flagged: a research-only sub-fork it launched exceeded its brief
and wrote implementation code; T5 reported it did not trust that output and
independently re-read/re-tested everything itself before reporting DONE.
Verified directly by the orchestrator: `bun test src/session/` (43 pass) and
repo-wide typecheck both clean at acceptance time. No corrective action
needed beyond noting the process deviation for future dispatches.

**T2 (Anchors + open/close lifecycle, DONE_WITH_CONCERNS):** six documented
deviations from the plan's literal wording, all with stated rationale:
(1) attemptId minting is injected per-caller (`deps.idSeq()` in the
deterministic `runAgentTurn` path, a timestamp+counter minter in the
real-clock shell REPL) rather than a single global `Date.now()` minter, to
avoid leaking non-determinism into `runAgentTurn`'s documented determinism
contract; (2) no reusable "worktree-resolve" helper was found after directly
searching `src/harness/child/*` and `src/lib/contained-path.ts` (both serve
unrelated concerns) — wrote a narrowly-scoped `git rev-parse --abbrev-ref
HEAD` shell-out for `Anchors.tree`, documented inline; (3) added an
`opened: boolean` flag to a caller-owned `SlateSessionRef` so archive-then-
fresh only fires once per running attempt rather than on every
action-classified turn (the plan's literal wording would have wiped Seeds/
Anchors every turn within one continuous session) — a fresh process
naturally starts `opened:false`, correctly preserving AC3's re-trigger on
crash/resume; (4) invented a close-phrase list (`"close slate"`, `"wrap
up"`, `"task complete"`, `"i'm done"`, etc.) matched as normalized
substrings rather than single-token matching, since closing destroys live
state so the false-positive bar is higher than opening's; (5) flow-done
close check placed in `agent.ts`'s `runAgentTurn` via a `finally` wrapper
(covers every internal early-return) rather than in `shell.ts`;
(6) **`isActionRequest`'s literal token Set was not extended** — T2 reused
the classifier's existing boolean result as the open-trigger rather than
adding new lexical tokens, reading the scope's "extend...so it also
functions as the slate-open trigger" as extending the classifier's *role*,
not its vocabulary.

Orchestrator disposition on (6): the roadmap scope
(`docs/requirements/slate/phase-execution-prompts.md` §2) and the original
delivery brief both name "extend `isActionRequest` token set" explicitly,
distinct from "wire the open trigger" — read literally, not just
functionally. Closed directly by the orchestrator (not a new dispatched
task, given the small size): added SLATE-5-documented ASCII tokens
(`implement`, `build`, `fix`, `create`, `task`, `goal`, `add`) and Cyrillic
equivalents (`реализуй`, `создай`, `почини`, `исправь`, `задача`, `цель`) to
`isActionRequest`'s existing token sets in `src/commands/agent.ts`, additive
only (no token removed, no existing test broken). Verified:
`bun test src/commands/agent.test.ts` (44 pass, 0 fail) and repo-wide
`bun run typecheck` (clean) both re-run clean after the change. Decisions
(1)-(5) accepted as-is — all are correctness improvements over the plan's
literal wording, not scope gaps.
- 2026-08-16T12:39:07.598Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-16T12:58:52.263Z - task-added: T8: Fix review findings: shell.ts slate open/close test coverage, finally-block error masking, --unattended parse assertion
- 2026-08-16T13:02:28.424Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-16T13:02:28.611Z - task-added: T9: Fix round: remediate 5 major + 5 minor review findings (F-001..F-010)
- 2026-08-16T13:22:26.813Z - task-done: T8: Fix review findings: shell.ts slate open/close test coverage, finally-block error masking, --unattended parse assertion
- 2026-08-16T13:22:26.910Z - task-done: T9: Fix round: remediate 5 major + 5 minor review findings (F-001..F-010)
