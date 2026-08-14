# Shared Agent Context — Documentation Truth: CI Protocol
Version: 0.1.0

## Status

**Future / planned CI protocol.** No current pipeline is asserted to implement
these gates.

## Inputs

A future documentation-truth job receives the checked-out commit/build identity,
changed operation/runtime/docs/graph/wiki paths, canonical operation registry,
approved evidence manifest, generated coverage artifacts, and isolated example
fixtures. It must reject an unpinned or mixed-revision input set.

## Required gates

1. **Structure and links:** package metadata, Markdown links, generated-file
markers, evidence record schema/digests, and real graph/wiki references.
2. **Registry/doc parity:** operation names, aliases, schemas, defaults, risk,
transport, authorization action, capability prerequisite, error codes, and
deprecation notices match canonical registry output.
3. **Status/evidence lint:** lifecycle, verification, capability, and freshness
terms are valid; every current claim links to same-commit evidence; historical
counts/results are visibly historical.
4. **Executable examples:** examples run only in isolated local fixtures and
produce the documented normalised success or safe failure.
5. **Graph/wiki coverage:** required SAC nodes/edges/pages and generated source
revision are present; a missing/stale projection yields a drift finding.
6. **Non-disclosure:** examples and docs tests prove disabled/denied/hidden
states do not disclose protected IDs, paths, counts, cursor distinctions, raw
evidence, or secrets.

## Gate outcomes

`pass` permits publication for the checked commit only. `fail` blocks current
claims and publication of affected generated docs. `warn` is permitted only for
an explicitly approved non-current explanatory document; it cannot accompany a
`current-verified` claim. Every outcome emits a minimised evidence record with
commit/build pin and artifact digest.

## Drift handling

When a generated doc, guide, graph/wiki page, evidence record, or registry
entry disagrees with a higher-ranked source, CI emits a deterministic drift
finding containing source IDs/revisions and safe remediation category. It must
not rewrite authored docs automatically, redact away the disagreement, or claim
the lower-ranked text is current. The owning maintainer resolves the source or
updates the affected documentation in a reviewed change.

## Security and execution limits

CI runs no remote identity flow, production workspace, privileged owner write,
full transcript, or unrestricted discovery scan. Test actors are fixture-local;
protected values are synthetic/redacted. A test requiring owner mutation uses
an approved fake/ephemeral target and proves the same authorization/error
boundary, not a generic file-write bypass.
