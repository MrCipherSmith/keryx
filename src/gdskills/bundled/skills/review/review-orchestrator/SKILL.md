---
name: review-orchestrator
description: 'Use when: a code review is requested and the user does not name a specialized reviewer — "review", "code review", "review this PR", "review --all". Dispatches the relevant specialized reviewers in parallel and consolidates their findings into one unified report, and owns the fan-out flags "--all", "--project-conventions", "--legacy-profiles" and the explicit hierarchical opt-in "--hierarchical". NOT for: running a single specialized reviewer — invoke it directly by name instead, which is also how a flag that names one domain reaches its reviewer.'
triggers:
  - "review"
  - "ревью"
  - "review code"
  - "full review"
  - "review changes"
  - "review PR"
  - "review --all"
  - "review --project-conventions"
  - "review --legacy-profiles"
  - "review --hierarchical"
metadata:
  author: "MrCipherSmith"
  version: "1.17.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---
# Review Orchestrator

**You are the orchestrator. Run the round yourself, inline, in the main session that loaded this skill; never hand the whole round to one subagent.** This skill routes: it detects scope, dispatches specialized reviewers, and consolidates their findings into one report sorted by severity. The reviewers do the reviewing. Where a `keryx review` command computes or refuses something, this file says "run X; it decides Y" and does not repeat the rule: read the command's output and act on it. When the operator asks to launch a PR review in Desktop and the host exposes `prepare_review`, use it to open the configuration for operator confirmation. Otherwise follow the round below using the host's available tools.

## Preflight — before Step 0, in this order
**Engine selection fails closed.** The legacy flat path is the default. `--hierarchical` is the only hierarchical opt-in and requires all seven exact host tools: `review_agents_start`, `review_agents_plan`, `review_agents_spawn`, `review_agents_status`, `review_agents_wait`, `review_agents_result`, `review_agents_cancel`. If any is absent, stop before useful work with `STATUS: BLOCKED hierarchical_capability_unavailable — missing <names>`; never silently fall back to legacy or the autonomous runner. If all are present, follow `SKILL.detail.md` § "Review agents — explicit hierarchical path"; its start-result capability check may still refuse the selected adapter.
1. **Can it spawn?** Without `--hierarchical`, the round needs a subagent-spawn tool (`Agent`, `spawn_subagent` or the host's equivalent) and depth budget left: Claude Code nests subagents at most 3 deep, and at the limit `Agent` is withheld. A host with no spawn tool at all (Codex and other AGENTS.md hosts) does not stop here and does not review alone: it runs the round through the autonomous runner, `keryx review run --autonomous --target pr --ref <pull request URL>` (no pull request: `--target branch --ref <base> [--head <commit>]`), and relays its verdict and exit code (see "Hosts"). Only a session that has spent the depth budget (a nested subagent) stops; its whole output is this line, with no tool calls and no review of your own: `STATUS: BLOCKED nested_dispatch_unavailable — run this skill in the main session`
2. **Is a round needed?** List the files with `git diff --name-status --no-renames <base>...HEAD`, so a rename shows both paths. A diff where EVERY file is prose or machine-written data ends here with one line, `round not needed: <reason>`, and no reviewer. Prose is exactly: README or CHANGELOG at any depth; CONTRIBUTING, LICENSE, SECURITY or CODE_OF_CONDUCT at the top level; and under `docs/`, `.metaproject/wiki`, `.metaproject/reviews` or a flow's `journal.md`, a file with extension md, rst or adoc whose name holds a lowercase letter (an all-uppercase name such as AGENT or WARP is steering by convention). Machine-written data is a file under `coverage/` or `__generated__/` with extension lcov, info or map only; json, txt, html and md there are code. Steering is code wherever it sits, `docs/` included: a directory (singular or plural) named agent, skill, command, rule, prompt, instruction, persona, steering or hook, any path segment starting with a dot (`.claude`, `.cursorrules`, `.mcp.json`), a file name starting with SKILL, AGENT, CLAUDE, GEMINI, QWEN, CODEX, WARP, CRUSH, JULES, KNOWLEDGE, GUIDELINES, CONVENTIONS or copilot-instructions, ending in .local, .override, .instructions, .prompt, .agent or .chatmode before the extension, or containing prompt, instruction or system. A flow's `description.md`, `acceptance-criteria.md` and `tasks/` are gate inputs, so they are code. Every other file counts as code too, including lockfiles, committed `dist/` output, CI, auth, migrations, config JSON, and any path with `..`, a backslash, a leading `./` or `//`. `classifyRoundNeed` in `src/review/round-need.ts` is the tested reference of this rule; the host executes this text, and nothing in the CLI calls the function yet. `--all`, an explicit reviewer list or a gating round forces a round.
3. **Round ceiling.** 5 rounds (`REVIEW_ROUND_CAP`) over the same change. Past it: interactive, ask the operator; unattended, `STATUS: BLOCKED round_cap`.
   - [ ] Check it, and say it: once `review plan` has written `<package>/round.json`, print `round cap: round <N> of 5` (N from `round.json`) before the first dispatch, and keep it as an item of your todo list. A round you did not state was not checked.
4. **PR state, shown before dispatch.** On a PR target read its state (`gh pr view <n> --json state,reviewDecision,statusCheckRollup`) and tell the operator, in one line, the risk that it merges before the round ends: an approved PR with green CI can merge any minute; a merged PR makes the round a post-merge audit. Depth and the estimate come from `keryx review plan` ("Round plan" 1, 4) and are shown with it before the first reviewer starts.

## Hosts — the same round, different tools

| | keryx shell | Claude Code | Codex, other AGENTS.md hosts | autonomous runner |
|---|---|---|---|---|
| Spawn | `spawn_subagent` | `Agent` (`subagent_type`) | its spawn tool; none → the runner (Preflight 1) | its own reviewers |
| Plan | `plan_set`, `plan_update` | its todo/task list | its plan tool (`update_plan`), else the checklist in your reply | none |
| Question | `ask_user` | `AskUserQuestion`; a Telegram operator: `send_poll` ("Hosts") | one question in your reply, then wait | none: defaults, unattended |
| Operator decision | the card tool | the four acts: `AskUserQuestion`, then the verb ("Operator decisions"); the rest in their terminal | the four acts: its question tool, else the question in your reply, then the verb; the rest in their terminal | refused: recorded Not run |
| Result file | `save_result_to: <package>/raw/<reviewer>.txt` | the reviewer writes `<package>/raw/<reviewer>.txt` itself, before it replies | as Claude Code | its own package |
| Wave bytes | `--host keryx-shell` (60000: a child dies at 5 min) | `--host claude-code` (150000) | `--host codex` / `--host other` (150000) | its own |

- **Every host keeps the same files, per package** (`<package>` is the directory `keryx review start` created): slices in `<package>/slices/`, one reply per dispatch in `<package>/raw/<reviewer>.txt` (reviewer replies only), one driver per dispatch in `<package>/drivers/`, and `research.json` from `keryx review ledger build --package <package>` — never by hand. The shared `.metaproject/data/review/raw` holds other rounds' replies: never write there and never pass it as `--raw`.
- **The result is the file, never the spawn tool's output.** keryx shell cuts a child's summary at 16000 characters and Claude Code returns only the last message: parse `<package>/raw/<reviewer>.txt`. A missing file is no result (`BLOCKED`). Token spend: keryx shell appends `KERYX_USAGE {"tokens_in":…,"tokens_out":…,"model":…,"by":"host"}` to that file itself; on another host, when your spawn tool's result reports the subagent's tokens, append that one line, with `"by":"host"`, to the file yourself (a dispatch without it is counted unknown, never 0; a line without the mark is counted as stated by the reviewer, not measured).
- **Caller token.** `keryx review start` prints `export KERYX_REVIEW_CALLER_TOKEN=…`; outside keryx shell export it on every later keryx call of this session (`tier`, `blast-radius`, `layers`, `dispatch-check`, `next`, `ingest` …: each shell command starts with the export), or readiness item 10 reads "not observable on this host".
- **Operator decisions.** In keryx shell the operator answers a card: `review_confirm_plan`, `review_waive_readiness`, `review_waive_coverage`, `review_waive_mutation`, `review_override_reviewers`, `review_chunks_answer`, `review_publish`, `review_comments_reply`, `review_decide_premise`, `review_complete`. Call the card and never send the operator to a terminal for these acts; they answer it in the shell or in the Telegram topic. A card is a keryx-verified press: first choice wherever one exists.
- **Host question, four acts:** `confirm-plan`, `waive-mutation`, `override-reviewers`, `decide-premise`. Where no card exists (Claude Code, Codex, other hosts) never send the operator to a terminal or keryx shell for them. Ask with the host's own question tool, as you would on a card, with the verb's options: `yes` or `no`; `waive` or `keep`; `override` or `keep`; `uphold` or `dismiss`. The question names its subject: for `confirm-plan` the plan numbers as the plan card shows them (reviewers, waves, dispatches, minutes, cost); for `waive-mutation` the mutant ids or their count; for `override-reviewers` the reviewer names; for `decide-premise` the finding id. **A Telegram operator:** When the session has the `mcp__helyx-channel__send_poll` tool, the operator reads Telegram and not the terminal, and the host's own question tool never reaches them: `AskUserQuestion` draws a selector in a terminal nobody watches and the session hangs. Ask every question of this skill through `send_poll` instead (`questions: [{question, options}]`, one call for the three start questions), recommended option first, and wait for the `poll_submit:<id>` message; do not re-ask in the terminal. Record the answer with `--answered-by helyx-poll:<poll-id>` and a distinct `:<message-id>` or `/<question>` ref per question. Unattended, nobody is asked: the command refuses `--answered-by`, and the act is recorded Not run.
- **Record the answer** with `keryx review <verb> --package <package> --answered-by <source>:<ref> --answer-text "<their words, verbatim>" --question-text "<the question as asked>"`, plus `--reason "<why>"` on `waive-mutation`, `override-reviewers` and `decide-premise` (`decide-premise` also `--finding <global_id> --answer uphold|dismiss`). In keryx shell use the card first: `keryx-shell:<ref>` is only for a plain question the shell itself asked. `claude-code:<ref>` and `codex:<ref>` are for the host harness's own question tool, `<ref>` its question id; `helyx-poll:<poll-id>[:<message-id>]` for a Telegram poll; `other:<ref>` for a host that asks in its reply, `<ref>` the message id or a short label.
- **What the record means.** `confirmedVia: "host-question"` keeps the question and the answer so a reviewer can check them; keryx does not verify them, which is why it is weaker than a card. Record only an answer the operator gave: free text that is not one of the options, a decline, an answer naming the other choice, or words you wrote is not a decision.
- **Terminal or card only.** The other acts stay with the operator, who runs the exact command in their own terminal outside keryx shell: `keryx review complete <package> --waive <item> "<their words>"` or `--waive-coverage "<their words>"`, `keryx review chunks estimate --package <package> --answer yes --quote "<their words>"`, `keryx review publish <package>`, `keryx review comments reply … --final`. You wait. Never run `--mode automatic` or `--yes`. **Shell calls in a `trust` or `auto` session.** Once a search, web, MCP or external-agent result has entered the turn, only a routine command runs without asking the operator, so write each call to stay routine: one keryx command per shell call (a short `&&` chain of keryx and read-only git commands is fine, a chain with `gh` or any other program is not); no `$(…)`, backticks or variables inside it, so read a pull request's base and head in a call of their own and pass them as literal SHAs; `keryx agents external list --no-probe`, never without the flag; a revision with braces quoted (`git cat-file -e '<sha>^{commit}'`). A `gh` call still asks: that is expected, so make it once and reuse what it printed.

## Round plan — the order on every host

1. `keryx review plan --target <pr-url|branch> [--ref <base>] [--head <sha>] --host <host> [--memory-query "<query>"] [--unattended]` is the one command: it runs `start` (round detection, `round.json`, `prior_findings.json`), `scope` (into `<package>/scope.json` and `scope-files.json`), `blast-radius` (Step 3b), `slice` (slices, manifest, one driver per reviewer × wave), `required --depth auto` (the roster) and `estimate`, writes `<package>/plan.json` and dispatches nothing. Read the round first (Step 1a). `--head` wants a SHA (`git rev-parse HEAD`), not `HEAD`. **A pull request is reviewed at its own head.** Without `--head` the round records the checkout's commit, so read the pull request's head first (`gh pr view <n> --json headRefOid --jq .headRefOid`) and, unless `git rev-parse HEAD` prints the same commit, fetch it (`git fetch origin <sha>`) and pass `--head <sha>`; `review start` and `review plan` refuse a checkout that is at another commit than the pull request.
2. If `plan` stops with an error, run the stages one by one in the same order and fix what the failing one names: `keryx review start --target <kind> --ref <ref> --memory-query "<query>" --host <host> [--unattended]`, `keryx review scope --ref <base> --json > <package>/scope.json`, `keryx review blast-radius --ref <base> --package <package> --json > <package>/blast-radius.json`, `keryx review slice --ref <base> --package <package> --host <host>`, `keryx review required --mode all --scope <package>/scope.json --depth auto --package <package>`, `keryx review estimate --package <package>`.
3. **Run the tests in `<package>/tests-to-run.json`, every round — reading the list is not running it.** Reasoned omissions (`unrelated-symbol`, `hub-damped`, `text-hub`, `test-consumer`) are context, not scope.
   - [ ] Run them through keryx so the run is recorded: `keryx review verify-run --package <package> --finding tests-to-run -- "<test command> <the listed files>"` (the command the radius prints; `bun test` here). It saves `<package>/research-evidence/verify-tests-to-run-<n>.txt`; without that file `verdict` and `readiness` warn "none recorded as run".
   - [ ] Run them at the reviewed head. A working tree at another commit is not a reason to skip: `git worktree add <scratch dir> <head-sha>` and run inside it (`-- "cd <scratch dir> && <test command> …"`).
   - [ ] Hand the saved file's path to **every** reviewer (Reviewer brief, line T), not only the testing reviewer.
   - [ ] Only when they cannot run at all (no installable dependencies, no test command): every brief and the report carry `Not run: tests-to-run (<reason>)`. A silent skip is a gap.
4. Show the operator depth, estimate and merge risk (Preflight 4). Over threshold, the operator confirms: in keryx shell call the card `review_confirm_plan` (never send them to a terminal); outside it, ask them with the host's question tool, the plan's numbers in the question, and record it with `keryx review confirm-plan --package <package> --answered-by … --answer-text … --question-text …` ("Hosts"). `dispatch-check` and `ledger build` refuse an unconfirmed plan. Unattended: report the estimate and stop with `STATUS: BLOCKED plan_over_threshold`.
5. Dispatch by slice roles from the drivers `slice` wrote: each role gets the slices that name it ("Slices, waves and results"). After each batch, `keryx review next --package <package>` decides what is left, an `escalated` core-role dispatch on a light slice included.
6. Verifier on the first blocker or major (Step 10). It runs no command itself: run `keryx review verify-run --package <package> --finding <id> -- <command>` and hand it the saved `research-evidence/verify-<id>-<n>.txt` as context. After it (no verifier ran: after the last reviewer), Wave D: `review-premise` (Step 10b).
7. `keryx review verdict <package>` to the operator, then the tail: mutation pass, `ledger build`, `ingest` (with `--premises`), the operator's answer to each held finding (Wave D), `readiness`, `complete`.

## Clean context — the round starts empty

Context comes only from your own context stages: scope, the Review Context Pack, the memory stage and the layers. Your session memory, the auto-memory index (`MEMORY.md`), remembered feedback and the earlier conversation are not inputs: do not read, quote or apply them.
- **Accepted exceptions, the only three:** `prior_findings` of an earlier round of the same package; review-notes and learning that reach you through the memory stage; a reviewer's own `memory_search`.
- **One memory read.** Run the stage query once and record it with `keryx review start … --memory-query "<query>"`. One `keryx memory search "<query>" --status accepted` call in the whole round, before `review plan`; `--memory-query` only records that query and searches nothing, so do not search again after `plan`. keryx writes `<package>/tool-calls/orchestrator.jsonl` itself from the moment the package starts: never create, edit or append to it. Readiness item 10, `memory-outside-stage`, blocks the `review_complete` card, `keryx review complete` and `review publish` on any other memory call; only the operator's waiver lifts it: in keryx shell call `review_waive_readiness` (a card, never a terminal), outside it `--waive memory-outside-stage "<operator quote>"` in their terminal; unattended, record it as Not run. Detail: `SKILL.detail.md` § "Clean context".
- **Open question.** Look in this skill and `SKILL.detail.md` first. If the answer is not there, ask the user: one question with the host's question tool (`AskUserQuestion`, `ask_user`, `send_poll` for a Telegram operator; "Hosts") interactively; unattended, the whole output is `STATUS: BLOCKED question — <the question>`. Never answer from memory or a guess. The one exception is the round's own pace: while the plan is authorized, "continue?", "launch the next wave?" and "close with waivers or continue?" are not open questions; the answer is already given ("One batch", `SKILL.detail.md` § "Between waves").
- **Named limit.** keryx cannot stop a runtime that loads the agent's memory before this skill starts, and reads of personal memory outside `keryx memory` are not visible to the log. The guarantee is instruction plus detection, not isolation.

## Workflow

```
Review Orchestrator Progress:
- [ ] Step 0: On a PR target, collect external comments — `keryx review comments collect`; and `keryx review context-collect` (sets `pr_context`)
- [ ] Step 0b: On a PR target whose checks are red, triage each failed run with `keryx review ci-triage --run <id>` (opt-in `review.jev.ci_triage`) — see "CI Triage on Red Checks"
- [ ] Step 1: Build Review Context Pack — PR metadata AND the PR's own description, scope, rules, context_doc summary, accepted memory, and the cross-repo contracts the diff consumes (prose step: no `keryx review` command builds it)
- [ ] Step 2: Detect review mode (diff mode vs. path mode)
- [ ] Step 3: Build the bounded scope with `keryx review plan` (or `keryx review scope`) — never by hand
- [ ] Step 3b: On a deep round, keep the blast-radius `--json` file for `review ingest --blast-radius`; when it says "Cut blast radius", run the chunk waves and bring in pass findings (see "Scope B")
- [ ] Step 4: Parse flags (Routing Table); the rest of the roster is what `keryx review required` prints
- [ ] Step 5: Start questions, once, after Steps 1 and 3 — reviewers (default: the set `keryx review required --depth auto` prints; `--all` only when the operator asks), counterpart verification (default on), model plan; unattended — and an `auto` or `trust` shell session, which has no operator at the keyboard — takes the defaults
- [ ] Step 5c: When `review.jev.select` is on, run `keryx review jev-select` and drop its `skip` decisions from Wave A/B — see "Reviewer selection with Jev"
- [ ] Step 6: Compute each dispatch's model with `keryx review tier`; show the operator depth, estimate and merge risk, and get an over-threshold plan confirmed before any dispatch ("Round plan" 4; 6a: publish this plan)
- [ ] Step 7: Stage 1 gate - spec compliance check (issue, task doc, or the PR body)
- [ ] Step 8: Dispatch selected reviewers in parallel with the reviewer-input schema — see "How to spawn"; tick "Reviewer brief — required contents" for every payload first
- [ ] Step 9: Collect reviewer-finding schema results and handle NEEDS_CONTEXT
- [ ] Step 9b: `jev-triage` — advisory, annotate-only annotations over the consolidated findings (opt-in `review.jev.triage`)
- [ ] Step 10: Wave C — when blockers/majors exist, `--verify` is set, or the PR is high-risk, dispatch `review-verifier` on the first blocker/major without waiting for other reviewers, then once per later pass over the findings held at that point
- [ ] Step 10b: Wave D — after the last verifier pass (none ran: after the last reviewer), dispatch `review-premise` (deep tier) over the canonical findings of severity ≥ minor (delta round: only those without a carried premise); pass its claims with `review ingest --premises <file>`; then ask the operator about each held finding (see "Wave D")
- [ ] Step 11: Sort by severity, deduplicate, emit unified report
- [ ] Step 12: Emit the machine-readable `keryx:findings` block alongside the report
- [ ] Step 13: Report the stage counts: dropped by pre-filter, refuted by the verifier, downgraded and held by the premise judge, retained
- [ ] Step 14: Managed rounds only (not `lightweight`, which is report-only), after the final round, on an open pull request at the head you reviewed — answer every external comment once with `keryx review comments reply --final` (render with `--dry-run`; the post itself is the operator's: the `review_comments_reply` card in keryx shell, else they run it in their terminal; unattended: do not publish, hand the rendered body back) — never against a pull request the dispatch named as the caller's
```

Step 0 runs on **every** round. Step 14 runs **once**, after the last one.

### Step 6 — the model is computed, not chosen

Before dispatching each reviewer, run `keryx review tier` with the signals you hold (`--scope`, `--findings`, `--diff-lines`, `--fix-attempt`, `--verifier`, `--security`, `--forced-strategy-change`) and paste the `model` block it prints into that dispatch. The tier comes from the command, not from reading `rules/process/model-selection.mdc`.

It names a model only if you gave it your session (`--session-provider`/`--session-model` or `KERYX_SESSION_*`) and discovery found another. Otherwise it prints `inherit: true` with the tier — **adaptive**: pick your own runtime's model for that tier (`standard` = your session model; `light`/`deep` = your runtime's lighter/most capable class if its dispatch tool offers one, else the session model). A model id never goes into a dispatch by hand.

