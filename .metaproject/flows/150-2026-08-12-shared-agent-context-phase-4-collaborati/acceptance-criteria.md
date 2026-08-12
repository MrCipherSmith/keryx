# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: SAC persists and returns only schema-valid, workspace-contained worktree/session references through a guarded collaboration facade; malformed, escaping, spoofed, cross-workspace, revoked-role and TOCTOU attempts are denied.
- AC2: Local activity is append-only, schema-validated allowlisted metadata and contains no raw transcript, prompt, secret, hidden reasoning, or copied source knowledge; tests reject forbidden content-bearing fields.
- AC3: Owner operations require a trusted ActorContext, strict guard and point-of-use authorization within the established lock/write discipline; viewer and untrusted client inputs cannot mutate collaboration state.
- AC4: CLI, local-stdio MCP and any optional client consume the same SAC service/normalizer and produce outputs compatible with shared contract fixtures; no UI/IDE-specific authorization or persistence path exists.
- AC5: A usability evaluation records unfamiliar-component onboarding and handoff tasks, outcomes and actionable gaps without sensitive payloads, and is reproducible from the stable SAC contract surface.
