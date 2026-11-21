---
name: flow-orchestrator
description: "Use when Task Manager is enabled and a non-trivial feature, issue, or story should be driven through keryx flow from initialization to a user-selected completion, verified handoff, or open state. NOT for: the same pipeline without Task Manager state (use job-orchestrator)."
triggers:
  - "создай фло"
  - "create flow"
  - "issue to flow"
  - "managed implementation"
  - "task manager orchestration"
  - "создай flow"
  - "заведи стори"
  - "implement with flow"
  - "flow orchestration"
metadata:
  author: "MrCipherSmith"
  version: "1.5.0"
  category: "orchestration"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Flow Orchestrator

## Preflight

Run in the main session: this skill dispatches workers. Without a subagent-spawn tool (`Agent`, `spawn_subagent` or the host's equivalent), or with the depth budget spent (Claude Code nests at most 3 deep), the whole output is this line, with no tool calls and no work of your own: `STATUS: BLOCKED nested_dispatch_unavailable — run this skill in the main session`

## Purpose

**You are the orchestrator** — the Task Manager-aware implementation orchestrator. You plan, dispatch workers, commit at task boundaries and move the flow through `keryx flow`; workers write the code. Use this skill instead of `job-orchestrator` when the user wants a managed story/issue lifecycle with frozen acceptance criteria, task state, an explicit completion choice, Code Health, and a durable flow package in `.metaproject/flows/`. Where a `keryx flow` or `keryx review` command computes, gates or refuses something, this file names the command and what to do with its output; it does not restate the rule. Read the output and act on it.

Plan bridge: publish the tasks with `plan_set` under the ids `T1`…`Tn`, mirror each `keryx flow task done` with `plan_update`, and publish Phase 4's completion choice as `proposed` — see the `session-plan-bridge` rule.

| | keryx shell | Claude Code | other hosts |
|---|---|---|---|
| Spawn | `spawn_subagent` | `Agent` (`subagent_type` = the worker skill; no such type: `general-purpose` with the worker's `SKILL.md` path in the prompt) | its spawn tool |
| Question | `ask_user` (a card where one exists) | `AskUserQuestion`, one question with options | one question in your reply, then wait |
| Plan | `plan_set`, `plan_update` | its todo list | its plan tool, else a checklist in your reply |

## Hard Preconditions

1. Read `.metaproject/index.md` and `.metaproject/metaproject.json`.
2. Task Manager must be enabled: `modules.tasks.enabled: true` in `metaproject.json`, and `.metaproject/skills/flow/SKILL.md` present. If not, stop and tell the user to run `keryx update` or initialize with the Task Manager module enabled. Do not emulate flow state by hand.

## The record

Flow state lives in `.metaproject/flows/<dir>/`. The CLI owns `flow.json` (read it freely, never write it), status transitions (`keryx flow …`), task status (`keryx flow task done`), attempt counts (`keryx flow task attempt`) and frozen acceptance criteria (`keryx flow ac update <id> --reason "<why>"`, or `--criterion ACn --text "…" --reason "<why>"` to rewrite one line). You edit `description.md`, `context.md`, `plan.md`, `tasks.md` (task definitions only) and `journal.md`.

Never bypass the CLI for a state change, never let a worker edit `flow.json` or frozen AC or decide completion, and never reword a criterion to fit what was built: change it through `keryx flow ac update` with the reason. Read broad source trees only after gdgraph/gdctx/wiki/memory have narrowed the context.

## Workflow

Keep this as your todo list (Claude Code) or plan; tick each item when its artifact exists.

```
Flow Orchestrator Progress:
- [ ] 0.0 `keryx flow list`; an interrupted flow → ask resume or new (question tool)
- [ ] 0.1 route to an existing flow, or `keryx flow init` with `--base`; `keryx flow status <id>`
- [ ] 1  execution-metrics question (direct user run only)
- [ ] 1  context from gdgraph, gdctx, gdwiki, memory, health/testing; read the required rules
- [ ] 1  write description.md, context.md, plan.md (state × event matrix or "not applicable"), tasks.md
- [ ] 1  every verification step of the plan added as a task (`keryx flow task add`)
- [ ] 1  acceptance-criteria.md: one `[verify: …]` marker per criterion; one kinds question to the operator if any is unclear
- [ ] 1  sourced from a finding: `review-premise` before freeze
- [ ] 1  `keryx flow freeze <id> --yes`, `keryx flow start <id>`; publish T1…Tn to the plan
- [ ] 2  once: worktree path resolved and branch checked; JEV edit guard checked
- [ ] 2  per task: resolve-context → attempt `started` → dispatch (Worker brief) → read STATUS → validate → boundary commit → `flow task done`
- [ ] 3  focused tests, `code-verifier`, `keryx health run`; first-green question; budget check; `review-orchestrator` inline; fix rounds; skill learning
- [ ] 4  completion question (A/B/C), or the typed input of a dispatched run; A: PR review/fix loop, merge, `keryx flow implemented`
- [ ] 5  `keryx flow ac confirm` per criterion, `keryx flow check-complete`, `keryx flow complete`
- [ ] Completion report
```

## Phase 0: Route And Resume

### 0.0 State resumption check — every invocation, before asking anything

The input contract's `mode: "resume"` runs this, but so does every other invocation: a restarted session remembers nothing; the flow package does.

1. Run `keryx flow list`. A flow in `in-progress`, `implemented`, `completing` or `blocked` is interrupted.
2. If one exists, ask once, with the numbers: "Found an in-flight flow `<id>` '<title>' (status `<status>`, tasks `<done>/<total>`). Resume it, or start a new flow?" Never guess.
3. On resume:
   1. `keryx flow status <id>`; read `description.md`, `plan.md`, `context.md`, `journal.md` and the frozen `acceptance-criteria.md`.
   2. Read `flow.json` (read-only) for `tasks[].attempts.count` and `tasks[].attempts.log` of every task not `done`. **That is the attempt count. Never count attempts from your own context** — a resumed session starts at zero, the real count does not.
   3. `keryx flow next <id> --json` names the next task (first not `done` whose `dependsOn` are all `done`). Do not derive it from prose.
   4. **Read its `resume` field before dispatching anything:**
      - `never-started` — dispatch normally.
      - `ended` — a retry; the attempt budget applies.
      - `unresolved` — an attempt opened with no recorded end; whether its work landed is UNKNOWN. Inspect the working tree and the task's `evidenceRefs`, then either close the stale attempt (`keryx flow task attempt <id> <Tn> --outcome failed --detail "<what you found>"`) or close the task (`keryx flow task done <id> <Tn>`). Never re-dispatch over an unresolved attempt.

      Resolve every other task `keryx flow next` lists under `unresolved` the same way.
   5. Record the attempt before dispatching: `keryx flow task attempt <id> <Tn> --outcome started --detail "resumed after session restart"`.
   6. If the task's persisted `attempts.count` has already reached **five**, do not re-dispatch the same approach: go to the re-planning step (Phase 4 loop, step 5) and journal the decision.
   7. Whatever the count says, run `keryx review loop --flow <id> --task <Tn>` before spending an attempt; a non-zero exit (a recurring finding, or two identical rounds) sends you straight to re-planning.
   8. A `blocked` flow: read the reason in `journal.md`, resolve or escalate it, then `keryx flow unblock <id>`.
4. A new flow: continue at 0.1.

Record attempts as they happen, not only on resume: `keryx flow task attempt <id> <Tn> --outcome started|failed|blocked [--detail "<what happened>"]`. The count lives in `flow.json`; a counter in your context resets exactly when the bound matters.

### 0.1 Route

1. Reuse the `keryx flow list` output. An active flow that obviously matches the request: use it. Several could match: ask one concise question.
2. No flow and a multi-step request: create one, always recording the base branch the work must land on:

   ```bash
   keryx flow init --issue <url> --base "<branch>"
   keryx flow init --title "<short formalized problem>" --base "<branch>" [--owner "<name>"]
   ```

   `--base` puts the base in the record, where the completion gate reads it; prose in `context.md` is not checked.
3. `keryx flow status <id>` and read the package.

## Phase 1: Initialize The Flow Package

Follow `.metaproject/skills/flow/init.md`.

Execution metrics (opt-in): when a USER runs this orchestrator directly, at the start ask "Collect execution statistics for this run? (yes/no)" per `rules/process/execution-metrics.md`. If yes, append the `## Execution Metrics` section at the end and save it under `<flow-dir>/metrics/`. Never ask or emit it when dispatched as a subagent.

Context sources: gdgraph (impacted files, dependencies), gdctx (compact command/search/diff output), gdwiki (architecture, domain rules, decisions), memory (lessons, repeated failures, constraints), health/testing reports (baseline risk).

Rules to read and apply:
- `.metaproject/rules/process/requirements-management.mdc`, `implementation-plans.mdc`, `implementation-doc-mandate.mdc`, `execution-metrics.md`
- `.metaproject/rules/process/subagent-context-construction.md`, `subagent-status-protocol.md`
- `.metaproject/rules/process/git-concurrency.mdc` — no `git stash`, no unscoped `git add`, pin every dispatch to its worktree
- `.metaproject/rules/core/tdd-workflow.mdc`, `.metaproject/rules/core/error-handling.mdc`, and per role `.metaproject/rules/activity/implement.mdc`, `test.mdc` or `review.mdc`
- `.metaproject/rules/stacks/react/code-style-patterns.mdc`

Write or update:
- `description.md` — problem, expected outcome, out of scope;
- `context.md` — compact links and findings, not raw dumps;
- `plan.md` — chosen approach and trade-offs, plus the state × event matrix below;
- `tasks.md` — task definitions grouped by context, test, implement, review, docs;
- `acceptance-criteria.md` — verifiable `ACn` criteria, each ending in one marker: [verify: exec `<command>`] or [verify: invariant `<command>`] (a backticked command), [verify: judged] (a human checks: live run, operator decision, text quality), or [verify: none — <reason>]. If a kind is unclear, ask the operator ONE question listing the criteria with proposed kinds, before `flow freeze`. Behaviour with an external dependency or a failure path gets its own failure-scenario criterion with an observable result (saved, error visible, retry creates no duplicate); a check claimed to catch a regression carries `· sensitive: revert|mutation|failure-scenario` and the confirm note carries `evidence: <ref>` (revert/mutation run or failure-scenario reference). Put the marker on every criterion before freeze: an `unclassified` criterion cannot become data afterwards without a recorded rewrite (`keryx flow ac update <id> --criterion ACn --text "…" --reason "<why>"`). `keryx flow ac kinds <id>` shows the kind each criterion parsed to.

### State × event matrix in plan.md

When the scope touches UI, a store, or other code that holds state across events, `plan.md` carries a state × event matrix before `flow freeze`. Rows are the states the surface can be in (loading, loaded, empty, missing, first-load failed, refresh failed); columns are the events that reach it (selection change, unmount, workspace or context change, retry). Each cell is one line: what the user sees and which state survives, citing the project's styling/UX rules where they decide it. List only the states and events the change reaches. Every non-trivial cell gets an `ACn` (or one AC per group of cells with the same result); a "no change" cell needs none.

| state \ event | user switches selection | unmount | retry |
|---|---|---|---|
| loading | drop the stale response; loading shows for the new one | no state write after unmount | — |
| refresh failed | keep loaded data; the error does not follow to the new selection | — | re-fetch; error stays inline until success |

No UI or state in scope (CLI output, pure functions, docs, build config): write `State × event matrix: not applicable — <why>` in `plan.md`. Workers and fix rounds check behaviour against the matrix; a choice no cell decides is a `behavior_changes` question for the operator (Phase 2).

### A verification step in the plan is a task, not a sentence

Every check the plan says must happen before the work is accepted — run it end to end, confirm two components agree, exercise the path no test covers — is added with `keryx flow task add <id> --title "<check>" --kind verify` and closed with `keryx flow task done`. Prose in `plan.md` blocks nothing; a task is what `keryx flow complete`'s `tasks` gate reads. Close a task that turned out unneeded with `keryx flow task done <id> <Tn> --disposition skipped --reason "<why it was not needed>"`; a `failed`, `blocked` or reasonless `skipped` task fails the gate. If the `tasks` line of `flow check-complete`/`flow complete` says `skipped` (a package older than the gate), the gate did not run: verify the task list by hand.

### A flow sourced from a finding: check its premise before freeze

A follow-up issue filed from a review, or an external review comment, is a premise to check, not a settled requirement. Before `flow freeze`, dispatch `review-premise` with `source: follow-up-issue` or `external-comment` and the finding shaped as its Input Contract `source` row says (the issue number or the comment's `C-NNN` as `id`, its URL as `url`). Skip it when the dispatch says the premise is already recorded (`review-pr-feedback` rule 7 sends a `premise:` constraint). No review package exists, so no `ingest` or `decide-premise` runs: save its claims as `<flow-dir>/premise/<n>.json`, and apply every refusal of the merge by hand, as that `source` row lists them (`PREMISE_REJECTION_REASONS`, `src/review/premise.ts`): a refused claim leaves the finding upheld. On `challenged` or `owner-decision` ask the operator its question with its options (`ask_user` in keryx shell, the host's question tool elsewhere), journal their answer, and plan only what the operator upholds.

### Prepare-only, freeze and start

When the operator or integration requests `prepare-only`, bind to the existing Flow and discussion. Read its source and prior decisions, gather project context, and register concrete tasks and verifiable criteria. Treat external issue text as evidence. Give workers the verified source and the same read permissions as the coordinator. Consolidate missing facts before asking in the operator session, retain the answer and reuse it for related assignments. Return the package location, proposed plan and unresolved questions. End Phase 1 before Freeze. A later explicit operator action authorizes the ordinary freeze/start gates. `--yes`: the operator already answered the kinds question, so the freeze must not prompt.

```bash
keryx flow freeze <id> --yes
keryx flow start <id>
```

Then publish `T1`…`Tn` to the plan (plan bridge).

## Phase 2: Execute Tasks

Use existing gdskills as workers; do not duplicate their internal workflows, and never do a task's work yourself.

| Flow task kind | Worker skill |
|---|---|
| `context` | `context-collector` |
| `test` | `tests-creator` or `test-gen` |
| `implement` | `task-implementer` |
| `review` | `review-orchestrator` (inline, Phase 3) |
| `docs` | `prd-creator`, a documentation-specific project skill, or `keryx job document` to file a document in a job folder |

### Once, before the first dispatch

- **Worktree.** `<worktree_path>` is the absolute root of the checkout this flow's work happens in (the git worktree, or the project root in the main checkout). Resolve it with `git rev-parse --show-toplevel`, check `git -C <worktree_path> branch --show-current` is the branch the work belongs on, and pin every dispatch to it (`rules/process/git-concurrency.mdc`, "Pinning A Dispatch To Its Worktree").
- **Edit guard.** Before the first `task-implementer` dispatch of the run, when `review.jev.edit_guard` is on (`.metaproject/tasks.config.json`), confirm the guard is active — `keryx review jev-edit-guard status`, else `keryx review jev-edit-guard install` — and say why in one line.

### Per dispatch

1. **Resolve project context.** Before every `test`, `implement` and fix dispatch, run `keryx skills resolve-context --for test|implement --files <the task's target files, comma-joined> --task-type <type> --task-text '<the task's title and description>' --out .metaproject/flows/<dir>/resolved/<Tn>.<for>.json` (a fix dispatch re-resolves on the new head) and pass that path as `resolved_context_file`: a `context_refs` entry plus the constraint below. Single-quote the text (a `'` inside becomes `'\''`): double quotes let the shell run a backtick or `$(...)` from the description. `--task-text` (`task_text` in the harness and MCP) is what lets a `references.json` keyword match; without it only globs promote.
2. **Record the attempt:** `keryx flow task attempt <id> <Tn> --outcome started --detail "<dispatch_id>"`.
3. **Build the dispatch** — a `subagent-dispatch` (`.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json`); workers inherit no session state (`rules/process/subagent-context-construction.md`). Tick the Worker brief below, then `keryx skills contracts validate <dispatch.json> --schema subagent-dispatch` and fix what it names.
4. **Dispatch**, then read the reply by the STATUS table.
5. **Validate the reply** before accepting it: `keryx skills contracts validate <result.json> --schema task-implementer-output|tests-creator-output --resolved <that file>`. Under `gdskills.projectContext.enforcement: block` a miss is a refusal (re-dispatch); under `warn`, journal it. It checks that each promoted `must_read` entry (reason `condition:glob:<g>` or `condition:keyword:<k>`) is cited in `project_context_applied` with `path`, whole-file `sha256`, `anchor`, a `summary` in the worker's words and `how` `read` or `followed`.
6. **Boundary commit, then `keryx flow task done`** (below).

### Worker brief — required contents (every dispatch)

A line left out is a defect of the brief, whatever schema validation says. Pointers, not paraphrases: give paths and do not restate their text.

- [ ] A `run_id` = flow id; `dispatch_id` = `<flow-id>-<Tn>`, the same across retries of that task.
- [ ] B `target_skill` from the routing table; `task` = title, description, `intent`.
- [ ] C `acceptance_criteria` = the frozen `ACn` lines this task must satisfy, verbatim.
- [ ] D `context_refs` = the flow's `context.md`, `plan.md`, `acceptance-criteria.md`, and the resolved file of step 1.
- [ ] E `files_to_read` = only the files gdgraph/gdctx narrowed to.
- [ ] F `constraints`, every one of: never edit `flow.json`; never edit frozen AC; the `resolved_context_file:` line; return a `subagent-result` whose first line is `STATUS:`; the agent-conduct "Dispatch form" line verbatim; git-concurrency (no `git stash`, no `git add -A`); the `Root:` pin to `<worktree_path>`; auto-commit off.
- [ ] G `allowed_actions`, `output_contract` (`subagent-result`, artifact `journal.md`), `budget`, `provenance`.
- [ ] H Fix dispatch only: `fix_context.review_feedback` = each finding's `id` and `suggested_fix` (held findings never), reviewers' red probes as `test_case_specs`, and `premise_verdict`/`premise_answer` for an upheld held finding (Phase 3 step 6).

Workers do not commit: you own every commit. A `subagent-dispatch` has no `automation` field, so auto-commit off travels as the constraint below — task-implementer's own default is `true`.

```json
{
  "contract_version": "1.0.0",
  "run_id": "<flow-id>",
  "dispatch_id": "<flow-id>-<Tn>",
  "orchestrator": "flow-orchestrator",
  "target_skill": "task-implementer",
  "task": { "title": "<Tn title>", "description": "<what to do>", "intent": "implement" },
  "acceptance_criteria": ["<the frozen ACn lines this task must satisfy>"],
  "context_refs": [
    { "path": ".metaproject/flows/<dir>/context.md", "kind": "context", "exists": true },
    { "path": ".metaproject/flows/<dir>/plan.md", "kind": "plan", "exists": true },
    { "path": ".metaproject/flows/<dir>/acceptance-criteria.md", "kind": "custom", "exists": true },
    { "path": ".metaproject/flows/<dir>/resolved/<Tn>.<for>.json", "kind": "custom", "exists": true }
  ],
  "files_to_read": ["<only files gdgraph/gdctx narrowed to>"],
  "constraints": [
    "Never edit flow.json.",
    "Never edit frozen acceptance criteria.",
    "resolved_context_file: .metaproject/flows/<dir>/resolved/<Tn>.<for>.json — read its must_read entries and cite each in project_context_applied; an entry promoted by a condition also needs its anchor and a summary.",
    "Return a subagent-result; first line must be STATUS:.",
    "Agent conduct (mandatory): <the \"Dispatch form\" line of .metaproject/rules/process/agent-conduct.mdc, verbatim>", "Follow rules/process/git-concurrency.mdc: never git stash; never git add -A.",
    "Root: <worktree_path>. Before the first write run `cd <worktree_path> && pwd && git branch --show-current`; run every git command as `git -C <worktree_path>`.",
    "Auto-commit is off (automation.auto_commit: false): do not commit; list every path you changed in changed_files. flow-orchestrator commits them at the task boundary."
  ],
  "allowed_actions": ["read", "write", "run-command", "git"],
  "output_contract": { "schema": "subagent-result", "artifact_path": ".metaproject/flows/<dir>/journal.md" },
  "budget": { "max_output_tokens": null },
  "provenance": { "created_at": "<iso-utc>", "created_by": "flow-orchestrator" }
}
```

### Reading the reply (STATUS protocol)

Read the `STATUS:` line first; never infer the outcome from prose (`rules/process/subagent-status-protocol.md`). A reply without one is `NEEDS_CONTEXT`: re-request one properly formatted `subagent-result`.

| Worker `status` | Action |
|---|---|
| `DONE` | Accept, boundary commit, `keryx flow task done <id> <Tn>`. |
| `DONE_WITH_CONCERNS` | Accept, boundary commit, record every concern in `journal.md`, decide continue vs. a fix task, then `flow task done`. Never drop a concern. |
| `NEEDS_CONTEXT` | Not a failure. Enrich `context_refs`/`files_to_read` from gdgraph/gdctx/wiki/memory and re-dispatch the same `dispatch_id`. |
| `BLOCKED` | `keryx flow task attempt <id> <Tn> --outcome blocked --detail "<worker reason>"`, `keryx flow block <id> --reason "<worker reason>"`; resolve or escalate one concise question, `flow unblock`, re-dispatch. Never implement it yourself. |
| `FAILED` | Only harness child workers emit it (`src/harness/child/contract.ts`; `task-implementer` maps its `failed` onto `BLOCKED`). Retry once with the same dispatch; a second failure blocks the flow and goes to the user. |

**A `behavior_changes` entry with `needs_operator: true` is a question, not a concern to journal.** Before accepting that result, ask the operator with the question tool — one question per entry, the implemented choice and each of its `alternatives` as options — and record the answer in `journal.md`. An answer other than the implemented one is a fix task on the same `Tn` before the boundary commit.

### Task boundary commit

After every accepted result (`DONE` or `DONE_WITH_CONCERNS`), commit exactly the worker's `changed_files` that git still shows as changed — never `-A`/`--all`/`.` (`rules/process/git-concurrency.mdc` rule 4) — then mark the task done. Nothing left (a worker that reported no files, or committed its own stubs like tests-creator) skips cleanly:

```bash
set -- <each changed_files path, single-quoted: 'src/a.ts' 'docs/b c.md'>   # may be none; an unquoted path with a space splits and is skipped
PENDING=()
for p in "$@"; do
  [ -n "$(git -C <worktree_path> status --porcelain -- "$p")" ] && PENDING+=("$p")
done
if [ ${#PENDING[@]} -eq 0 ]; then
  echo "boundary commit: nothing left to commit, skipped"
else
  git -C <worktree_path> add -- "${PENDING[@]}"
  git -C <worktree_path> commit -m "<type>(<scope>): <Tn title>

task: <Tn>" -- "${PENDING[@]}"
fi
keryx flow task done <id> <Tn>
```

The per-path check and the trailing `-- "${PENDING[@]}"` keep a file another lane staged out of this commit. New work discovered on the way: `keryx flow task add <id> --title "<task>" --kind <kind>`.

## Phase 3: Verification And Review

Before accepting implementation:

1. Run focused tests for the touched scope.
2. Run `code-verifier`.
3. Run `keryx health run` when Code Health is enabled.
4. **First-green gate, once per flow.** The first time every implement/test task is `done` and steps 1–3 pass, ask the operator one question (question tool, options) before any review round: `issue AC met — open the PR with the standard review`, or `harden first` with each extra matrix cell or failure path you would add as its own option. Journal the answer; picked hardening becomes `keryx flow task add` tasks (plus `keryx flow ac update` when it adds criteria) before review. A dispatched run has no operator: it takes the standard review and journals that the dispatch answered the gate.
5. Check the bounds, then run `review-orchestrator` with relevant domains — in this session,
   never handed whole to one subagent: one without a dispatch tool returns `STATUS: BLOCKED`.
   ```bash
   keryx review budget --spent <usd-so-far> --full --outstanding <subagents still running, 0 if none>
   ```
   A non-zero exit means the spend ceiling (3 USD by default) has been reached:
   **stop and ask the user** rather than dispatching another fan-out — never shrink the fan-out to fit.
   Pass `--outstanding` every time: keryx cannot see subagents running in this session, so without it the cap bounds nothing. `--full` for `--all`.
   Dispatch prompts point at sources (files, SHAs, the PR) and never paraphrase a contract.
   Every round opens with `keryx review start` on the current head, never a hand-built range (Phase 4 loop, step 1).
6. Findings that need code changes: a fix round through `task-implementer`, recorded as a flow fix task:
   - **Scope freeze.** A fix round fixes the round's findings and nothing else. Hardening, refactors or new cells a fix suggests go to the operator as a question (as in step 4).
   - **Red probes → ONE implementer.** Reviewers' red probes (failing tests or commands on the findings) go as `test_case_specs` to one `task-implementer` dispatch — no separate `tests-creator` task. `tests-creator` runs only for a new contract no probe covers.
   - **A held finding is not fixed.** A finding `review-premise` held (`challenged` or `owner-decision`) is neither fixable nor clean: it never goes into `fix_context.review_feedback` and it blocks the loop until answered. Ask the operator as `review-orchestrator` "Wave D" says (the card in keryx shell; elsewhere the host's question tool, naming the finding id, then `keryx review decide-premise` with `--answered-by <source>:<ref> --answer-text … --question-text …`) and journal the answer; only an upheld finding enters a fix round, carrying `premise_verdict` and `premise_answer` as task-implementer's `FIX_CONTEXT` defines them. A dispatched run leaves it held and journals it.
   - **`suggested_fix` is a hypothesis.** Pass each finding's `id` and `suggested_fix` in `fix_context.review_feedback`; the implementer reproduces it (red), checks the suggestion against the state × event matrix, then fixes (task-implementer 1.3). Journal every `suggested_fix diverged` / `did not reproduce` note it returns.
7. Close the skill-learning loop (`rules/process/skill-lifecycle.mdc`). Collect the `skill_drift` fields from task-implementer results and the `## Skill Learning` block from review-orchestrator. For each flagged project skill, dispatch a subagent — on a cheaper model if `keryx review tier --findings 1 --diff-lines 0` resolves one (`rules/process/model-selection.mdc`), otherwise the session model — to run `keryx skills learn --from-review <report> --skill <m>/<s>` and return the proposal. Read it, then `skills learn apply` it or discard it. Never apply unread; never put `learn` in a hook. Record applied updates in the completion report.

The implementer never self-accepts: only you decide whether the flow can move to `implemented`.

## Phase 4: Completion Choice

When tasks, verification and review are complete, stop before creating a PR or changing the flow to `implemented`, and ask the user how to finish (question tool; no default, wait for the answer). Not every flow needs a PR:

```text
How should this flow end?

  A) Create a PR, review it, merge it into the flow's base branch, and complete the managed flow
  B) Finish with a verified handoff and no PR
  C) Keep the flow open for more work
```

- **A — Create PR and merge:** create or confirm a PR in the author's name against the base recorded at init, run the PR review/fix loop below, merge, then `keryx flow implemented`. Never mark the flow implemented or complete before the merge into that base. The `base-branch` gate of `keryx flow complete` compares where the merge landed with the recorded base; a flow with no recorded base fails it (`not recorded`), so make sure `--base` was recorded at init.
- **B — Verified handoff without PR:** no PR, no `keryx flow implemented`, no `keryx flow complete`. Produce the completion report with verification and acceptance-criteria evidence, record that the implementation work is finished, and leave the flow `in-progress`, explaining that the CLI requires a recorded PR before it can move the flow to `done`.
- **C — Keep open:** record remaining or deferred work in `journal.md`, report the current verification state, leave the flow `in-progress` for resume.

### A dispatched run answers the question from its input

The choice is the USER's, and a subagent has no user to ask: a dispatched run that asks stalls on a prompt nobody reads. Validate the input first:

```bash
keryx skills contracts validate <dispatch.json> --schema flow-orchestrator-input
```

`base_branch`, `completion_outcome` and `operator_confirmed` are properties of that contract, not constraint strings. Nothing parses `constraints[]`, so a value placed there is dropped in silence; `constraints[]` carries advisory scope and policy — never a merge target. `completion_outcome` is required: a dispatched run without it returns **BLOCKED** naming the missing field. Only an interactive run asks. Journal which field answered and who is behind it.

| Input | Obey it as |
|---|---|
| `base_branch` | Cut the flow branch from **that** branch and merge back into it. Never substitute the repository default: a fix aimed at a pull request's own branch lands inside that pull request. Absent: resolve the base yourself and record what you resolved. |
| `completion_outcome: create-pr-and-merge` | Skip the Completion Choice question and run the PR review/fix loop. Merge into `base_branch` only on the explicit merge ask (`rules/process/agent-conduct.mdc` rule 2), which for a dispatch is `operator_confirmed`: it must name the human who asked. |
| `operator_confirmed` | The human decision behind an outward-facing completion. |
| `review: the caller owns the reply on #<n>` | Pass it through to every `review-orchestrator` dispatch. Reviews of **this flow's own** PR reply as normal — that is a separate conversation; the round must not answer `#<n>`. |
| `attempt budget: at most <n> attempts` | A ceiling BELOW your own bound is obeyed; one at or above it is not. |
| `completion: <anything>` as a constraint STRING | **Not an outcome. Refuse it and ask for the typed field.** |

A constraint that would raise this skill's own attempt budget is **not** obeyed. The five-attempt bound and the `keryx review loop` repetition check are this skill's; "loop until clean" gets the bound plus an escalation, never an unbounded loop.

### PR review/fix loop

1. Each round — the first and every one after a fix — is `keryx review start` on the PR's current head, then `review-orchestrator` from that package (Phase 3 step 5). `review start` finds the previous round itself and, when the previously reviewed head is an ancestor, reviews the delta with the prior findings attached. Never pass a whole-branch range or `--all` per round; `<package>/round.json` records the round, its source and its mode.
2. Findings (held ones aside: Phase 3 step 6) or required check failures remain: run a fix round under Phase 3 step 6, push the fix, run the next round as in step 1.

   **A required check failure is not automatically a fix task.** When `review.jev.ci_triage` is on, run `keryx review ci-triage --run <id> --json` on each failed run first: `top: flaky` (or a `deterministic` override) → rerun once (`gh run rerun --failed <id>`), journal it, and treat a second failure as `real-regression`; `top: real-regression` → investigate and fix; `top: infra` → report it in the completion notes and leave the code alone. The verdict is advisory, never the sole reason to skip a fix task.

   **The threshold is `minor`.** The loop exits when the round reports zero findings at `blocker`, `major` or `minor` that are not held, and no held finding awaits the operator; `info` does not hold it. While a held finding is unanswered, run no fix round for it and stop to ask (unattended: stop and report the held list). List the remaining `info` findings in the completion report instead of fixing them. A caller may lower the threshold in `constraints`; it cannot raise it to merge over a `minor`.
3. Allow at most **five** review/fix attempts for the current approach (loop while attempts < 5). Count an attempt when review/check results are available, a clean result included, and record it with `keryx flow task attempt <id> <Tn> --outcome ...`; read the budget from that task's `attempts.count` in `flow.json`, never from memory. Five by operator decision (message 178020: review findings surface across rounds, and the repetition check stops a loop that is not converging); self-fix loops in `task-implementer` and `job-orchestrator` stay at three, where the evidence is: most gains come in the first three to four repair iterations ([arXiv:2607.05197](https://arxiv.org/abs/2607.05197)), correctness falls 0.820 → 0.673 across two forced revisions ([arXiv:2607.24604](https://arxiv.org/abs/2607.24604)), and other agent tools hardcode `max_reflections = 3`.
4. **Before** spending an attempt, however much budget is left, run `keryx review loop --flow <id> --task <Tn>`. A non-zero exit (the same finding in two rounds, or two consecutive identical rounds) escalates to step 5 now.
5. Fifth attempt not clean, **or the repetition check escalated**: do not repeat the same loop. Enrich context from the findings, the affected graph, the relevant wiki and health/testing artifacts; identify the likely cycle cause; choose a materially different fix strategy or split the work into narrower tasks; journal the decision; continue with the enriched context. The review round count is not reset: past `REVIEW_ROUND_CAP` rounds on one merge-base..HEAD, report to the operator instead of running another round.
6. Never merge while findings or required checks remain unresolved. If the re-planned approach still cannot produce a mergeable PR, leave the flow `in-progress` and report the blocker.

When the PR is mergeable, required checks are green and the merge was explicitly asked for (the user picked A in this session, or `operator_confirmed`; otherwise stop and ask — agent-conduct rule 2), merge it into the recorded base branch, verify that the merge completed, and only then record it:

```bash
keryx flow implemented <id> --pr <pr-url>
```

Continue to Phase 5 only after the user selected A, the loop is clean, and the merge into the recorded base is confirmed.

## Phase 5: Complete The Flow

Follow `.metaproject/skills/flow/complete.md`. The flow folder is committed in the same PR as the code; never retarget or close against a branch other than the recorded base.

1. For every acceptance criterion, verify its evidence and run `keryx flow ac confirm <id> ACn --note "<evidence>"` (`--signed-by "<name>"` names the signer; otherwise `KERYX_ACTOR` or the git identity is recorded, as a claim).
2. Run `keryx flow check-complete <id>`: it lists every completion gate and the PR's merge state and writes nothing. For each refusal, run the fix it names (owner, committed folder, confirmation token, …) and check again. `keryx flow check` reports an id clash with a remote branch (`keryx flow renumber <dir> --to <free id> --reason "<why>"`).
3. A flow created with `--require-confirmation` needs `--confirm-token <token>`: in keryx shell call the `flow_confirm` tool (the operator answers a card; never send them to a terminal); elsewhere the operator mints it with `keryx flow confirm <id>` in their terminal.
4. `keryx flow complete <id>`. Gates that fail return the flow to `in-progress`: journal it, create fix tasks, repeat Phase 2. A flow stuck in `completing` after a crash or interrupted attempt (never a normal gate failure): `keryx flow recover <id> --reason "<why>"`.

Released work whose remaining refusal is known: read [completion-exceptions.md](completion-exceptions.md) before closing — fresh operator words, failing gates preserved, never called clean.

## Completion Report

- flow id and final status;
- selected completion outcome;
- PR URL when a PR was created;
- tasks completed;
- acceptance-criteria evidence summary;
- verification/review results, applied skill updates;
- unresolved risks or blocked gates.

For a verified handoff without PR, distinguish "implementation work finished" from Task Manager status `done`: report the flow as `in-progress` and say why it was intentionally not transitioned.

## Contracts

| Direction | Schema |
|---|---|
| Skill input | `skills/gdskills/orchestration/flow-orchestrator/input-contract.schema.json` |
| Skill output | `skills/gdskills/orchestration/flow-orchestrator/output-contract.schema.json` |
| Worker dispatch | `core/gdskills/contracts/subagent-dispatch.schema.json` |
| Worker result | `core/gdskills/contracts/subagent-result.schema.json` |
| Durable flow state | `.metaproject/flows/<id>/flow.json` (CLI-owned; never agent-written) |

Validate any of them with `keryx skills contracts validate <file> --schema <name>`.
