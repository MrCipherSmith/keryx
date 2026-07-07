---
name: gproject-problem-definer
description: "Defines core problems, SMART goals, non-goals, and success metrics from discovery data. Use when: dispatched by gproject-orchestrator Phase 1."
triggers:
  - "gproject-problem-definer: define problems and goals"
  - "Dispatched by gproject-orchestrator Phase 1"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---


# gproject-problem-definer

## Purpose

Transform raw discovery data into a crisp problem statement with measurable goals.
This phase answers: "Why are we doing this?" and "How will we know we succeeded?"

## Iron Laws

| # | Law |
|---|-----|
| 1 | Every goal MUST have a measurable success metric |
| 2 | Non-goals are as important as goals — list at least 3 |
| 3 | Problems MUST be stated from the USER's perspective, not technical |
| 4 | NEVER introduce solutions in the problem statement |
| 5 | If discovery brief has low confidence areas, flag them — don't paper over |
