# Keryx Shared Agent Context — Specification
Version: 1.2.0

## Documentation truth

This specification describes the **current** SAC runtime (`src/sac/`, shipped
through `v0.2.32` and present on `main` as of `v0.2.35`). Earlier revisions
labelled the CLI/MCP surface `planned` and stated that "the current runtime
exposes none of these SAC commands or tools." That claim is false against
today's code. Remaining `future` items are listed explicitly at the end of
the CLI/MCP section and in satellite RP-01…RP-12 packages. Those satellite
packages are **not** the source of truth for shipped SAC-1…SAC-12 behavior.

## Identity and ownership

**Package id:** `shared-agent-context` (`SAC`). SAC is the implemented
local-first collaboration/entry-point layer. It stores local references, roles,
derived context receipts and proposals; it does not replace existing sources
of truth.

| Concern | Owner | SAC responsibility |
|---|---|---|
| Context assembly, retrieval trace, feedback | Context Operations | Запрашивает assembly и сохраняет только SAC receipt/reference. |
| Session, worktree, approvals, execution | Project Agent Harness | Передаёт/читает references; не управляет lifecycle. |
| Work status and acceptance criteria | Flow | Отображает read-only projection, never writes flow state. |
| Long-lived knowledge | Wiki, Memory, Skills | Reads accepted knowledge; proposal acceptance делегируется guarded writers. |
| Security and transport redaction | Security, MCP | Applies existing output/write seams; SAC не создаёт bypass. |

## Storage structure

```text
.metaproject/workspaces/
  <workspace-id>/
    workspace.json          # primary manifest (WorkspaceService)
    proposals/<id>.json     # immutable proposed record
    proposals/<id>.<hash>.decision.json
    proposals/<id>.<hash>.approval.json
    proposals/<id>.<hash>.write-intent.json
    proposals/<id>.<hash>.write-result.json
    activity.jsonl          # append-only proposal/collaboration events

.metaproject/context-operations/
  access-receipts.jsonl              # hash-chained access-receipt ledger
  access-receipts.checkpoint.json    # fast-path integrity checkpoint
```

`workspace.json` is the only SAC primary record. All referenced knowledge stays
in its owning module. FWK receipts are derived response objects, not a
persisted `fwk-receipt.json` file. Writes use atomic replace plus the
repository lock/write discipline. Access-receipt integrity is owned by
`src/sac/receipt-integrity.ts` (`sealAccessReceipt` /
`verifyAccessReceiptLedger`): each record carries `integrity.recordHash` and
`previousRecordHash` (`GENESIS` or the prior hash). `activity.jsonl` is
append-only audit metadata for proposal transitions, not a second knowledge
store.

## Functional surface

| ID | Function | Короткое пояснение | Current implementation |
|---|---|---|---|
| SAC-1 | Workspace registry | Связывает работу без копирования knowledge. | `WorkspaceService` (`src/sac/workspace-service.ts`) validates the manifest schema, resolves typed refs and writes `workspace.json` atomically. CLI: `create`/`list`/`show`/`add-resource`. |
| SAC-2 | Facts resolver | Строит task-local verified facts. | `createLocalFwkReadService` (`src/sac/fwk-service.ts`) resolves evidence revisions, rejects unresolved/denied evidence, computes freshness and expiry. |
| SAC-3 | Work projection | Показывает единое состояние работы. | Same FWK service reads a Flow snapshot; maps status, AC, next, blockers and evidence; exposes no mutation method. Unbound work is explicit. |
| SAC-4 | Know-how resolver | Возвращает reusable reviewed knowledge. | Queries accepted wiki/memory/skills; preserves trust/applicability/revision. Know-how kinds are only `wiki \| memory \| skill`. |
| SAC-5 | Compact overview | Даёт стартовый bounded context. | `overview` assembles identity, policies and FWK summary under `maxItems`/`maxTokens`; required overflow → typed `context_overflow`; optional omission → `partial` + `omittedOptional`. |
| SAC-6 | Progressive retrieval | Раскрывает детали по необходимости. | `read` after overview: CLI `keryx workspace read`, MCP `sac.read`, harness `workspace_read`. Visibility, budget and freshness are re-checked. |
| SAC-7 | Access policy | Делает доступ reproducible и economical. | Deterministic rule over role, phase, source trust/freshness and remaining budget. Phase 6a: `resolvePolicySelection` opt-in guard. |
| SAC-8 | Access receipt | Даёт аудит решения и результата доступа. | Append-only hash-chained ledger at `.metaproject/context-operations/access-receipts.jsonl`. No raw retrieved content, prompts or hidden reasoning. |
| SAC-9 | Wrap-up proposal | Делает результат сессии reviewable. | `ProposalLifecycleService.create` accepts only a server-issued one-time wrap-up from a completed session (`resolveSessionWrapUp`). CLI `workspace propose`, MCP `sac.propose`. Flow wrap-up as a propose source is not wired. |
| SAC-10 | Review queue | Отделяет proposal от принятого знания. | `review` is a terminal state machine. `accepted` requires a durable write-intent then a correlation-bound owner receipt. Owner map: `wiki-update` → wiki, `memory-entry` → memory, other kinds → skill. |
| SAC-11 | Freshness/invalidation | Не скрывает устаревание. | Stored revisions/ACL/TTL are compared; stale is observable. Evidence is re-validated immediately before owner write (TOCTOU → `stale`). |
| SAC-12 | Permission boundary | Делает disclosure least-privilege. | Role check before discover/read/propose/review. MCP SAC tools refuse HTTP (`sac_transport_denied`); local stdio only. |

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

