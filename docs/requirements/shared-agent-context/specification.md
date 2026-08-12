# Keryx Shared Agent Context — Specification
Version: 1.1.0

## Identity and ownership

**Package id:** `shared-agent-context` (`SAC`). SAC является будущим
collaboration/entry-point layer. Он хранит local references, roles, derived
context receipts и proposals; не заменяет существующие sources of truth.

| Concern | Owner | SAC responsibility |
|---|---|---|
| Context assembly, retrieval trace, feedback | Context Operations | Запрашивает assembly и сохраняет только SAC receipt/reference. |
| Session, worktree, approvals, execution | Project Agent Harness | Передаёт/читает references; не управляет lifecycle. |
| Work status and acceptance criteria | Flow | Отображает read-only projection, never writes flow state. |
| Long-lived knowledge | Wiki, Memory, Skills | Reads accepted knowledge; proposal acceptance делегируется guarded writers. |
| Security and transport redaction | Security, MCP | Applies existing output/write seams; SAC не создаёт bypass. |

## Future storage structure

```text
.metaproject/workspaces/
  <workspace-id>/
    workspace.json          # primary manifest
    fwk-receipt.json        # derived, regenerable snapshot
    access-receipts.jsonl   # append-only metadata, no raw content
    proposals/<id>.json     # candidate; keyed write-intents/decisions/receipts are immutable metadata
    activity.jsonl          # append-only lifecycle events
```

`workspace.json` is the only SAC primary record. All referenced content stays
in its owning module. Derived files may be removed and rebuilt. Writes require
atomic replace plus the repository's established lock/write discipline.
`access-receipts.jsonl` and `activity.jsonl` are diagnostic/audit metadata,
not a claim of tamper-evident storage: future implementation must define their
integrity owner and protection before using them as security evidence.

## Functional surface

| ID | Function | Короткое пояснение | Future implementation proposal |
|---|---|---|---|
| SAC-1 | Workspace registry | Связывает работу без копирования knowledge. | `WorkspaceService` validates manifest schema, resolves typed refs and writes atomically. |
| SAC-2 | Facts resolver | Строит task-local verified facts. | Resolve evidence revisions; reject unresolved/denied evidence; compute freshness and expiry. |
| SAC-3 | Work projection | Показывает единое состояние работы. | Read `FlowService` snapshot; map only status, AC, next, blockers and evidence; expose no mutation method. |
| SAC-4 | Know-how resolver | Возвращает reusable reviewed knowledge. | Query accepted wiki/memory/skills through Context Operations; preserve trust/applicability/revision. |
| SAC-5 | Compact overview | Даёт стартовый bounded context. | Assemble identity, policies and FWK summary under explicit token/item limits; required-item overflow returns typed `context_overflow`; optional omission returns `partial` plus `omittedOptional` IDs; emit trace. |
| SAC-6 | Progressive retrieval | Раскрывает детали по необходимости. | Future read-only CLI/MCP adapters call resolver after visibility, budget and freshness checks. |
| SAC-7 | Access policy | Делает доступ reproducible и economical. | Versioned deterministic rule function over role, phase, source trust/freshness and remaining budget. |
| SAC-8 | Access receipt | Даёт аудит решения и результата доступа. | Append schema-validated metadata; no raw retrieved content, prompts or hidden reasoning. |
| SAC-9 | Wrap-up proposal | Делает результат сессии reviewable. | Harness/Flow integration builds proposal only from explicit summary and EvidenceRef IDs. |
| SAC-10 | Review queue | Отделяет proposal от принятого знания. | State machine validates owner/reviewer, security decision and target guarded write result. |
| SAC-11 | Freshness/invalidation | Не скрывает устаревание. | Compare stored revisions/ACL/TTL; mark stale and regenerate rather than mutate source knowledge. |
| SAC-12 | Permission boundary | Делает disclosure least-privilege. | Role check before discovery/read/propose/review; MCP tool registry applies existing visibility/redaction seam. |

## FWK semantics

### Facts

