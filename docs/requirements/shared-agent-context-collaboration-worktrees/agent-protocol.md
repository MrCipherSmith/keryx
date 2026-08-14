# Shared Agent Context — Collaboration and Worktree Agent Protocol
Version: 0.1.0

## Status

**Future / planned protocol.** Agents must not claim the planned collaboration writer, reservations, or overlays are currently available.

## Collaboration behavior

1. Publish only a server-validated handoff with typed artifact references, bounded purpose, causal parent, and permitted audience.
2. Do not send raw transcript, prompt, hidden reasoning, credentials, copied source content, or a free-form chat message through collaboration.
3. Treat a handoff as an informational reference, not a permission grant or a Flow assignment.
4. Follow owner references and current authorization checks before relying on a handoff result.
5. Present a current RP-06 short-lived delegated capability for every public mutation. Handoff recording binds action, Project/workspace/Checkout, recipient audience, and workflow; revoked, expired, or mismatched bindings are denied at use.

## Reservation behavior

An agent may create a short TTL reservation for a logical work scope before substantial work. It must state intent without claiming exclusive ownership. On observing another active reservation, it coordinates if possible or proceeds when authorised; it must not wait indefinitely, edit another reservation, or represent a hint as a lock. It releases its own reservation on completion when possible and treats expiration/crash as normal.

Reservation create/release separately authorize at use with action/resource/audience/workflow-bound capabilities; the reservation identifier grants no authority.

## Worktree and bundle behavior

An agent treats base workspace context as read-only and its checkout overlay as private. It may prepare an explicit reviewable delta but cannot publish automatically or read a sibling overlay because paths are nearby. A portable bundle is a reference package, not an access capability: the agent reauthorizes and resolves each reference after import.

Overlay publish and bundle export/import also require their own current RP-06 capability. Trust/sensitivity/retention/deletion labels propagate as visibility-safe state references, and restricted, deleted, or owner-withdrawn artifacts cannot be recovered from a handoff or bundle.

## Flow and reporting behavior

Agents read work state from Flow and use Flow-native operations for any task-state change. A handoff may link a Flow snapshot/reference but must not restate or update completion, blockers, acceptance criteria, or task ownership as an authoritative collaboration record. Reports should cite event/artifact IDs, not raw contents.

## Required protocol tests

- Client direct-ledger write and malformed nested handoff payload are denied.
- A raw transcript/message field cannot be published.
- A reservation cannot deny another authorized actor or mutate Flow.
- A sibling checkout cannot read a private overlay based on filesystem proximity.
- Bundle import with altered project identity, expired reference, or escaped path fails closed or reports unresolved references.
- Handoff, reservation create/release, overlay publish, and bundle export/import deny revoked, expired, missing, wrong-audience, wrong-workflow, cross-project, and cross-checkout capabilities before mutation.