### Step 6a — the plan bridge

Publish this checklist with `plan_set` under the ids `step-0`…`step-14` and `step-10b` once, here, when scope and dispatch are fixed (keryx shell already published it as `pending` at the start — update it with `plan_update` instead; another host uses its own plan tool, "Hosts"). Publish each of steps 0–5 that ran as `completed` and each that did not run as `skipped`; publish steps 6–14 and 10b as `pending` (`in_progress` for the one starting now). From then on move each item with `plan_update` as its step completes — see the `session-plan-bridge` rule. `completed` means the step's artifact exists: steps 8–10 and 10b become `completed` (in the plan and in the report) only after `keryx review ingest` has recorded their results (10b: `--premises`), and a step whose reviewers were `BLOCKED` is `blocked`.

## How to spawn (Steps 8 and 10)

- One `Agent` call per reviewer, all calls of a wave in a single message, so the wave runs in parallel.
- Reviewers are read-only: they read the diff and the files and run only the read-only commands: `git log`, `git blame` and `git show` (law 4; `review-premise` too) where the host gives a read-only child git. keryx shell does not: a `spawn_subagent` child has no shell and no git tool, so you run `git log -L <start>,<end>:<file>` and `git blame -L <start>,<end> <file>` for each deliberate-looking site a reviewer must judge and pass the output in `context_files`; with neither, the reviewer says the history was not read. Beyond those, a reviewer runs only the layers-block commands (`keryx gdgraph affected|find`, `keryx test related`, `keryx wiki ask`, `keryx memory search`) and `keryx ctx rg|read`, never tests, health checks, servers, mutation or any command that writes in the reviewed tree: that evidence comes from you (`keryx review verify-run --timeout <seconds>`, `keryx review mutate`), the verifier, or the one testing reviewer with `run-tests`, in a scratch copy and a time budget. Each payload carries `allowed_tools` (`read-only` or `run-tests`) and `exec_budget_s`.
- Use the reviewer's exact `subagent_type`. If the runtime has no such type, use `general-purpose` and name the reviewer's `SKILL.md` path in the prompt. Neither available: that reviewer is `BLOCKED`.
- Build every payload and prompt from "Reviewer brief — required contents" below, and tick it off per dispatch before the wave goes.
- Prompts carry pointers, not pasted files — the diff, the SHAs, the PR, the schema paths — and never paraphrase a contract. On keryx shell the slices travel in `context_files` instead (below). Run `keryx review dispatch-check --payload <file> --manifest <package>/slices/manifest.json --package <package>` on every payload before a mass dispatch; on exit 1 fix the payload it names and do not dispatch around it (no slice, over the wave ceiling: dispatch fewer slices, a missing `skill_path` or `context_doc`, an unconfirmed plan, a schema break, no `pr_context` with `--pr-context`).
- A reply is a result only if it starts with a `STATUS:` line and carries a `REVIEW_RESULT` block matching `reviewer-finding.schema.json`; anything else is `BLOCKED`. The one exception: a reply or dispatch error of `STATUS: RATE_LIMITED` is handled by the Rate limits rule under Control, never marked `BLOCKED`.
- The model comes from `keryx review tier` (Step 6). On `spawn_subagent` pass its tier as `model_tier` on every reviewer — `review-verifier` and simple reviewers `light`, normal `standard`, complex reviewers and `review-premise` `deep` (`keryx review tier --premise`); an omitted tier runs the child on your own model.

