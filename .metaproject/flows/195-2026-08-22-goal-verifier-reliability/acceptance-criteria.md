# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A `/goal --auto` run's transcript/session history shows an observable line for every verifier outcome (achieved / not achieved / unavailable) — success is no longer silent (issue #389).
- AC2: The verifier is given the run's actual evidence trail (recent Seeds and/or `workspace_propose` records from this run) as part of its dispatch context, not just the bare goal text (issue #392).
- AC3: A reproducible scenario where the model recognizes the goal is done before round budget exhaustion now lets the loop exit early, or an equivalent deterministic "done" signal exists and is exercised — the "one more round" branch is reachable in a real test, not structurally dead code (issue #394).
- AC4: Existing goal-command tests still pass; new or updated tests cover all three behaviors; `tsc --noEmit` is clean.
