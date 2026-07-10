---
name: gproject-discovery
description: "Collects and structures initial project information from user input, documents, codebase, and web research. Use when: dispatched by gproject-orchestrator Phase 0."
triggers:
  - "gproject-discovery: collect project data"
  - "Dispatched by gproject-orchestrator Phase 0"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---


# gproject-discovery

## Purpose

Gather raw project information from all available sources, structure it into
a unified discovery brief. This is the foundation — every downstream decision
depends on the quality of discovery.

## Iron Laws

| # | Law |
|---|-----|
| 1 | NEVER assume information not explicitly provided or discovered |
| 2 | ALWAYS distinguish facts from assumptions — label each |
| 3 | If a critical area has no data, return NEEDS_CONTEXT — don't fill gaps with guesses |
| 4 | Web research MUST cite sources |
| 5 | Codebase analysis MUST reference actual file paths |
