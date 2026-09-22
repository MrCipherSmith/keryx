# Context

Collected deterministically by `keryx flow init` at 2026-09-22T22:30:55.798Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.865] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
2. [1.654] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
3. [1.635] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
4. [1.618] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
5. [1.615] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-09-22T20:37:55.124Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

### Phase 1 research (2026-09-22) — headless runners, approvals, cost, locks, flow state

Baseline read: flow 286 package (`description.md`, `context.md`, `journal.md` T5/T7/T8/T9/T11/T15 notes),
`src/trigger/{run,record,config}.ts`, `src/commands/trigger.ts`. Everything below is file:line against
the `feat/triggers-wave2` worktree.

#### 1. How keryx can run an agent headlessly today

| Runner | Can it work one flow task end to end, no TTY? | Returns | Cost / tokens | Approval posture when nobody is there |
|---|---|---|---|---|
| `keryx harness run` (`src/commands/harness.ts:376-560`) | **No.** Registers no tools (`new ToolRegistry()`, `denyingExecutor` — `harness.ts:296-300,546-555`), policy fixed to `read-only-review` (`harness.ts:525,539,550`), budget `maxSeconds 60 / maxToolCalls 5` (`harness.ts:526`). It can answer a prompt, it cannot edit a file or run a test. | One JSON blob `{events,text,completion,evidence}` as the last stdout line (`harness.ts:1-7,363-374`). | Provider usage events only; no USD. | `RunDeps.interactive: false` unconditionally (`harness.ts:553`) → policy engine step 6 turns every `ask` into `deny` with rule `headless-fail-closed` (`src/harness/policy/engine.ts:233-241`). `--unattended` is parse-and-store only, wired to nothing (`harness.ts:254-268`). |
| `keryx serve` turn (`src/lib/serve-turn.ts:445-700`) | **No**, same `runOffline` core: `toolExecutor: denyingExecutor`, `maxToolCalls: 0` (`serve-turn.ts:571,595`). | Durable turn record, `outcome` slug. | Tokens only. | `interactive: false` + `nonInteractive: true` (`serve-turn.ts:575-578,602-605`); an asked action **terminates as a recorded denial** detected via `headless-fail-closed` (`serve-turn.ts:667-692`). This is the precedent for "denied and recorded". |
| External codecs `claude-cli` / `codex-cli` (`src/harness/external/`) | **No, not in this release.** `worktree-write` is schema-valid and REFUSED; only `read-only` sandbox is implemented (`src/harness/external/dispatch.ts:12-14,67-68,125-131`). Claude child gets `--tools Read Grep Glob`, no MCP (`codec/claude-cli.ts:25-28,47,95-110`). | stream-json events, classified outcome. | **Only runner with a real USD number**: claude-cli maps the CLI's own `total_cost_usd` to `costUnits` (`codec/claude-cli.ts:387-408,449-460`) and can enforce `--max-budget-usd` up front (`claude-cli.ts:82,172`). codex reports **no monetary cost at all** (`codec/codex-cli.ts:391`). | The vendor CLI's own sandbox + read-only tool roster; `--permission-mode plan` deliberately absent (`claude-cli.ts:30-33`). |
| `keryx shell --print <prompt>` (`src/commands/shell.ts:2969-2977,3121-3126,3208-3213,3818-3837`) | **Yes — the only native path that can.** One full agent turn through the same REPL loop a person drives (`shell.ts:3818-3829`), with the full interactive tool roster (`apply_patch`, `shell_exec`, `spawn_subagent`, search/graph/memory, …, `src/harness/tool/builtin/*`). Needs `--provider` AND `--model`: with no `--provider` it runs the interactive provider picker (`shell.ts:3861-3878`) which reads from the same one-line iterator that holds the prompt. | Exit code + rendered output; `--events-file <path>` appends NDJSON `turn_start/tool_call/tool_result/usage/turn_end` (`shell.ts:2978-2983`, `src/commands/shell-events.ts:20-39`). | **Tokens only** (`ShellEventUsage {inputTokens, outputTokens, totalTokens}`, `shell-events.ts:21-25`; `NormalizedUsage`, `src/harness/provider/types.ts:127-134`). No price table exists anywhere in `src/` (`keryx ctx rg -i "price|pricing"` → only prose hits). | **Not fail-closed by design — by accident, and not everywhere.** See below. |
| ACP server (`src/acp/server.ts:400-426`) | In-process `runAgentTurn` with a real tool list — the composition precedent for running a turn outside the REPL. | — | Tokens. | Deliberately NOT `unattended` (`acp/server.ts:415-425`) — an operator is present over the wire. |
| `keryx job` (`src/commands/job.ts`) / background job registry (`src/harness/tool/builtin/background-job-registry.ts:1077-1396`) | **No.** `job` is a jobs/ document tracker; the registry tracks shell tasks an already-running agent spawned. Neither starts an agent. | — | — | — |
| `keryx flow next` (`src/flow/types.ts:395-412`, `src/flow/machine.ts:270-287`) | Decides only: `ready {task, resume}` / `blocked` / `none`, plus every not-done task with an unresolved attempt. | `NextTaskDecision`. | — | — |
| flow-orchestrator skill (`.metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md:370-430`) | Needs a host LLM session to execute the skill; defines the protocol an unattended dispatcher should mirror: `task attempt --outcome started --detail <dispatch_id>` before dispatch (`:426`), `blocked` on an unusable reply (`:428`), boundary commit of only the reported files then `task done` (`:370-393`), STATUS table (`:413-419`), verification before acceptance (`:431-438`). | — | — | — |

