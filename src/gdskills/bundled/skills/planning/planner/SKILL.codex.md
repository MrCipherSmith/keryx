---
name: gproject-planner
description: "Generates roadmap, milestones, task breakdown with dependency graph and effort estimates from approved PRD. Use when: dispatched by gproject-orchestrator Phase 6."
triggers:
  - "gproject-planner: generate roadmap"
  - "Dispatched by gproject-orchestrator Phase 6"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
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
