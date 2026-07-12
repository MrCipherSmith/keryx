# Context Operations — Artifact Lifecycle
Version: 1.0.0

## Classes

| Class | Location | Authority | Retention |
|---|---|---|---|
| Source knowledge | `memory/`, `wiki/`, rules, project-skills | human-reviewed Git source | retained until superseded/deprecated |
| Input evidence | graph/health/testing/review artifacts | producing module | module policy |
| Assembly manifest | `data/context/assemblies` | derived | disposable/rebuildable |
| Retrieval trace | `data/context/traces` | derived/redacted | bounded diagnostics retention |
| Feedback ledger | `data/context/feedback` | append-only observation | reviewed then compacted, never silently rewritten |
| Eval evidence | `data/context/eval` | CI/run output | per CI retention policy |

## Validity and supersession

- Source item is selected only when its content hash/version matches the
  manifest record and its temporal/status policy permits it.
- A changed source does not mutate prior manifests; subsequent assembly marks
  the old reference stale.
- `superseded` memory stays queryable `asOf` its validity period but is absent
  from default current retrieval.
- Deleting generated context data must not delete source knowledge or evidence
  referenced by a flow/review record.

## Retention and privacy

Raw tool output is never retained by Context Operations unless its producer
already retains it under an approved policy. Stored manifests and traces must be
redacted before write. External adapter identifiers and credentials references
are configuration metadata, never embedded credentials.

