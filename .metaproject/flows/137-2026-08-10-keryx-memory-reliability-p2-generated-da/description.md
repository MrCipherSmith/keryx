# Keryx memory reliability P2: generated data and migration policy

Status: active P2 handoff (flow-orchestrator)
Source: user description

## Problem

Keryx's generated memory catalog, embedding cache, runtime reports, staging
files, and legacy `latest` artifacts are not consistently isolated from Git.
Generated init/update templates and downstream verifier/documentation surfaces
still describe the legacy report path, while existing projects have no safe,
non-destructive migration advisory.

## Expected Outcome

Only canonical Markdown memory and configuration remain trackable in a fresh
project; all generated memory classes are ignored by real Git matching. Init and
update provide an advisory for legacy tracked paths without deleting files or
mutating the Git index. Generated indexes/embeddings remain reproducible and
the verifier records explicit structured memory consultation evidence rather
than treating a legacy artifact as proof.

## Out of Scope

- P0/P1 pure-recall and report-service behavior.
- P3 accepted/current recall authority, adapters, MCP/unified projections,
  approval context, flow related-memory, procedural injection, and their
  cross-surface tests.
- P4 lifecycle transitions and the unified guarded canonical write seam.
- Any commit, push, PR, staging, `git rm --cached`, or automatic deletion.
