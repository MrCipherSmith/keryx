# Shared Agent Context — Session, Workspace and Flow Lifecycle Binding
Version: 0.2.0

## Status

Future / planned requirements package. No behaviour in this package is a claim
about the current runtime.

**Scope narrowed (0.2.0):** automatic Session↔workspace↔Flow *binding* —
resolving or creating a workspace for the current task via model judgment,
and dispatching a proposal without a separate human command — is now owned
by [Keryx Slate v2](../slate/README.md) (SLATE-16…19), implemented with the
harness's existing tool-calling/model-judgment pattern rather than the
formal `LifecycleBinding` record, ACL, and subject-hash model this package
originally specified for that scope. This package's remaining, still-future
scope is unchanged: explicit `keryx shell --workspace <id>` selection,
`--session current` resolution, Flow/worktree derivation preview, and
accepted-target link-back (FR3–FR8 minus the parts SLATE-16 now covers) —
see `prd.md`/`specification.md` for the precise line.

## Purpose

Define an opt-in lifecycle binding between a trusted agent Session, a Shared
Agent Context (SAC) workspace, and an optional owner-controlled Flow. The
binding removes routine ID handoff without turning SAC into a Flow owner,
promoting content automatically, or injecting whole workspaces into a model.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package scope and navigation. |
| [prd.md](prd.md) | Product requirements and success criteria. |
| [specification.md](specification.md) | Planned identity, CLI, agent, and data contracts. |
| [agent-protocol.md](agent-protocol.md) | Rules for agent discovery, reads, resume, and completion. |
| [artifact-lifecycle.md](artifact-lifecycle.md) | Binding records, freshness, retention, and link-back lifecycle. |
| [metrics-and-validation.md](metrics-and-validation.md) | Measurable checks and validation matrix. |
| [implementation-plan.md](implementation-plan.md) | Incremental implementation plan and gates. |

## Scope

- Optional immutable Session → workspace binding, with an optional Flow
  reference.
- Trusted identity, resume, discovery, shell, agent-native and worktree
  derivation behaviour.
- Completion behaviour and an explicit accepted-target link-back proposal.

## Non-goals and invariants

- SAC does not own or mutate Flow state; native Flow commands remain the sole
  work-state channel.
- No automatic promotion, acceptance, or workspace link-back is allowed.
- No workspace, Session archive, Flow body, or accepted artifact is silently
  injected into model context. Reads remain authorised, bounded, and
  progressive.
- Visibility and error responses preserve least disclosure.

## Related modules

This package extends the future SAC surface and integrates only by reference
with Context Operations, Harness/Session, native Flow, workspace/worktree
metadata, and owner systems for Wiki, Memory, and Skills.