**The approval crux — how headless mode resolves approvals today in the one runner that can do work (`shell --print`):**

- `AgentDeps.unattended` exists (`src/commands/agent.ts:316-328`) and does the right thing where it is
  consulted — `ask_user` stops the whole turn with a `TerminalState` (`agent.ts:2636-2646`), the
  untrusted-content gate refuses instead of asking (`agent.ts:2693-2708`), budget exhaustion becomes a
  `TerminalState` (`agent.ts:2045,2917,2932`). **But no production caller sets it**: `keryx ctx rg
  "unattended: |deps.unattended"` finds only readers in `agent.ts` and the ACP comment saying it is
  deliberately unset. `keryx shell --print` does not set it.
- Permission mode for `--print` falls back to **the project's stored default** from the user-global
  `permission-mode.json` (`shell.ts:2031-2037`, `src/lib/permission-mode-config.ts:27-28,82`). If the
  operator ever stored `auto` for this project, an unattended `--print` run auto-approves every
  `shell`/`write`/`destructive` call except the credential / SAC-confirm / publish-lease floors
  (`src/commands/permission-mode.ts:113-144`). `trust` auto-approves everything non-destructive.
- Under `ask`, the readline approver reads its answer from the one-shot iterator, which is already
  exhausted, so `readLine()` returns `undefined` → `""` → denied (`shell.ts:1844-1848,1872-1877,1906-1911`).
  That is fail-closed **by stdin exhaustion**, not by posture: nothing records it as an unattended
  denial, and the rendered transcript says `denied` as if a person typed "no".
- **Saved shell permissions still auto-approve** in `--print`: `evaluateShellApproval(...).autoApprove`
  returns approved without any prompt (`shell.ts:1916-1946`). Memory lesson
  `lessons/allowlist-not-a-boundary.md`: a live allowlist held `bash *`, `sudo *`, `rm -rf /`.
- `resolveApprovalDecision` has no notion of "unattended-forbidden": under `trust`, `git push`
  (non-force), `git merge`, `git tag`, `gh pr merge`, `keryx flow freeze|ac confirm|ac update|complete`
  run via `shell_exec` resolve to `auto` and **never reach `requestApproval`** (`permission-mode.ts:138-141`).
  `isPublishCommand` exists (`src/lib/command-risk.ts:300-324`, covers `git push`, `gh release`,
  `gh pr merge`, `npm/bun publish`) but only escalates when a bus publish-lease applies
  (`permission-mode.ts:72-83,130-132`), and its own doc says it is "not a security boundary".
- The managed-flow-file guard (`isManagedFlowFile`) lives only in the harness policy engine
  (`engine.ts:92,189-197`) — the interactive agent's `apply_patch` path does not consult it, so an
  agent could patch `flow.json` / `acceptance-criteria.md` / `.metaproject/triggers.json` /
  `data/trigger/runs.jsonl` (i.e. raise its own ceiling or erase its own spend).
