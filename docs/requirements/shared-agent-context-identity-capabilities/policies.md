# Shared Agent Context — Identity and Capability Policies
Version: 0.1.0

## Status

**Future / planned policies.** These rules constrain a future implementation and do not authorise any remote capability or transport.

## P-01: Client non-authority

Only a trusted server boundary creates `ExecutionContext`, role authority, reviewer authority, owner authority, or a capability. Request arguments, MCP payloads, environment values, prompts, manifest fields, and user-visible labels are data only. A field that names a subject or role cannot cause an authorization result.

## P-02: Mode selection and least privilege

Central transport admission classifies each request once. Local single-user mode is limited to the verified principal/session. Local multi-agent mode adds a narrow delegated execution identity, not another user or tenant. Remote is a denied mode and may not be selected implicitly from a failed local request.

## P-03: Live strict decision

Every protected operation uses the authoritative live strict provider at use time. Missing provider, error, stale decision, advisory mode, `needs-approval`, or a locally fabricated pass is denial. A receipt records policy ID/revision and reason code without sensitive implementation detail.

## P-04: Delegation narrowing

An issuer can delegate only capabilities it currently holds, and every child must be no broader in action, resource, audience, workflow binding, expiry, and owner scope. The verifier validates the complete chain and rejects cycles, missing parents, revoked parents, widening, or a chain longer than configured policy. Delegation does not grant reviewer independence or override source-owner writes.

## P-05: Continuous authorization and revocation

Authorization is checked at admission and immediately before material disclosure or write. Capability expiry, explicit revocation, current-role revision change, workspace/target ACL change, policy revision invalidation, workflow/session mismatch, or audience mismatch blocks the next use. A cached pass is never sufficient for mutation.

## P-06: Audience and token-passthrough resistance

Each capability binds an intended local SAC audience/service and one action/resource scope. A receiver verifies audience before capability lookup or target resolution. It rejects forwarding to another adapter/service, replay outside nonce/replay binding, and use for a different workspace, owner, target, or action.

## P-07: Central remote denial

One transport-admission service denies HTTP, remote MCP, and unknown/unauthenticated transports before routing. No adapter may add a private HTTP allowlist or bypass based on an apparent token. Remote enablement requires a future policy change plus passing all gates; it is out of scope here.

## P-08: Provenance minimisation

Audit records store opaque/canonical identity references, capability/decision IDs, revisions, mode, action/resource class, and outcome. They must not store access tokens, credentials, raw policy inputs, prompts, or hidden reasoning. Provenance must distinguish principal, execution agent, reviewer, owner writer, and delegation chain references.

## Prohibitions

- No HTTP/remote, SSO, or multi-tenant administration enablement.
- No static `strict/pass` composition in a protected path.
- No shared-UID assumption as agent identity in local multi-agent mode.
- No client-created or broad/wildcard mutation capability.
- No capability that bypasses current owner checks, workspace visibility, or security policy.
