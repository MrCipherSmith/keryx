# External agents: one-step enable and short agent names

Status: draft

Source: operator request (operator chat channel, 2026-09-30): "how do I phrase a question so keryx shell starts a subagent on Claude? Make it as simple as possible."

## Problem

Reaching Claude CLI from keryx shell takes the exact id `claude-cli`; `claude` is refused as an unknown agent. A project that has not opted in refuses with "run `keryx init --external-agents`", but that command rewrites many unrelated tracked files (measured in the keryx repo: 8 files, +661/-3355 lines, plus git hooks), and the user-global `externalAgents.enabled` switch has no command at all, only a hand edit of the user config.

## Expected Outcome

- `keryx agents external enable` turns the capability on for this machine and this project, touching nothing else. `disable` turns it off.
- `claude`, `codex`, `agy` work wherever an external agent id is typed: `/delegate`, `keryx agents external ...`, and a model-issued `spawn_subagent` runtime block.
- Every refusal names `keryx agents external enable` as the fix.

## Outcome criteria

- not measured — a usability fix; verified by the acceptance criteria and a live `/delegate claude ...` run.

## Out of Scope

- Changing `keryx init --external-agents`.
- The security gates (remote transport, CI hard disable, consent, spawnDecision, per-agent `enabled`). Aliases must never bypass a per-agent setting keyed by the canonical id.
- Write mode, new agents, Gemini.
