# Keryx Evidence Retrieval
Version: 0.1.0

## Purpose and status
Implementation package for a separate **Evidence Retrieval Layer (ERL)**:
semantic discovery over raw evidence, exact visible-context exclusion, incremental
indexing. **P0 and explicit lexical P1 are implemented; P2–P5 remain pending.**
CLI supports `evidence index/search/status/clear/maintenance`; the interactive
shell exposes read-only `evidence_search`. Enabled hybrid mode and automatic
recall currently fail explicitly before source access, rather than silently using
lexical retrieval. They are reserved for P2 and P4 respectively.
Session revocation is a trusted owner API backed by the durable ledger and reader
drain; no archive-deletion command or ACP `session/delete` workflow was added.
Benefits have not yet been benchmarked; whole-flow acceptance remains pending.

## Document index
- [PRD](prd.md)
- [Specification](specification.md)
- [Current evidence and decisions](current-evidence.md)
- [Policies](policies.md)
- [Artifact lifecycle](artifact-lifecycle.md)
- [Agent protocol](agent-protocol.md)
- [Implementation plan](implementation-plan.md)
- [Metrics and validation](metrics-and-validation.md)
- [Configuration schema](schemas/config.schema.json)
- [Search result schema](schemas/search-result.schema.json)
- [Visible projection schema](schemas/visible-projection.schema.json)
- [Documentation verifier](verify.py)

## Scope and related modules
V1: project-local session archives and explicitly allowlisted UTF-8 files.
Accepted memory, wiki, SAC, Slate and code graph retain their owners and trust
contracts. Automatic recall is off by default. No automatic promotion, always-on
watcher, code-history graph import, global cache or external memory runtime dependency.
Related existing seams: src/memory/, src/session/, src/harness/context/,
src/harness/provider/, src/security/, src/forgetting/ and src/sac/.
