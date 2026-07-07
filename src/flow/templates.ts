export function renderDescription(title: string, source: string): string {
  return `# ${title}

Status: draft (flow-init skill formalizes this)
Source: ${source}

## Problem

Describe the problem precisely: what is broken/missing, for whom, and why now.

## Expected Outcome

What must be true when this flow is done.

## Out of Scope

Explicitly excluded work.
`;
}

export function renderPlan(): string {
  return `# Implementation Plan

Status: draft (flow-init skill fills this after context and brainstorm)

## Approach

Chosen approach and why (link brainstorm alternatives if any).

## Steps

1. ...

## Risks

- ...
`;
}

export function renderTasksDoc(): string {
  return `# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via \`gd-metapro flow task done <id> <taskId>\`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
`;
}

export function renderAcceptanceCriteria(): string {
  return `# Acceptance Criteria

Rules:

- Criteria lines use the exact format \`- ACn: <criterion>\`.
- After \`flow freeze\` this file is checksum-protected: any edit outside
  \`gd-metapro flow ac update\` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  \`gd-metapro flow ac confirm <id> <ACn>\`.

## Criteria

- AC1: <replace with a hard, verifiable criterion before freeze>
`;
}

export function renderJournal(createdAt: string): string {
  return `# Flow Journal

- ${createdAt} - flow created
`;
}

export function renderFlowsReadme(): string {
  return `# Flows

Each directory is one flow: \`<NNN>-<YYYY-MM-DD>-<slug>/\`.

A flow is a story's journey from initialization to completion, managed by the
Task Manager module (\`gd-metapro flow ...\`). flow.json is CLI-owned state -
do not edit it by hand. Acceptance criteria are checksum-frozen after
\`flow freeze\`.

Statuses: initializing -> ready -> in-progress -> implemented -> completing ->
done (+ blocked). See \`.metaproject/skills/flow/SKILL.md\`.
`;
}

export function renderTasksManifest(): string {
  return `# tasks (Task Manager)

Version: 0.1.0

## Purpose

Agent-first flow lifecycle: initialization with frozen acceptance criteria,
strict status state machine, draft-PR completion gates, and tracker reporting.

## Commands

- \`gd-metapro flow init (--issue <url> | --title "<t>")\`
- \`gd-metapro flow list | status <id>\`
- \`gd-metapro flow freeze <id>\` / \`flow start <id>\`
- \`gd-metapro flow task add|done ...\`
- \`gd-metapro flow ac confirm|update ...\`
- \`gd-metapro flow implemented <id> --pr <url>\`
- \`gd-metapro flow complete <id> [--comment]\`
- \`gd-metapro flow block|unblock <id>\` / \`flow check\`

## Entry

- \`flows/\` (flow packages)
- \`skills/flow/SKILL.md\`
`;
}

export function renderFlowSkillRouter(): string {
  return `---
name: flow
description: Use for managed work items (flows) - initializing a story, tracking implementation status, and completing with gates. All flow state changes go through gd-metapro flow CLI; never edit flow.json or frozen acceptance criteria by hand.
---

# flow Skill (router)

A flow is a story from initialization to completion. Pick the role:

- Starting new work (a problem description or an issue link): read
  [init.md](init.md) - flow-init.
- Orchestrating/implementing an active flow: read [manage.md](manage.md) -
  flow-manager (embeds into the orchestrator).
- Finishing a flow whose draft PR exists: read [complete.md](complete.md) -
  flow-complete.

## Hard policy (all roles)

- flow.json is CLI-owned. Never edit it by hand.
- Acceptance criteria are frozen after \`flow freeze\`; edits only via
  \`gd-metapro flow ac update <id> --reason\`. Implementors NEVER touch them.
- Status changes only through the CLI; invalid transitions are rejected.
- Only flow-manager declares implementation complete (\`flow implemented\`),
  and only when a draft PR exists.
`;
}

export function renderFlowInitSkill(): string {
  return `# flow-init Skill

Initialize a flow from a problem description or a GitHub issue URL.

## Workflow

1. \`gd-metapro flow init --issue <url>\` or \`--title "<problem>"\`. The CLI
   creates the package and collects deterministic context into context.md
   (issue body, memory search, gdgraph artifacts, health status).
2. Enrich context: use gdgraph (structure/affected), gdctx (compact reads),
   memory search (accepted decisions/constraints), wiki (domain knowledge).
   Append findings to context.md.
3. Formalize description.md: problem, expected outcome, out of scope.
4. Brainstorm approaches (2-3 options, trade-offs); pick one into plan.md.
5. If requirements are ambiguous, interview the user: focused questions with
   options and a recommendation. Do not guess hard requirements.
6. Break work into tasks: \`gd-metapro flow task add <id> --title ... --kind
   context|implement|test|review|docs\` (defaults T1-T4 already exist; adjust).
7. Write acceptance-criteria.md: hard, verifiable \`- ACn:\` criteria.
8. Re-verify the whole package, then freeze and hand off:
   \`gd-metapro flow freeze <id>\` -> \`gd-metapro flow start <id>\`.

The implementor/orchestrator now works the plan. It must not modify acceptance
criteria or flow state directly.
`;
}

export function renderFlowManageSkill(): string {
  return `# flow-manager Skill

Embedded into the orchestrator for an active flow. Sole authority over flow
data and status.

## Workflow

1. Track progress: \`gd-metapro flow task done <id> <taskId>\` as tasks finish;
   add discovered tasks with \`flow task add\`.
2. Keep description.md/journal current (append notes; never edit flow.json).
3. If genuinely stuck: \`gd-metapro flow block <id> --reason\`; resume with
   \`flow unblock <id>\`.
4. Acceptance criteria change ONLY when requirements truly changed:
   \`gd-metapro flow ac update <id> --reason "<why>"\` (logged; audit trail).
5. Completion decision is yours alone: when the implementor has finished and a
   **draft PR exists in the author's name**, run
   \`gd-metapro flow implemented <id> --pr <url>\`.
   Never accept work without a draft PR; never let the implementor self-accept.
6. Hand off to flow-complete (complete.md).
`;
}

export function renderFlowCompleteSkill(): string {
  return `# flow-complete Skill

Finish a flow whose status is \`implemented\`.

## Workflow

1. Re-verify the package: description matches the result; plan followed or
   deviations journaled; all tasks done.
2. Confirm every acceptance criterion after actually checking it:
   \`gd-metapro flow ac confirm <id> ACn --note "<evidence>"\`.
3. Run \`gd-metapro flow complete <id>\`. Gates: AC confirmed + checksum intact;
   draft PR exists with green checks; code-health gate passes.
4. Gates fail -> flow auto-returns to in-progress with fix notes:
   - small fixes: run a fix agent, then re-run from step 2;
   - large fixes: describe what is wrong in the journal and relaunch the
     implementor/orchestrator against the updated plan.
5. Gates pass -> flow is done:
   - source was an issue: \`gd-metapro flow complete <id> --comment\` posts a
     short, factual summary comment to the issue;
   - no issue: ask the user whether to create a ticket for the record.
`;
}
