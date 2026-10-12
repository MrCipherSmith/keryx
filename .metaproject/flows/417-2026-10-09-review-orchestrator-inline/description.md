# review-orchestrator runs inline in the main session and never half-runs

Status: draft, AC awaiting operator review before freeze
Source: user description (origin: human-request)

## Problem

Two of the operator's agents could not run `review-orchestrator`. One ran it as a dispatch inside a
separate subagent that had no way to spawn the reviewers. The other first failed to launch it, then
launched it as a review subagent, which kept orchestrating by itself and stopped midway.

Causes found in the audit (`orchestrator-audit.md`, `review-orchestrator-skill-audit.md`):

- The skill's first 49 lines never say "you are the orchestrator, run the round yourself", carry no
  preflight and no round ceiling. The only fail-closed rule (`BLOCKED nested_dispatch_unavailable`)
  sits at ~lines 1072 and 1188 of 1712, so an agent reaches it at Step 8, after it is already
  orchestrating.
- "does not perform any review logic itself" invites handing the whole round to one subagent.
- `job-orchestrator` carries a `SUBAGENT-STOP` block, while `vantage-job` is itself a subagent that
  must run the skill. The chain main, vantage-job, orchestrator subagent, review, reviewers is four
  layers against a default depth limit of three (Claude Code docs, sub-agents).
- Keryx's exported agent vocabulary (`src/agents/tools.ts`) has no spawn tool.
- `--all` contradicts the skill's own red flag; no "no round needed" branch; start questions without an
  unattended default; a dead schema reference; double Step numbering; a raw `find` the hook blocks.
- The dispatch cap (`DEFAULT_MAX_PARALLEL_REVIEWERS = 4`, `src/review/caps.ts`) is not in the skill and
  cannot adapt to a rate limit.

## Expected Outcome

An agent that reads the skill knows within the first screen: it is the orchestrator and runs inline in
the main session; if it cannot spawn, it stops with one line before doing anything; whether a round is
needed at all; how to spawn each wave; how many rounds are allowed; when it is done.

## Outcome criteria

- Запрос (дословно): «после последнего обновления получилось так, что у меня два агента не смогли нормально запустить ревью оркестратора» (source: helyx 194482, 2026-10-09T13:03Z)
- Эффект (оператор, дословно): «ревью оркестратор должен быть основным механизмом ревьюинга и работать безотказно максимально» (source: helyx 194614, 2026-10-09T14:28Z)
- Эффект (формализация агента): `review-orchestrator` is the default way a review is done. Launched from the main session it completes a round; launched where it cannot spawn, it refuses in one line without side effects. It never stops midway silently: every end is either a consolidated report or a named `BLOCKED` reason.
- Как наблюдать (предложение агента): run the skill in the main session on a small diff, and run it as a subagent without the `Agent` tool. The first ends in a consolidated report and a recorded round, the second in a single `STATUS: BLOCKED` line. The tests listed in the acceptance criteria fail when the preflight is removed.

## Out of Scope

- Moving `review-orchestrator` or `flow-orchestrator` into subagents (decided: not by default; a later flow if the operator wants it, after the host and version of the two failing agents are known).
- The operator's global `~/.claude/CLAUDE.md` (the line routing review through `vantage-review`): the operator's own file; recorded as a follow-up, not edited here.
- Flow 416 closing, flow 415 and any other open item.
- TUI: no new user-facing surface. Wave progress already appears through the existing round record; a TUI view of waves is not added, by choice.
