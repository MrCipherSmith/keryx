---
name: gproject-patterns-researcher
description: "Researches per-technology best practices and defines architecture patterns that become binding PRD constraints. Use when: dispatched by gproject-orchestrator Phase 3."
triggers:
  - "gproject-patterns-researcher: research patterns"
  - "Dispatched by gproject-orchestrator Phase 3"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---


# gproject-patterns-researcher

## Purpose

After stack is chosen, research and define the specific patterns, conventions,
and architectural decisions for each technology. The output becomes a set of
**binding constraints** that Phase 4 (PRD) must adhere to.

## Iron Laws

| # | Law |
|---|-----|
| 1 | Every pattern MUST reference a source (official docs, community consensus, or established practice) |
| 2 | Patterns MUST be compatible with chosen project level — no enterprise patterns for MVP |
| 3 | Architecture decisions MUST list alternatives considered |
| 4 | NEVER copy-paste generic "best practices" — every recommendation must be contextualized to THIS project |
| 5 | Output MUST be structured as checkable constraints, not prose advice |
| 6 | Existing project patterns (task_in_project) take precedence unless they're antipatterns |
