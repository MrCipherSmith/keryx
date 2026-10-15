# PRD: a new review starts with clean context

Status: DRAFT 2 for the operator (source: helyx voice message 206452, 2026-10-15). Decisions of poll 179 applied. Not frozen.

## Problem

A review session that ended early reported that at some points it used information from its own memory. A review must be reproducible from its package: the same inputs must give the same context, whoever runs it and whatever that agent remembers from earlier work.

## Requirement (operator's words, condensed)

1. A new review runs with fully clean context. The agent does not consult its own memory or its earlier work (earlier sessions, earlier reviews of the same PR, its auto-memory index).
2. Context is gathered only by the review-orchestrator's own context stages.
3. When the agent has a question, it looks in the review-orchestrator's own instructions, or asks the user. It does not answer from memory.

## Audit (what reads memory or earlier work today)

(a) Legitimate project data, gathered by the orchestrator's own stage — keep, but make it the only path:
- `review-orchestrator/SKILL.md:591-617` "Memory (required)": `keryx memory search ... --status accepted`, scoped to the change, recorded with `query`.
- `src/review/layers.ts:523-526, 602` indexes project memory into `<package>/layers/memory`; `src/review/layers-payload.ts:203-283` puts matches into each reviewer's `layers.memory`; `review-context.schema.json` / `reviewer-input.schema.json` carry `memory`.
- Reviewer skills read the layers block (`review-performance/SKILL.md:349-356` and siblings): `keryx memory search` as a lookup in the project's recorded lessons.

(b) Leakage of the agent's own memory or earlier work — nothing stops these:
- No instruction in any review skill says "do not use your session/auto memory (MEMORY.md, remembered feedback, earlier conversation)". The orchestrator runs in the operator's session, which loads `MEMORY.md` and `CLAUDE.md` memory before the skill starts.
- `prior_findings` / fix rounds (`SKILL.md:129, 191, 588, 688-701`): earlier-round findings enter by design for rounds >= 2 of the same package; a NEW review of the same PR has no rule saying to start from an empty `prior_findings`.
- `src/review/review-notes.ts` and Skill Learning handoff (`SKILL.md:1518-1540`): review output feeds back into `.metaproject/memory/review-notes/`, which a later review can read through the memory stage. This is a path by which an earlier review's conclusions reach a new review as "accepted memory".
- Bundled non-review agents list `memory_search` (`agents/security-auditor.md:16,48`, `go-code-auditor.md:12,42`, `design-advisor.md`, `work-planner.md`): "check for prior accepted findings before re-raising" is instructed there; if dispatched as reviewers they bypass the orchestrator's scoping.
- `layersUsed.memory` (`src/review/layers-usage.ts:9-25, 98`) counts memory calls from logs, but nothing compares them with the allowed set; a memory read outside the orchestrator stage is invisible.

(c) Places where the agent may answer itself instead of consulting instructions or the user:
- `SKILL.md:377, 433, 978` and `SKILL.detail.md:546`: questions exist only for specific forks (start questions, round cap, unlocated producer); there is no general rule "an open question goes to these instructions first, then to the user, never to memory or a guess".
- `SKILL.detail.md:608` "Do not decide this by memory" is a single local rule, not a general one.

## Out of scope

- Changing what the memory stage collects or its `--status accepted` rule.
- The 9-item readiness gate (flow 451).

## Decisions of the operator (poll 179, 2026-10-15)

1. Enforcement: instruction plus a check that blocks `completed` on a memory read outside the stage.
2. `prior_findings` for the same PR: stay automatic. Not changed.
3. review-notes and skill learning: auto-accept stays. Not changed.
4. `memory_search` in reviewer agents: stays as is. Not changed.

Consequence: the audit items about prior findings, review-notes and agent tool lists are recorded as known, accepted paths and are listed in the docs as such. The flow changes only the instruction and the detection.

## Acceptance criteria (draft 2)

- AC1: `SKILL.md` and `SKILL.detail.md` (both copies, byte-identical, under the 1615-line ceiling) carry one "Clean context" section stating: context comes only from the orchestrator's context stages; the agent's session memory, auto-memory index (`MEMORY.md`) and earlier conversation are not inputs; the three accepted paths (`prior_findings`, review-notes, reviewer `memory_search`) are named as the only exceptions. Check: a skill-text test asserts the heading and the required sentences in both copies.
- AC2: Every reviewer skill under `review/` states that its inputs are the reviewer payload only. Check: a test iterates all `review-*/SKILL.md` and fails when the sentence is missing.
- AC3: `keryx review start` records a `cleanContext` block in the package manifest (start time and the memory query of the context stage). Check: unit test on the manifest of a fresh package.
- AC4: Memory reads made by the orchestrator outside its memory stage are detected from the usage log: a read whose query differs from the recorded stage query, or that precedes the stage, and is not a reviewer lookup, is reported as `memory-outside-stage`. It is a tenth item of the readiness checklist: it blocks `completed` and publishing, and only the operator can waive it (`--waive`, terminal, quote). Check: tests with a log that holds an extra orchestrator `keryx memory search` (blocked), a stage-only log (ready), and a reviewer lookup (ready). The first task confirms that the usage log tells orchestrator calls from reviewer calls; if it does not, the log records the caller and the AC stays as written.
- AC5: One general "open question" rule in the skill: look in the orchestrator's instructions; if the answer is not there, ask the user (one `AskUserQuestion` interactively, `STATUS: BLOCKED question` unattended). Never answer from memory or a guess. Check: skill-text test for the rule; one scripted run where an unanswerable question produces the BLOCKED status.
- AC6: Surfaces: `review readiness` (CLI), `review status`, the TUI depth tab, sidebar and `/review readiness` show the new item like the other nine. Check: the existing readiness tests extended to ten items.
- AC7: Docs (`docs/docs/guides/review-with-a-record.md`, `cli-reference.md` where the item list is named) and CHANGELOG describe clean context and the three accepted paths. Check: docs coverage tests stay green.
- AC8: Named limit documented: an agent runtime that loads its memory before the skill starts cannot be prevented by keryx; the guarantee is instruction plus detection (AC4), not isolation; reads of the agent's personal memory outside `keryx memory` are not visible to the log. Check: the sentence is present in the guide and the skill.
- AC9: The default blast-radius limits (40 files, depth 2) and the nine existing readiness items are unchanged. Check: existing readiness and chunk tests stay green without edits.
