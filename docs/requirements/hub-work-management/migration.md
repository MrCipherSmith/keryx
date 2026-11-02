# Migration and coexistence with Keryx0.4.0
Version: 0.2.0

Status: planned migration contract; no live migration executed.

## Additive rollout

1. Back up current Hub SQLite database and retained attachments with existing documented consistency procedure; test restoration to isolated path.
2. Stop writes for the short schema migration boundary. Add the versioned hub_work_records payload table and dedicated hub_work_* events/receipts/archive/reservation/observation/conversion tables and indexes transactionally (physical mapping in specification.md section7); existing HubState records are unchanged.
3. Start with `workManagement.enabled=false` (proposed administrator config). Legacy behavior remains; new work endpoint reports explicit unavailable until supported configuration/readiness.
4. Enable new metadata for explicitly selected projects after compatibility/backup/limits checks. UI capability response reports supported schema/commands and legacy vs managed flow mode; absence means legacy, never infer from title.
5. Enable contributor adapters and optional Git observer independently. No code publication or machine enrollment is implied by flag changes.

## Legacy records

Existing Flow IDs, statuses, specs, evidence, revisions and human receipts remain byte/meaning preserving. Legacy read projection says `mode: legacy` and exposes original data; it does not fabricate Intent or Attempt. Completed Flows remain historical. New managed WorkFlows receive `mode: managed`, new IDs and explicit `legacyFlowId` only on conversion. Proposed rich Flow metadata does not retrospectively invent problem/owner/creator.

Conversion is explicit human dry-run→confirm for unfinished idle legacy Flow only: no active/queued/unknown runs, no pending review/approval/result upload, no existing conversion, exact source version/spec digest. Conservative initial eligibility: initializing or ready only, not in-progress/implemented/completing/done. The human supplies new Intent and recommended outcome/owner fields; copies frozen requirements as an immutable source reference, never claims new approval for changed text. New managed approval happens separately.

The conversion transaction creates managed records and an authoritative conversion guard keyed legacyFlowId. Retain legacy record read-only; *every* legacy write path (REST/MCP/result adapter) checks guard and returns409 `flow-converted` with authorized new ID. Check before side effects. No old-writer path can revive the record. Existing old data remains readable in old shape; new UI shows replacement link. A conversion precondition race with start/import/result/review yields one winner, no partial dual authority. Guards belong in central domain lookup and relevant remote admission/results seams, not UI alone. Additive tests cover all real write entry points.

An active legacy Flow should finish under legacy semantics or wait for explicit separately designed handover. Do not duplicate current frozen work just to use the new UI. Historical review-bundle data stays under its old restrictions; new metadata may reference it but never turn it into publishable source.

## Rollback

Before managed writes or conversions: restore compatible backup or disable new feature following verified down-version startup checks. After managed writes: disabling UI/adapters is safe only if work records remain retrievable with same meaning; never restore an old DB and silently erase decisions. After conversion guards exist, older binaries unaware of guards MUST refuse startup via minimum writer schema/version gate. Operational rollback uses prior compatible guarded binary or forward fix; original0.4.0 writer is not safe. Keep backups and exact schema/app versions in upgrade receipt; migration must test pre- and post-activation paths.

## Performance and storage

Single-process SQLite first; no mandatory infrastructure replacement. Archive exact current/previous document contents before pinning them if existing latest-only storage lacks history; unknown old contents remain unavailable, never reconstructed from digest. Existing v1 sync stays compatible; new exact-version reads serve approved pins. ContextSnapshot can share content-addressed document objects. No full Git mirror or source snapshots added for this feature. Object storage adapter/retention can be extended after real storage measurement, not a prerequisite.
