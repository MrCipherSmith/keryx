# Flow supersession specification
Version: 0.1.0

Status: future; normative design, not a description of an existing endpoint.

## Identity and integration

Capability: human supersession of a non-running Team Hub Flow. Integrate with Hub project authorization, transactional Flow storage, version checks, audit history, context pins, Flow detail and board queries. Reuse existing Flow identifiers and project identity. No new CLI, agent tool, background action, manifest or user configuration is required. An agent may read closure evidence but cannot perform closure.

The future implementation must select a human-authenticated UI/API route and its concrete request/response schema before coding. This package defines semantic fields and invariants only; it introduces no JSON body or endpoint spelling and therefore no schema file. A later wire-contract document must link its schema from this package before that contract is implemented.

## Data and storage contract

Persist a closure record associated with the source Flow: disposition `superseded`, nonblank reason, replacement Flow identifier, server-authenticated human actor identifier, server UTC timestamp, and audit event identifier. Preserve the original execution phase and expose an effective closed disposition separately; do not add `superseded` to historical phase enums. Missing closure metadata on older records means open.

The operation's semantic inputs are source identifier, replacement identifier, reason, expected source version, expected replacement version and idempotency key. Versions are mandatory concurrency tokens, using the authoritative Flow version scheme; checking `ready` alone is insufficient. Closure advances the source's mutation version without changing its frozen specification digest, acceptance criteria or context pin. The replacement is read and validated under concurrency protection and is not mutated.

Persist the closure record, source version advancement, audit event and idempotency result in one transaction. Retain prior events, specifications, attachments and pins without rewriting or deleting them. Audit history records the pre-closure phase, reason, replacement, actor, time and before/after source versions. Retain successful idempotency results for the lifetime of the closure. Reopen, undo and deletion are not part of this release.

## Authorization, validation and transaction

Authenticate first and require a human principal authorized to mutate the source project and read the replacement. Never accept an actor or timestamp supplied by the caller as authoritative; reject agent/service credentials even when they otherwise have project write access.

For a new operation, atomically verify both expected versions, source open disposition, source phase `initializing` or `ready`, existing same-project replacement with open disposition, distinct identifiers and absence of a directed supersession cycle. Traverse retained supersession links when checking cycles, including imported historical records; do not infer acyclicity only from current open-state rules. A replacement may be in progress: the initial restriction applies to the source. No replacement completion or acceptance is required.

Use a transaction/lock discipline that serializes closure against start, freeze and any competing source mutation, and protects the validated replacement against concurrent closure/version change. A failed validation leaves no event, closure or version change. Return distinguishable authorization, validation, closed/conflict and stale-version outcomes in the eventual wire contract.

Scope an idempotency key to project, authenticated actor and source operation. After authorization, an identical successful replay returns the original closure result, including original timestamp/event/version, even though its expected versions are now old. A changed reason, replacement or expected version under that key is a conflict. A different key after closure is a closed/conflict result, never a second event. Failed attempts do not reserve a successful result; a retry must still satisfy current versions.

## State and event matrix

| Source condition/action | Result | Persisted event and effect |
|---|---|---|
| Open `initializing` or `ready`; valid human closure | Closed, disposition superseded; historical phase retained | Exactly one supersession audit event and source version increment |
| In progress, submitted, accepted, done, failed, cancelled, or any other phase | Reject closure | None; no active cancellation |
| Eligible source with running/queued operation able to mutate it | Reject closure as busy | None; clear stale/busy state through its existing lifecycle first |
| Closed source; identical successful replay | Return original result | No new event or mutation |
| Closed source; new operation | Reject | None |
| Closed source; freeze/start/submit/accept or another advancing mutation | Reject server-side | None; read/history still work |
| Invalid link, reason, authorization or expected versions | Reject | None |
| Replacement advances or closes during validation | Reject stale/conflict or serialize before it changes | No partial closure |

Busy detection is required even if the source's phase appears eligible. This feature must not cancel, abandon, detach or silently forget queued work or running sessions. Active cancellation and subsequent closure need a separate specification.

## UI, read compatibility and discovery

In both English and Russian, eligible detail pages expose “Close as superseded” / “Закрыть как заменённый”, mandatory reason, same-project replacement selection and a confirmation showing both identifiers. Reload current versions before submission; show conflicts and require fresh review instead of automatically retrying a changed decision. Ineligible or busy sources show an explanation. Server checks remain authoritative.

Closed detail displays a prominent closed-as-superseded label, historical phase, reason, actor, time, audit history and replacement link. The replacement detail shows a readable incoming historical link without changing its version, specification or pin. Provide localized active/default, closed-only and all board filters and a direct closed-history route. Counts follow the selected filter; closed source detail remains available through existing authorized detail routes.

Keep existing phase values and identifiers stable and append closure fields to compatible read contracts. Active work queries, including legacy default listings and agent queues, exclude closed records server-side. Old clients may ignore metadata, but cannot list closed drafts as actionable work or mutate them using old routes. Historical/all queries must explicitly request closed records. Verify any strict legacy decoder before choosing the additive wire shape; version or negotiate the response if it would reject additive fields. Backward compatibility cannot depend on old clients implementing new checks.

## Acceptance criteria

Each criterion uses human judgment over test results and product evidence. No feature criterion is satisfied merely by this document existing.

1. **AC1 — Human authorization and intent.** A permitted human closes an eligible draft with a nonblank reason and same-project replacement; missing/blank reason and agent/service credentials fail without writes. Actor/time come from the server. Verification: judged.
2. **AC2 — Lifecycle and busy safety.** Closure succeeds only for open `initializing`/`ready` sources without queued/running mutators. All other phases and busy sources fail. Concurrent start/closure cannot both commit; no cancellation is performed. Verification: judged.
3. **AC3 — Link integrity.** Missing, self, cross-project, closed replacement and cycle-producing links fail atomically, including historical-link cycle fixtures. A valid in-progress replacement is allowed. Verification: judged.
4. **AC4 — Versions and idempotency.** Both expected versions are required; stale new operations fail. Exact successful replay returns the original result/event; changed payload under the same key and new operations on closed sources fail. Concurrent requests produce one closure/event. Verification: judged.
5. **AC5 — History and delivery semantics.** Closure retains all original criteria, artifacts, pins, digest and events; records reason, replacement, actor and time once; preserves historical phase and advances only the source mutation version. It creates no done criterion, completion or acceptance and leaves the replacement unchanged. Verification: judged.
6. **AC6 — Russian and English experience.** Both locales offer the eligible close dialog, reason and replacement review, conflict/busy messages, closed detail/history and working links. Active/default, closed-only and all board filters and counts behave consistently. Verification: judged.
7. **AC7 — Existing clients.** Records without metadata remain open. Representative older clients can still read supported responses and active lists, cannot advance closed work through any prior route, and do not receive closed work from actionable queues. Strict decoder compatibility is demonstrated or negotiated explicitly. Verification: judged.
8. **AC8 — Real required closure.** After implementation, the authenticated human operator executes and verifies the exact real old-draft supersession in the [mandatory real acceptance check](plan.md#mandatory-real-acceptance-check). Record retained evidence and an independent reviewer judgment; simulated closure alone does not pass. Verification: judged.
