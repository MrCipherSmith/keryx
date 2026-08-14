# Shared Agent Context — Promotion Semantics and Transaction Integrity Specification
Version: 0.1.0

## Status and identity

**Future / planned normative specification.** Package ID: `shared-agent-context-promotion-integrity` (RP-04). It extends SAC promotion requirements while preserving source-owned knowledge and Flow ownership.

## Ownership boundary

| Concern | Authoritative writer | SAC role |
|---|---|---|
| Proposal, decision, durable intent, workspace link-back | SAC workspace service | Stores immutable metadata and links only. |
| Wiki decision/risk artifact | Wiki owner | Renders, validates, guards, writes, receipts. |
| Memory note | Memory owner | Renders, validates, guards, writes, receipts. |
| Flow follow-up | Flow owner | Renders, validates, guards, writes, receipts. |
| Requirements/spec contract artifact | Requirements-document owner | Renders, validates, guards, writes, receipts. |
| Explicit skill change | Skills owner | Renders, validates, guards, writes, receipts. |

SAC must not directly write any owner store. An owner must not directly modify the SAC workspace manifest or receipts.

## Exhaustive proposal kind and target matrix

`proposal.kind` and `proposal.target.type` are independent, closed enums, but only these pairs are valid. Each row identifies exactly one owner and renderer.

| Kind | Permitted target type | Owner | Required target intent |
|---|---|---|---|
| `summary` | `memory-note` | Memory | Named memory collection and applicability scope. |
| `decision` | `wiki-decision` | Wiki | Decision/ADR collection, stable subject, and optional supersedes reference. |
| `follow-up` | `flow-follow-up` | Flow | Existing Flow reference, requested follow-up title, and non-authoritative proposed fields. |
| `risk` | `wiki-risk` | Wiki | Approved risk-register collection, risk title, impact/likelihood inputs. |
| `contract-change` | `requirements-contract` | Requirements-document owner | Existing requirements package, approved document class, and base revision. |
| `skill-change` | `project-skill` | Skills | Existing skill or approved new skill identifier and declared change class. |

`skill-change` is the only kind allowed to target Skills. `decision`, `follow-up`, `risk`, `contract-change`, `summary`, unknown kinds, missing targets, and a mismatched pair must be rejected before rendering. There is no default owner, generic note target, or catch-all Skill fallback. A caller cannot name a filesystem path as a target; target intent contains typed owner locators only.

## Immutable proposal and preview bundle

Creation persists an immutable proposal revision with canonical UTF-8 content, evidence references/revisions, proposer subject, target intent, and `proposalContentDigest`. Mutable notes, sidecars, or post-creation attachments are forbidden. A material correction creates a new proposal revision.

For a valid pair, the owner produces a `PreviewBundle` before review:

```text
PreviewBundle = {
  proposalId, proposalRevision, workspaceId, owner, targetType,
  targetLocator, targetBaseRevision?, renderedBytesDigest,
  renderInputsDigest, rendererId, rendererVersion, renderedAt,
  previewReference, securityPolicyRevision, redactionPolicyRevision
}
```

`renderInputsDigest` is a canonical digest of every value that can affect rendered bytes or target selection: proposal canonical content and digest; proposal kind; workspace ID; owner and target type; target logical locator and base revision; renderer/template ID and version; owner configuration/collection mapping revision; ordered evidence IDs, revisions and any owner-rendered extracts; deterministic transformation, validation, redaction, locale, timezone, and line-ending policies; and approved target metadata such as title, tags, supersedes, severity, impact, or likelihood. The owner must reject undeclared render input. SAC stores the bundle as immutable metadata and does not re-render it.

Review approval binds `proposalId`, `proposalRevision`, `workspaceId`, `owner`, `targetType`, `renderedBytesDigest`, `renderInputsDigest`, and the security/redaction policy revisions. An owner must render again immediately before write and compare both digests. Any mismatch returns `preview_stale`; the decision cannot be reused.

## Review authority and independence

