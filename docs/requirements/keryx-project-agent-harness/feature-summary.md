# Feature Summary
Version: 1.0.0

## Purpose

The Keryx Project Agent Harness is an opt-in, provider-neutral runtime that
lets a model operate on a project through controlled tools while keeping the
project brain local, durable, auditable, and reproducible.

## Runtime flow

1. The user starts a run for a project.
2. Keryx resolves the project root and reads `.metaproject`.
3. Context providers assemble a bounded manifest from rules, active flow,
   graph, wiki, memory, testing, health, and security evidence.
4. The model communicates through a provider port and registered tools.
5. Each tool call is evaluated as `allow`, `ask`, or `deny` by the policy port.
6. Events, attempts, policy decisions, tool results, and evidence are written
   to append-only local session records.
7. Completion is accepted only when required evidence and blocking gates pass.
8. Resume and replay reconstruct state without duplicating accepted events or
   executing live side effects.

## Project and Metaproject integration

- `.metaproject/` remains the durable project brain and source of project
  orientation, knowledge, rules, testing, health, and security evidence.
- Existing Keryx services are consumed through adapters; the harness does not
  replace graph, wiki, memory, testing, health, security, or flow ownership.
- Task Manager/`flow-orchestrator` remains the sole owner of managed-flow task
  state, retries, review/fix lifecycle, and completion.
- The harness provides execution primitives and typed evidence/gate artifacts;
  it does not edit `flow.json` or create a second managed coordinator.
- With `harness.enabled=false`, no provider is loaded and the deterministic
  Keryx floor remains unchanged.

## User interaction

The user supplies the objective and selects an allowed role/profile. The user
can observe progress, evidence, policy outcomes, failures, and completion
status; approve or reject actions that require confirmation; stop a run; and
resume or replay a prior run. Unsafe, unavailable, or incomplete operations
produce typed blocked/denied results rather than hidden effects.

## Release 0 boundary

Release 0 contains only the offline fake-provider/read-only vertical slice.
Production providers, mutation, unrestricted shell, network tools, child
agents, parallel execution, extensions, provider-side session storage, and TUI
are later-release capabilities with separate security and evidence gates.
