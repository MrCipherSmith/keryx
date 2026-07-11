# Keryx Project Agent Harness Agent Protocol
Version: 0.2.0

## Purpose

Define the deterministic protocol used by the Keryx harness and by
`flow-orchestrator` when implementing this package. The protocol exists to
make a large implementation decomposable, resumable, and safe for subagents.

## Preconditions

1. Read `.metaproject/index.md` and `.metaproject/metaproject.json`.
2. Read this package's `README.md`, `specification.md`, and the relevant phase
   of `implementation-plan.md`.
3. Confirm Task Manager is enabled before using `flow-orchestrator`.
4. Read `.metaproject/data/testing/context.md` before changing or creating
   tests.
5. Read the current health artifact and report baseline failures honestly.
6. Never edit `flow.json` or frozen acceptance criteria manually.
7. Every dispatched worker receives an explicit context block with Task,
   Acceptance Criteria, Context, Files to read, and Constraints.

## Ownership Model

| Concern | Owner |
|---|---|
| Project truth | `.metaproject/` source-of-truth files and generated artifacts |
| Flow state | Task Manager / `keryx flow` service and CLI |
| Harness run state | harness execution services and append-only run artifacts |
| Session events | session store |
| Tool execution | tool runtime |
| Permission decision | policy engine |
| User approval | transport adapter, persisted as an approval event |
| Model interaction | provider adapter |
| Child task status | Task Manager for a managed flow; harness only persists execution evidence |
| Completion | Task Manager consumes one typed harness completion-gate artifact |
| Skill learning | explicit review/learning workflow, never automatic |

## Phase 0: Route

1. Identify whether the request is interactive, headless, a managed flow, a
   review, or a child-agent task.
2. Resolve project root and active `.metaproject/`.
3. Reuse a matching active run/session when the target and fingerprints match.
4. Create a new run id and session id otherwise.
5. Select role, provider, policy profile, and budget without allowing model
   output to override user/project policy.

## Phase 1: Build Project Context

1. Read the manifest and enabled modules.
2. Read orientation, project rules, applicable skills, and active flow docs.
3. Use graph navigation to narrow target files and dependencies.
4. Use compact context artifacts for diff, search, command output, and reads.
5. Add relevant wiki, memory, testing, health, and security evidence only when
   relevant to the task.
6. Run security checks on untrusted external text before prompt inclusion.
7. Write and validate one context manifest with hashes and freshness.
8. Keep raw content out of child dispatches unless explicitly required and
   redacted.

## Phase 2: Plan

For a managed flow, `flow-orchestrator`/Task Manager is the only coordinator:

1. Read frozen acceptance criteria.
2. Build a plan with task kinds `context`, `test`, `implement`, `review`, and
   `docs`.
3. Identify dependencies and independent waves through the Task Manager model.
4. Reserve total model/tool/time budget through the coordinator.
5. Add or transition tasks through Task Manager only. The harness must not
   recreate a plan/execute/verify/review loop or mutate `flow.json`.

For an interactive run:

1. Ask the model to produce a structured plan when the task is non-trivial.
2. Persist the plan and user confirmation when policy requires it.
3. Do not mutate files before the plan/role policy allows mutation.

## Phase 3: Execute a Turn

1. Persist `model_request` before provider invocation.
2. Stream provider events into bounded runtime events.
3. If the response is text only, persist it and evaluate whether a tool action
   or completion gate is required.
4. If the response contains tool calls, validate every call against the tool
   schema before policy evaluation.
5. Resolve policy for every call independently.
6. For `ask`, create an approval event and pause; do not execute optimistically
   unless the explicit policy profile says so.
7. Execute with timeout, cancellation, output limits, and environment/path
   restrictions.
8. Redact tool output before persistence and before returning it to the model
   when security policy requires it.
9. Persist tool result, evidence links, and metrics before requesting the next
   model turn.
10. Detect repeated ineffective calls, budget exhaustion, and context overflow.

## Phase 4: Child-Agent Dispatch

