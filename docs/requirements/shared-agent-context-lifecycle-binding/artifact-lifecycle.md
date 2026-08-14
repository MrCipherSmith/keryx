# Shared Agent Context — Lifecycle Binding Artifact Lifecycle
Version: 0.1.0

## Status

Future / planned lifecycle. It complements the SAC artifact lifecycle and does
not replace owner retention rules.

## Artifacts and authority

| Artifact | Owner | Lifecycle | Content policy |
|---|---|---|---|
| Lifecycle binding | SAC | active → completed/stale/revoked → retained/deleted | Minimal immutable identity metadata only. |
| Binding event | SAC append-only log | created/resolved/completed/revoked/link-back outcome | Correlation, revisions, outcome; no content body. |
| Flow reference | Native Flow | owner-defined | Read-only projection; SAC never writes it. |
| Derivation preview | SAC transient response | generated → expired | References, warnings, digest only; no mutation. |
| Accepted target | Wiki/Memory/Skill owner | owner-defined | SAC retains a reference/receipt only. |
| Link-back intent/event | SAC + workspace registry | pending → linked/failed | Idempotency and receipt metadata; no copied artifact. |

## Binding lifecycle

```text
create(active) → resolve* → session-completed → retain/archive
      └────────→ stale | revoked → deny resolution
```

`resolve` never changes the immutable binding. A Session end may append
`session-completed`, but binding retention is independent from Session archive
retention. Revision mismatch, expired Session authority, changed ACL, deleted
workspace, or non-visible Flow makes a binding stale or unusable. A new active
binding requires fresh explicit creation; it must not overwrite the old record.

## Completion and handoff

Completion captures only a trusted completion revision/time and correlation.
It does not preserve a raw Session transcript as lifecycle content, mutate a
Flow, or create/accept a proposal. A handoff recipient must resolve its own
authorised binding; a prior agent's binding is not transferable by sharing an
ID or transcript.

## Accepted-target link-back lifecycle

```text
owner-accepted (owner artifact and target receipt durable)
  → explicit link-back request
  → pending intent
  → workspace reference linked + SAC receipt → proposal accepted
  → typed failure → remains owner-accepted
```

The target owner write is never rolled back because a workspace link-back
fails, but the proposal does not reach terminal `accepted` until both receipts
are bound. Link-back verifies receipt and current access at execution time, uses an
owner/workspace idempotency key, and adds only a reference with target revision
and provenance. Repeated same-key calls return the original outcome; conflicting
or late calls do not rewrite terminal history. Automatic link-back is prohibited.

## Retention, deletion and disclosure

Bindings and events retain only policy-permitted audit metadata. Delete derived
events before source-of-truth workspace/owner artifacts when retention permits.
Deletion or archival revokes normal discovery; reads return an unresolved or
non-disclosing result rather than a cached content fallback. No lifecycle record
may become a hidden archive of workspace, Session, Flow, or accepted-target
content.
