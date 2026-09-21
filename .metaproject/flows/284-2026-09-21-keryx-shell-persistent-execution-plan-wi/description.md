# Keryx Shell persistent execution plan with agent-followed sidebar progress

Status: ready for implementation
Source: user description

## Problem

When an interactive Keryx Shell agent writes a multi-step plan, that plan exists
only as prose in the transcript. Keryx cannot render it as durable state, restore
it with the session, tell which step is active, or prevent the agent from
declaring completion while planned work remains. Background Jobs track
subprocesses and Flow tasks track project lifecycle work, but neither currently
provides a lightweight session plan owned by the interactive agent.

## Expected Outcome

- The main interactive agent can create, inspect, replace and update a typed
  execution plan through dedicated tools without parsing assistant prose.
- The plan is stored with the session and restored on resume.
- Every subsequent agent round receives a compact current-plan snapshot, and a
  completion guard gives the agent another chance when it tries to stop with
  open plan items.
- The OpenTUI sidebar shows a compact Plan panel immediately above Background
  Jobs, with at most seven items and the active item centered when possible.
- The existing `/plan` read-only permission mode remains compatible and keeps
  its current meaning.

## Out of Scope

- Replacing Task Manager Flow packages or their completion gates.
- Inferring plan progress from natural-language replies or shell commands.
- Automatically mapping supervised shell tasks one-to-one onto logical steps.
- Making subagents co-own the main session plan.
- Redesigning the full sidebar or Background Jobs inspector.
