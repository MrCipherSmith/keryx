# Shared Agent Context — Source-Owned Projections: Specification
Version: 0.1.0

## Identity and status

**Package id:** `shared-agent-context-source-projections` (RP-02).

This is a **future, spec-ready** contract for source-owned FWK projections. It
does not add a SAC persistence store for source contents. SAC stores only
workspace references and regenerable, minimised projection/assembly receipts as
defined by the parent SAC package.

## Related normative contracts

- [Shared Agent Context specification](../shared-agent-context/specification.md)
- [Shared Agent Context design rationale](../shared-agent-context/design-rationale.md)

## Ownership model

| FWK concern | Authoritative owner | SAC role |
|---|---|---|
| Work | Flow | Read-only projection consumer; never a Flow writer. |
| Facts/evidence | Evidence/resource owner | Typed resolver consumer; records only permitted reference/receipt metadata. |
| Wiki Know-how | Wiki | Typed query consumer and requester of canonical guarded writes. |
| Memory Know-how | Memory | Typed query consumer and requester of canonical guarded writes. |
| Skills Know-how | Skills | Typed query consumer and requester of canonical guarded writes. |
| Assembly/trace | Context Operations | Requests bounded assembly; does not create a competing trace. |

## Port surface

The future implementation SHALL introduce owner-owned interfaces equivalent to
the following language-neutral contracts. Exact names may change only with
owner approval and fixture compatibility.

```text
FlowProjectionPort.getCanonicalSnapshot(FlowRef, ActorContext)
  -> FlowSnapshotResult

EvidenceProjectionPort.resolve(EvidenceRef, ActorContext, ResolutionPolicy)
  -> EvidenceResolution

KnowHowProjectionPort.query(KnowHowQuery, ActorContext)
  -> KnowHowQueryResult
  # implemented separately by WikiProjectionPort, MemoryProjectionPort,
  # and SkillsProjectionPort

WikiDecisionWritePort.applyAcceptedDecision(WikiWriteIntent, ActorContext)
  -> OwnerWriteReceipt
```

All read results SHALL include `owner`, canonical typed reference/subject,
owner revision (or explicit `revisionUnavailable`), visibility result, and one
of `available`, `stale`, `withdrawn`, `denied`, or `unavailable`. They SHALL
not return raw source files merely for SAC to re-interpret.

## Data contracts

### FlowSnapshotResult and Work projection

`FlowSnapshotResult` SHALL contain exactly one owner-selected Flow identity and
the canonical Flow snapshot relevant to the reference. A workspace receipt that
needs Work SHALL name exactly one `workFlowRef`; more Flow resources remain
ordinary resources until an explicit selection rule binds one.

The SAC Work projection SHALL preserve, without semantic reinterpretation:

- status and its canonical owner value;
- acceptance criteria and their verification state;
- next action(s), blockers, and verification/evidence links;
- Flow revision, retrieval time, owner identity, and projection status.

If the Flow is inaccessible, stale, unavailable, or unbound, Work SHALL return
that explicit state. It SHALL not render a partial task list, map a status by a
Markdown/JSON heuristic, or create/complete/change any Flow data.

### EvidenceResolution and Facts

The evidence port SHALL resolve a typed `EvidenceRef` to an owner-recognised
identity, revision, visibility, provenance/trust classification, observed time,
freshness/expiry result, and an allowed content/reference form. SAC may form a
Fact only when the result is visible, resolvable, revision-consistent where the
owner supports revisioning, and not expired. Owner-specific evidence semantics
are preserved in an opaque `ownerMetadata` field with a documented schema or
typed extension; SAC must not reclassify trust from a file path or hash.

### KnowHowProjection

Each Wiki, Memory, and Skills result SHALL include:

```text
kind, canonicalRef, owner, revision,
 lifecycleState, trust, applicability, visibility,
stalenessState, withdrawnAt?, ownerReceiptRef?
```

