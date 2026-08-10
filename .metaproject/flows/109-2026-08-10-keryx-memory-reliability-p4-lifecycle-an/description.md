# Keryx Memory Reliability P4 — Lifecycle and Unified Guarded Write Seam

Status: ready to freeze
Source: user description

## Problem

Keryx durable memory mutations currently reach Markdown entries through several
independent paths. That splits lifecycle validation, path confinement, security
guard behavior, atomic persistence, and audit metadata. A rejected or failed
multi-entry write must never leave canonical memory partially published.

## Expected Outcome

Lifecycle changes are explicit through one service/CLI contract, all Keryx-owned
canonical entry writes use one validated guarded atomic seam, and supersession
is transaction-like with rollback. Security modes preserve their current
advisory/enforced/CI semantics and every result is structured and auditable.

## Out of Scope

- P5 temporal, config, and catalog consolidation.
- P6 release documentation, roadmap work, full-repository rollout, commits, PRs,
  or flow completion.
- Removal or staging of existing dirty legacy latest artifacts.
