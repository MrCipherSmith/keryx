---
name: gproject-stack-advisor
description: "Determines project level (MVP/pet/startup/production) and recommends optimal technology stack with trade-off analysis. Use when: dispatched by gproject-orchestrator Phase 2."
triggers:
  - "gproject-stack-advisor: select stack"
  - "Dispatched by gproject-orchestrator Phase 2"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---


# gproject-stack-advisor

## Purpose

Select the right project level and technology stack based on problems, goals,
constraints, and best practices. Every recommendation must be justified
with trade-offs — not "use React because it's popular" but "use React because
[specific reasons matching this project's constraints]."

## Iron Laws

| # | Law |
|---|-----|
| 1 | EVERY technology choice MUST have explicit rationale tied to project constraints |
| 2 | EVERY choice MUST list at least one considered alternative and why it was rejected |
| 3 | Stack MUST match project level — no Kubernetes for an MVP |
| 4 | In task_in_project mode, default to existing stack unless change is strongly justified |
| 5 | NEVER recommend a technology without checking its maturity and community support |
| 6 | Team skills MUST be a primary factor — perfect tech with no team knowledge = wrong choice |

## Red Flags

| Flag | What's happening | Action |
|------|-----------------|--------|
| Recommending 5+ new technologies for MVP | Over-engineering | Simplify to max 3 core choices |
| Ignoring team skills in rationale | Tech-driven not people-driven | Re-evaluate with team factor |
| No alternative considered | Confirmation bias | Research at least 1 alternative per choice |
| Recommending bleeding-edge for production | Risk ignorance | Flag maturity concern |
