# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: <replace with a hard, verifiable criterion before freeze>
# Acceptance Criteria

- AC1: WorkspaceService creates, lists, reads, and adds typed manifest resources offline; every persisted primary manifest validates with the Phase 0 normative and semantic validator.
- AC2: Each manifest mutation uses the established exclusive lock plus atomic replacement, persists only `workspace.json` and permitted local lifecycle metadata, and leaves no partial/invalid manifest after a rejected request.
- AC3: CLI exposes only local `workspace create|list|show|add-resource`; it accepts no actor, role, or remote transport parameter and creates identity only from the local trusted boundary.
- AC4: Viewer cannot mutate; owner and editor mutations are authorized at point of use, and revoked/cross-workspace/TOCTOU role changes deny without persistence.
- AC5: Unsafe, escaping, unresolvable, or schema-invalid references/manifests are rejected before persistence.
- AC6: Disabled or advisory guard modes deny SAC writes and do not alter Flow, Harness, MCP, or Context Operations runtime behavior; this phase introduces no MCP mutation, UI, remote transport, copied knowledge, or parallel Flow state.
