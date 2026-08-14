# Shared Agent Context — Secure Minimal Evidence: Artifact Lifecycle
Version: 0.1.0

## Status

**Future / planned lifecycle.** Existing SAC lifecycle rules remain in force
until owner-approved implementation and verification occur.

## Artifacts and retention

| Artifact | Owner | States | Retention rule |
|---|---|---|---|
| Session terminal record | Harness/session | open → sealed → superseded | Owner-defined; SAC retains reference only. |
| WrapUpProvenance | Harness/session | issued → consumed/expired/revoked | One-time; expiry invalidates use and permits no persistence. |
| MinimalEvidence | SAC derived record | prepared → scanned → persisted → expired → deleted | Retain only by retention class; expiry requires verified deletion/inaccessibility. |
| Restricted archive | Security/Harness | disabled or protected-active → expired/revoked → deleted | Never default; protected zone with independent TTL/delete audit. |
| Proposal | SAC candidate | proposed → reviewed terminal state | Immutable, reference-bound; never accepted knowledge itself. |
| Accepted knowledge | Wiki/Memory/Skills | owner-defined | SAC retains only permitted reference/receipt metadata. |

## State transitions

```text
session open -> sealed -> superseded
sealed provenance -> issued -> consumed | expired | revoked
minimal candidate -> scanned-pass -> persisted -> expired -> deletion-requested -> deleted
minimal candidate -> scan-fail | scan-indeterminate | rejected-before-persistence
restricted archive -> protected-active -> expired | revoked -> deleted
```

`sealed`, `persisted`, and `deleted` append immutable state/receipt records.
Corrections create new revisions or replacement references; they never overwrite
the old lifecycle history. A failure to delete is an explicit terminal incident
state, not a successful expiry.

## Deletion requirements

1. At expiry/revocation, prevent new reads and proposal use immediately.
2. Queue deletion with owner, method, requested time, and scope.
3. Delete stored bytes or perform verifiable crypto-erasure according to the
   approved retention class; delete derivatives/caches that contain the payload.
4. Persist a minimised deletion receipt containing identity, method, time,
   actor/service, result, and any permitted failure code—never the payload.
5. Mark all dependent SAC references `deleted` or `unresolved`; do not retain a
   content fallback. A failed job raises an incident and blocks reuse.

Deletion never deletes the Flow, original session-owner record, Wiki, Memory,
Skills, or another owner’s data. Their policies govern their own retention.

## Restricted archive lifecycle

An archive activation is separately approved and policy-bound. It must have a
finite expiry shorter than or equal to its authorised purpose. Revocation or
expiry triggers protected-zone access removal and deletion/crypto-erasure with
an independent receipt. Backups, replicas, and keys are in scope of the archive
owner’s deletion proof; a bare application-file deletion is insufficient.

## Migration compatibility

No existing verbatim session export is grandfathered as `MinimalEvidence`.
Migration first disables it as a proposal source, inventories/restricts any
legacy evidence under Security direction, and creates only minimised new records
after sealing and scanning. Unknown lifecycle/schema majors fail closed.
