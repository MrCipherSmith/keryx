# Shared Agent Context — Identity and Capability Implementation Plan
Version: 0.1.0

## Status

**Future / planned implementation plan.** No phase asserts that a capability issuer, remote verifier, network listener, SSO, or multi-tenant administration currently exists.

## Phase 1 — Contract and threat fixtures

- Freeze mode, execution-context, strict-decision, capability, provenance, and authorization-receipt schemas.
- Add fixtures for forged role, same-UID agents, stale policy, provider error, audience confusion, capability widening, replay, revocation, and remote probing.
- Define an explicit compatibility rule: unknown transport/mode/capability fields deny rather than guess.

**Exit:** semantic validation fails closed for every invalid fixture before any workspace or owner call.

## Phase 2 — Central live strict policy

- Introduce one injected live strict decision provider backed by the authoritative Security configuration.
- Replace constant/local pass composition in each protected SAC path with provider evaluation at admission and commit/disclosure.
- Make provider errors, advisory results, and stale revisions typed denials; preserve minimised receipt metadata.

**Exit:** fault injection shows no protected path continues after provider unavailability or non-strict outcome.

## Phase 3 — Local execution identities

- Establish trusted local principal resolution in CLI/Harness boundaries.
- Issue server-created execution identities for local multi-agent runs under the same principal/UID and persist minimal delegation provenance.
- Update reviewer/owner integrations to use canonical execution/principal context without permitting client role authority.

**Exit:** same-UID agents are distinguishable and cannot reuse each other's authorization references.

## Phase 4 — Capability issuance and authorize-at-use

- Implement opaque, short-lived capability storage/verification with narrow action/resource/audience/workflow scope and revocation status.
- Enforce delegation narrowing and continuous authorization at use and owner commit.
- Bind capabilities to owner writes and promotion integrity without allowing them to bypass owner guard paths.

**Exit:** scope, replay, forwarding, revocation, and role/policy/ACL-change tests pass across all local adapters.

## Phase 5 — Central transport admission

- Route all SAC ingress through one transport-admission service before workspace discovery.
- Remove duplicated adapter transport-allow/deny logic in favour of common typed denial rendering.
- Keep `remote` hard denied and add no HTTP listener, SSO path, remote issuer, or tenant management surface.

**Exit:** all adapters deny remote/HTTP/unknown transport identically and expose no workspace existence signal.

## Phase 6 — Deferred remote decision

- Run the complete abuse suite in a separately approved future security programme.
- Produce independent evidence for issuer/key lifecycle, verified-principal handling, replay resistance, confused-deputy resistance, revocation, logging, and incident response.
- Require an explicit human activation decision for a bounded rollout after review.

**Exit:** this phase intentionally has no automatic implementation or enablement outcome; absent explicit approval, remote remains denied.

## Dependencies and constraints

- Security must expose a live strict decision provider with versioned outcome semantics.
- CLI/Harness must offer a trusted local principal boundary; MCP must not supply its own authority model.
- Owner modules retain final target authorization and guarded write responsibility.
- RP-04 promotion integrity consumes these contracts but does not weaken reviewer independence or owner-controlled writes.
