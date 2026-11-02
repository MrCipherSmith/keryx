# Release-backed Hub updates
Version: 0.1.0

Status: PR1113 preparation only. Keep the PR in Draft. Owner review must precede merge; no release tag, publication or production cutover is authorized before that review. Implementation and isolated backup/migration rehearsal continue. User explicitly authorized main integration and a successor release after0.4.3 on2026-11-01. Latest steering: publish the release and prepare instructions so the owner performs production cutover; do not switch the live Hub automatically.

## Contract

CI builds the Hub from an immutable version tag, publishes checksummed install/source/binary artifacts and an OCI image reference pinned by digest. The installed server never rebuilds from a working checkout. Do not replace an existing release tag with new code.

Public CLI: `keryx hub update [version] [--check|--dry-run] [--install-dir path] [--yes]`. Default version is latest stable. The command operates on the local server installation only; a project binding URL or contributor token confers no administrative update authority. Run on the Hub host (SSH remains external). It delegates to the installation-owned hubctl with argument arrays and inherited interactive streams; no shell interpolation, sudo password, token or remote executable URL handling. Unknown flags, invalid versions/paths, incompatible legacy installers and missing tools fail before mutation. CLI status/binding semantics and agent/MCP capabilities stay unchanged.

Private bridge contract: `hubctl update-check [version|latest] [--json]`; `hubctl upgrade <version|latest> --dry-run`; actual upgrade uses the existing command/confirmation/lock/backup path. Check/dry-run are read-only with respect to the installation, current pointer, data and running services. Return installed/target version and pinned release information, not secrets. Reject a target without all required validated release artifacts. Normal upgrade downloads and verifies before stopping, then backs up the complete quiescent volume and trial-starts a copy.

## Compatibility and recovery

Released Compose passes managed-work enable/registry settings explicitly, default disabled. Staging retains explicitly configured Cloudflare Access role mappings and SSO overlay across upgrades; operator/agent/reviewer and tunnel credentials stay installation-owned. The trial reads feature/Access configuration safely and tests supported paths without public networking or production writes. A managed write activates minimum writer3; old readers that accept only2 must be rejected by a preflight trial before the live service/pointer is changed. A normal rollback preserves current data and must validate old image compatibility on a copy first. Restoring old data is a separately explicit destructive operation, with current data backed up first. Never silently restore an earlier database after accepting new public writes.

The current geekom install is a legacy source-build layout (old compose wrapper, no release upgrade). Adopt/migrate it once using a full verified backup, preserving its original data/credentials/tunnel/Access policy; do not run the fresh installer over it or delete/recreate its data volume. Document the exact conversion and final pinned artifact. Keep legacy service available for recovery until the new instance passes isolated rehearsal.

## Acceptance

1. CLI routes all forms correctly, validates input, delegates only to the explicitly resolved installation tool, propagates failure and never leaks secrets. Tests exercise mutation-sensitive boundaries.
2. Check/dry-run do not mutate server state or stop services; missing/incomplete releases fail clearly.
3. Existing release installation/backup/restore/upgrade tests pass; new tests cover writer3 downgrade refusal, opt-in configuration and retained SSO.
4. Managed work and latest remote run lifecycle regressions pass together after resolving the fixture conflict; no feature or fix is discarded.
5. Successor release includes new Hub and updater;0.4.3 is not repurposed. Published assets/checksums/image digest and CI checks are verified before use.
6. Production backup passes integrity and semantic record comparison after isolated restoration; rehearsal proves old/new reads, new work lifecycle and preserved authorization without mutating production.
7. Supply an operator cutover procedure with no active work silently interrupted, no dual writers, a final consistent backup, real health/Cloudflare/authorized project checks and retained recovery files. Rehearse on a copy; owner performs live cutover. Record actual outcome rather than claiming deployment or self-accepting product work.

## State/event matrix

| State | Check/dry-run | Apply/retry | Failure |
|---|---|---|---|
| Missing/legacy install | Explicit unsupported diagnostic | Refuse; no changes | Preserve original install |
| Valid install | Read-only installed/target report | Lock, verified backup and trial before switch | Keep live service/pointer until safe boundary |
| Upgrade in progress | Bounded status/lock response | Refuse concurrent operation | Restore only before writes are exposed; preserve new data otherwise |
| Incompatible old image | Report unsupported downgrade | Refuse before stopping current service | Current data/service unchanged |
| Completed | Report pinned current release | Same version is explicit no-op/refusal | No fabricated success |
