# Shared Agent Context — Causal Collaboration and Worktree Overlays Specification
Version: 0.1.0

## Status and identity

**Future / planned normative specification.** Package ID: `shared-agent-context-collaboration-worktrees` (RP-08). It specifies reference-based collaboration; it does not create a collaboration chat service or modify Flow ownership.

## Ownership and storage structure

```text
<project-shared-store>/
  collaboration-events.jsonl   # CollaborationEvent only
  proposal-events.jsonl        # ProposalLifecycleEvent only
  base-workspaces/<workspace>/ # project-scoped, owner-controlled base
<checkout-private-store>/
  overlays/<workspace>/        # checkout-private facts/proposals/receipts/reservations
```

The shared store is selected from a canonical Project identity and explicit configuration, not from a sibling checkout path. Each ledger has its own writer/validator/version and append discipline. A later unified ledger must use `recordType` as an exhaustive discriminant and consumers must skip unknown future tags while rejecting malformed records for the tags they own.

## Causal event spine

`CollaborationEvent` is immutable metadata, not message content:

```text
CollaborationEvent = {
  schemaVersion, eventId, eventType,
  projectId, cloneId?, checkoutId?, workspaceId?, overlayId?,
  occurredAt, actorRef, executionRef, causedByEventId?, causalRootId,
  workflowRef?, artifactRefs[], reservationRef?, visibility,
  payload: typed-by-eventType
}
```

Allowed `eventType` values are exactly `dispatch`, `reservation`, `result`, `handoff`, `verifier`, `receipt`, and `proposal`. `payload` is an exhaustive nested schema for that tag and may contain bounded labels, intent summaries, result classifications, and typed references only. It must reject `transcript`, `prompt`, `message`, arbitrary text blobs, credential fields, hidden reasoning, and untyped path fields. `artifactRefs` identify owner-managed artifacts by typed logical reference and revision/digest. Each reference carries only visibility-safe `trust`, `sensitivity`, `retentionClass`, and `deletionState` labels/state references inherited from RP-05, never protected content. Consumers re-authorize and resolve current owner state at use. Trust cannot be upgraded, sensitivity cannot be lowered, and a restricted, deleted, withdrawn, or owner-inaccessible reference yields a typed denied/unresolved outcome.

`causalRootId` identifies one collaboration thread; `causedByEventId` must refer to an earlier visible event in the same Project/workspace scope. The spine describes causality, not authority: every referenced owner operation independently authorizes at use.

## Public handoff writer

The planned server-owned operation `recordHandoff` accepts a `HandoffDraft` only after trusted actor/execution resolution, mode/transport admission, workspace/project visibility, schema validation, live security policy, reference containment checks, and RP-06 authorize-at-use. It MUST consume a current short-lived `DelegatedCapability` bound to action `collaboration.record-handoff`, the exact Project/workspace/Checkout resource, recipient audience, and workflow. Revoked, expired, missing, wrong-audience, wrong-workflow, cross-project, or cross-checkout capabilities deny before append. It writes one `handoff` event and returns a receipt reference. Planned CLI, MCP, and Harness adapters normalize to this same operation; no adapter may write a ledger file directly.

A handoff contains recipient audience/reference, bounded purpose, causal parent, artifact references/revisions, optional reservation reference, and expiry. It does not contain Flow status, copied knowledge, or an authorization grant. A failed validation reveals no hidden workspace or artifact existence.

## Reservations

`Reservation` is a typed collaboration artifact:

```text
Reservation = { reservationId, projectId, workspaceId?, checkoutId,
                scopeRefs[], intentDigest, createdAt, expiresAt,
                actorRef, executionRef, state: active | released | expired }
```

Scope references can name components, logical files, graph symbols, or task areas. A reservation is advisory only: it is a duplicate-work hint, not a file lock, ACL, workflow claim, target write permit, or Flow state mutation. Readers may warn, coordinate, or proceed. Crash/expiry automatically makes it inactive; release is idempotent. An active reservation never blocks owner-controlled writes that otherwise pass authorization.

Reservation creation and release each consume a current RP-06 short-lived `DelegatedCapability` bound to their exact action, Project/workspace/Checkout resource, audience, and workflow. Release authority is re-evaluated at use; possession of a reservation ID is never sufficient.

## Project, Clone, and Checkout identity

| Identity | Meaning | Authority rule |
|---|---|---|
| `ProjectId` | Stable logical project identity rooted in configured repository common-dir/repository identity. | Establishes the share namespace only after explicit membership checks. |
| `CloneId` | One independently cloned repository instance associated with a Project. | Identifies portability/provenance; does not inherit access. |
| `CheckoutId` | One worktree/checkout within a Clone. | Identifies a private overlay; its filesystem path is diagnostic/resolution input only. |

Canonical IDs are parsed before storage lookup. Realpath containment protects each configured root, but proximity, common parent directory, matching branch, or same UID never proves membership or grants access. An import/publish operation verifies project membership, trusted identity/capability, and visibility policy separately.

## Base, overlay, and portable bundle model

`BaseWorkspace` is a project-scoped, owner-controlled, read-only collection of typed source references and published collaboration events. `CheckoutOverlay` is private to one Checkout and carries only overlay-local facts, proposal references, receipts, reservations, and unpublished collaboration drafts/events. It cannot overwrite base entries.

`OverlayDelta` lists additions, withdrawals, and revision-aware reference changes. Publishing invokes a reviewed, owner-controlled base writer; it validates every referenced artifact and consumes a current RP-06 capability bound to `overlay.publish`, the exact Project/workspace/source Checkout/base resource, audience, and workflow before writing a receipt. There is no automatic merge, no automatic promotion, and no copying of another overlay's private content.

`PortableContextBundle` contains `ProjectId`, optional source `CloneId`/`CheckoutId` provenance, base workspace revision/digest, allowed typed artifact references/revisions with visibility-safe trust/sensitivity/retention/deletion labels, causal checkpoint, compatibility version, and expiry. It excludes absolute paths, raw transcript/prompt content, credentials, private overlay entries, and authorization capability material. Export and import independently consume current RP-06 capabilities bound to their exact action, Project/workspace/Checkout resource, audience, and workflow. Import then re-authorizes and resolves every reference under the recipient's configured roots and treats restricted, deleted, withdrawn, unresolved, or stale references as denied/unresolved, never as copied fallback content.

## Planned surface and acceptance criteria

Planned operations are `collaboration.record-handoff`, `collaboration.list`, `collaboration.show`, `reservation.create/release/list`, `overlay.export`, `overlay.publish`, and `bundle.export/import`. They are future contracts, not current command claims.

- Separate ledgers or a safe tagged union prevent proposal/collaboration schema collision.
- Handoff->proposal->review->receipt->collaboration read succeeds in one mixed-lifecycle corpus.
- Reservation expiry/release survives crash and never blocks an otherwise authorized actor.
- Project-shared base visibility and checkout-private overlay isolation hold across sibling worktrees and separate clones.
- No event, bundle, or overlay duplicates Flow state or carries raw transcript content.
