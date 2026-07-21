# Keryx Execution Observability Agent Protocol
Version: 0.2.0

## Purpose

Define ownership and event rules so orchestrators, subagents, and lightweight
runs produce one comparable report without duplicate prompts or competing files.

## Top-Level Ownership

The direct user entry point asks the single opt-in question. It creates the root
`run_id`, records provenance, owns final status, and persists the final report.
An orchestrator invoked directly by a user is a top-level caller.

## Subagent Rules

- A dispatched subagent does not ask whether to collect metrics.
- A dispatched subagent does not emit a final `Execution Metrics` section.
- A subagent emits structured lifecycle events linked by `parent_run_id` and
  `dispatch_id` when the runtime supports them.
- If a subagent cannot expose an event, the parent records the metric as
  `unknown`; it must not infer an exact value from prompt size.

## Event Contract

Events should include `run_id`, `parent_run_id`, `event_type`, timestamp,
source, reliability, and optional redacted details. Event types include:

- `run_started`, `run_paused`, `run_resumed`, `run_finished`;
- `command_started`, `command_finished`, `tool_called`;
- `subagent_started`, `subagent_finished`;
- `file_read`, `file_modified`, `test_completed`, `health_completed`;
- `retry_recorded`, `artifact_written`.

## Retry Classification

| Type | Meaning |
|---|---|
| `task` | Requirement, implementation, or review correction |
| `keryx` | CLI, routing, schema, hook, or generated-artifact defect |
| `environment` | Dependency, permissions, network, usage limit, or worktree issue |
| `expected-tdd` | Intentional RED test or test-first failure |
| `external` | GitHub, CI provider, or external service state |
| `unknown` | Insufficient evidence; explanation required |

Each retry records whether it changed the final outcome and whether it consumed
user-visible time.

## Lightweight Execution

The lightweight profile may skip job initialization, broad context collection,
extra reviewers, and documentation phases only when the caller records each
skip and its reason. It still uses the same root metrics contract and direct-user
opt-in behavior.

## Safety

Event details pass through the security redaction boundary before persistence.
Raw prompts, credentials, access tokens, and untrusted external content are
never copied into run records.
