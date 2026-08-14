# Shared Agent Context — Identity, Capabilities, and Continuous Authorization
Version: 0.1.0

## Status

**Future / planned requirements.** This RP-06 package specifies a future security model only; it does not enable remote transport, SSO, multi-tenant administration, or new runtime behavior.

## Purpose

RP-06 replaces identity assumptions based solely on a local operating-system UID and hard-coded security passes with explicit execution identities, live strict policy decisions, bounded delegated capabilities, continuous authorization, and one central transport-admission boundary.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package status, scope, and index. |
| [prd.md](prd.md) | Problem, goals, requirements, risks, and recommendation. |
| [specification.md](specification.md) | Normative modes, identity/capability contracts, policy composition, and transport rules. |
| [policies.md](policies.md) | Non-bypass policy, delegation, revocation, and remote-denial rules. |
| [agent-protocol.md](agent-protocol.md) | Future agent behavior for capability use and denial handling. |
| [metrics-and-validation.md](metrics-and-validation.md) | Security gates, abuse tests, and future-only measures. |
| [implementation-plan.md](implementation-plan.md) | Sequenced future implementation and activation gates. |

## Scope

- Explicit `local-single-user`, `local-multi-agent`, and reserved `remote` modes.
- Live strict security-policy composition at every protected operation.
- Short-lived, action/resource/audience-bound delegated capabilities for mutation.
- Continuous authorization and provenance across proposer, reviewer, executor, and owner writer.
- Centralized, fail-closed transport admission and remote/HTTP denial.

## Non-goals

- Enabling HTTP, remote MCP, SSO, or multi-tenant administration.
- Treating a caller-provided role, agent ID, token payload, or prompt claim as authority.
- Replacing source-owner authorization or guarded write checks.
- Trusting shared OS UID as sufficient agent identity in local multi-agent mode.

## Related requirements

- [Shared Agent Context agent protocol](../shared-agent-context/agent-protocol.md)
- [Shared Agent Context specification](../shared-agent-context/specification.md)
- [Promotion semantics and integrity](../shared-agent-context-promotion-integrity/README.md)

## Package completion condition

The package is complete as documentation when its linked files remain present, versioned, future-statused, and internally consistent. Runtime activation requires the separate gates in [metrics-and-validation.md](metrics-and-validation.md).
