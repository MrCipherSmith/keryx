# Acceptance Criteria

- AC1: Facts resolve only visible, revision-matching evidence; expiry or source
  revision mismatch is explicit fresh/stale/expired state, never silent success.
- AC2: Work is a read-only normalized projection of exactly one Flow snapshot;
  missing Flow is explicit unbound and no SAC API mutates Flow.
- AC3: Know-how exposes only accepted/reviewed Wiki, Memory and Skill entries,
  retaining source, revision, trust, applicability and withdrawn/stale state.
- AC4: Mandatory overview budget exhaustion returns typed context_overflow with
  no successful manifest or receipt; optional omissions return partial=true and
  every omitted optional ID.
- AC5: Allowed, denied, stale and budget outcomes emit schema-valid
  metadata-only AccessReceipts linked to canonical assembly/trace, policy and
  config revisions, selected and omitted IDs; no raw prompt/transcript/reasoning
  or secret is persisted.
- AC6: Read-only CLI and MCP adapters share normalized output fixtures and pass
  parity tests; disabled/advisory guards cannot disclose FWK data.
- AC7: Focused SAC tests, typecheck and health pass, and review has no open
  blocker, major or minor findings.

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: <replace with a hard, verifiable criterion before freeze>
