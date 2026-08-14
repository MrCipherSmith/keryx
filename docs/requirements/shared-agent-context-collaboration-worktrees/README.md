# Shared Agent Context — Causal Collaboration and Worktree Overlays
Version: 0.1.0

## Status

**Future / planned requirements.** RP-08 defines a future metadata-only collaboration and worktree model. It does not claim that a public collaboration writer, shared overlay, or cross-worktree runtime behavior exists today.

## Purpose

Provide safe agent handoff and parallel-work context without a shared raw-transcript bus, duplicate Flow state, unsafe mixed ledgers, or filesystem-proximity authority.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package status, scope, and index. |
| [prd.md](prd.md) | Problem, goals, requirements, risks, and recommendation. |
| [specification.md](specification.md) | Normative event spine, ledgers, identities, overlays, and interfaces. |
| [agent-protocol.md](agent-protocol.md) | Future agent conduct for handoff, reservation, and overlay publishing. |
| [artifact-lifecycle.md](artifact-lifecycle.md) | Event, reservation, bundle, and overlay lifecycles. |
| [metrics-and-validation.md](metrics-and-validation.md) | Mixed-lifecycle corpus and multi-worktree validation. |
| [implementation-plan.md](implementation-plan.md) | Phased future delivery and activation gates. |

## Scope

- Separate/tagged append-only ledgers and metadata-only causal collaboration events.
- A public, validated handoff writer for CLI, MCP, and Harness parity.
- TTL reservations as duplicate-work hints, never locks or authority.
- Explicit Project, Clone, and Checkout identities.
- Portable bundles and a read-only base plus private overlay model.

## Non-goals

- A shared raw transcript, prompt, hidden-reasoning, or chat bus.
- Another source of Flow task state, completion, or acceptance criteria.
- Access inferred from checkout location, sibling worktree proximity, or common filesystem ownership.
- Automatic overlay publish/merge or mutation of another agent's checkout.

## Related requirements

- [Shared Agent Context specification](../shared-agent-context/specification.md)
- [Shared Agent Context agent protocol](../shared-agent-context/agent-protocol.md)
- [Keryx Multi-Agent Engine](../keryx-multi-agent-engine/README.md)

## Completion condition

Documentation completion requires every linked file to be present, versioned, future-statused, and internally consistent. Any future runtime activation must satisfy the corpus in [metrics-and-validation.md](metrics-and-validation.md).
