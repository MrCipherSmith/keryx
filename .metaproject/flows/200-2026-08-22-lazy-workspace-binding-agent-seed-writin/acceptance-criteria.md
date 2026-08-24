# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A fresh session's first action-intent open (agent.ts) no longer calls resolve-or-create — the slate opens with workspaceId unset, and no workspace is created for operational requests (verified by updated agent.test.ts SLATE-16 tests).
- AC2: `/goal` without `--workspace` (goal-command.ts) no longer auto-resolves-or-creates — workspaceId stays unset until the agent explicitly creates/binds one (updated goal-command.test.ts).
- AC3: `workspace_create` binds the newly created workspace to the current session's slate (writes slate.workspaceId) so wrap-up can propose into it without a second manual bind.
- AC4: `runWrapUp` with seeds but no workspaceId resolves-or-creates a workspace from the seeds' topic (or degrades to the existing unbound-candidate artifact on no_credential/ambiguous), then proposes per kind-group — covered by new machine-wrap-up tests.
- AC5: `buildAgentSystemInstruction` contains explicit seed-writing rules: when to write a seed (root cause found, code changed, decision taken, risk identified), which `kind` to use, 2-3 sentence length, and that operational/one-shot tasks need no seeds — verified by an instruction-content test.
- AC6: `tsc --noEmit` passes and the full test suite is green after the changes.
