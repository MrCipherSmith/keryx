# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The sidebar subagent list includes every spawned child for the session (running, done, and failed) and never replaces a child with `… +N more`.
- AC2: Each listed subagent row is clickable (`onMouseDown`) and the click opens the shared `openModal` host (not a private overlay).
- AC3: The inspector modal shows the child's label, model, status, task, and an ordered work log of tool / reasoning / text events captured from the child `AgentIO`.
- AC4: While a child is still running, new fleet/log events update the open inspector without requiring a second click.
- AC5: `spawn_subagent` no longer auto-removes a finished child from the inspectable list after 15s; a completed child stays openable until the TUI session ends.
- AC6: Headless tests cover the session store, list formatter (all rows, no truncation), inspector `openModal` tab shape, and spawn-tool log emission; `@opentui/core` is not imported at top level in the new runtime modules.