A Fact is valid only while all EvidenceRefs resolve, are visible to the actor,
match the recorded revision (when revisioned), and `expiresAt` has not passed.
`confidence` communicates uncertainty; it never removes the evidence requirement.
Facts are task-local and must be deleted or marked expired at task/workspace end.

### Work

Work is a normalized projection of exactly one Flow snapshot or an explicit
`unbound` state. In `unbound`, SAC may show no task list. A workspace can link
several flows, but each receipt selects one `workFlowRef` and reports all other
links only as resources. No SAC command/tool may create, mutate or complete a
Flow.

### Know-how

Know-how is a reference to an accepted/reviewed item in an owning system. It
has applicability scope and may become stale, withdrawn or inaccessible. A
proposal is not Know-how until the target system accepts it through its normal
guarded path.

## Data contracts

Normative Draft 2020-12 schemas and fixtures are in [schemas](schemas/README.md):

- [workspace manifest](schemas/workspace-manifest.schema.json)
- [FWK receipt](schemas/fwk-receipt.schema.json)
- [access receipt](schemas/access-receipt.schema.json)
- [workspace proposal](schemas/workspace-proposal.schema.json)
- [review decision](schemas/review-decision.schema.json)

`SubjectId` is the canonical, normalized identity of each actor, owner,
reviewer and referenced subject. It has one canonical serialization; aliases,
path spellings and client-provided role labels must resolve to it before ACL
evaluation. A manifest has exactly one canonical owner subject and no duplicate
or conflicting role assignment for a `SubjectId`.

In v1 every `uri`/reference is workspace-relative and typed by its target kind.
The implementation resolves it beneath the configured workspace root with an
application-level `realpath` check before access; absolute, network and
escaping references are rejected. Remote references require a future separate
egress and identity contract.

All IDs are opaque lower-case identifiers. Every timestamp is normative UTC in
the lexical form accepted by the pinned validator with format assertion and by
the application parser; format annotations alone are insufficient. The parser
rejects non-UTC timestamps and invalid ordering: `createdAt <= updatedAt`,
`observedAt <= expiresAt` where both apply, and every lifecycle transition has
a non-decreasing transition time. Later immutable revisions must have a later
revision/transition sequence and may not rewrite an earlier decision.
An `EvidenceRef` carries `kind`, `uri`, `revision`, `observedAt` and `trust`.
Schemas intentionally forbid fields for transcript/prompt/secret payloads.

The schemas in this package are normative contracts, but they are not proof
that the existing runtime validates them. Future implementation must run the
pinned schema validator and application-level semantic checks before persistence
or egress.

## Future CLI and MCP surface

All names below are **planned**, not currently available CLI/MCP claims.

```text
keryx workspace create --title <title> --component <ref>
keryx workspace add-resource <workspace-id> <typed-ref>
keryx workspace overview <workspace-id> [--flow <flow-id>] [--budget <n>]
keryx workspace fwk <workspace-id> --flow <flow-id>
keryx workspace proposal create <workspace-id> --from-flow <flow-id>
keryx workspace proposal review <workspace-id> <proposal-id> --accept|--reject|--dismiss
```

Planned MCP read tools: `workspace.get`, `workspace.overview`, `workspace.fwk`,
`workspace.resources`. Planned mutation tools are not exposed in the first MCP
release; CLI mutations require actor identity, role check, schema validation
and normal security/write gate. CLI and MCP share one normalized service API.
The current runtime exposes none of these SAC commands or tools.

## Permission model and security invariants

| Action | Owner | Editor | Viewer | Mandatory gates |
|---|---|---|---|---|
| Discover/read visible workspace/FWK | yes | yes | yes | ACL, source visibility, redaction |
| Create/update workspace resources | yes | yes | no | schema, typed-ref resolver, security write gate |
| Create proposal | yes | yes | no | schema, evidence resolver, redaction/security gate |
| Review/accept/reject proposal | yes | no by default | no | target ownership, security pass, evidence freshness |
| Archive workspace/change roles | yes | no | no | audit event, atomic write |

Security decisions are recorded but sensitive detector detail is not duplicated.
If a source cannot be checked or redacted safely at an egress boundary, the
operation is denied rather than returned partially as authoritative context.
The existing security module's mode remains authoritative; SAC must not weaken
it or bypass a guarded write path.

