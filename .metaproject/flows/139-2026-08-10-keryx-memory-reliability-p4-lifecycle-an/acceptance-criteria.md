# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A pure exhaustive lifecycle helper permits only documented transitions and identifies idempotent no-ops.
- AC2: MemoryService.transition() returns structured success/no-op/error outcomes, enforces terminal states, and does not duplicate metadata on retries.
- AC3: `keryx memory transition` validates user input and delegates lifecycle mutation through the service without duplicating transition logic.
- AC4: The shared canonical-entry write seam confines paths to the typed memory root and validates every next entry before any guard or replacement.
- AC5: The shared seam evaluates security guards and preserves advisory warnings while enforced/CI rejection leaves canonical bytes unchanged with structured evidence.
- AC6: The shared seam stages beside its target, atomically replaces when supported, fsyncs/cleans staging, and reports structured persistence outcomes.
- AC7: Manual create and overwrite operations use the shared canonical-entry write seam.
- AC8: Ingest creation/reconciliation and reflection-created pattern drafts use the shared seam and remain draft-only.
- AC9: Supersession prevalidates and preguards both entries, writes both through the seam, and restores the first entry byte-for-byte if the second persistence fails.
- AC10: Successful transitions and supersessions append one deterministic changelog/provenance record; idempotent retries append none.
- AC11: Focused tests cover state transitions, idempotency, invalid/terminal errors, confinement, guard blocks, atomic cleanup, pair rollback, and audit metadata.
- AC12: Tests prove no automatic ingest or reflection path can accept a draft; acceptance requires the explicit lifecycle service/CLI path.
