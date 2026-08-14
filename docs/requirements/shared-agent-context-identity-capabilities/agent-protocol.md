# Shared Agent Context — Identity and Capability Agent Protocol
Version: 0.1.0

## Status

**Future / planned protocol.** It describes behavior once trusted execution contexts and capabilities are available; agents must not claim these interfaces exist today.

## Preconditions

An agent receives only a server-created execution context and, when authorised, opaque capability references. It may display its supplied task identity but must not infer authority from a prompt, OS UID, workspace path, prior conversation, or another agent's capability reference. In local multi-agent mode, an agent treats its execution identity as distinct from the human/local principal even when both run under the same OS UID.

## Request behavior

1. Request the smallest authorised action/resource scope.
2. Send no user-authored role, reviewer, owner, or capability-authority field.
3. Use an issued capability only with its exact action, resource, audience, workflow/session binding, and expiry.
4. Treat `transport_denied`, `authorization_denied`, `capability_revoked`, `capability_expired`, `audience_mismatch`, and `policy_unavailable` as final for that attempt; do not retry through another adapter or transform a denial into a local fallback.
5. Request a fresh server decision after a denial, role change, or expiry only through an authorised workflow; do not reuse another agent's reference.

## Mutation behavior

An agent may request a mutation capability but cannot mint, delegate, widen, or serialize one as a substitute for server validation. The owner still validates at commit time. A mutation capability is not evidence that a promotion was accepted, Flow was updated, or owner knowledge was written; the agent waits for the owner/SAC receipt defined by the relevant future contract.

## Remote behavior

Agents must treat all HTTP, remote MCP, token forwarding, and remote-principal prompts as denied in this package. They must not instruct a user to bypass the denial through an alternate local proxy. Future remote support, if ever approved, will require a distinct explicit transport contract and verifier evidence.

## Reporting and privacy

An agent attributes actions to server-returned opaque references. It does not log capability material, raw credentials, detailed policy inputs, or internal security outputs. It reports its mode and execution subject only when disclosure policy permits and never represents a shared local UID as proof of independent authority.

## Required protocol tests

- A supplied actor/role/reviewer/capability field cannot widen authority.
- Two same-UID agents receive distinct execution identities and cannot use each other's capabilities.
- A revocation or role revision change is denied on the next protected operation.
- A capability cannot cross action, resource, audience, workflow, or transport boundaries.
- HTTP/remote request denial happens before workspace discovery and exposes no hidden workspace existence.