### Reviewer brief — required contents (every dispatch)

One payload file per dispatch (`reviewer-input.schema.json`) plus one prompt. Each line: what goes in ← where it comes from. A line left out is a defect of the brief, whatever `dispatch-check` says (it checks the schema, not this list). Pointers, not paraphrases: where a line says "path", give the path and do not restate the text in your words.

**Payload fields**
- [ ] A `reviewer`, `scope_mode`, `branch`, `base_sha` ← `plan.json` / `round.json`; the prompt also names base and head SHA and the PR URL.
- [ ] B `slices` = this wave's slice ids ← the driver `drivers/<reviewer>-w<n>.json`; the prompt names their absolute paths (keryx shell: `context_files`).
- [ ] C `pr_context: <package>/pr-context.md` ← `keryx review context-collect` (Step 0).
- [ ] D `model` = the block `keryx review tier` printed for this dispatch, pasted verbatim ← Step 6. The same block goes, verbatim, into the prompt text and into the driver's `model` field (line S). "See payload", a summary or `model: omitted` is not the block.
- [ ] E `allowed_tools` and `exec_budget_s` on every payload ← `read-only` / `0`, except the one testing reviewer: `run-tests` / its seconds. The prompt states both values.
- [ ] F `budget` (`max_prompt_tokens`, `max_findings`) ← the token policy.
- [ ] G `layers` ← `keryx review layers block … --json` for this reviewer's files.
- [ ] H `metaproject.memory` ← the same entries as `review_context.memory` (line M).
- [ ] I Delta round, FIX slice: `is_fix_round: true` and `prior_findings` = the findings that slice answers ← `prior_findings.json`; the prompt asks for `prior_dispositions: [{id, disposition}]`, one per attached id. Later wave: `known_findings`.
- [ ] J Project reviewer: `skill_path` (absolute `<path>/SKILL.md`), the sentence that it overrides a same-named agent type, one "where your text names `<ref>`, read `<resolved>` instead" line per `shadowedRules` entry ← `keryx review reviewers --json`.

**`review_context` (`review-context.schema.json`) — one object, the same for every reviewer of the round**
- [ ] K `request` (the operator's words, flags, mode, range) and `git` (repo, branch, base, head, merge-base) ← the request, `round.json`.
- [ ] L `pr` = `number`, `url`, `title`, `state`, and `body` = the full description text ← `gh pr view <n> --json title,body`. The text itself, in `pr.body`: a path, a `body_summary` or a pointer to `pr-context.md` does not replace it.
- [ ] M `memory` = `{query, status_filter: "accepted", entries, searched}` ← the one `keryx memory search … --status accepted` of the round ("Memory (required)").
- [ ] N `requirements` = issue URL, task docs, and the acceptance criteria listed one by one ← `context_doc`, the issue, else the PR body (Stage 1 gate).
- [ ] O `rules` = the rule and convention files matched by the changed paths, as paths ← the scope's paths against `.metaproject/rules` and the project's convention docs.
- [ ] P `scope` (files by domain, `changed_lines`, `risk_areas`) and `token_policy` (budget, `omissions` from `slices/manifest.json`, `model_plan`) ← `<package>/scope.json`, the manifest, `keryx review tier`.
- [ ] Q `routing` = the decisions entry: `selected_reviewers`, `skipped_reviewers`, and `reasons` (why each reviewer was selected or skipped) ← `keryx review required`, Start question 1, `jev-select`.
- [ ] R `cross_repo` = one entry per consumed contract, pinned SHA (`state: merged`) or PR (`state: open`) ← "Cross-repo contracts are read, not assumed"; none consumed: `[]`.

**Driver**
- [ ] S `drivers/<reviewer>-w<n>.json` carries `model` (line D) and `result` under `<package>/raw/` ← `slice` wrote it with `model` empty; a dispatch with no driver gets one ("Slices, waves and results" 4).

**Prompt text**
- [ ] T Test output: the path of `research-evidence/verify-tests-to-run-<n>.txt`, or the `Not run: tests-to-run (<reason>)` line ← "Round plan" 3.
- [ ] U Severity and finding fields: point to `## Severity (canonical)` in `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` and to `reviewer-finding.schema.json`; do not restate the rubric.
- [ ] V The cross-repo rule, pasted as written in "Cross-repo contracts are read, not assumed" (the one quoted sentence there, `info` not `major`) ← Context Pack.
- [ ] W Counterpart rules and round obligations: point to `SKILL.detail.md` § "Counterpart verification" and § "Round obligations" by path ← Start question 2.
- [ ] X Scope-B reviewer: `keryx review blast-radius … --brief` stdout verbatim; `review-degradation`: the `--degradation` stdout verbatim ← "Scope B".
- [ ] Y Write the whole reply to the driver's `result` (`<package>/raw/<reviewer>…txt`) before answering ← line S.
- [ ] Z Start with a `STATUS:` line and return a `REVIEW_RESULT` per `reviewer-finding.schema.json`, listing as `slices` the ids it read in full ← "Slices, waves and results" 3.

## Slices, waves and results — every host; keryx shell specifics marked

A reviewer starts in the project root and reads project files; a path outside the project root is unreadable to it. On keryx shell its `context_files` content reaches it wrapped as DATA, and slices and measurements travel only there (never pasted or retyped); elsewhere the prompt names the slice paths. `skill_path` and `pr_context` stay payload fields.

0. **Publish the plan before anything else (keryx shell).** Your first tool call is `plan_set` with `step-0`…`step-14` and `step-10b` all `pending`. A shell turn that has open plan items is continued by the host; a turn that ends on a text reply is over, and a message saying the review "cannot be honestly completed" ends the run with nothing reviewed. Never end the turn while a step is `pending` or `in_progress`: mark it `blocked` only with a cause you cannot fix with a command, and otherwise keep working. Step 6a then updates this plan rather than creating it.
1. **Slices.** `review plan` (or `review slice`) cuts the diff into `<package>/slices/slice-NN.diff` files, a `manifest.json` with the wave budget, and drivers `drivers/<reviewer>-w<n>.json` (slice ids, absolute slice paths, `result` path). On keryx shell with a large diff pass a small `--max-bytes` (for example 18000) and `--wave-bytes` (for example 54000) so no wave outruns a reviewer's five minutes. Ledgers (csv, lockfiles, snapshots, generated files) are listed under `omissions` with a reason — list them in the report as not reviewed, never as clean.
2. **Slices travel by path; on keryx shell, only by `context_files`.** On keryx shell pass each reviewer its slice paths in `spawn_subagent`'s `context_files`: the host copies the text into that reviewer's task, so you never paste or retype a slice. Elsewhere name the slice paths in the prompt. Put the `slices` ids in its reviewer-input. A dispatch that names a git range but no slice leaves the reviewer with nothing to read — that is `BLOCKED`, not a review.
3. **The brief asks for the covered slices.** Tell every reviewer to list the `slices` it read in full in its `REVIEW_RESULT` object, as ids (`"slices": ["slice-01", "slice-02"]`), and to leave out a slice it did not read. A finished reply with no `slices` list covers nothing.
4. **One batch.** Dispatch the whole wave — up to 10 reviewers — in one message, not one at a time. On keryx shell every round reviewer's `spawn_subagent` carries `review_wave: {"package": "<package>", "pass": "round"}` (a wave outside it counts against the turn's 32 children) and a `timeout_ms` that fits its wave: the default 300000 is sized for a wave of 60000 bytes, so a larger `--wave-bytes` needs a larger `timeout_ms`. Give each reviewer `max_rounds` of at least 40 (the default); a reviewer that spends its rounds reading the skill and the schema returns nothing. Write the dispatch's `model` block into each driver you dispatch (`slice` leaves the field empty; Reviewer brief, line S); a dispatch with no driver gets `<package>/drivers/<reviewer>.json` = `{"reviewer", "slices", "result": "raw/<reviewer>.txt", "definition": "<path of the reviewer's SKILL.md>"}`, because `ledger build` takes the rule file from `definition`. Save each reply to its driver's `result`; only reviewer replies belong in `raw/`. **After each batch run `keryx review next --package <package>`** (never `retry-plan` once per reviewer): it decides every reviewer's next wave (reason `missing`, `retry`, `stalled` or `escalated`), prints the `- **Not run:** …` line to paste for a reviewer that stopped making progress, or prints `done`. **While the plan is authorized, do not stop between batches.** `next` says so with the line "plan authorized; continue the loop without asking the operator; stop only for the card list, for plan growth, or on done / Not run" (`--json`: `planAuthorized`, `continue`). Then dispatch what it returned in the same turn: no "continue?", no "launch the next wave?", no "close with waivers or continue?", and no end of turn before `next` prints `done` or the reviewer is `Not run`. The stops are the closed list in `SKILL.detail.md` § "Between waves" and nothing else. Only the operator can accept a smaller set than that (the `review_override_reviewers` card, or their answer to the host question recorded with `keryx review override-reviewers`, "Hosts"). An unfinished reviewer is never counted as a clean pass. **Persist every result, on every host.** On keryx shell pass each reviewer `save_result_to: <package>/raw/<reviewer>.txt`: the host writes its full final text there. Elsewhere the prompt tells the reviewer to write its whole reply to `<package>/raw/<reviewer>.txt` before it answers. Build `research.json` with `keryx review ledger build --package <package>` — never by hand — and do each gap's next command it prints; run `keryx review ingest --research <package>/research.json` once it prints READY (exit 0). A refused `review_complete` card (or `keryx review complete` at a human's terminal) names what is missing: fix that with a command and close again; it is never `blocked`.
5. **Never print a scope or a slice.** The tool output of one call is cut at about 20 KB and `keryx review scope` of a large PR prints hundreds of KB. Write it to a file and read the counts from the file (`keryx ctx read`, or `jq`); take `<base>` from `git symbolic-ref refs/remotes/origin/HEAD`, not a guessed `origin/main`. A missing directory is a command to run (`mkdir -p`), not a blocker. **Machine artifacts by direct write.** Save slices, payloads and results by redirection or `keryx ctx run --raw -- <command>`; the summarized form of `keryx ctx run` drops the bytes a later step parses.
6. **Write mutants whole.** A testing reviewer's `mutant_candidates` cover every changed branch, code downstream of the diff included. Write them to `research-evidence/mutants.json` unchanged; you may not narrow them, and a candidate no pass has run still blocks the coverage gate (`SKILL.detail.md`, mutation pass).
7. **Measure before `review-layout`.** Run the browser measurements (Playwright/Storybook) yourself and pass them in its first dispatch (`context_files` on keryx shell, by path elsewhere); they count as evidence when the command and viewport are named (`SKILL.detail.md`).

## Control

