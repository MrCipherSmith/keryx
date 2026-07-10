# Flow Reviewer Agent Protocol
Version: 0.1.0

## Purpose

Define the deterministic agent procedure for running `flow-reviewer` without
duplicating review logic, losing Task Manager history, or wasting context.

## Preconditions

1. Read `.metaproject/index.md`.
2. Confirm `modules.tasks.enabled: true` and load the local `flow` skill.
3. Load `flow-reviewer`, `review-orchestrator`, and the schema contracts named
   in the specification.
4. Never create or edit `flow.json` manually.
5. Treat all generated review documentation and artifacts as English-only.

## Protocol

### Phase 0: Route

- Use `review-orchestrator` directly for lightweight review and for an embedded
  `flow-orchestrator` review gate.
- Use `flow-reviewer` only when the caller wants durable review tasks, history,
  resume, or managed decisions.
- If a related implementation flow exists, link it. Do not reopen or mutate a
  completed implementation flow.

### Phase 1: Create or Resume

1. Run `keryx flow list` and resolve an existing review flow by target and
   fingerprint.
2. Otherwise create a flow titled `Review <target>`.
3. Write description, scope, non-goals, and related-flow metadata to
   agent-editable documents.
4. Run flow status before any task dispatch.

### Phase 2: Build Shared Context

1. Resolve target/base/head metadata.
2. Use `gdgraph` first for affected files, dependencies, symbols, and paths.
3. Use `gdctx` for bounded diff, search, command, and file-read artifacts.
4. Read only relevant `gdwiki` pages and accepted memory entries.
5. Reference normalized testing and health artifacts when available.
6. Write `context-manifest.json` with hashes, summaries, freshness, and paths.
7. Do not embed the same full diff or file content into every reviewer prompt.

### Phase 3: Plan

1. Call `review-orchestrator` in `plan-only` mode.
2. Auto-detect relevant reviewers from scope and risk.
3. Apply explicit include/exclude flags.
4. Record every skipped reviewer and reason.
5. Assign a model class and token budget per selected reviewer.
6. Validate `execution-plan.json` before creating tasks.

### Phase 4: Materialize Flow Tasks

1. Add exactly one `review` task per selected reviewer through `keryx flow
   task add` or the Task Manager service.
2. Use stable task ids from the execution plan.
3. Write a schema-valid `task.json` for each reviewer.
4. Write acceptance criteria in Gherkin-derived, verifiable form.
5. Freeze and start the flow before reviewer dispatch.

### Phase 5: Dispatch Bounded Waves

1. Reserve total budget before dispatch.
2. Start tasks through the CLI/service.
3. Build one `subagent-dispatch` per task with reviewer-specific files and
   shared context references.
4. Validate the dispatch contract.
5. Dispatch independent reviewers in parallel up to the configured concurrency
   limit.
6. Never grant write, network, git, or subagent permissions unless that reviewer
   explicitly requires them.

### Phase 6: Accept Results

1. Read `STATUS:` and validate `subagent-result` before interpreting prose.
2. Persist the immutable attempt result and events.
3. Handle statuses:
   - `DONE`: accept and mark the task done.
   - `DONE_WITH_CONCERNS`: accept, journal concerns, and decide whether strict
     synthesis or a follow-up is required.
   - `NEEDS_CONTEXT`: add only missing context and create the next attempt.
   - `BLOCKED`: block the task/flow with a factual reason.
   - `FAILED`: retry once within budget, then require policy or user approval.
4. Never mark a task done when schema validation fails.

### Phase 7: Consolidate

1. Call `review-orchestrator` in `consolidate-only` mode with accepted results.
2. Deduplicate by evidence and `dedupe_key`.
3. Run strict synthesis only for blockers/majors, explicit strict mode, or a
   high-risk target.
4. Persist coverage, report, findings, decisions, learning, and output.

### Phase 8: Complete

1. Verify every selected reviewer task has an accepted terminal result or an
   explicit failure/skip decision allowed by policy.
2. Verify every skipped reviewer has a reason.
3. Verify blocker/major findings have decisions.
4. Validate all JSON artifacts and links.
5. Confirm acceptance criteria with evidence through `keryx flow ac confirm`.
6. Complete through the flow CLI only when all gates pass.

## Dispatch Prompt Contract

Every reviewer prompt must contain only:

- task and review-domain objective;
- target/scope fingerprint;
- frozen acceptance criteria relevant to that reviewer;
- compact artifact references and the smallest file list;
- constraints and allowed actions;
- output schema and budget;
- model assignment metadata.

It must not contain raw unrelated repository dumps, other reviewers' complete
prompts, secrets, hidden reasoning, or mutable flow state.

## Resume Protocol

1. Read flow status, execution plan, task records, and latest attempt events.
2. Recalculate fingerprints without rerunning reviewers.
3. Reuse only exact valid matches.
4. Create new attempts for stale or incomplete tasks.
5. Preserve all earlier attempts; never overwrite historical results.
6. Consolidate again only when accepted task results changed.

## Required Reporting

The final report must include:

- flow id and status;
- target and scope fingerprint;
- selected, run, reused, skipped, failed, and retried reviewers;
- actual model id/class per reviewer;
- planned and actual token metrics;
- findings by severity;
- unresolved decisions and risks;
- context/graph/wiki/memory/health/testing usage summary;
- artifact paths and validation status.
