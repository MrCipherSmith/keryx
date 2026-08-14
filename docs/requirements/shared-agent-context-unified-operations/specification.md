# Shared Agent Context — Unified Operations: Specification
Version: 0.1.0

## Identity and status

**Package id:** `shared-agent-context-unified-operations` (RP-09).

This is a **future, spec-ready** surface contract. The registry describes
operations; it does not own workspace/proposal/knowledge data or replace the
execution owners behind them.

## Related contracts

- [Parent SAC implementation plan](../shared-agent-context/implementation-plan.md)
- [Current public guide](../../docs/guides/shared-agent-context.md)
- [Agent protocol](agent-protocol.md)
- [Metrics and validation](metrics-and-validation.md)
- [Implementation plan](implementation-plan.md)

## Registry structure

The future registry is a versioned machine-readable source of operation
metadata. Each entry has the following normative shape:

```text
id, version, lifecycle, aliases?,
inputSchema, outputSchema, defaults,
risk, allowedTransports, authorizationAction,
requiredCapabilities, dependencies,
normalization, errors, pagination?,
helpRef, docsRef, deprecation?
```

`risk` uses the established read/write/privileged classification. `allowedTransports`
is local-process/local-stdio only for this package; remote transport, identity,
and delegation are not introduced. `authorizationAction` is evaluated by the
existing trusted server-side `ActorContext`, never a client argument. Registry
metadata cannot grant an operation that its owner/service refuses.

## Derived surfaces

| Surface | Derived contract | Boundary |
|---|---|---|
| CLI | Argument schema, defaults, help, alias/deprecation warning, normalised output. | CLI resolves trusted local actor; no client role flag. |
| MCP | Tool name/description/input-output schema and local transport eligibility. | HTTP/remote remains denied; server resolves actor. |
| Harness | Tool descriptor, risk, input schema, result renderer. | No implicit workspace discovery beyond authorised operation result. |
| Help/docs | Generated operation table/snippets and references. | Publish only currently declared operation/capability availability. |
| Tests | Shared fixtures and semantic parity runner. | Executes owner service fakes/approved integration seams, not duplicate business logic. |

Adapters may map syntax and transport envelopes, but SHALL NOT redefine
defaults, validation, risk, authorisation action, operation lifecycle, or output
semantics.

## Capability status and error model

`capability.status` returns a normalised envelope:

```text
operationId, moduleState, capabilityState, transportState,
dependencyState, allowed, correlationId, notices[]
```

Allowed public states are `enabled`, `disabled`, `unavailable`, `degraded`,
`unsupported-transport`, and `denied`. A resource-specific request returns
`not-found-or-denied` when revealing whether the resource exists would leak
information. It MUST NOT distinguish hidden from absent by error code, count,
cursor behavior, elapsed timing guarantee, or diagnostic detail.

Module enablement is evaluated once by the capability gate and consumed by all
generated adapters. Disabled means operation execution is denied/hidden as
defined by its registry visibility policy; it does not merely hide templates or
one transport while another remains active.

## Operation families

### Workspace

- `workspace.current`: returns an authorised explicit/session/Flow-derived
  binding or `none`; it never guesses from an invisible workspace.
- `workspace.list`: lists only visible workspaces with opaque cursors and no
  total count that includes hidden entries.
- `workspace.doctor`: returns safe actionable categories such as capability
  disabled, missing authorised binding, stale visible reference, or dependency
  degraded. It omits secrets, hidden IDs, raw receipts, and path internals.

### Proposal review

- `proposal.inbox`: lists only proposals whose workspace and target/reviewer
  authority are currently visible to the actor; uses opaque cursor pagination.
- `proposal.show`: returns one visible immutable proposal/transition summary.
- `proposal.preview`: renders the reviewed canonical digest, intent, allowed
  evidence references/revisions, and current typed eligibility. It excludes
  mutable notes, full transcripts, hidden target content, and owner internals.

### Handoff

`handoff.create` and `handoff.show` use a typed collaboration-owner record
schema, current ACL, and minimised metadata. They do not expose arbitrary
`activity.jsonl`, bypass source validation, synchronise worktrees, or establish
remote/MCP identity.

## Normalisation and deprecation

Every successful result is normalised to `{operationId, version, status, data,
notices, correlationId}`. Every failure uses `{operationId, code, retryable,
correlationId, safeMessage}`; it has no secret/raw path/hidden-resource detail.
Defaults and pagination semantics originate in the registry.

Aliases carry `introducedIn`, `deprecatedIn`, `replacement`, `removalAfter`,
and a parity-fixture requirement. An alias emits the same warning through all
surfaces and may be removed only after telemetry/owner approval and fixture
coverage prove the replacement.

## Acceptance criteria

- **AC-1:** Every supported operation has one registry entry and generated or
  registry-validated CLI/MCP/Harness/help/docs artifacts; duplicate semantic
  declarations fail CI.
- **AC-2:** Capability status returns the same module/capability/dependency
  semantics across supported local surfaces and respects a disabled module.
- **AC-3:** Parity fixtures prove equivalent defaults, normalised outputs,
  errors, risk, and authorisation behaviour for each available operation.
- **AC-4:** Hidden workspace/proposal/reference tests prove no discovery oracle
  through responses, counts, cursors, preview, doctor, aliases, or transport.
- **AC-5:** Current/list/doctor and inbox/show/preview work for authorised
  actors with opaque pagination and correlation IDs.
- **AC-6:** Handoff uses only collaboration-owner schema/ACL and cannot expose
  raw ledger content, remote identity, or cross-worktree data by default.
