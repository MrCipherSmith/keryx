# Shared Agent Context — Collaboration and Worktree Artifact Lifecycle
Version: 0.1.0

## Status

**Future / planned lifecycle.** Current activity files and worktrees are not retroactively converted by this document.

## Artifact lifecycles

| Artifact | States | Writer and rule |
|---|---|---|
| Collaboration event | validated -> appended -> visible -> expired/retained | Public collaboration writer only; append-only. |
| Proposal lifecycle event | owner-defined proposal states | Proposal writer only; never appended to collaboration ledger by shape accident. |
| Reservation | active -> released | expired | Collaboration writer; TTL hint only. |
| Checkout overlay entry | private-draft -> published-delta | withdrawn/expired | Checkout owner writes private storage; base writer accepts reviewed delta. |
| Base workspace entry | published -> superseded/withdrawn | Project/base owner only. |
| Portable bundle | exported -> imported | expired/unresolved | Export/import validates identity, digest, references, and containment. |

## Ledger integrity and mixed consumption

Each append receives a schema version, record ID, durable sequence/checkpoint, timestamp, actor/execution provenance, and scope binding. A collaboration reader reads only `collaboration-events`; a proposal reader reads only `proposal-events`. If a future migration combines streams, the migration writes explicit `recordType` tags and every consumer filters tags before parsing payload. Unknown tags are retained/ignored by a non-owning reader; malformed owned tags cause a typed local error without corrupting or deleting records.

## Reservation lifecycle

Creation emits a `reservation` event and records expiry. No renewal extends another actor's reservation; renewal creates or updates only the caller's validated reservation according to policy. A crash has no special ownership effect: after `expiresAt`, the reservation is inactive. A release event is idempotent. Retention preserves minimal causal metadata, never a transcript or change content.

## Overlay publishing and bundle portability

Private overlay entries are visible only through the checkout's authorised owner. Publishing produces a reviewed `OverlayDelta`, validates that its base revision and references remain current, appends a receipt/provenance event, then updates the base through its owner. Conflicts result in a non-published delta; they do not merge private data automatically.

Bundle export captures a base checkpoint and allowed references. Import verifies ProjectId and audience/membership before resolution; it never accepts its embedded CloneId/CheckoutId/path as authority. A missing or changed reference is marked unresolved/stale, not copied into a new owner store.

Handoff, overlay, and bundle references retain only visibility-safe trust, sensitivity, retention, and deletion state labels. Resolution re-authorizes against the current owner state. Sensitivity cannot be lowered and trust cannot be raised; source restriction, deletion, or owner withdrawal makes the reference denied/unresolved across checkouts and portable bundles.

## Causal retention

Event causal links may outlive individual retained payload metadata as tombstone references. Pruning must preserve enough identifier, type, time, scope, and digest information to explain a causal gap without retaining raw content. No lifecycle transition creates a duplicated Flow snapshot/state.
