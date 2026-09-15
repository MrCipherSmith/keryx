---
name: planner
description: >
  Generates roadmap, milestones, task breakdown, and dependency graph from PRD.
  Use when: dispatched by gproject-orchestrator Phase 6.
  NOT for: direct user invocation.
triggers:
  - "create plan"
  - "roadmap"
  - "task breakdown"
metadata:
  version: 1.0.0
  compatible_harnesses: "cursor,codex,zed,opencode"
---

# gproject-planner

## Purpose

Transform approved PRD into an actionable implementation plan with milestones,
task breakdown, dependency ordering, and effort estimates. Output is ready
to feed into job-orchestrator or task-implementer.

## Iron Laws

| # | Law |
|---|-----|
| 1 | Every task MUST trace to a user story in PRD |
| 2 | Dependencies MUST form a DAG — no circular dependencies |
| 3 | Estimates are ranges (optimistic / realistic / pessimistic), never single numbers |
| 4 | P0 user stories MUST be in Milestone 1 |
| 5 | Each milestone MUST be independently deployable / demonstrable |
| 6 | Infrastructure and setup tasks come before feature tasks |

## Red Flags

Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "This task is obviously needed even though no user story asks for it." | Iron Law 1: every task traces to a user story. An untraceable task is either scope the PRD did not agree to, or a story the PRD is missing — both are worth surfacing, and neither is fixed by adding the task quietly. |
| "A single estimate is clearer to read than a three-point range." | Iron Law 3: estimates are ranges. A single number is read as a commitment, and the pessimistic case — the one that decides whether the milestone holds — was never stated. |
| "These two tasks depend on each other, which is just how the work is." | Iron Law 2: dependencies form a DAG. A cycle means the decomposition is wrong, not that the work is circular. Split one task at the boundary where it stops needing the other. |
| "Milestone 1 is already large, so this P0 story can move to Milestone 2." | Iron Law 4: P0 stories are in Milestone 1. If M1 is too large, the split goes elsewhere — deferring a P0 silently redefines what the PRD called essential. |
| "Milestone 2 is a coherent chunk of work, even if it demos nothing on its own." | Iron Law 5: each milestone is independently deployable or demonstrable. A milestone with no demo has no completion signal, and slips are invisible until the next one that does. |
| "Setup is boring — the feature tasks are what matters for the estimate." | Iron Law 6: infrastructure and setup come first, and they are estimated like anything else. Unestimated setup is the most common reason a critical path is wrong from day one. |

---

## Input Contract

```yaml
task: "Generate roadmap and task breakdown"
input_artifacts:
  - .metaproject/jobs/<job>/artifacts/prd.md
  - .metaproject/jobs/<job>/artifacts/architecture.md
decisions_so_far:
  D_level: "..."
  D_frontend: "..."
  D_backend: "..."
  # All relevant decisions
```

## Output Contract

```yaml
status: "DONE" | "NEEDS_CONTEXT"
summary: "<3-5 sentences: milestone count, total tasks, critical path duration>"
new_decisions:
  D_milestones: ["<M1 name>", "<M2 name>", ...]
  D_estimated_duration: "<range>"
  D_critical_path: "<list of blocking tasks>"
artifact_path: ".metaproject/jobs/<job>/artifacts/roadmap.md"
```

---

## Workflow

### Step 1: Decompose User Stories into Tasks

For each user story, break into implementation tasks:

```yaml
- task_id: "T-001"
  title: "<specific task>"
  user_story: "US-001"
  layer: "frontend | backend | database | infra | testing"
  type: "setup | feature | integration | test | docs"
  estimate:
    optimistic: "<time>"
    realistic: "<time>"
    pessimistic: "<time>"
  depends_on: ["T-000"]  # or [] if no deps
  acceptance_criteria:
    - "<from user story, scoped to this task>"
  files_likely_affected:
    - "<file path or module>"
```

### Step 2: Identify Dependencies

Build dependency graph:
- Infrastructure tasks → before all feature tasks
- Database schema → before backend → before frontend
- Auth setup → before any authenticated feature
- Shared components → before pages that use them

Verify: no cycles in dependency graph.

### Step 3: Group into Milestones

Each milestone:
- Has a clear deliverable (demo-able, deployable)
- Contains all P0 stories it covers (no half-done P0 at milestone end)
- Ends with a verification checkpoint

Typical milestone structure:

**M0: Foundation**
- Project setup, tooling, CI/CD, dev environment
- Database schema initial migration
- Auth skeleton
- Deploy pipeline to staging

**M1: Core (P0 features)**
- All P0 user stories
- Core API endpoints
- Core UI flows
- Integration tests for critical paths

**M2: Complete (P1 features)**
- P1 user stories
- Polish, edge cases
- Performance optimization
- Full test coverage

**M3: Launch-Ready (if production level)**
- P2 features (selected)
- Security hardening
- Monitoring, alerting
- Documentation
- Load testing

### Step 4: Estimate Critical Path

Identify the longest dependency chain and estimate total duration.
Flag tasks that block the most other tasks.

### Step 5: Write Roadmap

Write `artifacts/roadmap.md`:

```markdown
# Roadmap: <Project/Task Name>

## Overview
- **Milestones**: <count>
- **Total tasks**: <count>
- **Estimated duration**: <optimistic> — <realistic> — <pessimistic>
- **Critical path**: <list of blocking tasks>

## Milestone 0: Foundation
**Deliverable**: <what can be demonstrated>
**Duration estimate**: <range>

### Tasks
| ID | Title | Layer | Depends On | Estimate | Story |
|----|-------|-------|-----------|----------|-------|
| T-001 | <title> | infra | — | <range> | — |
| T-002 | <title> | database | T-001 | <range> | — |

## Milestone 1: Core
**Deliverable**: <what can be demonstrated>
**Duration estimate**: <range>

### Tasks
| ID | Title | Layer | Depends On | Estimate | Story |
|----|-------|-------|-----------|----------|-------|
| T-010 | <title> | backend | T-002 | <range> | US-001 |

## ...

## Dependency Graph (summary)
<textual description of key dependency chains>
T-001 → T-002 → T-010 → T-015 (critical path)
T-001 → T-003 → T-011 (parallel track)

## Risk-Adjusted Timeline
| Scenario | Duration | Assumptions |
|----------|---------|-------------|
| Optimistic | <time> | No blockers, all estimates hold |
| Realistic | <time> | Normal friction, 1-2 minor blockers |
| Pessimistic | <time> | Major unknowns surface, rework needed |

## Parallelization Opportunities
<Which tasks can run simultaneously — useful for team or multi-agent execution>

## Integration with job-orchestrator
<How to feed this roadmap into job-orchestrator for automated implementation>
- Each milestone maps to a job-orchestrator run
- Tasks within a milestone map to issue-analyzer output format
- Dependency order maps to wave-based execution
```

### Step 6: Return Summary

Compact summary: milestone count, task count, critical path duration,
biggest scheduling risk.
