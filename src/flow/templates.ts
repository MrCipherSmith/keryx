import { DEFAULT_TASKS } from "./default-tasks";

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

/**
 * The `tasks.md` that ships in a fresh flow package.
 *
 * The table is rendered FROM {@link DEFAULT_TASKS} rather than typed out
 * beside it. Hand-maintained, the two drifted: `flow.json` carried
 * `T4 Self-review and prepare draft PR` while this table claimed
 * `T4 Review, fix findings, and prepare PR`, so every package documented a
 * task it did not contain. One list means the document cannot disagree with
 * the state again — and `flow init`'s scaffold being "exactly the documented
 * set" is the claim `default-tasks.test.ts` pins (flow 211, AC9).
 */
export function renderTasksDoc(): string {
  const rows = DEFAULT_TASKS.map((task) => `| ${task.id} | ${task.kind} | ${task.title} |`).join("\n");
  return `# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via \`keryx flow task done <id> <taskId>\`.

These four are created by \`keryx flow init\` as a default checklist. Add your
own with \`keryx flow task add\`; a scaffold row your plan supersedes is closed
with \`--disposition skipped --reason "<why>"\`, not left open.

| ID | Kind | Title |
|----|------|-------|
${rows}
`;
}

export function renderAcceptanceCriteria(): string {
  return `# Acceptance Criteria

Rules:

- Criteria lines use the exact format \`- ACn: <criterion>\`.
- After \`flow freeze\` this file is checksum-protected: any edit outside
  \`keryx flow ac update\` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  \`keryx flow ac confirm <id> <ACn>\`.

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
Task Manager module (\`keryx flow ...\`). flow.json is CLI-owned state -
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
strict status state machine, reviewed-and-merged PR completion gates, and
tracker reporting.

## Commands

- \`keryx flow init (--issue <url> | --title "<t>")\`
- \`keryx flow list | status <id>\`
- \`keryx flow freeze <id>\` / \`flow start <id>\`
- \`keryx flow task add|done ...\`
- \`keryx flow ac confirm|update ...\`
- \`keryx flow implemented <id> --pr <url>\`
- \`keryx flow complete <id> [--comment]\`
- \`keryx flow block|unblock <id>\` / \`flow check\`

## Entry

- \`flows/\` (flow packages)
- \`skills/flow/SKILL.md\`
`;
}

export function renderFlowSkillRouter(): string {
  return `---
name: flow
description: Use whenever the user asks to start, create, track, or finish a managed piece of work - "создай фло", "заведи флоу из этой ишью", "create a flow", "start a story", "какой статус по фло", "заверши фло/стори", or pastes an issue link asking to work on it. All flow state changes go through the keryx flow CLI; never edit flow.json or frozen acceptance criteria by hand.
---

# flow Skill (router)

A flow is a story from initialization to completion. The user does NOT need to
know CLI commands - recognize the intent and route it yourself.

## Trigger Examples -> Intent

| User says (RU/EN) | Intent | Do |
|---|---|---|
| "Создай фло: <описание проблемы>" / "create a flow for ..." | init from description | \`keryx flow init --title "<формализованный заголовок>"\`, then follow [init.md](init.md) |
| "Создай фло на основании <issue URL>" / "make a flow from this issue" / вставил issue-ссылку + "сделай" | init from issue | \`keryx flow init --issue <url>\`, then [init.md](init.md) |
| "Заведи стори / инициализируй задачу / start a story" | init | ask for a problem description or issue link if missing, then init |
| "Какие фло активны? / статус по фло / where are we on 003" | status | \`keryx flow list\` / \`flow status <id>\` |
| "Отметь задачу T2 / добавь задачу в фло" | manage | [manage.md](manage.md): \`flow task done/add\` |
| "Создай PR и доведи до merge" | create and merge | [manage.md](manage.md): review/fix, merge into base, then \`flow implemented --pr <url>\` |
| "Заверши фло / закрой стори / finish the flow" | complete | [complete.md](complete.md): confirm ACs, \`flow complete\` |
| "Фло застрял / поставь на паузу" | block | \`flow block <id> --reason\` / \`flow unblock\` |

Ambiguous ("сделай эту фичу" without flow context): if the work is
non-trivial and multi-step, propose starting a flow; for one-liners just do
the work.

## Roles

- Starting new work: [init.md](init.md) - flow-init.
- Orchestrating/implementing an active flow: [manage.md](manage.md) -
  flow-manager (embeds into the orchestrator).
- Finishing a flow whose reviewed PR has merged: [complete.md](complete.md) -
  flow-complete.

## Hard policy (all roles)

- flow.json is CLI-owned. Never edit it by hand.
- Acceptance criteria are frozen after \`flow freeze\`; edits only via
  \`keryx flow ac update <id> --reason\`. Implementors NEVER touch them.
- Status changes only through the CLI; invalid transitions are rejected.
- Only flow-manager declares implementation complete (\`flow implemented\`),
  and only after a reviewed PR has merged into the recorded base branch.
`;
}

