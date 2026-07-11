# Harness Schema Fixture Matrix
Version: 0.3.0

This directory is the normative fixture location for the future validator and
semantic-gate implementation. The matrix is deliberately checked into the
requirements package before runtime implementation so each contract has an
explicit positive, negative, mutation, and migration test target.

`fixture-index.json` is the machine-readable index. The two catalog files are
the current deterministic fixture artifacts; each matrix row points to a JSON
Pointer in those catalogs. The implementation task may split catalog entries
into per-schema files without changing the pointers or fixture semantics.

| Family | Positive fixture | Negative fixture | Mutation/failure fixture | Migration fixture |
|---|---|---|---|---|
| envelope/config/run | `positive-contract-catalog.json#/cases/*` | `negative-contract-catalog.json#/cases/*` | `fixture-matrix.json` semanticOnly | migration cases are defined per schema in the implementation task |
| context/session/evidence | `positive-contract-catalog.json#/cases/*` | `negative-contract-catalog.json#/cases/*` | torn-tail/ancestor cases are semantic gates | prior-version fixtures are required before migration |
| provider/model | `positive-contract-catalog.json#/cases/*` | `negative-contract-catalog.json#/cases/*` | partial-stream cases are catalog entries | prior-version fixtures are required before migration |
| tools/recovery/replay | `positive-contract-catalog.json#/cases/*` | `negative-contract-catalog.json#/cases/*` | outcome-unknown/replay cases are catalog entries | prior-version fixtures are required before migration |
| policy/approval/gate | `positive-contract-catalog.json#/cases/*` | `negative-contract-catalog.json#/cases/*` | stale-approval cases are catalog entries | prior-version fixtures are required before migration |
| child adapter/RPC | `positive-contract-catalog.json#/cases/*` | `negative-contract-catalog.json#/cases/*` | transport mismatch is a semantic gate | prior-version fixtures are required before migration |

Every fixture must bind the schema version and `$id`, and durable fixtures must
preserve stable identifiers and evidence references across migration. Negative
fixtures must include the missing/invalid conditions listed in
`gherkin-coverage-report.md`.

`harness-agent-task.schema.json` is intentionally absent from the active matrix
and both catalogs. It is retained only as a migration-reader schema; new
transport, persistence, and fixture cases must use the canonical
`subagent-dispatch`/`subagent-result` contracts.