- **Profiles.** The default is read-only: one round, no edits. `--fix` hands the findings to `flow-orchestrator` or `task-implementer`; the orchestrator never edits code. Control returns to this main session after each hand-off, which loads this skill again (never the implementer, which would nest); each re-review counts toward the ceiling (it adds 1 to the count).
- **Waves.** Split by diff domain (`core` = logic, security, architecture; `domain` = frontend, backend, conventions; `support` = style, tests), in that order; A/B/C/D below keep their dependency order, except Wave C, which starts early and overlaps A and B (see Wave C); Wave D runs after the last verifier pass. A full or `--all` round runs at most 10 reviewers per wave (`MAX_REVIEWERS_PER_WAVE_FULL`). The domain order ranks reviewers inside a dispatch; it never holds Wave B back while `estimate` says the plan fits one wave — then every required reviewer goes out in the first message.
- **Rate limits.** On a reviewer dispatch that fails with a rate-limit or overloaded error (reported as `STATUS: RATE_LIMITED`, a harness signal, not a schema status), halve the wave, requeue the rest and honour `retry-after`, at most 300 seconds (`MAX_RETRY_AFTER_SECONDS`). After at most two halvings (`MAX_RATE_HALVINGS`) stop with `STATUS: BLOCKED rate_limited`, naming the queue left.
- **Early verdict.** When every reviewer and the verifier are done, save every verifier pass to `research-evidence/verifications.json` and Wave D's claims to `research-evidence/premises.json`, then run `keryx review verdict <package>` and give the operator the verdict in the same message. A verdict given before Wave D ran is provisional, and you say so. The verdict is interim: the tail (mutation pass, ledger, ingest, readiness, the `review_complete` card) still runs, and the round is not done until `complete` (`SKILL.detail.md` § "Early verdict").
- **Recovery.** After a timeout, crash or resumed session: run `keryx review next --package <package>` first — it collects late results from `<package>/raw/` and never re-hands a finished slice — validate and ingest what it collected, then dispatch only what it returns. Never re-dispatch a wave whose results are on disk; after a second timeout of the same reviewer change the task (fewer slices, narrower focus, a lighter tier for a mechanical slice), not only the diff size (`SKILL.detail.md` § "Recovery").
- **Done when** the consolidated report and the `keryx:findings` block are emitted and the stage counts and **Not run** are stated. A managed round (not `lightweight`, which is report-only) is also done only when every dispatched reviewer's result is recorded with `keryx review ingest` and the `review_complete` card has been answered (an agent never runs `keryx review complete`; that command is for a human in a terminal). `completed` means `keryx review readiness` passed, or each failing item but `premise-decisions` (answered per finding, never waived) is waived by the operator ("Hosts": card or their terminal; unattended, record Not run); publishing is held by the same checklist (`SKILL.detail.md` § "Readiness").

---
## Step 12 — the `keryx:findings` block

The prose report is for a human. **`keryx review ingest` reads the fenced block, not the prose**, so every report ends with one fenced block whose info string carries `keryx:findings`:

````text
```json keryx:findings
[ { …one object per finding, conforming to review-finding.schema.json… } ]
```
````

- **Exactly one block per report.** It is the array the reviewers returned, carried through — not re-derived from the prose above it. Consolidate by merging the reviewers' findings into one array, never by concatenating one block each (ingest refuses a second block, and a block that is not an array of findings).
- Each object conforms to **`review-finding.schema.json`**; ingest drops any property that contract does not name. Pipeline triage fields (`classification`, `flow_relevance`) are not finding properties: they are the orchestrator's judgement and are recorded in `decisions.md`.
- `reviewer` is the reviewer that actually produced the finding. Never the orchestrator's own name.

A report without the block is a **legacy** report: ingest still reads its prose, but writes `impact`, `suggested_fix`, `evidence` and `confidence` as `not recorded:` and stamps `confidence: low`.

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `flags` | string[] | no | One or more of: `--hierarchical`, `--frontend`, `--backend`, `--architecture`, `--security`, `--performance`, `--style`, `--clean-code`, `--highload`, `--project-conventions`, `--frontend-conventions`, `--testing-practices`, `--core-boundaries`, `--flow-graph`, `--legacy-profiles`, `--learned`, `--verify`, `--all`. `--hierarchical` selects the capability-gated hierarchical engine; absence keeps the legacy path. |
| `path` | string | no | File or directory path to review (e.g., `src/stores/`, `src/components/UserCard.tsx`). Activates **path mode** — reviews the files at this path directly, not a git diff. |
| `commit_range` | string | no | Explicit commit hash or range (e.g., `abc123..HEAD`). Overrides merge-base detection. Ignored in path mode. |
| `issue_url` | string | no | GitHub issue or task URL. If provided, Stage 1 gate checks spec compliance before dispatching reviewers. |
| `context_doc` | string | no | Path to job context document (e.g., `.metaproject/jobs/<job>/ai/context.md`). |
| `context_mode` | string | no | `none`, `light`, or `full`. Default: `light` for PR review, `none` for small path reviews. `full` may call `context-collector` before dispatch. |
| `token_budget` | object | no | Optional budget controls: `{total, per_reviewer, diff_max_chars, file_max_chars}`. |
| `model_strategy` | string | no | `ask` or `adaptive`. Default: `ask` in an interactive round (shown once as Start question 3), `adaptive` unattended; the model per dispatch is computed by `keryx review tier`, never chosen by hand (see Step 6). |
| `managed_review` | object | no | Optional managed review mode: `{mode, target, target_ref, flow_id, reviewers}` where mode is `lightweight`, `attach-review`, `review-flow`, or `ingest`. |
| `verification_mode` | string | no | `off`, `annotate`, or `filter`. Default `annotate` — verdicts are recorded and nothing is removed. See Wave C. |
| `pr_comments` | object | no | `{enabled, max_replies_total, max_sentences_per_reply}`. Defaults: enabled when a PR exists, `30`, `2`. Collect every round, reply once at the end. See External PR comments. |

---

## Managed Review Feedback Loop

A **first-pass** review is lightweight by default: emit the consolidated report only and create no Task Manager artifacts. Use managed mode when requested by the caller or when an unambiguous related flow is detected and the caller accepts attachment.

**A fix round is managed, not optional.** Before dispatching reviewers on any round where `is_fix_round: true`, run `keryx review start --target <kind> --ref <ref>`; after synthesis, run `keryx review ingest --report <path> --ref <ref>`. A round whose findings were never ingested cannot be cited as a completed round, because nothing durable records what it found.

Pass `ingest` everything the round produced, by flag (`keryx review ingest --help` lists them; an unknown option is refused): `--scope` (the whole `--json` scope document, so the record keeps each pre-filter drop with its reason), `--blast-radius <file>` (required whenever the round dispatched `review-regression`; never write the record inside the package before ingest), `--verifications`, `--premises`, `--research`, and `--refuted <file>` — the findings this round **raised and then dismissed**, in the finding shape, each with `disposition: {state, evidence}` in a `dismissed-*` state. Without `--refuted` a package keeps only the survivors of an unlogged triage.

`review-degradation` (profile `full`, deep tier) asks whether the code is worse than on the base and can that be shown; slice routing decides which slices get it, and Scope B below says what to hand it.

The `review_complete` card records what became of a finding when the fix round closes: pass `dispositions`, a list of `{finding, disposition, evidence}`, one per finding; the operator sees each on the card.
At a human's terminal the same is `review complete --finding <id> --disposition <state> --evidence <ref>`, a triple repeatable per finding.
States: `unknown`, `acted-on`, `dismissed-incorrect`, `dismissed-wont-fix`, `dismissed-out-of-scope`, `dismissed-deprioritised`. Everything except `unknown` must cite where the outcome is written down — the commit, the test, the decision. Record a correction as a new round.

`review complete` on a PR-bound package refuses a merged PR or a moved head unless `report.md`'s first line names the reviewed SHA and says so; a package with no PR binding is unaffected.
`review complete` refuses a report with no `Evidence level:` line (`static only — did not run: <what>` or `ran — <what>`); a package ingested before the field existed only warns.
`review ingest` keeps an internal finding whose `quote` is not at its `path` at the reviewed SHA (absent, or in several places) with no line, flagged `quote_unlocated`, instead of refusing the round (readiness item `quotes-located` lists it until it has a disposition); it still refuses, naming the finding, a quote it could not check at all (commit not in the checkout, no file named, or a size bound), and adds a `citation not found` line, never a deletion, to a rebuttal citing a rule or document that is not in the tree.
A finding may close as `narrowed` (research obligation `"status":"narrowed","remains":"<what remains>"`); it counts as closed only with that text, and the report keeps it under "Refuted and narrowed".

**Closing a fix round without dispositions leaves every finding reading `unknown`** — "nobody wrote down what happened".

Managed modes:

- `lightweight`: report-only; no flow or managed review artifacts are created, and nothing is posted — no `comments reply`.
- `attach-review`: write under `.metaproject/flows/<flow-dir>/reviews/<review-id>/`.
- `review-flow`: write under `.metaproject/reviews/<review-id>/`.
- `ingest`: convert an existing review report into managed findings, decisions, and learning handoff, attached to a flow when one is explicit or matched.

When attaching to a flow, resolve the flow by explicit `flow_id`, PR URL, issue URL, or branch metadata. Never mutate `.metaproject/flows/*/flow.json` from review code; Task Manager state changes remain owned by `keryx flow`.

---

## External PR comments

**Collect every round. Answer once, at the end.** Collection, severity classification and the reply limits live in the CLI; the judgement — is this comment right, what do we say — stays here.

```text
keryx review comments collect --repo <owner/repo> --pr <n> --sha <head-sha>
                              [--self <login>] [--round <n>] [--out <findings.json>] [--json]
keryx review comments reply   --repo <owner/repo> --pr <n> --outcomes <file|->
                              --review <review-id> --sha <head-sha> --final [--dry-run]
                              [--max-replies <n>] [--max-sentences <n>] [--max-chars <n>]
                              [--flow-link <url>]
```

`--sha` is the pull request's **current head**. `--fixtures <dir>` runs either against JSON on disk, nothing posted. `collect` reads every source, treats a bot reviewer as a reviewer, classifies severity (`major` under `CHANGES_REQUESTED`, else `minor`, `basis: unclassified` when the fact is missing) and lists everything it filtered with its reason.

- You may **lower** an external comment's severity only by assigning a terminal disposition with a reason. You may never silently drop an external comment.
- The verifier cannot refute an external comment: ingest turns a `refuted` verdict into `answered-disagree`, which still owes a reply explaining why.
- The reply pass runs **after the final round and before the completion gate**, so every reply states a settled outcome. Write one outcome per comment:

| Outcome | Reply is |
|---|---|
| `acted-on` | one sentence naming what changed, plus the commit SHA |
| `answered-disagree` | one or two sentences on why not, and a link to the flow's journal entry |
| `dismissed-out-of-scope` / `dismissed-deprioritised` | one sentence, and where it was recorded instead |

  `comments reply` enforces the rest (two sentences, no code block, one reply per comment in its thread, no `unknown`, 30 replies then a summary, never resolving or hiding a thread, a durable record per post). A comment that **blocks** progress rather than reporting a problem gets `escalate: true`: it leaves the reply queue and is reported to the operator immediately.

### A round never answers a pull request another skill is answering

`review-pr-feedback` handles the other direction: a pull request `#A` someone already reviewed. Under its `--fix` mode it dispatches `flow-orchestrator`, which opens a **second** pull request `#B` carrying the fix and runs **this** orchestrator inline on every round against `#B`. `review-pr-feedback` is present only when installed (profile `full`); when it is absent this orchestrator owns the reply — say it is not installed and name the install command (`SKILL.detail.md`, "Skills present only when installed").

`#B` is its own conversation. Collect and reply on it exactly as always: its record is filed under `#B`'s own number.

- **Never run a reply pass against a pull request the dispatch named as the
  caller's.** When `constraints` says the caller owns the reply for `#A` — or the target resolves onto a pull request another skill declared — collect if the round needs the record and stop there. `review-pr-feedback` answers `#A` once, after the merge; a mid-loop reply would make that post-merge reply be skipped as already answered.
- **Absent such a constraint this orchestrator owns the reply.**
- The reply is the only thing that moves; collection, classification, the verifier exemption and the cap exemption are unchanged.