- `shell_exec` OS containment is opt-in (`KERYX_SANDBOX_SHELL`, `src/harness/tool/builtin/shell-exec-tool.ts:10`).

**Conclusion for (a):** no existing runner can both do the work and hold an honest unattended posture.
The build is: the native agent turn (`runAgentTurn`, `agent.ts:1718`, composed like the ACP server does,
or `keryx shell --print` extended) with `unattended: true`, a permission mode taken ONLY from the trigger
entry (never the stored project default, never `auto`), saved shell allowlist NOT honoured, a
`requestApproval` that denies and records, and a new hard "unattended-forbidden" floor evaluated BEFORE the
mode so `trust` cannot auto-approve the forbidden list.

#### 2. Trigger budget today, and where a dispatched agent's cost can come from

- `evaluateTriggerBudget(projectRoot, actionKind, options)` (`src/trigger/run.ts:257-293`) sums
  `cost.usd` over EVERY record in `runs.jsonl` where `cost.recorded` (`run.ts:234-240`) — project-wide,
  across triggers and action kinds. Tagged `RecordedTriggerSpend` (`run.ts:224-226`): absent ledger =
  demonstrated `$0`; unreadable ledger = `known:false` → refuse before `evaluateSpendCap` is asked
  (`run.ts:262-279`). Ceiling is `evaluateSpendCap`'s default `DEFAULT_SPEND_CEILING_USD = 3`
  (`src/review/caps.ts:221-247,261-290`); no per-project or per-trigger knob (`run.ts:172-177`).
- Only `open-flow`/`flow-next` are gated (`src/commands/trigger.ts:354-358,443-447`); refusal records
  `budget-refused`, exit 0 (`trigger.ts:487-495`).
- `TriggerRunCost = {recorded:true, usd} | {recorded:false, reason}` (`src/trigger/record.ts:84-86`);
  **nothing produces `recorded:true` today** (`trigger.ts:227-235,304-307`). No token field on the record.
- **Where a real number comes from:** only claude-cli reports USD (`claude-cli.ts:396-408`). The native
  agent and codex report tokens only; there is no rate table. `keryx review` has the same gap and
  solved it by recording what the caller reports (`src/review/cost.ts:1-31`, `spent_usd` optional,
  "an unreported spend stays `not recorded` and never becomes `0`").
- **Consequence:** with the native runner, USD is available only if the operator declares rates on the
  trigger entry (input/output USD per million tokens). A dispatch whose cost cannot be priced would
  record `recorded:false` and never move either ceiling — spend would be unbounded. That must be a
  refusal (config-time rejection or pre-dispatch refusal), not a silent pass.
- **Refusing BEFORE spending** needs two checks: (i) pre-dispatch: `spent(trigger) >= ceiling(trigger)`
  or project-wide over → refuse, record `budget-refused`, no agent started; (ii) in-flight: pass the
  REMAINING allowance into the run as a hard cap (native: accumulate `onUsage` × rates and abort the turn
  at the cap; claude-cli: `--max-budget-usd remaining`), and record the partial cost of an aborted or
  failed run too — otherwise one run can overshoot by its whole size.

#### 3. Locks

- `withFileLock(lockPath, fn, {timeoutMs=5000, retryMs=25, staleMs=30000, heartbeatMs})`
  (`src/lib/fs.ts:76-148`): `mkdir` acquire + `owner.json {pid, token}` (`fs.ts:103-121`), heartbeat
  `utimes` every `staleMs/3` (`fs.ts:135-139`), stale reclaim only when mtime is old AND owner pid is
  dead (`fs.ts:216-243`), release only if the token is still ours (`fs.ts:140-147`). Timeout error text
  `"Timed out waiting for lock: <path>"` (`fs.ts:127-130`).
- **Not re-entrant.** A second acquire of the same path from the SAME process sees EEXIST; the owner pid
  (itself) is alive and the heartbeat keeps mtime fresh, so it is never judged stale; it waits
  `timeoutMs` and throws. With `timeoutMs: 0` it throws at once.
- `withTriggerRunLock` (`src/trigger/run.ts:96-157`): path `.metaproject/data/trigger/.run.lock`,
  `timeoutMs: 0`, contention → `{acquired:false}` → recorded `lock-refused`, exit 0. Used by
  `reconcile`/`rebuild` (`trigger.ts:199-215`) and `open-flow` (`trigger.ts:364-374`); `flow-next` takes
  none (`trigger.ts:437-465`).
