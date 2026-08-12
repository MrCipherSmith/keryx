# Shared Agent Context — Schemas and Fixtures
Version: 1.2.0

## Purpose

These are normative future data contracts for SAC. They use JSON Schema Draft
2020-12. Runtime code does not exist yet; fixtures define the minimum validator
and integration-test corpus for the first implementation Flow. The
implementation must enable format assertion and run the semantic validator for
the declared `x-` invariants: canonical SubjectId topology, realpath/root
containment, timestamp ordering and ledger-level idempotency.

## Schemas

- [Workspace manifest](workspace-manifest.schema.json)
- [FWK receipt](fwk-receipt.schema.json)
- [Access receipt](access-receipt.schema.json)
- [Workspace proposal](workspace-proposal.schema.json)
- [Review decision](review-decision.schema.json)

## Fixtures

- [Valid workspace](fixtures/valid-workspace.json)
- [Invalid workspace](fixtures/invalid-workspace.json)
- [Valid FWK receipt](fixtures/valid-fwk-receipt.json)
- [Invalid evidence without revision](fixtures/invalid-evidence-missing-revision.json)
- [Invalid bound Work without Flow reference](fixtures/invalid-bound-work-no-flow-ref.json)
- [Valid proposal](fixtures/valid-proposal.json)
- [Invalid proposal](fixtures/invalid-proposal.json)
- [Valid accepted transition](fixtures/valid-accepted-transition.json)
- [Accepted transition with failed security gate](fixtures/invalid-accepted-transition-failed-gate.json)
- [Accepted transition without target write](fixtures/invalid-accepted-transition-no-target-write.json)
- [Valid review decision](fixtures/valid-review-decision.json)
- [Valid access receipt](fixtures/valid-access-receipt.json)
- [Invalid duplicate roles](fixtures/invalid-duplicate-roles.json)
- [Invalid unsafe URI](fixtures/invalid-unsafe-uri.json)
- [Invalid timestamp order](fixtures/invalid-time-order.json)
- [Invalid stale evidence](fixtures/invalid-stale-evidence.json)
- [Spoofed viewer mutation](fixtures/invalid-spoofed-viewer-mutation.json)
- [Denied resource egress](fixtures/invalid-resource-egress.json)
- [Replay/idempotency corpus](fixtures/replay-idempotency-corpus.json)

Positive fixtures must validate against their named schema. Negative fixtures
must fail for the documented contract reason. The replay corpus is evaluated by
the append-only ledger validator, not by an isolated JSON document. All schemas
forbid raw transcript, prompt, hidden-reasoning and secret payload fields by
using closed objects.

`workspace-proposal` creation also requires minimal `wrapUp` metadata. It is
only an audit pointer: runtime authorization requires the corresponding
server-issued, one-time trusted provenance capability bound to its session or
read-only Flow wrap-up source, actor, workspace, evidence and expiry.
