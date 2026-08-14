# Shared Agent Context — Unified Operations: Implementation Plan
Version: 0.1.0

## Delivery status

**Future / planned; not implemented by this package.** It responds to verified
current adapter duplication/docs drift, inconsistent opt-in semantics, and
missing safe current-workspace/reviewer discovery. It does not state that a
unified registry or operation families already exist.

## Dependencies

- Existing trusted local `ActorContext`, ACL, Security, and transport
  restrictions remain authoritative.
- Workspace, proposal, collaboration, Flow, and knowledge owners expose only
  their approved operation seams; registry metadata cannot bypass them.
- Parent SAC capability policy defines the disabled baseline and local-stdio
  transport boundary.

## Phased migration

| Phase | Deliverable | Dependencies | Exit gate |
|---|---|---|---|
| 0 — registry contract | Versioned metadata schema, error envelope, code/doc generation contracts, ownership matrix. | Command, MCP, Harness, Security owners. | Frozen fixtures and no remote identity/UI scope. |
| 1 — status and read surface | Capability status plus workspace current/list/doctor through registered local operations. | Phase 0; workspace ACL. | Disable/degraded/hidden-resource fixtures pass. |
| 2 — review operations | Proposal inbox/show/immutable preview and normalised pagination/errors. | Phase 1; proposal/reviewer authority. | Inbox/preview non-disclosure and parity pass. |
| 3 — handoff | Typed collaboration-owner handoff operation and mixed-ledger safety checks. | Phase 1; collaboration owner schema. | No raw-ledger/cross-worktree/remote disclosure. |
| 4 — adapter generation | Registry-backed CLI/MCP/Harness descriptors/help/docs and executable parity runner. | Phases 1–3. | All migrated operations have parity and docs drift checks. |
| 5 — deprecation | Warn/telemetry/replace old wiring and aliases, then remove. | Phase 4; owner approval/rollback. | No unregistered adapter or stale published example remains. |

## Migration rules

1. Register an operation before exposing it on any new surface.
2. Migrate one operation family at a time behind a capability flag; keep the
   owner execution implementation single rather than creating registry-owned
   business logic.
3. Before cutover, compare absent and unauthorised resource observations and
   ensure doctor/help/alias output remains non-oracular.
4. Generate or validate public documentation from the same registry version;
   preserve deprecated commands only with warning, replacement, expiry, and
   parity fixture.
5. Roll back by disabling the registry operation/adapters, preserving owner
   data and existing ACLs; never solve a parity failure by widening discovery or
   adding remote identity.

## Explicit deferrals

- Remote MCP/HTTP identity, delegated credentials, multi-user federation.
- Web/TUI/IDE user-interface implementation beyond existing local adapters.
- Cross-worktree data sharing, unrestricted activity-log browsing, or an SAC
  replacement for owner/Flow lifecycle systems.