---

## CI Triage on Red Checks (Step 0b)

Once per round, on a PR target whose checks are red, before Step 1: for each failed check run, `keryx review ci-triage --run <id>`. When `review.jev.ci_triage` is not `true` in `.metaproject/tasks.config.json`, or no Jev/OpenRouter credential is resolvable, skip it and say so in the report — never silently absent. Read each verdict into the report: `flaky` suggests a rerun rather than a finding; `regression` means investigate before trusting this round's other findings; `infra` is noted and the round continues. Advisory only: a verdict never gates dispatch and is never itself a finding.

---

## Everything written to GitHub is brief

PR bodies, comments, replies and commit messages lead with the conclusion, say what changed and where, and link rather than paste; verbose in the flow, terse on GitHub (`SKILL.detail.md` § "Everything written to GitHub is brief").

## Review Context Pack

Before routing reviewers, build a compact `review_context` object. This is the shared source of truth for all sub-agents and must follow `.metaproject/skills/gdskills/review/review-orchestrator/review-context.schema.json`.

Required content (the typed keys and their sources, one line each: "Reviewer brief — required contents", lines K–R):
- Request: raw user request, flags, review mode, explicit paths or commit range.
- Git/PR metadata: repo, branch, base, head, merge-base, PR number/URL when available.
- Scope summary: changed files grouped by domain, high-risk files, generated/ignored files.
- Requirements: issue URL, linked task docs, acceptance criteria extracted from `context_doc` (else the issue or the PR body), listed one by one.
- **The PR's own description**, fetched not assumed: `gh pr view <n> --json title,body`, into the typed `pr.body`. See below.
- **Cross-repo contracts the diff depends on**, in the typed `cross_repo`: each pinned to the ref you read it at, and each recording whether the producer has merged. See below.
- Rules: matched repository rules and convention docs by path.
- **Memory: accepted project memory intersecting the changed paths.** See below — this step is required, not best-effort.
- Decisions: why each reviewer was selected or skipped, in the typed `routing` (`selected_reviewers`, `skipped_reviewers`, `reasons`).
- Token policy: effective budget, truncation decisions, files summarized instead of fully inlined.
- Legacy/profile reviewer availability and selection state.

### The PR description is evidence, not decoration

Fetch the body into `review_context.pr.body` — the full text, not a path or a summary — and hand it to every reviewer. It is the author's own statement of what the change does, and it is checkable against the diff. **A description that promises an approach the diff does not take is a `minor` finding** — file it, do not merely mention it; the Stage 1 gate files it (`## Stage 1 Gate — Spec Compliance`). Same class, same severity: an approach that depends on another repository's change being deployed first, with no deploy note saying so. That `minor` is about the *description*; when the dependency is real and this change can merge first, the blocker is filed against the call site instead (`### A producer that has not merged yet`).

### Cross-repo contracts are read, not assumed

When the diff consumes a contract owned by another service — a payload shape, a status enum, a timeout, a permission, a default — **read the producer** and pin the SHA:

```yaml
cross_repo:
  - repo: acme-backend
    state: merged
    sha: f5219d5d4
    merge_order: independent
    reason: "DQ report payload: which halves are null vs 0"
    facts_pinned_round: 1
    facts:
      - "sqlScore/schemaDriftScore stay null when the half is absent"
```

Put the facts in `review_context.cross_repo` so every reviewer shares one reading. The shape is typed in `review-context.schema.json`. The rule that follows for reviewers, and that belongs in the dispatch prompt:

> **A claim about another service's behaviour, with no `file:line` at a pinned SHA behind it, is `info`.** Not `major`, however confident.

If you cannot locate the producer, ask the operator where it is (Start question 2); record `state: unavailable` only when it cannot be read, and leave the dependent findings at `info`.
An input rule records the producer's full check set and is verified every round, paired PR or not — SKILL.detail.md § "Counterpart verification". Unattended, nobody is asked: record
`state: unavailable` with the reason and continue.

A finding whose evidence lives in the producer sets `repo` on the finding itself.

### A producer that has not merged yet

A **parallel pull request** — the producer change still open — is pinned differently from `state: merged`:

- **Pin the pull request, not just the commit.** An open branch gets rebased and squashed, so `state: open` requires `pr` and the SHA is only a note about when you read it.
- **Merge order is a `blocker`, not a note.** When an entry is `state: open` with `merge_order: producer_first`, and this change can merge without the producer and no gate already holds the merge, file a `blocker` (shape 1 or shape 2 under "Severity") against the consuming call site, with a fix that is a merge gate, a flag or a fallback — never an edit to a diff that may be correct. A missing deploy note in the PR body stays the `minor` above. A `merge_order: unknown` is a question to resolve, not a blocker to file.
- **Re-read an open producer every round.** On each round, re-read every entry with `state: open` and set `revalidated_round`. An entry whose `revalidated_round` is behind the current round has not been checked this round, and findings resting on it drop to `info` until it is.

### Memory (required)

Run, once, per review — the round's only memory call, before `review plan` (whose `--memory-query` records this query and searches nothing):

```bash
keryx memory search "<changed modules and the concepts they touch>" --status accepted
```

Put the matched entries in `review_context.memory` and in each reviewer's `metaproject.memory`. Record `query` alongside them, and set `searched: false` **only** when the memory module is disabled — an empty `entries` with `searched: true` means the search ran and matched nothing.

- **`--status accepted` only.** A draft entry is a hypothesis. Handing one to a reviewer as project truth is how a wrong hypothesis becomes a wrong finding.
- **Scope it to the change.** Entries whose recorded scope does not intersect the changed files or modules stay out.

Context modes:
- `none`: no additional context collection; use only diff/path and local rules.
- `light`: default for PR review. Read existing `context_doc`, local `AGENTS.md`/`CLAUDE.md`, and matching rule files. Do not browse external docs.
- `full`: for large/high-risk PRs or user request. Invoke `context-collector` first, then pass the resulting context path and summary to reviewers.

High-risk triggers for `full` recommendation:
- Auth, permissions, API contracts, a client-side mirror of a server rule (validation, limit, permission, uniqueness, reserved names), migrations, shared core, state management, graph/flow, security, performance-critical paths.
- More than 20 changed source files or more than 2,000 changed lines. Size never lowers depth below the risk class (SKILL.detail.md § "Depth floor").
- Missing or ambiguous linked requirements.

If `full` context would be useful but was not explicitly requested, ask once:

```text
This PR touches high-risk areas. Build full review context before dispatching reviewers?

  A) Yes - collect full context first (recommended)
  B) No - use light context and continue

> pick a letter (default: A)
```

Unattended: take A and record it in the review scope.

---

## Token and Context Budget Management

The orchestrator owns the token budget: each reviewer gets only the context its domain needs (its slices), never generated files, lockfiles, snapshots, build output or vendored code unless it reviews that file type; omitted files and truncation go in `review_context.token_policy.omissions`, and a `NEEDS_CONTEXT` gets only the missing targeted context. The budget rules and the size table: `SKILL.detail.md` § "Token and context budget".

---

## Model Strategy

The model per dispatch is computed by `keryx review tier` (Step 6) and never written by hand.
`model_strategy` governs only how the computed model is surfaced:

| `model_strategy` | Behavior |
|---|---|
| `ask` (default, interactive) | Present the `keryx review tier` model plan once before dispatch — Start question 3; the operator may accept it, take all `deep`, or set it. |
| `adaptive` (default, unattended) | Dispatch on the computed model directly; record the chosen model per reviewer in the final report metadata. |

`inherit: true` is the adaptive answer: dispatch on your runtime's model for the block's `tier`, and
record `model_assignment: adaptive` with the model you chose.

---

## Scope Detection

### Fix round check (Step 1a)

`keryx review start` (or `keryx review plan`) decides the round; you never pick a range. `<package>/round.json` says round N, the mode (`first`, `delta`, `fallback-first`), the source that found the previous round and the `range`; `<package>/prior_findings.json` holds the earlier findings. "Round 1 — no previous round found (sources tried …)" is a valid outcome: review as a first round and say which sources were tried. An empty range (base equals head) is refused; pass the recorded base with `review start --base` / `review plan --ref`.

- **`delta` round.** Slice routing decides who reads each FIX, NEW and SECOND-LOOK slice; `review plan` prints them. On every dispatch over a FIX slice set `is_fix_round: true` and attach the findings that slice answers as `prior_findings`; the reviewer returns `prior_dispositions: [{id, disposition}]` in its `REVIEW_RESULT`, one entry for every attached finding id. A NEW slice is reviewed as round 1. When round.json says "previous round weak: …", that code is `kind: new` and gets the full round-1 treatment.
- **`fallback-first` round** (force-push or rebase: the previous head is not an ancestor). Review `merge-base..head` in full, with the prior findings attached.
- **Every attached prior finding leaves the round with a disposition** — `closed`, `open`, `partial`, `regressed` or `withdrawn` — one line each in the report before the new findings, checked against the code and not the commit message. A fix is new code: the report carries a `## Regressions the fixes introduced` section. A finding this round disproves is withdrawn at the top of the report with its evidence. Table and shapes: `SKILL.detail.md` § "Fix rounds — dispositions, regressions, withdrawal".
- **Duplicates.** `keryx review ingest` merges duplicate findings; later waves receive `known_findings` and do not report them again.
- **Enumerate what NAMES the thing the fix changed.** For each guard, instruction, message, refusal or helper a fix hunk touched, find its callers and the text that recommends it, and record the result in `review_context.scope.files`. A round that searched and found nothing is a different fact from one that never searched; only the recorded list tells them apart.

**The Jev edit guard is a FIX-phase tool.** `keryx review jev-edit-guard` runs in the author's agent while it applies fixes; this skill never runs it. Nothing refuses a dispatch that omits them (the `prior_findings`): `reviewer-input.schema.json` states the rule, no production code loads it, and the `prior_findings` array a reviewer receives is the only evidence it was met.

### Step 2: Determine Review Mode

Before anything else, determine whether the request is **diff mode** or **path mode**:

**Path mode** is active when ANY of these is true:
- User explicitly provides a file or directory path (`src/stores/`, `src/components/UserCard.tsx`)
- User names a specific module, component, or store: "review the UserStore", "review the pipelines module", "review src/auth/"
- User says "review [the entire / whole / all of] X" where X is a module name, not a branch name

**Diff mode** (default) is active when:
- No path or target name provided
- User says "review", "review my changes", "review PR", "review this branch"

---

### Diff Mode

Scope A is what `keryx review scope` (run by `review plan`) retained: the change since the merge base, with generated, lockfile, snapshot, vendored and minified paths and whitespace- or comment-only blocks dropped, each drop with its reason. **Do not run `git diff` yourself for the review scope, and do not decide what to leave out.** Keep the scope file until the round is ingested and pass the whole `--json` document as `--scope`. Reviewer selection is driven by the scope-A file list alone; `keryx review required` already does that.

---

### Scope B — the blast radius (deep rounds)

Scope A answers *is this change correct?*; scope B answers *did this change break something that was working*. A deep round dispatches under **both**. Scope B is computed, never browsed:

```bash
keryx review blast-radius --ref "${BASE_SHA}" --package "${PKG}" --json > blast-radius.json   # KEEP THIS FILE
keryx review blast-radius --ref "${BASE_SHA}" --package "${PKG}" --brief                      # what a scope-B reviewer is told
```

**KEEP THIS FILE**: the ingest at Step 12 is **refused** for a scope-B finding without it — pass it as `review ingest ... --blast-radius blast-radius.json`. Do not pick the files or widen the set; an empty radius is `unresolved`, not clean.

A scope-B reviewer answers one question: does this change break an existing behaviour **at these sites**? Pass `--brief` verbatim so no reviewer spends the round on findings ingest will refuse (`outside-set`, `non-regression-severity`, `no-link-to-change`). `class_scope` names the caller that breaks.

