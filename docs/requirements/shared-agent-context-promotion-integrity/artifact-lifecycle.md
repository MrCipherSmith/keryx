# Shared Agent Context — Promotion Integrity Artifact Lifecycle
Version: 0.1.0

## Status

**Future / planned lifecycle.** Existing SAC artifacts are not retroactively reclassified by this document.

## Authoritative artifacts

| Artifact | Writer | Mutability | Required binding |
|---|---|---|---|
| Proposal revision | SAC | Immutable | workspace, proposer, kind/target, canonical content/evidence digest. |
| Preview bundle | Target owner, retained by SAC as metadata | Immutable | proposal revision, owner/target, complete render-input and rendered-byte digests. |
| Review decision | SAC | Append-only | independent reviewer context, preview digests, authority/policy revision. |
| Pending-write intent | SAC | Append-only | stable intent ID, scope, binding digest, decision and preview references. |
| Target-write receipt | Target owner | Durable/immutable | intent ID, binding digest, idempotency scope, target revision/digest. |
| Workspace link-back receipt | SAC workspace service | Durable/immutable | intent, target receipt, target typed reference and workspace revision. |
| Transition event | SAC | Append-only | prior event, actor metadata, outcome and all required receipt references. |

## State machine

```text
proposed -> previewed -> reviewed-approved -> pending-write
proposed|previewed|reviewed-approved -> rejected | dismissed | stale
pending-write -> pending-link-back -> accepted
pending-write|pending-link-back -> recovery-required | failed-nonaccepted | stale
recovery-required -> pending-write | pending-link-back | accepted | failed-nonaccepted
```

`reviewed-approved` grants no write authority by itself. `accepted` is terminal for that proposal revision. Corrections create a new proposal revision that links to the earlier target; no event or receipt is overwritten.

## Transition rules

1. `proposed` has no mutable auxiliary target content.
2. `previewed` records the owner preview bundle. The preview can be regenerated only to verify equality; unequal output makes the prior preview stale.
3. `reviewed-approved` records a server-derived independent reviewer and exact digest bindings.
4. `pending-write` is durable before owner invocation and has the restart-stable intent/binding identity.
5. The owner can produce `TargetWriteReceipt` only after the owner-controlled atomic target/receipt commit.
6. SAC creates `pending-link-back` after validating the target receipt and before changing the workspace manifest/reference ledger.
7. `accepted` records both receipts and their mutual binding. It is not inferred from a file existing.

## Crash and restart recovery

Recovery starts from durable state, not process memory or request correlation. It uses `intentId`, full idempotency scope, and `bindingDigest`; a fresh process correlation is recorded as an attempt annotation only.

| Crash point | Required durable state | Recovery action | Permitted outcome |
|---|---|---|---|
| Before pending intent commit | No intent | Do not call owner; caller may submit a new request. | Proposed/reviewed only. |
| After intent, before owner call | Pending-write | Owner receipt lookup, then one idempotent promote if absent. | Target receipt or non-accepted failure. |
| During owner transaction | Pending-write | Owner transaction/journal resolves commit vs rollback, then lookup. | Exactly one receipt/mutation or none. |
| After owner commit, before response | Pending-write | Lookup returns matching receipt; never blindly write again. | Pending-link-back. |
| After receipt validation, before link-back commit | Pending-link-back | Verify receipt and idempotently write link-back. | Accepted or recovery-required. |
| During workspace link-back transaction | Pending-link-back | Workspace journal resolves commit, then receipt/link lookup. | One link-back or none. |
| After link-back, before accepted event | Pending-link-back | Verify both receipts and append accepted once. | Accepted. |
| After accepted event acknowledgement loss | Accepted | Return recorded terminal result for same binding. | No new owner call. |

An owner receipt for the wrong proposal/revision/workspace is a binding conflict, not recovery evidence. If a required store cannot determine outcome safely, the proposal remains `recovery-required` and requires an authorised operational resolution; it must not be auto-accepted.

## Retention and minimisation

Retain proposal/decision/intent/receipt metadata under applicable audit policy. Preview content is retained only when policy permits; its immutable digests and owner reference are required even if the preview bytes are later expired. Records contain no raw transcript, hidden reasoning, secret, or copied owner artifact. Deleting/archiving an owner target marks the workspace typed reference `unresolved`; it does not create a copied fallback.
