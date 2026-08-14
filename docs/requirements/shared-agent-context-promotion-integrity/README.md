# Shared Agent Context — Promotion Semantics and Transaction Integrity
Version: 0.1.0

## Status

**Future / planned requirements.** This package defines the RP-04 target state only. It does not claim that the current SAC runtime implements these contracts.

## Purpose

RP-04 makes promotion from a Shared Agent Context (SAC) proposal to an owner-managed artifact explicit, independently reviewed, replay-safe, and recoverable after a process crash. It closes the integrity gaps identified in the 2026-08-14 SAC analysis without changing the principle that source owners control their own stores.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package status, scope, document index, and related requirements. |
| [prd.md](prd.md) | Product problem, goals, requirements, risks, and recommendation. |
| [specification.md](specification.md) | Normative interfaces, proposal matrix, transaction and receipt contracts. |
| [policies.md](policies.md) | Authority, review independence, validation, and non-bypass policies. |
| [artifact-lifecycle.md](artifact-lifecycle.md) | Immutable artifacts, state transitions, retention, recovery, and link-back lifecycle. |
| [metrics-and-validation.md](metrics-and-validation.md) | Acceptance, fault-injection matrix, negative tests, and operational measures. |
| [implementation-plan.md](implementation-plan.md) | Sequenced future delivery plan and exit criteria. |

## Scope

- Explicit, exhaustive proposal-kind and target semantics.
- Owner-rendered immutable preview and render-input digest.
- Reviewer independence and server-issued reviewer authority.
- Owner/workspace/proposal/revision-scoped idempotency and restart-safe recovery.
- Owner-target receipt plus workspace link-back receipt in one durable acceptance outcome.
- Opaque-ID, realpath, workspace-ownership, and target-containment validation.

## Non-goals

- Automatic acceptance or automatic promotion.
- SAC becoming a writer for Wiki, Memory, Skills, Flow, or any owner store.
- Client-authored reviewer identity or authority.
- A generic/catch-all Skill target for otherwise unsupported proposal kinds.
- Retroactively asserting correctness of existing proposal records or runtime behavior.

## Related packages

- [Shared Agent Context specification](../shared-agent-context/specification.md)
- [Shared Agent Context agent protocol](../shared-agent-context/agent-protocol.md)
- [Shared Agent Context artifact lifecycle](../shared-agent-context/artifact-lifecycle.md)

## Package acceptance status

This package is structurally complete when every linked document remains present, contains the version shown above, and its future-state language is preserved during implementation planning.