The schemas in this package are normative contracts. The runtime validates
them through `validateSacContract` (`src/sac/index.ts`) before persistence:
workspace manifests, proposals, transitions, review decisions and access
receipts. Format assertion plus application-level checks (SubjectId, realpath
containment, timestamp order, ledger idempotency) run in that path.

## Current CLI, MCP and harness surface

These names are **shipped**. They live in `src/commands/workspace.ts`,
`src/mcp/tools.ts` and `src/harness/tool/builtin/workspace-context-tool.ts`.
Older spec names (`workspace.fwk`, `workspace.proposal create --from-flow`,
MCP `workspace.get` / `workspace.overview`) were never implemented and must
not be treated as the current contract.

```text
keryx workspace create --title <title> [--component <workspace-relative-ref>]
keryx workspace list
keryx workspace show <workspace-id>
keryx workspace add-resource <workspace-id> --kind <kind> --uri <workspace-relative-ref> [--revision <revision>]
keryx workspace overview <workspace-id> [--max-items N] [--max-tokens N] [--explain]
keryx workspace read <workspace-id> <item-id> [--max-items N] [--max-tokens N] [--explain]
keryx workspace propose <workspace-id> --kind <decision|wiki-update|memory-entry|follow-up|contract-change|risk> --session <session-id> [--note <one-line note>]
keryx workspace review <workspace-id> <proposal-id> --decision <accepted|rejected|dismissed> [--reason <reason>] [--idempotency-key <key>]
keryx workspace collaboration <workspace-id>
keryx workspace policy-readiness
```

MCP tools (local stdio only; HTTP returns `sac_transport_denied`):

| Tool | Mutating | Implementation |
|---|---|---|
| `sac.overview` | no | `createLocalFwkReadService().overview` |
| `sac.read` | no | `createLocalFwkReadService().read` |
| `sac.propose` | yes | `createHarnessProposalLifecycleService().create` from a completed session |
| `sac.review` | yes | same composition `.review` through guarded owner-writers |
| `sac.collaboration` | no | `createLocalCollaborationService().overview` |

Harness tools (local `keryx shell` turn; `risk: "read"`; no session↔workspace
auto-binding — caller must pass `workspaceId`):

| Tool | Implementation |
|---|---|
| `workspace_overview` | same FWK overview as the CLI |
| `workspace_read` | same FWK read as the CLI |

CLI and MCP read results share `normalizeFwkResult`. Propose/review share
`normalizeProposalLifecycleResult`. `createLocalProposalLifecycleService` is
fail-closed for accept (no real owner writers). Accept is only possible
through `createHarnessProposalLifecycleService`, which wires:

| Proposal kind | Owner | Writer | Target prefix |
|---|---|---|---|
| `wiki-update` | wiki | `createRealWikiOwnerWriter` | `./wiki` (decision page under `.metaproject/wiki/decisions/`) |
| `memory-entry` | memory | `createRealMemoryOwnerWriter` | `./memory` (same guarded seam as `keryx memory new`) |
| `decision`, `follow-up`, `contract-change`, `risk` | skill | `createRealSkillOwnerWriter` | `./project-skills` (`keryx skills create` path) |

### Still future (do not treat as current)

- Automatic session↔workspace linkage (`--workspace` on `keryx shell`, RP-03).
- Propose from a Flow wrap-up snapshot (only `source: "session"` is wired).
- MCP/HTTP or other remote SAC transports.
- Phase 6b runtime re-ingestion of raw receipts/outcomes.
- Public collaboration *writer* (only a read-only overview exists).
- Satellite RP-01…RP-12 capabilities (runtime truth rewrite, source-owned
  ports, promotion-integrity extras, generational memory, worktree handoffs,
  unified operation registry, etc.).

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
- `src/wiki`, `src/memory`, `src/gdskills`: accepted Know-how and the guarded
  promotion targets (`wiki-owner-writer`, `memory-owner-writer`,
  `skill-owner-writer`).
- Context Operations: bounded assembly, retrieval trace, and the access-receipt
  ledger path under `.metaproject/context-operations/`.
- `src/harness`: session archive for trusted wrap-up; in-process
  `workspace_overview` / `workspace_read` tools. No session↔workspace field.
- `src/mcp`: local-stdio adapters `sac.overview|read|propose|review|collaboration`;
  HTTP is denied. MCP is never the execution core.
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
