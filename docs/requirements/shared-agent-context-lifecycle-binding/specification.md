# Shared Agent Context — Lifecycle Binding Specification
Version: 0.1.0

## Status

Future / planned specification. Names below describe intended contracts, not
currently available commands or agent tools.

## Identity and ownership

SAC owns only the binding record and derived discovery index. A binding joins
one trusted Session with one workspace and may carry one read-only Flow
reference. Session/Harness owns Session identity and completion; Flow owns work
state; owner systems own accepted artifacts; Context Operations owns assembly
traces. SAC never mutates a referenced Flow.

## Binding record

```text
LifecycleBinding {
  bindingId: opaque immutable ID
  schemaVersion: 1
  subjectHash: stable authenticated subject hash
  session: { id, revision }
  workspace: { id, revision }
  flow?: { ref, revision }
  worktree?: { commonDirHash, rootHash, derivationKind }
  createdAt, expiresAt?, status: active | completed | revoked | stale
  correlationId
}
```

The record contains no Session body, Flow body, workspace manifest body,
credential, prompt, model output, or owner-artifact content. Its identity
fields are immutable. Expiry, revocation and derived freshness are recorded as
append-only lifecycle events rather than rewriting identity.

## Creation and resolution

Creation requires a verified server-issued Session principal, an authorised
workspace reference, current revisions, and an optional visible Flow snapshot.
At most one active binding is usable for `(subject, session)` unless an explicit
resolver policy selects a single canonical binding; otherwise `current` returns
`binding_ambiguous` without enumerating hidden candidates.

Resolution by `current` re-checks principal, role revision, workspace ACL,
binding status and referenced revisions. `not_bound`, `binding_stale`, and
`binding_ambiguous` expose no foreign workspace ID. `access_denied` must be
indistinguishable from a non-visible binding to callers without visibility.

## Planned command and agent surface

| Surface | Planned behaviour |
|---|---|
| `keryx shell --workspace <id>` | Explicitly selects an authorised workspace for a local shell session; it does not serialize workspace content into environment or prompt. |
| `keryx workspace overview --session current` | Resolves only the caller's current valid binding, then performs the ordinary bounded overview. |
| `keryx workspace read --session current <ref>` | Resolves binding then runs ordinary ACL and addressed-read checks. |
| `workspace current` (agent-native) | Returns one authorised binding summary and references only. |
| `workspace list` (agent-native) | Lists only visible binding summaries with pagination and no content bodies. |
| `workspace derive --from-flow <ref> --worktree <path> --preview` | Returns proposed workspace references and warnings; no write, checkout, Flow mutation, or binding creation. |
| `workspace link-accepted <proposal-or-receipt>` | Explicit authorised request to attach an accepted target reference to the source workspace. |

All planned agent-native tools receive their actor from the trusted boundary;
they do not accept actor, subject, role, or arbitrary current-session identity
from tool arguments. A bare `--session current` is valid only where an
authenticated current Session is available; interactive shell fallback must ask
for an explicit workspace rather than guess.

## Flow/worktree derivation preview

A preview validates the Flow reference through the native read projection and
uses worktree/common-directory metadata only to propose workspace resource
references. It displays candidate root containment, collisions, ACL conflicts,
and stale revisions. It creates neither a workspace nor a binding. A later
explicit create operation may use the preview's digest only if all inputs are
fresh and the caller remains authorised.

## Completion and accepted-target link-back

On Session completion, SAC may append a `session-completed` association that
contains the binding ID, Session completion revision/time and correlation ID.
It is not a Flow status update and it does not manufacture a wrap-up,
proposal, review, acceptance, or target write.

An owner write produces the distinct intermediate proposal state
`owner-accepted`; the owner artifact and receipt remain valid independently of
SAC. The proposal reaches SAC terminal state `accepted` only after the required
link-back succeeds and both the target owner receipt and SAC link-back receipt
are durably bound to the same proposal revision and intent digest. A separate link-back
request verifies the owner target-write receipt, source binding/workspace,
current ACL, target visibility and idempotency key; it appends a
`link-back-pending` intent before adding only a target reference to the
workspace, then records the owner/SAC receipt. The action is never automatic,
including when proposal and workspace match. An unavailable/deleted workspace
returns a typed failure, leaves the owner artifact unchanged, and leaves the
proposal `owner-accepted` rather than `accepted` until an authorized retry
completes the receipt-bound link-back.

## Integration and acceptance criteria

Integrations are limited to trusted Harness/Session identity, native Flow read
projection, workspace registry, Context Operations read assembly, worktree
metadata, and owner acceptance receipts. The implementation is acceptable only
when all listed planned surfaces preserve bounded authorised reads, no Flow
mutation, no automatic promotion, no automatic link-back, and no disclosure of
hidden workspace/session metadata.
