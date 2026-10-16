# Evidence Artifact Lifecycle
Version: 0.1.1

## States and ownership
Sources remain owned by file/session stores. ERL owns disposable indexes and durable
invalidation ledger. Generation: staging -> validated -> committed -> superseded
-> collected. Source: eligible/stale/denied/removed/unreadable, never memory status.
All deletion/revocation/retention/delivery and minimum atomic full-build publication
guarantees are P1 lexical prerequisites. P2 adds incremental/vector reuse, P4 adds
automatic integration, not the first safe lifecycle.

## Writer protocol
1. Acquire project build lease before source snapshot, retain through publication.
   Kernel ownership releases it on process death, never by age. Concurrent builds
   fail closed. A separate short writer lease serializes ledger writes and CURRENT
   publication, allowing immediate tombstones during embedding. Readers pin CURRENT.
2. Snapshot config/security/source-set, realpath sources and scan/redact.
3. Unchanged hash/fingerprint reuses chunks/vectors. Archive append checks saved
   prefix hash, file identity and complete-record byte cursor; ingest only complete
   records. Rewrite/truncate/prefix mismatch forces full source regeneration.
   Append including incomplete tail changes full source versionHash. Rebind all
   retained record/chunk citations to verified version; reuse compatible sanitized
   embeddings. Test retrieval of old record after append; no stale citations.
4. Changed plain file fully rechunks; reuse sanitized-content embedding keys where
   compatible. Model/revision/dims change invalidates vectors; sanitizer/chunker
   changes invalidate dependent artifacts. No mtime-only identity.
5. Validate staging hashes/counts/references/finite vectors/caps; recheck source
   versions. A source changed during build is withheld with diagnostic, not torn
   evidence. Persist cursor only for published complete records.
6. Flush files/directory, rename staging to immutable generation, atomically replace
   CURRENT on same filesystem with manifest hash. Readers verify members, never mix.
7. Release build lease on success, cancellation or failure; collect superseded
   generation only after reader pins release.

## Deletion, revocation and retention
Every query checks source existence/permissions/version and ledger regardless of
cache. Source-owner forgetting/revocation appends durable scoped tombstone BEFORE
reporting success; failure refuses retrieval. This covers revoked data still on disk.
Cancel affected in-flight readers before deletion success so old excerpts cannot
race delivery. Reindex removes chunks/vectors/catalogs; GC purges affected superseded
generations after readers stop. Clear cancels readers and removes all derived
snapshots/staging under writer lease, preserving tombstones until explicit source
reauthorization. Authoritative sources are never erased by clear.
Maximum derived retention: 30 days since source eligibility check; expired entries
withheld until explicit reindex. Physical cleanup is an explicit owner operation:
`runtime.maintenance()` / `keryx evidence maintenance` (fresh approval in agent
workflows). It decides expiry under the writer lease, durably invalidates CURRENT,
cancels/drains readers, and purges derived artifacts while preserving sources and
tombstones. Healthy CURRENT is preserved; superseded artifacts are collected only
without reader pins. Search/status never trigger cleanup. No background schedule
is installed; operators must invoke maintenance to perform physical cleanup.
No new source-archive retention policy. Secure
physical erasure is not promised for SSDs/backups; backup retention is operator-owned.

## Failure and rollback
Interrupted/oversize build leaves old CURRENT active. Corrupt generation refused,
not partially loaded; explicit rebuild required. Disable immediately stops automatic
use. Backup restore requires source, ledger, scope and model revalidation.
