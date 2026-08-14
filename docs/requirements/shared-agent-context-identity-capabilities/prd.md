# Shared Agent Context — Identity, Capabilities, and Continuous Authorization PRD
Version: 0.1.0

## Status

**Future / planned.** The requirements do not assert that SAC currently has per-agent identities, a live strict policy provider, or remotely authenticated transport.

## Problem

SAC needs an identity/security boundary that holds across CLI, Harness, MCP, and owner writes. A local OS UID is sufficient only to identify a local user, not distinct agents operating under that user. A constant `strict/pass` composition is not a live policy decision. Transport denial duplicated across adapters can drift, and remote MCP lacks a verified principal or capability. These gaps make delegation, revocation, provenance, and least privilege unverifiable.

## Goal

Define a future fail-closed model in which every protected operation has a trusted execution context, a live strict decision, current authorization, and—when mutating—a short-lived delegated capability whose action, resource, audience, workflow binding, and provenance are explicit.

## Users

- A local human operating SAC through a trusted CLI or Harness session.
- Multiple local agents acting for one user with separately attributable execution identities.
- Source owners and reviewers that need current, non-client-authored authority.
- Security operators who need one audit and transport-admission policy point.

## Requirements

1. SAC shall classify every request into exactly one declared mode: `local-single-user`, `local-multi-agent`, or `remote`.
2. `remote` shall remain a hard-denied, non-active mode. HTTP and other remote transports may not reach workspace discovery or SAC handlers until every remote abuse gate is explicitly approved; this package does not enable them.
3. `local-single-user` shall bind a trusted local OS/Harness principal and a session/execution instance; it shall not manufacture multi-agent or reviewer independence from one UID.
4. `local-multi-agent` shall issue distinct server-created execution identities for agents sharing an OS UID. Each identity is delegated from a verified local principal and is attributable in provenance.
5. Every protected operation shall obtain a live strict decision through the authoritative Security policy provider. Missing, stale, advisory, exception, or fail-open results deny access or mutation.
6. Mutation shall require a server-issued, short-lived delegated capability bound to a specific action, resource, audience, subject/execution identity, issuer/delegation chain, expiry, workflow binding where applicable, and policy/role revisions.
7. Authorization shall be re-evaluated at use, including role/capability status, workspace/resource visibility, workflow/session binding, owner authority, audience, and target conditions. Issuance alone shall not authorize a later action.
8. Client payloads, environment values, prompts, manifest display fields, and MCP parameters may carry non-authoritative display metadata only; they shall never create or widen role, reviewer, owner, or capability authority.
9. Transport admission/denial shall be centralized so all adapters receive the same decision and denial behavior. Adapters shall not implement independent HTTP/remote exceptions.

## Success criteria

- Two agents with one OS UID receive distinct execution identities and attributable delegation provenance.
- A revoked role or capability is denied at the next read or mutation without relying on token expiry alone.
- A capability for one action/resource/audience cannot be replayed, forwarded, or used to discover another workspace.
- Security policy outage/advisory/fail-open conditions produce a typed denial, not a synthetic pass.
- HTTP/remote transport remains denied before routing until all defined abuse gates pass and an explicit later activation decision exists.

## Risks

More identity checks can add latency and operational complexity. RP-06 accepts that cost for mutation and material reads; implementations should cache only non-authoritative metadata and revalidate the security-critical state at use. Future remote enablement also expands the threat model and must not be inferred from local-mode success.

## Recommendation

Deliver local execution identity and live strict policy composition first. Treat remote mode as a deliberately disabled contract and postpone any remote activation decision until the adversarial verifier suite proves replay, confused-deputy, token-passthrough, cross-workspace, and revocation resistance.