Every child dispatch must include:

```text
## Task
<one bounded objective>

## Acceptance Criteria
- <verifiable criterion>

## Context
<decisions, constraints, project-specific evidence, hashes>

## Files to read
- <absolute project/worktree path>

## Constraints
- no flow.json edits
- no frozen AC edits
- allowed tools and policy
- output schema and artifact path
```

The dispatch must validate against the existing versioned
`subagent-dispatch` schema. The child result must validate against
`subagent-result`; textual `STATUS:` is adapter framing that is normalized into
the canonical durable result before persistence. The harness extension may add
only parent run/session, attempt id/number, branch/context/policy fingerprints,
budget reservation, and durable result artifact fields. It is not a second task
or result source of truth.

### Child Status Handling

- `DONE`: validate artifacts, persist result, mark task done.
- `DONE_WITH_CONCERNS`: persist concerns, decide whether to add a fix task,
  then mark task done only if acceptance criteria are met.
- `NEEDS_CONTEXT`: add only the requested bounded context and retry with the
  same dispatch id and incremented attempt.
- `BLOCKED`: record the factual blocker, block the flow/task, resolve or
  escalate, then resume through Task Manager.
- `FAILED`: retry once if retryable and budget allows; otherwise block or create
  an explicit follow-up task.

No worker may self-accept a parent flow or change parent completion state.

## Phase 5: Review and Verification

1. Run focused tests for changed scope.
2. Run Keryx testing and health services.
3. Run security scans over generated artifacts and changed files.
4. Dispatch review agents with read-only permissions by default.
5. Normalize findings using the existing review-finding contract.
6. Require dispositions and evidence for blockers and majors.
7. Create fix tasks instead of allowing reviewers to silently edit source.

## Phase 6: Completion

For a managed flow, Task Manager may finalize only after consuming a typed
completion-gate artifact. The harness may finalize a standalone run only when:

- acceptance criteria are intact and evidenced;
- required tasks are terminal or explicitly dispositioned;
- tests and health evidence are available or honestly skipped;
- security policy passes or has an explicit approval;
- review coverage is complete;
- blocker/major findings have decisions;
- no approval, retry, or child task remains active;
- output, events, and evidence validate.

The final output must state what was done, what was not done, evidence paths,
model/provider usage, retries, skipped phases, and unresolved risks.

## Resume Protocol

1. Load the run/session manifest and current leaf.
2. Recalculate project, target, context, policy, skill, schema, and model
   fingerprints.
3. Reuse only exact matching completed results.
4. Preserve all prior attempts and events.
5. Create new attempts for stale, partial, invalid, or policy-changed work;
   stale approvals are retained but cannot be consumed.
6. Rebuild context only for the changed scope.
7. Never infer “already done” from a missing artifact.

## Flow-Orchestrator Task Decomposition

The implementation plan is normative for task creation. Task Manager evolution
(dependencies, attempts, disposition states, acceptance/evidence references,
budgets, run/session linkage, and backward-compatible migration) is a
prerequisite before any harness managed-flow integration. Workers must be
dispatched in dependency waves, and every task must reference the frozen ACs
that it satisfies. The implementation plan, not this legacy suggested list,
defines the authoritative waves.

- Wave 1: contracts, baseline tests, module skeleton, current harness move.
- Wave 2: model normalization, event core, tool registry, policy engine.
- Wave 3: session persistence, context builder, evidence and metrics.
- Wave 4: CLI/JSONL transport, single-agent loop, approval/resume.
- Wave 5: flow bridge, roles, child agents, bounded parallel waves.
- Wave 6: completion gates, replay, security hardening, docs and migration.

## Reporting

Every parent run report must include:

- run/session/flow ids;
- project and target fingerprints;
- phase and task statuses;
- selected, reused, skipped, retried, blocked, and failed workers;
- policy decisions and approvals;
- model/provider and token metrics with reliability labels;
- test, health, security, review, and completion evidence;
- artifacts and schema validation status.
