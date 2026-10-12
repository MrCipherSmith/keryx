# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The first 60 lines of the bundled `review-orchestrator/SKILL.md` state that the reading agent is the orchestrator and runs the round inline in the main session, and hold a three-point preflight (can it spawn: `Agent` tool present and depth budget left; is a round needed; round ceiling). A test pins the phrases and that the preflight precedes the workflow checklist and Step 5.
- AC2: When the preflight finds no spawn tool or no depth left, the skill ends before any Step 1 with exactly one line `STATUS: BLOCKED nested_dispatch_unavailable — run this skill in the main session`. The two older BLOCKED statements in the body are reduced to a pointer to the preflight. A test fails if the BLOCKED rule appears only after the Step 5 heading.
- AC3: `flow-orchestrator` and `job-orchestrator` carry the same preflight in their first 60 lines. The `SUBAGENT-STOP` block is gone from every orchestrating `SKILL.md`, and a test fails if one comes back.
- AC4: The agent vocabulary in `src/agents/tools.ts` can express the spawn tool, and an exported agent declared as an orchestrator keeps it in its `tools`. A test fails for an orchestrating agent file that lacks it, and for one that names it where the host does not support nested spawn.
- AC5: The skill holds a spawn recipe: all calls of one wave in a single message; the exact `subagent_type` when the host has it, else `general-purpose` with the reviewer's skill path in the prompt; the prompt carries pointers, not pasted files; each reviewer returns a `STATUS:` line and a `REVIEW_RESULT` block; the model tier comes from `keryx review tier`. A test pins each element.
- AC6: Waves are split by diff domain by default (logic and security, then frontend and backend, then style and tests), keeping waves A, B, C by dependency. For `--all` and a full review a wave holds at most 10 reviewers. The cap is a setting; `DEFAULT_MAX_PARALLEL_REVIEWERS` is replaced by the domain rule and the 10 ceiling, and the skill states them. Unit tests cover the planner for a 3, a 14 and a 20 reviewer set.
- AC7: A docs-only or config-only diff yields `round not needed` with the reason in the report, and launches no reviewer. A test over two fixtures (docs-only, code) asserts both outcomes; `--all` still forces a round.
- AC8: The default profile is read-only: one round, no edits. A `--fix` profile is defined: the orchestrator changes no code itself, hands findings to `flow-orchestrator` or `task-implementer`, takes the new head and runs the next round; each re-review counts toward the round ceiling, which equals `REVIEW_ROUND_CAP` in `src/flow/review-gate.ts` (5 today; the earlier text said 3 by mistake). After the last round it stops and reports to the human. A test asserts the skill's ceiling equals the code constant.
- AC9: A reviewer that hits a rate limit returns `STATUS: RATE_LIMITED`. The orchestrator halves the wave size, requeues the reviewer and honours `retry-after` when given, at most two halvings, then `BLOCKED rate_limited` naming the queue left. Unit tests cover the planner for one and for three consecutive rate limits.
- AC10: Every start question in the skill has a stated default for an unattended run, and an unattended run asks nothing. A test fails for a prompt without a default.
- AC11: Skill hygiene: `review-finding.schema.json` references point at the file that exists; the two Step 0 and Step 1 numberings are one; the raw `find` is replaced by `keryx ctx`; the model rule is stated once; CAPS and NEVER emphasis conform to `opus-5-5-prompting.mdc`; the skill is not longer than its ceiling in `skill-length-ceilings.ts`, and the ceiling is not raised. A test resolves every schema and file reference of the skill.
- AC12: The facades `vantage-review` and `vantage-job`, where this repository generates their text, state the precondition and the depth budget: "the main agent runs the skill inline and does not spawn this agent for it". Where the text is generated outside this repository, the flow's journal names the owner of that text instead.
- AC13: `.metaproject/skills/catalog.md`, `.metaproject/routing.md` and the managed block of `CLAUDE.md` and `AGENTS.md` say the orchestrators run in the main session. A test fails when the managed block is regenerated without it.
- AC14: Negative proof: removing the preflight from each of the three orchestrators fails at least one test (mutation run, results in the journal). Existing `review-first-round-completeness` tests still pass.
- AC15: Docs: `docs/docs/guides/review-with-a-record.md`, `cli-reference.md` where a flag changed, the README review line and the CHANGELOG describe the preflight, the profiles, the wave rule and the rate behaviour, and say what the skill does not do. `mkdocs build --strict` passes.
- AC16: Smoke before release: one real round in the main session on a small diff ends in a consolidated report and a recorded round; the same skill started as a subagent without `Agent` ends in the single BLOCKED line. Both are run and written in the journal. The released package is installed from npm and the smoke repeated.