A missing input is replaced in the dispatch, never left blank. No linked flow means no frozen acceptance criteria: put the PR body or issue text in the scope-B payload, labelled as the criteria it stands in for; with neither, write `acceptance criteria: none supplied`, and the reviewer's summary says it judged behaviour against the diff alone. A FIX slice in a `delta` round gets no graph blast-radius set: its radius is the names the fix changed (`review_context.scope.files`), and the reviewer checks the fix lines for regressions of the behaviour they touch before it disposes each attached finding.

`review-degradation` is told its consumers by the graph, not by its own search: before each dispatch of it (a deep slice, or a delta round's fix or new deep slice), run `keryx review blast-radius --ref "${BASE_SHA}" --package "${PKG}" --degradation` from the worktree root and hand its stdout to the reviewer verbatim as its payload section. It needs no `--blast-radius` record; without the payload the reviewer has no consumers to read.

On rounds 2..N and always on the final round, run this and follow the decision it prints:

```bash
keryx review blast-radius --ref "${BASE_SHA}" --package "${PKG}" --previous blast-radius.json [--final]
```

`PKG` is the review package, created by `keryx review start` before dispatch. Give each reviewer `keryx review layers block --package "${PKG}" --files <its slice files> --json` as the payload's `layers` field.
When `dropped` is non-empty, run `keryx review chunks plan|estimate|next|record|merge --package "${PKG}"` until `next` has none left; an unattended run runs every wave without a question, up to the 25-pass ceiling. `review complete` refuses while a file is uncovered; the coverage waiver (`review_waive_coverage`) and the chunk-run question (`review_chunks_answer`) are the operator's alone, never yours ("Hosts": card or their terminal; unattended, record Not run). Pass `review_wave: {"package": "${PKG}", "pass": "<chunk id>"}` on every `spawn_subagent` of a chunk pass (`"pass": "round"` for the round's own reviewers): each wave counts its own 32 children and one turn opens at most 25 waves; a wave the package does not record is ignored and counts against the turn's 32. **Bring in pass findings.** `chunks merge` prints each finding the pass raised and `N chunk-pass findings not in round`; read it as you read a reviewer's result, and run `keryx review ingest --review-id <id>` (the package where the chunks ran) to bring them in. When a pass finishes after the report was written, run `chunks merge`, then ingest again and rewrite the report: `review complete` only warns about a pass finding out of `findings.json`, and a warning left standing is a defect you shipped.

### Path Mode

When a path or target is named, collect the candidate files:

```bash
# If a directory path is given:
keryx ctx run --raw -- rg --files -g '*.{ts,tsx,js,jsx}' <path> | sort

# If a module name is given (e.g. "UserStore", "pipelines module"):
keryx ctx run --raw -- rg --files -g '*<name>*.{ts,tsx}' | sort
# Also check common locations: src/stores/, src/modules/, src/components/
```

`--raw` returns plain paths, one per line, and the whole list. The summarized form (`keryx ctx rg --files`) prints header lines among the paths and cuts the list at 120 entries, so a round built on it silently covers a part of the scope. Only path lines are file entries.

Then put the list through the same exclusions before reading anything:

```bash
keryx review scope --path "src/a.ts,src/b.ts" --json > scope.json
```

Pass the full **file contents** of the paths it **retained** to sub-reviewers, and read none of the ones it dropped. Set `SCOPE_MODE: path`.

**Reviewer behavior in path mode:** reviewers check the entire file content — not just added lines. All findings apply to the current state of the code, not only to changes.

### Reviewer selection — computed by `keryx review required`

`keryx review required --mode all --scope <scope.json> --depth auto [--package <package>]` prints the roster: every installed bundled and project reviewer, filtered by the repository's stack (`metadata.stack_requires`), by path gates over scope A (`no-matching-paths`), by role switches, by depth (light: logic, testing and the stack's conventions reviewer), and with `review-regression` and `review-pr-contract` only when their inputs exist. Dispatch every reviewer it prints, and copy its exclusions, each with its reason, into the report's `Skipped reviewers`: a reviewer silently absent reads as "it had nothing to say".

**Project-local reviewers.** `keryx review reviewers --json` returns the `bundled` and `project` halves; a project reviewer is a reviewer — same contract, same rubric and laws, verified in Wave C, never self-verified. From each `project` entry, use the inventory's fields, not its prose: `flags` / `familyFlags` (a passed unique flag selects it explicitly and ungated; a family flag selects it and leaves it path-gated), and name once in the report its `flagWarnings`, `unresolvedRules`, `unresolvedReferences` and `drift`; `shadowedRules` go into the dispatch prompt ("Agent Runtime Compatibility"). What each field means: `SKILL.detail.md`, "Project-local reviewers". A description saying another entry point dispatches it is its author's routing note, not a restriction.

### Start questions (Step 5)

Ask once, after the context pack (Step 1) and the scope (Step 3), in one interaction — one
`AskUserQuestion` call on Claude Code (one `send_poll` for a Telegram operator), one `ask_user` in keryx shell, the lettered prompt in SKILL.detail.md elsewhere:

1. **Reviewers** — default the set `keryx review required --depth auto` prints (light or full); `--all` only when the operator asks; detected convention reviewers are included. Narrowing
   (tests only, one domain, custom) is the operator's explicit choice, recorded by them ("Hosts": reviewer override). Passed flags answer it.
   Legacy/profile reviewers stay flag-only and are never prompted.
2. **Counterpart** — show what the context pack found for the other side of the contract
   (endpoints, mirrored rules, a paired PR, or "no link found") and a checkbox to verify it,
   ON by default even with no link. If the round cannot locate that code, it asks where it is.
   Verification is not limited to a paired PR: contracts and logic are re-read every round.
3. **Models** — complexity, the per-role tier from `keryx review tier`, the model each tier
   resolves to on this host; accept (default), all `deep`, or custom. Once per round.

Unattended rounds ask nothing: the `required --depth auto` set, counterpart verified, computed models — recorded in
`### How this review was run`. In a `job-orchestrator` pipeline the job setting
`convention_reviewers` still answers question 1 (unresolved: include all detected reviewers
and record that choice in the review scope).

A gating round runs what these answers selected; a host with no spawn tool runs `keryx review run --autonomous`, and a
nested session at the depth limit returns `STATUS: BLOCKED` (`nested_dispatch_unavailable`), instead of reviewing alone (Preflight 1). Every
round also carries the always-on obligations — SKILL.detail.md § "Depth floor",
§ "Counterpart verification", § "Round obligations".

### Reviewer selection with Jev (`jev-select`) — advisory, before dispatch (Step 5c)

When `review.jev.select` is on, before Wave A/B dispatch: run `keryx review jev-select (--diff <ref>|--pr <n>) --json` over the finalized candidate set and drop every reviewer whose `decision` is `skip` from Wave A/B — never the Wave A core safety set (`review-logic`, `review-architecture`, `review-security-code`, `review-highload` when selected). Record every decision in the report's scope section as `skipped by Jev selection (advisory)`, naming the probability and reason: this lever is unmeasured, so its skips must stay visible. A `jev-select` failure keeps every candidate; it is never a reason to skip a reviewer.

---

## Legacy/Profile Reviewer Auto-Detection

Legacy/profile reviewers (`code-learned-review`, profile `full` only) are exempt from the finding contract (free prose, no per-finding severity), so they are dispatched ONLY when the user passes one of the flags below, or when `job-orchestrator` provides `reviewers` / `conditional_reviewers` that name them; never auto-included, never prompted, interactive or unattended, and `--all` never selects them.

| Trigger | Reviewers appended |
|---|---|
| `--legacy-profiles` | `code-learned-review` |
| `--learned` | `code-learned-review` |

When the inventory's `bundledSource` is `"project"` and the reviewer is missing from its `bundled` half, it is not installed: do not dispatch a substitute; record it in `Skipped reviewers` with reason `not-installed` and the command that adds it (`SKILL.detail.md`, "Skills present only when installed", also for `"package"`). Review Plan Preview includes an `Optional legacy/profile reviewers` group (each installed one with its flag) and a `Skipped reviewers` group with each one's reason (`SKILL.detail.md` § "Review Plan Preview — legacy groups").

## Routing Table

| Flag | Reviewers dispatched |
|------|---------------------|
| `--frontend` | `review-logic` + `review-frontend` + `review-style` |
| `--backend` | `review-logic` + `review-backend` + `review-architecture` |
| `--architecture` | `review-architecture` |
| `--security` | `review-security-code` |
| `--performance` | `review-performance` |
| `--style` | `review-style` (asked for by name; the set `keryx review required` prints leaves it, and `review-clean-code`, out unless the round started with `keryx review start --style`) |
| `--clean-code` | `review-clean-code` (same rule as `--style`) |
| `--highload` | `review-highload` |
| `--project-conventions` | all generic convention reviewers: `review-frontend-conventions` + `review-testing-practices` + `review-core-boundaries` + `review-flow-graph` |
| `--frontend-conventions` | `review-frontend-conventions` |
| `--testing-practices` | `review-testing-practices` |
| `--core-boundaries` | `review-core-boundaries` |
| `--flow-graph` | `review-flow-graph` |
| `--layout` / `--ui-ux` | `review-layout` / `review-ui-ux` (UI/UX and AI-slop; live mode too only when the payload supplies a URL or screenshots) |
| `--pr-contract` | `review-pr-contract` |
| `--all` | all reviewers above (including `review-highload` and project convention reviewers when local convention docs exist; `review-clean-code` and `review-style` only when the round started with `--style`, and nothing a project lists under `reviewRoles.disabled` in `routing.config.json`); never the legacy/profile reviewers, which stay flag-only |
| `--verify` | `review-verifier`, started on the first blocker or major and re-run for each later one (`SKILL.detail.md` § "Early verifier"); checks the findings by running something. Delete-only. |
| (always, Wave D) | `review-premise` after the verifier, over the canonical findings of severity ≥ minor; judges whether each is a defect at all; lowers or holds, never adds. Not a fan-out flag |
| (no flag) | what `keryx review required` prints |

Multiple flags may be combined: `review --backend --security` dispatches `review-logic` + `review-backend` + `review-architecture` + `review-security-code`. A bare `review --frontend` (or `--style`, `--architecture`, `--security`, `--performance`) reaches the specialist alone, not this table; ask by name, or use `review --all`, for the three-reviewer fan-out.

## Stage 1 Gate — Spec Compliance

**Run this FIRST, before dispatching quality reviewers, whenever the change has a stated intent — an `issue_url`, a task doc, or a PR body.** Run it on every round, not only the first: the code moves to answer findings and the body does not.

1. Fetch issue or task requirements.
2. Map changed files and functions to acceptance criteria.
3. Identify any criteria that are not addressed by the diff.
4. If there are unimplemented criteria: emit them as `blocker` findings in the final report and note them in `## Blockers`. Their `reviewer` is the reviewer that ran the comparison (`review-jev-contract`, or `review-logic` given the spec and the diff) — never `review-orchestrator`: a finding under the orchestrator's name cannot be routed away from its author, so Wave C silently skips it.
5. Continue dispatching the remaining reviewers regardless (spec gaps + quality issues both belong in the report).

**With no issue and no task doc, the PR body is the spec.** When `issue_url` and `context_doc` are both absent, read `pr.body` as the spec and run steps 2-4 against it. Nothing at all to read — no issue, no task doc, an empty body — is itself the finding: `minor`, that the change states no intent.

**This gate owns the description-vs-diff comparison**: the `minor` for a description that promises an approach the diff does not take (Context Pack) is filed here. When `review.jev.contract` is on, dispatch `review-jev-contract --pr` and read its `findings` as this comparison's scored result instead of judging it by eye; when that opt-in is off, the fallback is `review-logic` dispatched with the spec and the diff, filing under its own name — `SKILL.detail.md` § "CLI-engine reviewers".

---

## Dispatching Reviewers

