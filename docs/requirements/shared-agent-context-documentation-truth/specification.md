# Shared Agent Context — Documentation Truth: Specification
Version: 0.1.0

## Identity and status

**Package id:** `shared-agent-context-documentation-truth` (RP-12).

This is a **future, spec-ready** documentation-governance contract. It does
not make documentation authoritative for runtime execution, authorization, or
owner data.

## Related contracts

- [Parent SAC requirements](../shared-agent-context/README.md)
- [Current public guide](../../docs/guides/shared-agent-context.md)
- [CI protocol](ci-protocol.md)
- [Metrics and validation](metrics-and-validation.md)
- [Implementation plan](implementation-plan.md)

## Truth sources and precedence

| Rank | Truth source | May prove | Cannot prove |
|---|---|---|---|
| 1 | Owner runtime contract/operation registry and trusted capability gate | Supported shape, defaults, risk, transport, authorization, declared status. | Successful execution on a particular commit. |
| 2 | Commit-pinned executable verification artifact | Exact fixture outcome on identified commit/build/environment. | Future behavior or another commit’s current state. |
| 3 | Generated graph/wiki projection | Navigation, ownership, dependency/coverage references. | Runtime behavior, authorization, or test success. |
| 4 | Authored guide/README/roadmap/requirements | Intent, explanation, non-goals, planned work. | Implementation/current verification without rank-1/2 evidence. |

When sources disagree, publish the higher-ranked outcome and create a drift
finding. A guide never silently upgrades a planned or historical result to
current.

## Evidence record and storage shape

Future release evidence is append-only, commit/build scoped, and stored outside
the public guide body in an approved evidence location:

```text
docs/evidence/sac/<commit-or-build-id>/<check-id>.json
docs/evidence/sac/<commit-or-build-id>/manifest.json
```

`manifest.json` contains commit SHA, repository/worktree identity, build/tool
versions, generated-at time, source revision, artifact list/digests, and status
scope. A check record contains check ID, command/fixture identifier, expected
and actual normalised result, pass/fail, environment constraints, timestamp,
artifact digest, limitations, and links to affected docs/operations. Raw
secrets, prompts, transcripts, hidden reasoning, and protected resource content
are forbidden. Evidence from another commit is `historical` or `stale`, never
`current`.

## Status taxonomy

Documentation SHALL use these non-interchangeable values:

- **Lifecycle:** `planned`, `in-progress`, `implemented-at-commit`, `deprecated`,
  `removed`.
- **Verification:** `current-verified`, `historical-verified`, `stale`,
  `unverified`, `unknown`.
- **Capability:** `enabled`, `disabled`, `unavailable`, `degraded`,
  `unsupported-transport`, `denied`, `not-found-or-denied`.
- **Data freshness:** `fresh`, `stale`, `expired`, `withdrawn`, `unresolved`.

`implemented-at-commit` requires a commit pin but does not alone mean
`current-verified`. A guide must state scope if a command is local-only,
fixture-only, disabled by default, or unavailable in a transport.

## Graph/wiki coverage contract

Future generated coverage SHALL include SAC’s operation roots; CLI/MCP/Harness
adapter dependencies; Context Operations assembly/trace boundary; Flow,
Security, Session/Harness, Wiki, Memory, Skills, and collaboration ownership;
capability gate; and documentation/evidence artifacts. Each page/edge has
source revision and generated timestamp. Missing expected coverage creates a
visible drift finding; unknown graph data cannot be presented as an absence of
runtime dependency.

Wiki prose is owner-reviewed explanatory context. It links to real graph/source
references and labels generated vs authored sections. It does not copy secrets,
hidden reasoning, or the full output of private evidence fixtures.

## Generated operations and executable examples

The canonical operation registry (from the RP-09 future contract) SHALL derive
or validate name/alias, input/output schemas, defaults, risk, transport,
authorisation action, capability prerequisites, normalised errors, deprecation
notice, help text, and documentation snippets. A missing registry entry blocks
publication of a new operation example.

Each executable example declares commit/build pin, fixture setup, local
transport/actor assumptions, operation/capability status, expected normalised
result or safe expected failure, and teardown. Examples run in an isolated
fixture with no remote identity, no privileged escape, no hidden-resource
enumeration, and no production mutation.

## Acceptance criteria

- **AC-1:** Every current SAC implementation/test-total claim references a
  matching commit-pinned evidence record; historical totals are visibly labelled.
- **AC-2:** Status lint rejects invalid lifecycle/verification/capability
  combinations and ambiguous terms such as bare “available” without scope.
- **AC-3:** Generated operation docs/help/schemas pass registry parity and
  contain no obsolete syntax/default/transport statement.
- **AC-4:** All required examples run in isolated fixtures and assert safe
  success/failure; no example widens ACL, transport, or discovery behavior.
- **AC-5:** Graph/wiki coverage check reports required SAC roots/edges/pages,
  generated revision, and gaps; coverage text is not accepted as behavior proof.
- **AC-6:** CI fails broken links, stale generated docs, invalid evidence pin,
  unexplained source disagreement, or an unsupported current-status claim.
