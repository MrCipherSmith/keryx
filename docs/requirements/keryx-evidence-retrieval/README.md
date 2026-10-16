# Keryx Evidence Retrieval
Version: 0.2.0

## Purpose and status
Implementation package for a separate **Evidence Retrieval Layer (ERL)**:
semantic discovery over raw evidence, exact visible-context exclusion, incremental
indexing. **Code for P0–P4 is on the PR #1022 branch; acceptance is not complete.**
CLI supports `evidence index/search/status/clear/maintenance`; the interactive
shell exposes read-only `evidence_search`; opt-in automatic recall (lexical) is
wired into the agent turn and is off by default. Enabled `hybrid` mode fails with
`hybrid-owner-unavailable` because no approved embedding owner is wired, rather
than silently using lexical retrieval. Exact visible-context exclusion needs the
adapter to expose its serialized request; only the OpenAI adapter does, others
report unknown. Incremental indexing code exists and is not measured.
Session revocation is a trusted owner API backed by the durable ledger and reader
drain; no archive-deletion command or ACP `session/delete` workflow was added.
Benefits have not been benchmarked: T12 (AC9) is open, the T13 independent review
is a reduced static assessment, and there is no TUI surface for the feature yet.
See [current evidence](current-evidence.md#acceptance-status). Rollout decision:
pending operator.
Operator guide: `docs/docs/guides/evidence-retrieval.md`.

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