export function renderFlowInitSkill(): string {
  return `# flow-init Skill (initialization orchestrator)

Initialize a flow from a problem description or a GitHub issue URL. Runs as
Phase 1 of the gdskills \`flow-orchestrator\`, or standalone. Non-trivial
initialization is decomposed by dispatching gdskills workers; trivial flows can
be filled inline.

## Worker communication (schema-governed)

Workers inherit no session state - construct each dispatch explicitly
(\`.metaproject/rules/core/subagent-context-construction.md\`). Every dispatch is
a \`subagent-dispatch\` object
(\`.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json\`) and every
worker reply is a \`subagent-result\`
(\`.metaproject/core/gdskills/contracts/subagent-result.schema.json\`) whose first
line is \`STATUS:\` (\`.metaproject/rules/core/subagent-status-protocol.md\`). Set
\`run_id\` to the flow id and \`dispatch_id\` to \`<flow-id>-<step>\`.

## Workflow

1. Create the package: \`keryx flow init --issue <url>\` or
   \`--title "<problem>"\`. The CLI scaffolds the package and collects
   deterministic context (issue body, memory search, gdgraph artifacts, health).
2. Enrich context - dispatch \`context-collector\` with \`context_refs\` to the
   flow package; it writes compact findings, not raw dumps. For an issue also
   dispatch \`issue-analyzer\`; for a described feature, \`feature-analyzer\`.
   Fold each \`subagent-result\` into context.md.
3. Formalize description.md: problem, expected outcome, out of scope.
4. Brainstorm approaches - dispatch \`brainstorm\` (2-3 options, trade-offs);
   record the chosen approach and rejected alternatives in plan.md.
5. If hard requirements are ambiguous, dispatch \`interviewer\`: focused
   questions with options and a recommendation. Do not guess hard requirements.
6. Break work into tasks: \`keryx flow task add <id> --title ... --kind
   context|implement|test|review|docs\`. The four \`origin: "scaffold"\` rows
   T1-T4 already exist as a default checklist — work them, or close the ones
   your plan supersedes with
   \`keryx flow task done <id> <Tn> --disposition skipped --reason "<why>"\`.
   Nothing closes them on a timer; leaving them open blocks \`flow complete\`.
7. Write acceptance-criteria.md: hard, verifiable \`- ACn:\` criteria grounded in
   the collected evidence.
8. Re-verify the whole package, then freeze and hand off:
   \`keryx flow freeze <id>\` -> \`keryx flow start <id>\`.

Read each worker's \`STATUS:\` first: \`NEEDS_CONTEXT\`/\`BLOCKED\` -> enrich and
re-dispatch (do not mark done); \`DONE\`/\`DONE_WITH_CONCERNS\` -> fold the result
in and journal any concerns. After freeze, the implementor works the plan and
must not modify acceptance criteria or flow state directly.
`;
}

export function renderFlowManageSkill(): string {
  return `# flow-manager Skill

Embedded into the orchestrator for an active flow. Sole authority over flow
data and status.

## Workflow

1. Track progress: \`keryx flow task done <id> <taskId>\` as tasks finish;
   add discovered tasks with \`flow task add\`. Accept worker results by their
   \`subagent-result\` \`STATUS:\` line (\`subagent-status-protocol.md\`), never by
   prose - only \`DONE\`/\`DONE_WITH_CONCERNS\` may close a task.
2. Keep description.md/journal current (append notes; never edit flow.json).
3. If genuinely stuck: \`keryx flow block <id> --reason\`; resume with
   \`flow unblock <id>\`.
4. Acceptance criteria change ONLY when requirements truly changed:
   \`keryx flow ac update <id> --reason "<why>"\` (logged; audit trail).
5. Completion decision is yours alone: after the user selects the PR path,
   create the PR, run the bounded review/fix loop, and merge it only after the
   review is clean and required checks are green. The merge target must be the
   base branch captured when the flow branch was created. Only after verifying
   that merge may you run \`keryx flow implemented <id> --pr <url>\`.
   Never accept work without a PR and confirmed merge; never let the
   implementor self-accept.
6. Hand off to flow-complete (complete.md).

Completion is strictly PR-and-merge-gated - there is **no bypass**. Work that
shipped straight to the default branch (direct commits, no PR) **cannot** be
completed through the flow. A PR that exists but has not been merged also
cannot be completed. A flow whose implementation already merged without a PR
stays open by design; record it as a legacy exception in journal.md rather than
forcing a status change.
`;
}

export function renderFlowCompleteSkill(): string {
  return `# flow-complete Skill

Finish a flow whose PR has passed review, been merged into the base branch, and
whose status is \`implemented\`.

## Workflow

1. Re-verify the package: description matches the result; plan followed or
   deviations journaled; all tasks done.
2. Confirm every acceptance criterion after actually checking it:
   \`keryx flow ac confirm <id> ACn --note "<evidence>"\`.
3. Verify that the PR was merged into the base branch recorded for the flow,
   then run \`keryx flow complete <id>\`. Gates: AC confirmed + checksum intact;
   merged PR exists with green checks; code-health gate passes.
4. Gates fail -> flow auto-returns to in-progress with fix notes:
   - small fixes: run a fix agent, then re-run the review/fix loop from step 2;
   - large fixes: describe what is wrong in the journal and relaunch the
     implementor/orchestrator against the updated plan.
5. Gates pass -> flow is done:
   - source was an issue: \`keryx flow complete <id> --comment\` posts a
     short, factual summary comment to the issue;
   - no issue: ask the user whether to create a ticket for the record.
`;
}