`canonicalRef` is the canonical-reference input defined by a versioned contract
for RP-01 stable ID derivation. Together with owner, kind, and workspace scope
identity it MUST produce the same opaque ID across reorder, insertion,
display-title rename, body edits, and owner content-revision changes that do not
change that identity tuple. `ownerRevision` remains freshness and receipt
metadata, not a stable-ID input. Only a canonical-reference, owner, kind, or
workspace-scope identity change creates a new stable ID; no change may retarget
an existing ID. Compatibility fixtures cover reorder, display/content revision,
and each identity-tuple change across every owner port.

`trust` and `applicability` are computed/validated by the owner. SAC may filter
on the returned values under its ACL/budget policy but SHALL NOT infer them by
parsing Markdown front matter, body text, filenames, or a `Status:` regex.
The content payload, if permitted, remains owner-labelled and bounded through
Context Operations.

### Canonical Wiki decision/body write

`WikiWriteIntent` SHALL import the RP-04 durable target-intent contract and bind
proposal ID/revision, intent kind/version, canonical Wiki target, exact reviewed
decision bytes, evidence references/revisions, actor/reviewer authority,
security policy/version, owner preview digest, final binding digest,
idempotency key, and correlation ID. The final binding digest MUST cover the
complete render-input tuple defined by RP-04; the bytes written must remain
compatible with the independently reviewed preview digest. The Wiki port SHALL run
its canonical validation and body-write path; SAC must not call a generic file
writer for Wiki content. A successful `OwnerWriteReceipt` SHALL bind the same
intent/binding/preview digest, proposal revision, correlation/idempotency key,
target revision, and canonical target ref.
Without that receipt, the proposal remains non-accepted.

## Integration and dependency sequence

1. **Contract alignment:** Flow, evidence, Wiki, Memory, Skills, Context
   Operations, Security, and SAC owners agree fixture vocabulary, identity,
   revision, lifecycle/trust/applicability semantics, and error taxonomy.
2. **Read ports:** implement Flow and evidence ports with parity fixtures, then
   owner-specific Know-how read ports. Existing readers become compatibility
   adapters only after an owner has approved their typed contract.
3. **Assembly integration:** route SAC FWK resolution through ports and feed
   bounded, owner-labelled results to Context Operations' existing assembly and
   trace. Do not duplicate assembly or retrieval trace storage.
4. **Canonical writes:** expose the Wiki decision/body port, integrate it with
   proposal review, security, and idempotent receipts, and remove the direct
   Wiki body-write route only after parity and rollback readiness are proven.
5. **Deprecation:** reject/retire raw Flow JSON parsing, Markdown status-regex
   trust checks, and direct Wiki body writes; retain migration telemetry that
   excludes raw content and secrets.

## Failure and compatibility rules

- Denied, withdrawn, stale, unbound, and unavailable are distinct typed states.
- A caller may expose a bounded non-authoritative diagnostic only when policy
  permits; it must never label fallback content as authoritative FWK.
- Ports must be read-only except canonical owner write capabilities. SAC never
  owns an emergency bypass writer.
- Owner contract versions are negotiated explicitly. An incompatible version
  fails closed for the affected source rather than reverting to raw parsing.
- Owner ACL and Security decisions apply before disclosure and again at write
  execution where a write is involved.

## Acceptance criteria

- **AC-1:** All five source categories have typed, owner-reviewed read ports
  with positive and negative fixtures for identity, visibility, revision, and
  typed result state.
- **AC-2:** For every selected Flow fixture, SAC Work is semantically equal to
  the canonical Flow snapshot fields listed above; no Flow mutation operation
  is present in any SAC surface.
- **AC-3:** Multiple Flow references require explicit `workFlowRef` selection;
  no first-resource or positional selection is permitted.
- **AC-4:** Facts fail stale/denied/unavailable when evidence resolution fails;
  tests prove a hash/path alone cannot establish owner trust.
- **AC-5:** Wiki, Memory, and Skills fixtures prove trust/applicability come
  from owner results and that Markdown status text cannot alter their outcome.
- **AC-6:** An accepted Wiki decision invokes only `WikiDecisionWritePort`,
  returns a bound owner receipt, and is idempotent across replay; failed or
  missing receipt leaves the proposal non-accepted.
- **AC-7:** Context Operations retains the sole assembly trace and SAC retains
  only authorised source references/receipts; no duplicate Flow or knowledge
  store is introduced.