- **Interactive commands take no lock**: `src/gdgraph/` and `src/wiki/` have none (286 context.md T5),
  `syncCommand` (`src/commands/sync.ts:13`) and `gdgraphCommand` (`src/commands/gdgraph.ts:29-91`) none.
  286's own AC3 confirmation line ("takes the same mkdir lock the interactive commands take") overstates
  this — the journal T7 scope note says the opposite and is right.
- **Where the shared lock goes:** entry of `syncCommand` when `--apply` (`sync.ts:33`), and entry of
  `gdgraphCommand` for `build` (`gdgraph.ts:29`, BEFORE `delegateToLocalRunner` at `gdgraph.ts:30-55`).
  Locking there covers the delegated child: `delegateToLocalRunner` spawns the copied
  `.metaproject/core/gdgraph/cli.ts` with `KERYX_GDGRAPH_LOCAL=1` (`gdgraph.ts:1046-1100`), which is a
  template that does not import keryx's lock code, so it cannot re-acquire.
- **Re-entrancy hazards, concrete:**
  1. `sync --apply` calls `gdgraphCommand(["build"])` in-process (`sync.ts:543-545`) — nested acquire of
     the same lock, same process → self-deadlock (5 s wait then throw) or immediate self-refusal.
  2. Triggered `reconcile`/`rebuild` already wrap `syncCommand`/`gdgraphCommand` in the lock
     (`trigger.ts:199-206`) — moving the lock into the commands makes that a second nested acquire.
  3. A dispatched agent will itself run `keryx gdgraph build` / `keryx sync --apply` through `shell_exec`
     (the routing text in every AGENTS.md tells it to rebuild the graph after moving files,
     `src/lib/templates.ts:218,407`) — a CHILD process. If `flow-next` held the shared lock for the whole
     agent run, the agent's own rebuild would be refused/timeout for hours. So `flow-next` must NOT hold
     the shared maintenance lock across the dispatch; it needs its own per-flow dispatch lock.
  4. The installed `post-commit` hook runs `keryx gdgraph build` (`src/lib/templates.ts:2122-2125`) and
     prints "gdgraph build failed" on any non-zero exit. An interactive/hook caller should WAIT (bounded)
     on the shared lock, and a lock-timeout must say "another reconcile/build holds the lock" rather than
     look like a build failure. Triggered callers keep `timeoutMs: 0` refuse-at-once (286 T7 decision).
- Re-entrancy fix options: (a) `AsyncLocalStorage` holding the set of lock paths this async context
  owns → nested acquire in the same context runs `fn` directly (no false re-entry for an unrelated
  concurrent call in the same process, which a module-level flag would give); (b) an env token passed to
  children. (a) covers hazards 1–2; hazard 3 is solved by not holding the lock across dispatch, not by
  inheriting it into the agent's children (inheriting would let the agent's rebuild race the operator's).

#### 4. Flow state when an unattended agent works a task

- State verbs (`src/flow/types.ts:348-440`): `taskAttempt` with CLI outcomes `started|failed|blocked`
  only (`types.ts:41-45`; `completed` is owned by `taskDone`, `paused` is migration-only);
  `taskDone` with `disposition completed|blocked|failed|skipped`, `evidenceRefs`, `acRefs`, `runLink
  {runId, sessionId, attempt, at}` (`types.ts:38,55-62,367-381`). Per-task `TaskBudget {maxSeconds,
  maxToolCalls, maxRetries, maxTokens}` exists (`types.ts:47-53`).
- Resume classification (`src/flow/machine.ts:184-268`): `never-started` / `ended` / `unresolved`
  (`attempt-not-closed`, `count-without-log`, `log-incomplete`). An `unresolved` task means someone may
  be mid-flight or half-landed — an unattended run must not start it again.
- What an unattended dispatch MUST do: take a per-flow dispatch lock; refuse unless the flow is frozen
  and `in-progress` (the operator chose the AC); refuse when `next` is `blocked`/`none` or the ready
  task's resume is `unresolved`; refuse when the task's attempt count has reached its cap
  (`TaskBudget.maxRetries` or a trigger default) — otherwise a failing task is retried every fire forever;
  record `task attempt --outcome started --detail <trigger run id>` BEFORE the model is called; on the
  agent's end record exactly one closing fact — `taskDone(disposition: "completed", runLink, evidenceRefs)`
  only when the run finished normally AND the post-run check passes (see recommendation), otherwise
  `taskAttempt(failed|blocked, detail)`; append the trigger run record (outcome, cost, tokens, task id,
  attempt, run id).