The review endpoint accepts no actor, role, reviewer, or owner-authority field from a caller. The trusted server boundary resolves the current `ActorContext` at decision time, including subject, authority, role revision, trusted principal reference, and policy eligibility.

For an accepting decision, all are required:

1. The reviewer has current owner-specific review authority.
2. Reviewer and proposer canonical subjects differ.
3. The reviewer is not a delegated alias, service principal, or role grant controlled by the proposer, as determined by the identity/authority policy.
4. The reviewer did not create the immutable proposal revision or its preview bundle.
5. Evidence, ACL, target base revision, preview bundle, and live strict security decision are fresh.

The system may record a same-subject rejection but must not reveal hidden target detail. There is no local/single-user auto-accept exception and no client-authored reviewer authority.

## Durable intent, idempotency, and receipts

After an accepting review, SAC appends a durable `pending-write` intent before invoking the owner. Its immutable binding includes `intentId`, `bindingDigest`, owner, workspace ID, proposal ID, proposal revision, owner operation (`promote`), target type/locator, reviewer decision reference, preview digests, policy revisions, and a derived owner idempotency key.

The owner idempotency scope is exactly:

```text
(ownerId, workspaceId, proposalId, proposalRevision, operation = promote)
```

The key is generated or deterministically derived by trusted services from that scope and `bindingDigest`; a caller-provided arbitrary key is not accepted. Owner receipt lookup requires the entire scope plus `bindingDigest`, not just an owner/workspace/key tuple. Any field mismatch is `idempotency_binding_conflict`, never a reused receipt.

`processCorrelationId` identifies one transport/process attempt only. It is diagnostic and may differ after retry or restart; it is not a recovery lookup key and must not invalidate an otherwise matching intent. `intentId` and `bindingDigest` are restart-stable.

The owner performs target mutation and durable `TargetWriteReceipt` in one owner-controlled atomic transaction or equivalently recoverable owner journal. A receipt includes owner, intent ID, binding digest, complete idempotency scope, target logical reference, target revision/digest, outcome, and commit time. A target write without a retrievable matching receipt is not considered successful.

After obtaining the receipt, SAC uses its own workspace transaction to append a `WorkspaceLinkBackReceipt` that binds workspace ID, proposal/revision, intent, target receipt reference/digest, target logical reference/revision, and link state. It adds only a typed reference; it never copies owner content. SAC appends `accepted` only when both receipts are durable and mutually bound. A failed link-back leaves `pending-link-back`, not `accepted`; recovery repeats receipt lookup and idempotent link-back.

## Validation and containment

1. Parse `workspaceId`, `proposalId`, revision, target type, owner, and intent ID as bounded opaque IDs before any path construction.
2. Resolve the proposal only through the requested workspace's canonical registry; verify the loaded record's workspace ID equals the request and durable intent before use.
3. Resolve target locators through the selected owner registry, never directly from a caller path.
4. Reject absolute paths, network locations, encoded traversal, symlink escape, unknown schemes, and locators outside the configured owner root. Apply `realpath` containment after resolution and again immediately before write.
5. Check workspace membership, owner authority, target ownership, base revision, and security policy after resolution and immediately before commit. Any change fails closed.

## Planned surface and result codes

Planned server-owned operations are `propose`, `preview`, `review`, `promote`, `recover-promotion`, and `workspace-link-back`. Adapters may expose them only after enforcing the same server-side contract. Relevant typed failures include `unsupported_proposal_target`, `preview_stale`, `reviewer_not_independent`, `reviewer_authority_denied`, `idempotency_binding_conflict`, `workspace_mismatch`, `unsafe_locator`, `target_changed`, `owner_receipt_missing`, and `link_back_pending`.

## Acceptance criteria

- Each matrix row selects one owner and every other pair is rejected with no owner call.
- Review approval is invalidated by any render-affecting input mutation.
- An accepted event has an independent reviewer, a current strict security pass, a matching owner receipt, and a matching workspace link-back receipt.
- Recovery converges using intent/binding identity across fresh process correlation IDs.
- Owner and SAC writer boundaries remain one-way and no path permits automatic acceptance.
