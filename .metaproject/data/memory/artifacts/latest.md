# Memory search: harness policy approval

Results: 1

### 1. Flow ids are allocated per clone, not per checkout  (score 1.803)
- type: constraint | status: accepted | confidence: high
- matched 1/3 terms; status accepted; confidence high
- scopes: module:tasks, entity:flow
- provenance: flow 116 (fix duplicate flow ids)
- summary: `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
- entry: constraints/flow-ids-allocated-per-clone.md
