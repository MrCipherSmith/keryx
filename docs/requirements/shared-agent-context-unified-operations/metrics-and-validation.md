# Shared Agent Context — Unified Operations: Metrics and Validation
Version: 0.1.0

## Status

**Future / planned validation.** No usability, security, or parity claim is
made until owner-approved fixtures and executable checks pass.

## Required gates

| Metric | Definition | Gate |
|---|---|---|
| Registry coverage | Supported SAC operations with complete registry entry | 100% |
| Surface parity | Shared fixtures with semantically equal normalised CLI/MCP/Harness results | 100% |
| Default parity | Surface-specific semantic default deviations | 0 |
| Enablement parity | Differing module/capability state for same actor/transport | 0 |
| Documentation drift | Registry-derived help/docs schema/example mismatch | 0 |
| Discovery leakage | Hidden-resource disclosure via result/count/cursor/error/timing/doctor | 0 |
| Inbox containment | Inbox/preview rows outside reviewer authority | 0 |
| Handoff containment | Raw-ledger, cross-worktree, or remote-identity disclosure | 0 |
| Deprecated alias safety | Alias without consistent notice/replacement/parity test | 0 |

## Fixture matrix

| Area | Required cases |
|---|---|
| Registry | Missing fields, duplicate ID/alias, schema mismatch, invalid risk/transport, unavailable owner dependency, generated artifact drift. |
| Capability | Module enabled/disabled, capability unavailable/degraded, unsupported transport, denied actor, recovery after dependency restoration. |
| Workspace | No current binding, visible current binding, visible list pagination, hidden/absent indistinguishability, safe doctor categories, stale visible reference. |
| Proposal | Empty authorised inbox, visible reviewable row, wrong reviewer, hidden/absent proposal, immutable preview, mutable-note exclusion, stale/denied eligibility. |
| Handoff | Valid schema/ACL, hidden reference, malformed nested payload, mixed activity records, ledger-read attempt, cross-worktree/remote attempt. |
| Parity | Every operation’s valid, invalid, denied, disabled, degraded, alias, and pagination fixture across all allowed local surfaces. |

## Executable parity procedure

1. Compile registry schemas into CLI/MCP/Harness adapters and help/docs fixtures.
2. Invoke the same owner-service fixture through every allowed local transport.
3. Normalise transport envelopes and compare status, data, defaults, notices,
   errors, risk, capability status, and correlation handling.
4. Run discovery-oracle tests with absent and unauthorised resources and compare
   observable result/body/count/cursor/error behavior; use controlled timing
   bounds where the platform can test them.
5. Fail CI on drift, unregistered adapter surface, direct duplicate metadata,
   unsafe diagnostics, or an undocumented deprecation.

## Rollout evidence

Each migrated operation records registry version, owner approval, schema digest,
parity fixture result, ACL/discovery test result, documentation generation
result, rollback owner, and removal plan for superseded wiring. A failed gate
blocks that operation’s cutover but must not reveal protected data in reports.