**Dispatch integrity is a completion prerequisite.** Use one distinct execution per selected reviewer role; do not combine multiple roles in one child or count sections of one response as independent runs. When budgets are tight, use sequential waves, not role batching. Resolve every project-rule anchor before dispatch; missing rules require context recovery or a blocked result, never silently skipped checks. A read-only pass cannot discharge executable obligations: dispatch a capable execution pass and retain its evidence. Partial scope and NEEDS_CONTEXT remain incomplete until rerun over the outstanding scope.

**The reviewer set is not yours to shrink.** Dispatch every reviewer `keryx review required --mode all` prints (`all` for a pull request, for `--all` and for no narrowing flag). `--mode diff` only when the operator named a narrower mode: pass their words as `--operator-quote`, and on a package `keryx review start` created the operator records the decision themselves (card `review_override_reviewers`, or their answer to the host question recorded with `keryx review override-reviewers --package <package> --reason "<why>" --answered-by … --answer-text … --question-text …`); closure refuses a smaller set without that record. `keryx review ledger build` writes the dispatch record from the drivers and raw results; do not fabricate execution ids or mark a truncated response complete, and audit the evidence and inventory yourself before freezing: the runtime validates the declarations, not their truth. Research closure is mandatory: see [Runtime research-completion ledger](SKILL.detail.md#runtime-research-completion-ledger).

Dispatch selected reviewers in parallel when independent — this engine dispatches them itself (see "How to spawn"); a host without a dispatch tool runs `keryx review run --autonomous`, a nested session at the depth limit returns `STATUS: BLOCKED` (`nested_dispatch_unavailable`), and neither reviews alone — Preflight 1. Waves follow the diff domains in "Control" and keep their dependency order:

1. Wave A - core correctness/risk reviewers: logic, architecture, security/highload when selected.
2. Wave B - domain reviewers: frontend/backend/testing/convention reviewers filtered to relevant files. The CLI-engine reviewers (`"engine": "jev"` in `keryx review reviewers --json`: `review-jev-rules`, `review-jev-risk`, `review-jev-scenarios`, `review-jev-docs`, `review-jev-comments`, `review-jev-contract`) also run here as commands, not sub-agents, each gated on its own opt-in — `SKILL.detail.md` § "CLI-engine reviewers".
3. Wave C - **verification**: `review-verifier` over the findings, started on the first blocker/major while other reviewers still run and re-run for each later one (`SKILL.detail.md` § "Early verifier"), or when `--verify` is set or the PR is high-risk. Wave C overlaps A and B; Step 9b's `verify_order` applies to the later passes; each verifier pass is its own run.
4. Wave D - **premise**: `review-premise` after the last verifier pass (see "Wave D" below).

**Execution belongs to both B and C, for opposite reasons.** Wave C runs a command to decide the fate of a finding that exists; it is delete-only. Wave B runs commands to make findings — `review-testing-practices` deletes each gate the diff added and records whether the suite goes red, and `review-layout` measures rendered geometry. **A surviving mutation is not something Wave C can hand you.** When a testing reviewer returns without a mutation table, treat it as a reviewer that returned without findings and without evidence: ask once, then record that the pass did not run. Unattended: record
`Not run: mutation pass` without asking (unattended = `review start --unattended`, or the autonomous runner). Attended (every other start): run `keryx review mutate` ([The mutation pass](SKILL.detail.md#the-mutation-pass-keryx-review-mutate)); skipping it is the operator's waiver (`review_waive_mutation`, or their answer to the host question recorded with `keryx review waive-mutation … --answered-by …`).

### Wave C — verification, and what it replaced

Wave C replaced `review-strict`, a meta-pass that re-read the findings and adjusted severity with no new evidence. It was **removed, not improved**, on measured evidence:
self-correction fell 95.5 → 91.5 → 89.0 (GPT-4, GSM8K) and 75.8 → 38.1 (GPT-3.5, CommonSenseQA), arXiv:2310.01798; Self-Refine's +49.2 on dialogue response generation is +0.2 on maths
(arXiv:2303.17651), so re-reading helps subjective tasks and not verifiable ones. A verifier that **runs something** rejects most false reports.
Do not restore the re-score because it looks useful.

`review-verifier` **never votes**: agreement between reviewers is not evidence and must never be recorded as verification.

Dispatch rules:

- Pass the findings held when this pass starts (the whole consolidated set on the last pass), each carrying `global_id` and the **real** originating `reviewer`.
- **A finding is never verified by the reviewer that raised it.** When only one reviewer ran, its findings are simply left unverified; verifying them yourself is worse than not verifying them. Do not route around the name check by respelling the name.
- Start it on the first blocker or major and re-run it for later ones.
- The verifier returns `verification-claim.schema.json`. Merge it with `keryx review ingest --verifications <file>`; do not apply verdicts by hand, and do not apply a severity, new finding or rewrite it returns (the merge discards that whole claim).

### Wave D — the premise judge, after the verifier

A finding can reproduce and still not be a defect. `review-premise` asks the other question, on the deep tier and a clean context: intent, accepted practice, consistency, fix soundness.
- Before dispatch, renumber any display id that another finding, carried or new, already has, in the saved reviewer results, so the judge, its claims and ingest all see the same ids (ingest refuses two findings under one key; a claim naming a shared id is rejected as `ambiguous-finding`).
- Dispatch it once after the last verifier pass (no verifier ran: after the last reviewer), over the canonical findings of severity ≥ minor, each with its display `id`, the **real** `reviewer` and `source`, and, for a finding carried from an earlier round, its `global_id`. External (PR-comment, `source: external`) findings are included: they can be challenged, never downgraded. In a delta round only findings without a carried premise. On keryx shell the judge has no shell and no git tool: run `git log -L` and `git blame -L` for each cited site first and pass the output in `context_files`.
- Save its claims object unchanged to `research-evidence/premises.json` (the verdict reads it there) and pass that file with `keryx review ingest --premises <file>`; never apply verdicts by hand.
- `challenged` and `owner-decision` **hold** a finding: it is neither fixable nor clean — not an open blocker or major, never in a fix loop's `fix_context.review_feedback`, and it blocks until answered; the verdict lists it as awaiting the operator. **Asking about a held finding** (every skill that meets one points here): at the tail, after `ingest --premises` wrote `findings.json` (never during Wave D, before the ingest: the answer commands read `findings.json`), in keryx shell call the card `review_decide_premise`, which records the answer; elsewhere put its `question` and `options` to the operator with the host's question tool (`uphold` or `dismiss`, the finding id in the question; never send them to a terminal), then record what they chose: `keryx review decide-premise --package <package> --finding <global_id> --answer uphold|dismiss --reason "<why>" --answered-by <source>:<ref> --answer-text "<their words, verbatim>" --question-text "<the question as asked>"` (`confirmedVia: "host-question"`; "Hosts", Operator decisions). Record only an answer they gave and never write their words or their reason yourself. In a flow, journal the recorded answer. Unattended: leave it held and report it.

### `verification_mode`

`off` | `annotate` | `filter`. **Default `annotate`.** Do not switch a project to `filter` on the strength of one round.

| Mode | What happens |
|---|---|
| `off` | No verification. Claims are refused rather than silently ignored. |
| `annotate` | Verdicts are recorded on the findings. **Nothing is removed.** A `refuted` finding is still reported, marked refuted. |
| `filter` | An applied `refuted` verdict removes the finding from the reported set and records it as `dismissed-incorrect`, with the verification evidence. |

### Agent Runtime Compatibility

Before dispatching a reviewer through a platform-native sub-agent mechanism, verify that the exact reviewer name is available as an agent type in the current runtime.

Runtime rules:
- If the exact reviewer agent type exists, dispatch that reviewer directly.
- If the exact reviewer agent type does not exist but `.metaproject/skills/gdskills/review/<reviewer>/SKILL.md` exists, dispatch `general-purpose` and include the reviewer name, the path of that skill file, bounded review context, and required `REVIEW_RESULT` schema in the prompt. For a bundled reviewer that path goes in the prompt text and in `dispatch_plan`, not in the input's `skill_path` field, which is for project reviewers only.
- If neither the agent type nor the skill file exists, do not silently substitute another reviewer. Mark that reviewer as `BLOCKED`, include the missing agent/skill name, and continue only with independent reviewers.
- **A project reviewer is dispatched by its package, on every branch above.** Put the absolute path of its registered `<path>/SKILL.md` in the dispatch (`skill_path`) and say in the prompt that this file is the reviewer's definition and overrides the built-in definition of any agent type with the same name. If the file is missing, mark the reviewer `BLOCKED` and name the missing path — do not fall back to the same-named agent type or to any other reviewer. For every entry in that reviewer's `shadowedRules`, the prompt also says: "where your text names `<ref>`, read `<resolved>` instead" (the absolute path of `resolved`) — see `SKILL.detail.md`, "Dispatching a project reviewer".
- Record the chosen runtime per reviewer in `review_context.review_plan.dispatch_plan`.
- The user-facing progress line must be explicit: "Running `<reviewer>` via `general-purpose` fallback because native agent type is unavailable." Do not use vague fallback messages such as "running through available agent types" without naming which reviewers used fallback and why.

Pass each sub-reviewer a payload matching `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-input.schema.json`:

```yaml
# Every field and its source, and what the prompt adds: "Reviewer brief — required contents" (How to spawn), lines A–Z.
review_context: <bounded context pack — lines K–R, incl. pr.body as full text>
reviewer: <skill-name>
skill_path: <absolute path of <path>/SKILL.md — project reviewers only; omit for a bundled reviewer>
scope_mode: diff | path
context_doc: <path or empty>
issue_url: <url or empty>
pr_context: <package>/pr-context.md on a pull-request review
conduct: <the "Dispatch form" line of .metaproject/rules/process/agent-conduct.mdc, verbatim>
model: <the `model` block `keryx review tier` printed for this dispatch — paste verbatim; also into the prompt and the driver>
allowed_tools: read-only | run-tests
exec_budget_s: <0 for read-only; seconds for run-tests>
layers: <keryx review layers block … --json>
metaproject: {memory: <the review_context.memory entries>}
is_fix_round: <true on a FIX slice of a delta round>
prior_findings: <the findings that FIX slice answers>
known_findings: <earlier waves of this round>
budget:
  max_prompt_tokens: <number or null>
  max_findings: <number>

# If scope_mode = diff:
branch: <branch>
base_sha: <base sha>
slices: <the slice ids of this wave>

# If scope_mode = path:
target_path: <resolved path or file list>
file_contents: <bounded file contents relevant to this reviewer>
```

Each reviewer must return a `REVIEW_RESULT` object matching `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, followed by a concise markdown summary. The orchestrator must reject or normalize free-form reports before consolidation. **Important for path mode:** instruct each reviewer to check the **entire file**, not just changes. The scope report should say "Path: `<TARGET_PATH>`" instead of a branch/merge-base.

## Sub-Agent Report Quality Gate

Before consolidation, validate every reviewer result:
- Every reply starts with a `STATUS:` line, and each status has one action:

| Status | Action |
|---|---|
| `DONE` | Consolidate. |
| `DONE_WITH_CONCERNS` | Consolidate and carry the concerns into the report. |
| `NEEDS_CONTEXT` | One targeted context refill; if still unresolved, keep it as an explicit open question, not a blocker. |
| `BLOCKED` | `review next` hands out the next wave of the uncovered slices; a reviewer with no progress is listed under **Not run**. |
| `RATE_LIMITED` | Halve the wave and requeue (Control). |
| anything else, or no result | Treat as `BLOCKED`. |

- Required finding fields: id, severity, file, `quote`, problem, impact, suggested_fix, evidence, confidence, reviewer. **`quote`, not `line`:** the reviewer copies the code the finding is about verbatim out of `file` and does not count lines — `keryx review ingest` locates the quote at the round's head and derives `line`. Quote enough to be unambiguous. A finding about the round rather than a site carries neither.
- Every blocker must include evidence and a concrete suggested fix.
- Findings without evidence are downgraded to `info` or returned to the reviewer for clarification.
- Duplicate findings are merged by `dedupe_key` or by `(file, quote, problem)`.
- **A reply that is not a result is `BLOCKED`.** That covers an empty reply (`(subagent produced no text)`), a reply without a valid `REVIEW_RESULT` block, and a `spawn_subagent` output whose first line is `status: BudgetExhausted (…)` or `status: NoProgress …` — the reviewer was cut short, so whatever fragment it left is not its review — and a `DONE` result whose `inputs_unreadable` lists a mandatory input it could not read. Re-dispatch it exactly once with a larger budget, telling it to return its report before the budget ends (and the same `cwd` when the round reviews a worktree). For unreadable inputs a larger budget changes nothing: first fix the path or payload that `inputs_unreadable` names, then re-dispatch once. If that also fails, the pass is **not run**: list it under **Not run** with the reason, and never write its findings yourself — a review nobody ran reported as run is worse than a gap the operator can see.
- **The verifier is held to the same rule.** A finding without an applied verifier verdict is `unverified`; the orchestrator never verifies one itself, and a verifier that returned nothing leaves every finding `unverified`, stated in the stage counts.
- If a reviewer exceeds `max_findings`, keep blockers/majors first and summarize lower severity findings.

## Severity (canonical)

**This is the only severity rubric in the review domain.** Reviewers do not carry their own. A reviewer may state which of *its* conditions land where; it may not redefine the levels.

### `blocker` — merge-blocking, and nothing else

Exactly four shapes. Nothing outside this list is a `blocker`, however strongly
the reviewer feels about it:

1. **A crash** — the process, request, or render dies on an input the change
   admits.
2. **Data loss or corruption** — something persisted, transmitted, or returned is
   destroyed or silently wrong.
3. **An exploitable vulnerability** — an attacker action with a named entry point
   and a named impact.
4. **An unimplemented acceptance criterion** — the change claims work the diff
   does not contain.

Everything else is at most `major`. "This will definitely cause problems later"
is not one of the four. Neither is "this violates the architecture", "this fails
the linter", or "this is how the last outage started".

**An unshipped dependency is shape 1 or shape 2, and the list stays closed.**
When a producer is recorded `state: open` with `merge_order: producer_first` and
nothing stops this change merging first, the consumer calls what is not there
(shape 1) or reads the default the producer has not changed yet (shape 2). File it
against the consuming call site, and say in the fix that the remedy is a merge gate,
a flag, or a fallback — never a change to the diff. A missing deploy note with no
recorded producer state behind it is the `minor` in the Context Pack.

### `major` / `minor` / `info` — the boundary test

Ask one question, and ask it of the **finding**, not of the code:

> **Does it name a trigger, and the observable outcome that trigger produces?**

- **`major`** — it does. There is an input, a call, a render, or a load level, and
  a resulting behaviour a user or a caller would call wrong: a wrong value, a lost
  update, a leak, a hang, a cost stated together with the frequency that makes it
  a cost. Not one of the four shapes above, so not merge-blocking — but the code
  does the wrong thing.
- **`minor`** — it does not, and does not claim to. The code behaves correctly;
  the cost lands on whoever reads or edits it next, and the finding names that
  cost at a named site.
- **`info`** — it names neither. An observation, a preference, or a risk with no
  demonstrated path.

Look for the trigger and the outcome. Present → `major`. Absent, but a concrete maintenance cost is named → `minor`. Neither → `info`.

A surviving mutant shows a missing assertion, not wrong behaviour: a test gap in code the
suite exercises is `minor`; `severity-audit` raises it only when no mutant in that file was killed.

- A finding that **claims** runtime harm and cannot name the trigger is `info`,
  not `major` — and not `minor`, which is for findings that never claimed runtime harm.
- Severity is a property of the demonstrated outcome, never of the reviewer that
  found it, and never of how crisply the finding is worded: an outcome that costs a
  user, a caller or persisted state nothing is `minor` however precisely its trigger is named.
- Two findings that both name a trigger and an outcome are the same severity even when
  one is obviously worse; the ordering inside a severity is the operator's.

### Shared laws (every reviewer)

Read the review activity rule before the code: `.metaproject/rules/project/activity/review.mdc` when the project keeps its own, else `.metaproject/rules/activity/review.mdc`. It holds what every reviewer applies and this file does not restate: scope (diff mode: the change; path mode: the whole file), the four shared laws, `info`, one finding per defect across lenses, and where severity comes from.

## Finding Format

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set.

```yaml
class_scope:
  sites: ["src/lib/shell-config.ts:60", "src/session/store.ts:133"]
  enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list
is a claim that the class has exactly one member — make it deliberately.
`minor` and `info` may omit it.

**Negative enumeration — the empty set is also a class scope.** A finding that something is **absent** (nothing clears this state, nothing reads this field, this prop can never fire) carries `sites: []` and an `enumeration_method` that names the complete candidate set and why each member fails to apply; "I looked and did not find one" is not that, a search that returned nothing, with the query, is. It covers the inert change (a prop, guard, field or branch nothing can reach), the missing clear, and the unreachable branch. An inert change is `minor` when it is merely dead, and `major` when its deadness means the bug it was added to fix is still live.

All findings from all sub-reviewers must be normalized to this format before consolidation:

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Repo**: producer repository — only when the evidence is not in the repository under review
- **Problem**: what is wrong
- **Why it matters**: impact on correctness / safety / maintainability / UX
- **Fix**: concrete suggestion
- **Patch** (optional):
  ```diff
  - old line
  + new line
  ```
```

Severity ordering for sort: `blocker` > `major` > `minor` > `info`.

### Model Metadata Rules

`adaptive` is a model-assignment outcome recorded when `keryx review tier` printed `inherit: true` and the host picked the model for the tier, not a model name. Never render it as `model: adaptive` or as the PR comment `Model` value.

When writing review report metadata or a PR comment:
1. Read `review_context.token_policy.model_plan`.
2. Set `Model strategy` from `model_plan.strategy` (`ask` or `adaptive`).
3. Set `Current model` from the first available value: `model_plan.current_model`, detected tool output, current runtime model shown by the platform, or `unknown`.
4. Record the model actually assigned per reviewer — the `tier` and (`provider`+`model` or `inherit`) from the `model` block `keryx review tier` printed for that dispatch; include `complex_model`, `normal_model`, and `simple_model` too when `model_plan` reports them.
5. If the dispatch's `model` block carried `inherit: true`, write `Model assignment: adaptive` and the model the host actually dispatched on for that tier (or `unknown`).
6. If the actual model is unknown, write `unknown`; do not substitute `adaptive` or `inherit`.

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS
```

`DONE` — no blockers or majors in the changed code.
`DONE_WITH_CONCERNS` — one or more blocker or major findings in the changed code.

The machine `verdict` is unchanged (`APPROVE`, `APPROVE_WITH_SUGGESTIONS`, `REQUEST_CHANGES`). The prose does not print those tokens. It prints the line in `templates/review-report.md`: `Changes requested` or `No blockers, merge-ready`.

Render the human report from that file. Do not invent a second skeleton here; its shape, for orientation:

```markdown
<!-- slot:pre-verdict -->
**Changes requested — 1 Blocker, 2 Major, 4 Minor, 1 question.** <what holds, and where the risk is.>
Reviewed `<head>` against `<base>` · round N · <files> files, +<add>/−<del> · CI <state>.
<!-- slot:after-verdict -->
### Blocker · ### Major · ### Minor · ### Questions (an info finding that needs an author answer; other info is not published)
<details> Pre-existing (not blocking) · Verified clean <!-- slot:verified-clean --> · How this review was run — **Workflow:**, **Scope:**, **Models:**, **Tools:**, **Skills:**, **Subagents:**, **Not run:**, **Verification:** <!-- slot:how-run --> </details>
```

Pick the domain file the same way reviewers are picked: frontend scope, or a fullstack / paired PR, reads `templates/pr-comment-frontend.md`. Backend-only reads `templates/pr-comment-backend.md`. A paired PR always uses the frontend file and must include the wire-contract line.

## Stage counts

Required in **How this review was run**, copied from `scope.md`, not re-counted by hand. State what each stage removed. Never state it as a precision improvement: no precision baseline exists to improve on. The line carries `verification_mode` (`off | annotate | filter`), confirmed / refuted / unverifiable / unverified, the premise verdicts (upheld / downgraded / held), and retained.

**Verified clean** is a hypothesis that was tested and died, with the evidence, not a list of virtues. There is no Positive Notes section. A compliment is not a result.

Tables: counts, ids, `file:line`, statuses, before/after, pass/fail only. A finding is a paragraph or a list item. A cell longer than about ten words is not a table cell.

## Skill Learning Handoff

After findings are consolidated, decide whether any of them should re-train a project-skill (see `rules/process/skill-lifecycle.mdc`): a finding that a project-skill *should have prevented* means the skill is stale or incomplete.

1. For each blocker/major finding, `keryx skills route <finding-file>` to see if a project-skill covers that module/entity.
2. If a covered skill exists and the finding reflects a rule the skill omits or contradicts — especially if the **same class of finding recurs** across files or across reviews — flag it for learning.
3. Do not mutate the skill yourself. Emit a `Skill Learning` block in the report and hand it to the caller (`job-orchestrator` / `flow-orchestrator`), which dispatches `skills learn` as a subagent (cheaper model if available):

```markdown
## Skill Learning
- `<module>/<skill>` ← F-012, F-019 (missing null-guard convention). Suggested:
  keryx skills learn --from-review <report-path> --skill <module>/<skill>
```

If no findings map to a project-skill, write `## Skill Learning\n- none`.
Never run `skills learn apply` from the reviewer — proposal review and apply are
the orchestrator's step.

---

## PR Review Report Publication

When the review target is a GitHub pull request, ask whether to publish after
the report exists, unless `publish_pr_review_report` is already set:

```text
Publish this review report to the PR?

  A) PR review only
  B) PR review + follow-up file (recommended when a fix round will follow)
  C) Do not publish

> pick a letter (default: C)
```

Automation values, names unchanged:

- `comment` or legacy `true` -> the PR review only.
- `comment-and-ai-artifact` -> the PR review plus the follow-up file.
- `none` or legacy `false` -> do not publish.

Unattended: do not publish; hand the rendered body back to the caller.

Default is do not publish. No resolvable PR number means skip and say so.

The review body is the report rendered from `templates/review-report.md`, English, with the domain file chosen above (`templates/pr-comment-frontend.md` / `templates/pr-comment-backend.md`) — never a summary written freehand. It does not use a tool heading, a finding table, or a meta table. It does not carry a co-author line, a `Generated with` trailer, or any sentence that names a vendor or a product as the author. Name the workflow and reviewers that actually ran, with models, tools, skills and subagents. Never identify the operator from `gh auth status`, git config or a credential; do not sign the review as a person, reviewer or model. A project overlay adds content only through the template's overlay slots.

The follow-up file path and the metadata rules (real model names, Run vs Not run, no `adaptive` in the model slot) live in that same template. The body goes out as one formal review whose state follows *Where it is posted* in the template, through the one keryx path to GitHub, held by the readiness checklist: `keryx review publish <package> --event COMMENT|REQUEST_CHANGES|APPROVE` (`--partial` when the package is not ready; `--event COMMENT` on a merged or closed PR). Publishing is the operator's decision: the `review_publish` card in keryx shell, elsewhere they run it in their terminal, where it shows the body first. You never pass `--yes`, and never post around it with `gh pr review` or `gh pr comment`.

**No GitHub write without an approved draft.** Before ANY write — the comment, a thread reply, `keryx review comments reply`, a review — show the user the rendered body and wait for explicit approval of that body.
Picking A or B above chooses *whether* to publish, not *what*; a comment is public and cannot be unsent. With no user to answer (a dispatched run), do not write: hand the rendered body back to the caller.

Re-read head and thread before posting. If head moved, re-check findings
and name unchecked commits. Do not duplicate findings; cite extended ones.

## Job Context Awareness

When a prompt carries `JOB_NAME` and `CONTEXT_PATH`, read that context document before scope detection (`SKILL.detail.md` § "Job Context Awareness"). It is optional and non-blocking.
