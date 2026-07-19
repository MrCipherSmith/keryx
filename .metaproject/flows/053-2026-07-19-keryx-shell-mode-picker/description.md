# Flow 053 — shell mode picker (agent default)

## Problem
Agent mode was only reachable via the `--agent` flag; bare `keryx` (interactive
picker) always launched CHAT mode, which has no tools/metaproject. The user hit
this: generic hallucinated answers in the picker-launched session vs. correct
tool-aware answers under `--agent`. Fix: default to agent, and let the picker
choose agent/chat explicitly. Also make the header mode label explicit.

## Approach
- `pickAgentMode(io)` in select.ts (testable, agent-default), mirroring
  `pickProviderModel`'s injected-IO contract.
- `shellCommand`: add `--chat`; resolve mode precedence flag > picker > default
  agent. Offer the mode step only in the interactive (no `--provider`) path and
  only when no explicit flag was given.
- Header: always show `· agent` or `· chat`.

## Out of scope
Persisting the last-used mode, a config default, per-provider mode memory.
