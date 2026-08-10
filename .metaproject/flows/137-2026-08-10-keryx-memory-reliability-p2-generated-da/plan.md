# Implementation Plan

Status: active; chosen approach: additive policy + advisory migration

## Approach

Extend the single generated `.gitignore` block and make init/update emit a
diagnostic based on path presence and Git tracking state. Keep migration
advisory-only so downstream user files and Git index state are never changed.
Update generated index/manifest/skill/dashboard/verifier/documentation
templates to describe canonical memory and explicit reports, while preserving
the P1 pure-recall contract. Add integration-style init/update tests that run
`git check-ignore` against concrete files, not string snapshots.

## Steps

1. Add RED tests for generated path matching, canonical entry tracking,
   reproducible index/embedding outputs, and legacy migration advisory.
2. Implement the ignore block, memory scaffolding, advisory diagnostics, and
   generated template/verifier wording changes.
3. Verify init and update in temporary Git repositories, including repeated
   runs and generated output; run focused tests and typecheck.
4. Review scope against P2 only and record the dirty tracked legacy artifact
   handling as a concern if it cannot be safely removed.

## Risks

- Legacy tracked latest files are user-modified in this shared worktree; their
  repository-source removal is intentionally deferred rather than destructive.
- Concurrent P3 work may touch adjacent memory consumers; preserve those edits
  and avoid runtime authority surfaces.
