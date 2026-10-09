# Keryx Evidence Retrieval
Version: 0.1.0

## Purpose and status
Implementation package for a separate **Evidence Retrieval Layer (ERL)**:
semantic discovery over raw evidence, exact visible-context exclusion, incremental
indexing. **Spec ready; runtime not implemented.** New paths, commands and defaults
are planned, not existing behavior. Benefits have not yet been benchmarked.

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
