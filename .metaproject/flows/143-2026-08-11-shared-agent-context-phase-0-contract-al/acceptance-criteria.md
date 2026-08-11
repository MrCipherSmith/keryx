# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every SAC positive fixture validates and every labeled invalid fixture
  fails against its named Draft 2020-12 schema plus semantic validation.
- AC2: Semantic validation rejects duplicate/conflicting canonical SubjectId
  roles, unsafe/escaping typed references, invalid UTC/time ordering and replay
  or idempotency violations before any persistence/egress seam.
- AC3: Typed workspace-relative references resolve only after realpath/root
  containment; absolute, network, traversal and symlink-escape inputs fail.
- AC4: ACL authorization consumes only server-created ActorContext and rejects
  spoofed client actor/role values, cross-workspace access, revoked role and
  authorization-to-use TOCTOU changes.
- AC5: Production SAC read, egress and write eligibility requires a strict
  enforced guard; disabled, advisory, unavailable, error or indeterminate
  guard states deny without disclosure/egress/write.
- AC6: SAC foundation adds no Flow state mutation and creates no knowledge
  store; focused tests, typecheck, health and relevant review gates pass.
