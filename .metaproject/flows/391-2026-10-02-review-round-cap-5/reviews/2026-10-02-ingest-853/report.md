# Review of PR 853 (flow 391): review round bound three to five

Round 1 of 1. Independent Sonnet code-reviewer, run after PR #853 merged (merge 938ee7446e57afbb643ec1c1fd3ab584bdd36d3f; PR head 4dc3f4a18a73af9b0fac9ff3fda9088898ef07e4, whose content the merge carries). The change raises flow-orchestrator's review/fix bound from three to five (REVIEW_ROUND_CAP = 5) and keeps three for job-orchestrator and task-implementer. The reviewer confirmed the gate logic, REVIEW_ROUND_CAP = 5, the 694-line length ceiling and the byte-identical bundled and mirror skill copies. It found five stale-prose defects, all text only, none affecting runtime. All were fixed in PR #855 (merge 4b387401130a80f970e47f38d72182b551759e63, release 0.3.61, CI green, merged).

**F-001 to F-005.** Each says some document still claims that all three orchestrators share one bound of three, or that rounds four to six were not worth running, after flow-orchestrator's review bound became five. Fix for all: name five as flow-orchestrator's review bound by operator decision and keep three for the two self-fix bounds. Landed in #855.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow391-sonnet-code-reviewer",
    "severity": "minor",
    "problem": "The job-orchestrator input contract still says all three orchestrators share a review bound of three (`task-implementer`, `flow-orchestrator` and SKILL.md 2.7), after PR #853 raised flow-orchestrator's review bound to five. Same sentence in the .metaproject mirror.",
    "impact": "The schema is what a caller reads to learn the bound; it states a shared bound that no longer exists. Text only, no runtime effect: the default stays 3 and round-bound.test.ts pins it.",
    "suggested_fix": "Say three is the bound task-implementer and SKILL.md 2.7 carry, and that flow-orchestrator's review bound is five by operator decision.",
    "evidence": "Read src/gdskills/bundled/skills/orchestration/job-orchestrator/input-contract.schema.json line 109 at 938ee7446e57afbb643ec1c1fd3ab584bdd36d3f (merge of #853). Same text in the .metaproject mirror.",
    "confidence": "high",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/input-contract.schema.json",
    "line": 109,
    "quote": "Three: the same bound `task-implementer`, `flow-orchestrator` and SKILL.md 2.7 carry"
  },
  {
    "id": "F-002",
    "reviewer": "flow391-sonnet-code-reviewer",
    "severity": "minor",
    "problem": "job-orchestrator/SKILL.md says three is the round bound that task-implementer, flow-orchestrator and this skill all use.",
    "impact": "A reader of the skill is told flow-orchestrator is bounded at three while its own skill and REVIEW_ROUND_CAP say five. Text only.",
    "suggested_fix": "Say three is the self-fix bound task-implementer and this skill share, and name flow-orchestrator's five as an operator decision.",
    "evidence": "Read src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md line 1268 at 938ee7446e57afbb643ec1c1fd3ab584bdd36d3f.",
    "confidence": "high",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 1268,
    "quote": "Three is the shared round bound: `task-implementer`, `flow-orchestrator` and"
  },
  {
    "id": "F-003",
    "reviewer": "flow391-sonnet-code-reviewer",
    "severity": "minor",
    "problem": "task-implementer/SKILL.md says three is the same three that job-orchestrator and flow-orchestrator use, 'one round bound, not four'. The task-implementer input-contract schema (line 191; bundled copy, .metaproject mirror and the core contracts copy) carries the same claim for the fix-iteration number.",
    "impact": "Two documents state a single shared bound after the bound split into three (self-fix, job review) and five (flow review). Text only.",
    "suggested_fix": "Name flow-orchestrator's review bound as five by operator decision in the skill and in all three schema copies; replace 'one round bound, not four' with 'two repair bounds, not four'.",
    "evidence": "Read src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md lines 365-366 and src/gdskills/bundled/skills/orchestration/task-implementer/input-contract.schema.json line 191 at 938ee7446e57afbb643ec1c1fd3ab584bdd36d3f.",
    "confidence": "high",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md",
    "line": 365,
    "quote": "Three, and it is the same three `job-orchestrator` and `flow-orchestrator`"
  },
  {
    "id": "F-004",
    "reviewer": "flow391-sonnet-code-reviewer",
    "severity": "minor",
    "problem": "flow-orchestrator/SKILL.md ends its round-bound rationale with 'Rounds four through six were not buying convergence; they were buying regressions', which contradicts the five review rounds the same skill now allows.",
    "impact": "The sentence argues against rounds four and five, which the skill permits two paragraphs earlier. Text only.",
    "suggested_fix": "Scope the sentence to a self-fix loop and say review rounds are the exception, as stated above.",
    "evidence": "Read src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md lines 567-568 at 938ee7446e57afbb643ec1c1fd3ab584bdd36d3f.",
    "confidence": "high",
    "file": "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md",
    "line": 567,
    "quote": "Rounds four through six were not buying convergence; they were buying"
  },
  {
    "id": "F-005",
    "reviewer": "flow391-sonnet-code-reviewer",
    "severity": "minor",
    "problem": "The comment on the goal bound in goal-command.ts says the repair bounds in this repository 'have been unified to 3', listing flow-orchestrator's PR review/fix attempts among them.",
    "impact": "A maintainer reading the goal bound is told flow-orchestrator's bound is 3; it is 5 (REVIEW_ROUND_CAP). Comment only, no runtime effect.",
    "suggested_fix": "Say two repair bounds were unified to 3, and that flow-orchestrator's review bound went from 6 to 5 by operator decision (flow 391).",
    "evidence": "Read src/commands/goal-command.ts lines 62-64 at 938ee7446e57afbb643ec1c1fd3ab584bdd36d3f.",
    "confidence": "high",
    "file": "src/commands/goal-command.ts",
    "line": 62,
    "quote": "unified to **3**: `task-implementer`'s self-fix attempts, `job-orchestrator`'s"
  }
]
```
