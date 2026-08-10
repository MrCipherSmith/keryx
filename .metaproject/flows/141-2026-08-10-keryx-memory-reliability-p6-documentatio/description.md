# Keryx Memory Reliability P6 — Documentation, Full Verification, and Rollout

Status: implemented (draft PR #261; completion pending CI and merge)
Source: delegated P6 execution request

## Problem

The P0–P5 implementation is present, but the repository-facing contract still
contains stale memory claims and incomplete release evidence. CLI help and the
command registry omit the transition surface and do not fully explain pure
search, explicit reports, optional catalogs, validation, and migration. Module,
architecture, setup, memory-workspace, skill, and wiki references still need to
agree with the current implementation. The tracked legacy
`.metaproject/data/memory/artifacts/latest.{md,json}` files also remain a P2-3
exception and must be backed up and removed without staging or deleting any
other user data.

## Expected Outcome

P6-1 through P6-11 are implemented and evidenced: documentation and command
metadata describe current behavior; the accepted `src-memory` wiki page is
updated and indexed; the requirements package, roadmap, changelog, and metrics
are honest and versioned; legacy artifacts are safely retired; targeted and
full verification plus structural/adversarial doc review have run; and every
PRD criterion has an evidence mapping. Implementation work is finished, but
flow 141 is linked to draft PR #261 and remains `implemented`; `complete` is
reserved for the post-merge gate.

## Out of Scope

No new memory behavior beyond documentation and verification, no dependency or
network changes, no worktree switch, no commit/push/PR/staging, no hand-editing
of flow state or frozen criteria, and no deletion except the two authorized
legacy latest artifacts after recoverable backup and hash verification.