`ActorContext` is the sole input for ACL subject/role evaluation. A CLI actor is
accepted only from a verified local OS identity or an explicitly trusted Harness
adapter. The first MCP release is limited to a trusted local single-user
transport or a verified principal/scoped capability. SAC never trusts an actor,
role or workspace owner sent by an unverified client. Every protected operation
must test spoofed identity, cross-workspace access, revoked role and TOCTOU
between authorization and target access/write.

The [agent protocol](agent-protocol.md) is the normative agent-facing behavior
for failure and proposal handling. The [artifact lifecycle](artifact-lifecycle.md)
is the normative retention and state-transition source; this specification adds
only cross-contract acceptance requirements.

## Integrations and dependencies

- `src/flow`: read-only Flow snapshot and its verification evidence.
- `src/gdgraph`: component/repository/dependency references.
- `src/wiki`, `src/memory`, `src/gdskills`: accepted Know-how and eventual
  guarded promotion target.
- Context Operations: bounded assembly, retrieval trace and feedback model.
- `src/harness`: session/worktree references and explicit wrap-up trigger.
- `src/mcp`: future adapter/visibility filter; never the execution core.
- `src/security`: input/output scan, redaction and guarded writes.

Runtime implementation depends on stable typed reference APIs from these
modules; this package does not authorize changing their existing contracts.

## Acceptance criteria

- **AC-1:** Every valid/invalid fixture is accepted/rejected by its normative
  schema and semantic validator; malformed IDs, duplicate/conflicting
  `SubjectId` roles, unsafe URI, revision, timestamp/order and forbidden
  raw-content fields fail before persistence.
- **AC-2:** A Facts entry has >=1 resolvable visible EvidenceRef, revision,
  observed time and expiry/freshness status. Source mismatch makes it stale.
- **AC-3:** Work output is semantically equal to its Flow snapshot and exposes
  no state mutation; absent Flow produces explicit `unbound`, not invented work.
- **AC-4:** Know-how lookup returns only accepted/reviewed sources and retains
  source, trust, applicability and stale/withdrawn status.
- **AC-5:** Overview obeys configured item/token limits, records sources and
  trace, and is regenerated after source/ACL/TTL invalidation. If any mandatory
  item cannot fit, it returns typed `context_overflow` and no successful
  manifest; an otherwise successful partial response lists every omitted
  optional ID in `omittedOptional`.
- **AC-6:** Every allowed or denied progressive access emits an AccessReceipt
  linked to its canonical Context Operations assembly/trace and records the
  applicable policy/config revision plus selected/omitted item IDs; it contains
  no raw prompt, transcript, secret or hidden reasoning.
- **AC-7:** Only a trusted `ActorContext` can authorize a request; Viewer cannot
  mutate; non-visible references are absent from both listings and direct read
  results; outbound MCP tools and resources pass configured redaction.
- **AC-8:** A proposal cannot reach `accepted` without a durable pending
  write-intent that binds fresh evidence, reviewer authority, passing security
  policy/version, causal order and owner idempotency key; the owning guarded
  writer must return a correlation- and intent-bound successful target-write
  receipt before acceptance is appended. Recovery reuses the owner key and
  cannot duplicate a target mutation; failed/replayed writes leave the proposal
  non-accepted.
- **AC-9:** Rejected/dismissed/stale proposals never change wiki, memory or
  skills and retain audit-only metadata according to lifecycle policy.
- **AC-10:** With SAC disabled, existing Context Operations, Flow, Harness,
  MCP and agent bootstrap results remain behaviorally unchanged.
- **AC-11:** CLI and MCP read results normalize to the same contract fixtures.
- **AC-12:** Learned-policy experiments remain opt-in and sandboxed; no policy
  can modify roles, security gates, acceptance criteria or itself. Phase 5 is
  blocked until each training/evaluation row links a hash/immutable receipt,
  policy version and independently verifiable outcome; a versioned corpus
  manifest records selection, redaction and provenance; holdout and adversarial
  cases pass; and failed/suspicious records enter quarantine rather than the
  corpus.
