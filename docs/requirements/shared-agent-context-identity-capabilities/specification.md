# Shared Agent Context — Identity, Capabilities, and Continuous Authorization Specification
Version: 0.1.0

## Status and identity

**Future / planned normative specification.** Package ID: `shared-agent-context-identity-capabilities` (RP-06). It supplies the identity and authorization contracts required by SAC adapters; it does not activate a remote service.

## Operating modes

| Mode | Admission | Identity model | Capability rule | Remote/HTTP state |
|---|---|---|---|---|
| `local-single-user` | Trusted local CLI or verified local Harness boundary only. | Verified local principal plus server-created session/execution instance. | Required for mutation; scoped to the local audience. | Hard denied. |
| `local-multi-agent` | Same trusted local boundary; no tenant administration implied. | Verified local principal plus one distinct server-created delegated execution identity per agent/run. | Required for mutation and owner-delegated actions; provenance retains parent principal and delegation chain. | Hard denied. |
| `remote` | Reserved only; central admission returns `transport_denied`. | No identity is accepted in this package. | No capability is accepted or issued for remote use. | Hard denied until a separate approved activation decision after all abuse gates. |

An OS UID identifies a local principal only. It must not be used as the agent execution identity, proof of reviewer independence, or capability subject in `local-multi-agent` mode.

## Trusted identities and provenance

The trusted CLI/Harness boundary creates an immutable `ExecutionContext` after authenticating the local principal. It contains canonical `principalSubject`, `executionSubject`, mode, authentication method/time, session/workflow binding if present, issued role revision, and an opaque request/attempt correlation ID. `executionSubject` is unique per delegated agent/run in local-multi-agent mode and is distinct from its parent `principalSubject`.

Every protected operation records only minimised provenance: principal subject, execution subject, delegation-chain references, mode, capability ID when used, current role/policy revision, owner subject, and attempt correlation. A client-supplied subject, role, owner, reviewer, capability, or delegation field is untrusted input and cannot become authority.

## Live strict policy composition

All protected SAC operations call one injected `LiveStrictDecisionProvider` with the resolved execution context, requested action/resource/audience, and current owner/transport state. It delegates to the authoritative Security policy configuration and returns a versioned result:

```text
StrictDecision = { outcome: pass | deny | needs-approval,
                   enforcement: strict,
                   policyId, policyRevision, decidedAt, reasonCode }
```

Only `outcome=pass` and `enforcement=strict` permit the next authorization stage. Provider unavailable, stale/unknown policy revision, advisory enforcement, exception, malformed response, or `needs-approval` results in fail-closed denial. Constant or locally constructed pass objects are prohibited. The provider is evaluated at admission and again immediately before material disclosure or owner mutation.

## Delegated capability contract

A mutation capability is server-issued after live authorization; it is not a bearer claim authored by the caller. The opaque capability resolves to immutable server-side fields:

```text
DelegatedCapability = {
  capabilityId, issuerSubject, principalSubject, executionSubject,
  parentCapabilityId?, delegationChainDigest,
  action, resource, audience, workspaceId, ownerId?, targetLocator?,
  workflowBinding?, issuedAt, expiresAt, status,
  roleRevision, policyId, policyRevision, nonceOrReplayBinding
}
```

- `action` is one explicit operation, such as `workspace.read`, `proposal.create`, `proposal.review`, or an owner-specific `target.promote`.
- `resource` is a typed logical resource with workspace and owner containment; no wildcard workspace or caller filesystem path is valid.
- `audience` binds the capability to the expected SAC service/adapter and local transport audience, preventing token passthrough to another service.
- `workflowBinding` is mandatory whenever an action is session-, Flow-, wrap-up-, review-, or owner-workflow-bound.
- `status` is `active`, `revoked`, `consumed`, or `expired`; mutation capabilities are short-lived and may be single-use where replay risk requires it.
- Delegation may only narrow action/resource/audience/expiry. A delegate cannot mint a broader child capability or bypass owner policy.

Capabilities are evaluated server-side by opaque ID or an integrity-protected reference. A received serialized field is never sufficient without issuer, audience, expiry, revocation, binding, and current-role verification.

## Continuous authorization sequence

For each protected read or mutation, SAC must: (1) central-admit transport; (2) resolve trusted execution context; (3) evaluate live strict policy; (4) resolve resource only within visible registries; (5) evaluate current roles, workspace visibility, workflow binding, capability status/scope/audience, and owner authority; (6) repeat relevant checks immediately before disclosure or write; and (7) emit minimised audit metadata. A revocation, role revision change, target/ACL change, expired capability, or policy change between checks denies the operation and prevents owner invocation.

Capability use never supersedes a source owner's guarded write or target authorization. An owner repeats authorization against the bound intent at commit time.

## Central transport admission

`TransportAdmissionService` is the sole policy point for SAC adapter transport classification and denial. CLI, Harness, MCP, and future adapters call it before workspace discovery, tool routing, capability lookup, or content access. It returns `admitted-local` only for approved local modes and `transport_denied` otherwise. HTTP, remote MCP, delegated remote credentials, and unknown transports are denied centrally; adapters may render the common typed error but cannot override or duplicate the allow decision.

Remote mode is not a fallback from local authentication failure. It remains denied even when a request carries an apparent token, SSO assertion, remote principal, or capability. This package specifies no remote identity issuer, SSO flow, tenant model, network listener, or activation API.

## Planned interfaces and data handling

Planned interfaces are `createExecutionContext`, `issueCapability`, `authorizeAtUse`, `revokeCapability`, `admitTransport`, and `getAuthorizationReceipt`. They are future server-side interfaces, not current CLI/MCP commands. Stored receipts omit raw credentials, token material, and detailed security detector output; capability IDs are opaque references.

## Integrations

- Security owns live strict policy evaluation and policy revisioning.
- CLI/Harness establish trusted local principal identity and execution context.
- MCP/other adapters use central transport admission only.
- Workspace and owner modules enforce resource containment and current owner authorization.
- Promotion integrity consumes execution/reviewer identity and owner-mutation capability bindings.

## Acceptance criteria

- Each request selects exactly one mode; unsupported transport is denied before workspace discovery.
- Same-UID local agents have distinct execution subjects and auditable delegation chains.
- Every mutation is blocked without a valid current capability and live strict pass.
- Revocation and role/policy revision changes deny the next protected operation.
- Capability scope, audience, resource, action, and workflow confusion are rejected without disclosure.
- HTTP/remote remains disabled pending every abuse gate and a later explicit activation decision.