- What must NEVER happen unattended: `flow freeze`, `flow ac update`, `flow ac reseal`, `flow ac confirm`,
  `flow implemented`, `flow complete`, `flow renumber`, `flow block/unblock` by the agent itself, `flow
  task add/depends` (scope change); `git push` (any), `git merge`, `git rebase` onto a shared branch,
  `git tag`, `gh pr merge`, `gh release`, `npm/bun publish`; writing `flow.json`,
  `acceptance-criteria.md`, `.metaproject/triggers.json`, `.metaproject/data/trigger/**`, the
  permission-mode / credential files; `keryx workspace confirm-review` (already a floor). These must be
  refused by a hard floor that `trust` cannot lift — and refused, not asked, since nobody can answer.

#### Recommendations on the contentious choices (for the operator)

1. **Runner:** native keryx agent turn, not the external codecs. External is read-only in this release
   (`dispatch.ts:67-68`), so it cannot "get the next task done". Implement as an in-process
   `runAgentTurn` composition (ACP server precedent) behind a small `runUnattendedTask` function, run in a
   **dedicated git worktree on a `trigger/<flow>-<task>` branch** (never the operator's checkout, never
   pushed), with a hard wall-clock limit. In-process gives direct `onUsage`, direct `TerminalState`, and
   lets the posture be set in code rather than inherited from `shell --print`'s stored-mode/allowlist
   fallbacks. (Alternative: spawn `keryx shell --print --unattended …` for kill-ability; it needs the same
   posture changes inside `shell.ts` plus a new flag, so it is strictly more surface.)
2. **Permission posture:** trigger entry declares `permissionMode: "ask" | "trust"`; default `ask`;
   `auto` rejected at config load. Stored project default and saved shell allowlist are ignored.
   `unattended: true` always. Every `ask` becomes a recorded denial (serve-turn precedent,
   `serve-turn.ts:667-692`). Honest caveat: under `ask` the agent can only read, so a useful overnight
   run needs `trust` explicitly opted in per trigger; the forbidden-list floor is what keeps `trust` safe.
   Recommend also forcing `KERYX_SANDBOX_SHELL` containment for the unattended run when available and
   stating it when not; `web_fetch`/`web_search`/`use_tool`/`spawn_subagent` denied in v1.
3. **Cost:** tokens are always recorded; USD = tokens × rates declared on the trigger entry
   (`dispatch.rates.inputUsdPerMTok/outputUsdPerMTok`). A dispatching `flow-next` without rates or
   without `ceilingUsd` is REJECTED at config load — an unpriceable dispatch cannot be bounded. Extend
   `TriggerRunCost` additively with `tokens`.
4. **Task completion:** mark `taskDone(completed, runLink)` only when the turn ended normally, it
   produced a commit on the trigger branch, and `keryx health gate` passes in that worktree; otherwise
   `attempt failed|blocked`. Never `ac confirm`, never `complete`. The branch is left for the operator to
   review and merge. (Alternative: never mark done, only record `attempt` — safer, but then the next fire
   re-dispatches the same task; would need a new "awaiting-review" attempt outcome.)
5. **Report-only `flow-next`:** keep today's reporting behaviour when the entry has no `dispatch` block,
   and say so in `list`/`status`; dispatch is opt-in per entry. Breaking the released 0.2.154 shape buys
   nothing.
6. **Locks:** one shared `.metaproject/data/.maintenance.lock` taken at the entry of `sync --apply` and
   `gdgraph build` (and by `open-flow`'s check-then-create), re-entrant per async context
   (`AsyncLocalStorage`); interactive callers wait (bounded, e.g. 60 s) then fail with a named holder;
   triggered callers refuse at once (`timeoutMs: 0`) → `lock-refused`. `flow-next` dispatch takes a
   separate per-flow `.metaproject/data/trigger/flow-<id>.dispatch.lock` and never holds the shared lock
   across the agent run.
