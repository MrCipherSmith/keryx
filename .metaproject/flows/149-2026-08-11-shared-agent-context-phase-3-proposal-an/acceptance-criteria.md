# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Explicit wrap-up input creates one schema-valid immutable `proposed` record; no raw prompt, transcript, hidden reasoning, secret, or source-knowledge copy is persisted.
- AC2: Every terminal lifecycle outcome is an append-only, causally ordered transition carrying proposal revision, correlation ID, prior-event linkage, and idempotency key; a same-key retry returns the original terminal result.
- AC3: `accepted` is impossible unless a durable, causally linked pending write-intent has bound the trusted reviewer, current ACL/authority, fresh evidence and ACL validation, and strict passing security policy revision; the owning guarded writer must then return one correlation- and intent-bound successful target-write receipt before the terminal acceptance is appended. Recovery retries the same owner idempotency key and cannot duplicate a target mutation.
- AC4: Failed target writes, stale evidence, denied/spoofed/revoked/cross-workspace authority, replay/conflicting transitions, and TOCTOU leave no accidental target mutation and yield non-accepted outcomes.
- AC5: Rejection, dismissal, and stale outcomes preserve audit-only lifecycle metadata and never mutate Wiki, Memory, Skills, or Flow; SAC contains no Flow mutation path.
- AC6: Local CLI and MCP lifecycle adapters normalize equivalent contract fixtures and preserve Phase 0/2 strict-guard/ActorContext boundaries.
