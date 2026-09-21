# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A test reproduces the stall on a temporary repository: graph built, then a commit touching only `.metaproject/`, and it fails before the fix — `keryx sync --apply` leaves `.metaproject/data/gdgraph/.provenance.json` on the older commit while the gdwiki baseline is refused for a stale graph.
- AC2: After the fix, that same sequence ends with the graph provenance naming HEAD and the gdwiki baseline recorded, in one documented command.
- AC3: A commit that changes a tracked code file still rebuilds the graph and advances provenance, unchanged from today (regression test).
- AC4: A working tree holding an untracked or newly added code file still refuses the wiki baseline, with the same message as today (regression test).
- AC5: Whichever of the three owners is not changed carries a comment naming the decision and why it is not the fix — the diff stage, the manual `gdgraph build` path, or the gdwiki baseline gate.
- AC6: `bun run check` passes and `keryx health run` gate is pass.
