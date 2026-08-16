# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `/goal --workspace <id>` rejects an invalid/actor-invisible id explicitly
  (fail closed) rather than opening a slate that only discovers the problem at
  wrap-up.
- AC2: `/goal` without `--workspace` never creates a workspace.
- AC3: An unattended session hitting `ask_user`/budget exhaustion emits a
  `TerminalState` record and stops cleanly; no `Do NOT call tools.`-style
  instruction persists into any later turn of the same session.
- AC4: Anchors visibly update mid-session (e.g. after a tool call) without any
  explicit tool call from the model.
- AC5: Course/Seeds content is reachable only through `slate_read`/
  `slate_write_seed`, never silently injected every round.
