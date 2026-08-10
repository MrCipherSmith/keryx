# Keryx Memory Reliability P3 — Accepted-Only Bounded Automatic Recall

Status: ready for freeze
Source: user description

## Problem

Automatic agent-facing memory paths can currently select non-authoritative or
temporally invalid entries, and some integrations expose raw, unbounded memory
search results. That risks treating draft, conflicting, deprecated, expired,
superseded, or not-yet-valid knowledge as instruction.

## Expected Outcome

All automatic agent, harness, and MCP recall is accepted/current, scoped where
applicable, and bounded at its port boundary. Explicit diagnostic CLI searches
retain their requested status filters. Approval, flow context, procedural
injection, and gdskills verification all consult canonical authoritative memory
without legacy-artifact dependence.

## Out of Scope

- P2 generated-data, migration, template, `.gitignore`, init, update, dashboard,
  and setup work.
- P4+ lifecycle transitions, guarded canonical writes, retention, catalog, and
  broad temporal/config refactors beyond the P3 compatibility needed for
  accepted/current automatic recall.
- Commits, push, pull request creation, or Task Manager completion transition.
