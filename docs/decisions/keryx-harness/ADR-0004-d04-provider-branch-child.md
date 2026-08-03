# ADR-0004: Provider State, Branch Model, and Child Wire Framing

**Status**: Accepted / Frozen 2026-07-12

**Decision ID**: D-04
**Task**: implementation-plan.md §W1 row D-04
**Reviewer Track**: contract
**Depends on**: D-01 (ADR-0001, SIGNED)
**Source of Truth**: docs/requirements/keryx-project-agent-harness/

---

## Context

Release 0 requires a provider-neutral runtime, an append-only session tree, and
a canonical child-agent wire framing so that later waves (W5 provider ports, W9
branching/compaction, W12 child agents, W14 real provider adapters) build on a
frozen contract surface rather than re-deciding boundaries mid-implementation.

This ADR freezes three sub-decisions carried by implementation-plan.md §W1 row
D-04 — "Freeze D4–D6 provider state, branch model, and child wire framing" — as
three decision records, each linked to its owning schema (by `$id`) and to the
`research-ledger.md` provenance table. It **freezes already-selected positions
and does not re-decide them**. Every deferred question remains OPEN.

> **Naming note.** The three decision records below are labelled **D4 / D5 /
> D6** as used in implementation-plan.md §W1 row D-04 (provider-state /
> branch-model / child-wire). These are the D-04 *sub-decisions* and are
> distinct from brainstorm.md §Selected Decisions D1–D8 (where D3 is the
> event-sourced session core and D4 is "Tool Registry Before Prompt Features").
> Both are cited where relevant.

---

## Decision Record D4 — Provider State (provider-neutral, event-sourced)

**Decision.** The harness state is provider-neutral and event-sourced. No
provider SDK type crosses the `ProviderPort`. A provider adapter owns
authentication lookup, serialization, streaming parse, error classification,
usage extraction, and capability discovery, and it normalizes every stream to
the runtime's own request/response/error/event records. **Provider-side storage,
retention, and continuation are OFF by default and excluded from Release 0**;
system and project instructions are reconstructed locally for each request and
the local Keryx event/session log remains authoritative state (per
`provider-protocol.md` §Provider Capability Matrix and brainstorm.md D3
event-sourced session core). Unknown provider extensions are preserved in a
namespaced, redacted field, never leaked into domain contracts.

**Owning schema link.**
- `provider-descriptor.schema.json` — `$id`
  `https://keryx.local/schemas/harness/provider-descriptor.schema.json`
  (schemaVersion 1). Its `remoteState` object requires
  `storage`/`retention`/`continuation`, each frozen to `const: false` — the
  machine-readable proof that provider storage/continuation stay off.
- `model-request.schema.json` — `$id`
  `https://keryx.local/schemas/harness/model-request.schema.json`.
- `model-response.schema.json` — `$id`
  `https://keryx.local/schemas/harness/model-response.schema.json`.
- `model-error.schema.json` — `$id`
  `https://keryx.local/schemas/harness/model-error.schema.json` (classification
  `authentication`/`invalid_request`/`context_overflow` force `retryable:
  false`).
- **Scenario**: S-02 (provider/model) — specification.md §Core Runtime Contracts
  › Model Provider (lines 153–166) and provider-protocol.md §Normalized
  Request / §Normalized Events / §Error Taxonomy.

**Constraints (frozen).**
- No provider SDK type crosses the port (implementation-plan.md §W5 P-01 exit:
  "no provider SDK types cross the port"; specification.md §Architectural
  Position: domain types must not depend on a provider SDK).
- Attempt-scoped streams: each attempt has a stable attempt id and terminal
  state (completes / fails / cancelled / abandoned-after-partial).
- A tool call is authorized only after its complete JSON input validates;
  partial deltas never authorize execution or retry reuse.
- The runtime must never claim exact token counts the provider did not report.
- Credentials are referenced, never embedded; a missing credential is a typed
  `environment_blocked`.

**Consequences.** W5 (P-01 provider/tool ports), W14 (RP-01 first real provider
adapter behind an explicit capability + privacy/retention contract, storage off
by default). RP-01 depends on this decision (implementation-plan.md W14 row).

---

## Decision Record D5 — Branch Model (append-only, immutable ancestors, no-merge-v1)

**Decision.** The session is an append-only tree. A branch has `branchId`,
`forkEntryId`, a current leaf (`leafEntryId`), and immutable ancestors
(`immutableAncestorIds`). **Branch merge is excluded from v1** (no-merge-v1).
Branch switch is atomic and ancestry is preserved; compaction is a typed derived
entry that must never delete history or evidence or promote an untrusted
summary (artifact-lifecycle.md §Compaction; specification.md §Session).

**Owning schema link.**
- `branch-metadata.schema.json` — `$id`
  `https://keryx.local/schemas/harness/branch-metadata.schema.json`
  (schemaVersion 1). Its description freezes the rule verbatim: "Ancestor
  immutability, fork reachability and no-merge policy require semantic
  validation; merge is excluded from v1." Required:
  `branchId, sessionId, forkEntryId, leafEntryId, immutableAncestorIds,
  createdAt`.
- Supporting: `checkpoint.schema.json` — `$id`
  `https://keryx.local/schemas/harness/checkpoint.schema.json` (typed derived
  recovery view; never replaces history/evidence); `compaction-entry.schema.json`
  — `$id` `https://keryx.local/schemas/harness/compaction-entry.schema.json`
  (source entry range/hash, `evidenceLedgerCursor`, evidence preservation).
- **Scenario**: S-08 (branch) — artifact-lifecycle.md §Compaction ("A branch has
  `branchId`, `forkEntryId`, a current leaf, and immutable ancestors; branch
  merge is excluded from v1") and specification.md §CLI Surface
  (`keryx agent session branch <session-id>`).

**Constraints (frozen).**
- Immutable ancestors: an accepted ancestor entry is never overwritten; new work
  creates a new attempt/leaf (artifact-lifecycle.md §Atomicity Rules).
- No-merge-v1: branch merge is not implemented in v1.
- Compaction preserves file read/modify history and never removes the evidence
  ledger; it is untrusted derived context until task/approval/error/evidence
  invariants validate.

**Consequences.** W9 (B-01 append-only branch metadata + no-merge-v1 rule; B-02
typed compaction entry with evidence-preservation validation). Builds on W8
durable resume (RS-01 immutable attempts).

---

## Decision Record D6 — Child Wire Framing (canonical contracts + harness extension)

**Decision.** Child-agent dispatch and result reuse the **canonical
`subagent-dispatch` / `subagent-result` contracts** as the inter-agent
compatibility layer. Textual `STATUS:` lines are adapter framing normalized into
the canonical durable result before persistence. The harness extension adds
**only** parent run/session ids, attempt id/number, branch/context/policy
fingerprints, budget reservation, and a durable result artifact reference — it
is not a second task or result source of truth (agent-protocol.md §Phase 4;
specification.md §Child Agent Model).

**Owning schema link.**
- `harness-child-contract-extension.schema.json` — `$id`
  `https://keryx.local/schemas/harness/harness-child-contract-extension.schema.json`
  (schemaVersion 1). Its `canonicalContract` field is frozen to the enum
  `["subagent-dispatch", "subagent-result"]`. Required:
  `canonicalContract, canonicalContractVersion, parentRunId, sessionId, attempt,
  branchId, contextManifestHash, policyFingerprint, budgetReservation,
  durableResultArtifact` — exactly the additive fields the extension may carry.
- **Scenario**: S-09 (child) — specification.md §Child Agent Model (lines
  278–294: "Child agents must return schema-valid `subagent-result` messages.
  The existing Keryx contracts remain the inter-agent compatibility layer") and
  agent-protocol.md §Phase 4 Child-Agent Dispatch.

**Constraints (frozen).**
- Child framing reuses canonical `subagent-dispatch`/`subagent-result`; the
  harness extension only adds parent/session/attempt + fingerprint + budget +
  durable-result fields.
- The dispatch validates against the versioned `subagent-dispatch` schema; the
  result validates against `subagent-result`.
- Status protocol is `DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT /
  FAILED`; no worker may self-accept a parent flow or change parent completion
  state.

**Consequences.** W12 (CA-01 adapt canonical contracts with parent/session/
attempt extensions + STATUS framing; CA-02 child isolation, context budget,
NEEDS_CONTEXT / blocked / failed dispositions). Child agents are excluded from
Release 0 (ADR-0001 exclusion 4).

---

## Schema-Link Table

| Decision | Owning schema `$id` | Scenario | Research-ledger ref |
|---|---|---|---|
| **D4 provider-state** | `https://keryx.local/schemas/harness/provider-descriptor.schema.json` (+ `model-request`, `model-response`, `model-error`) | S-02 (provider/model) | RL-01, RL-02 |
| **D5 branch-model** | `https://keryx.local/schemas/harness/branch-metadata.schema.json` (+ `checkpoint`, `compaction-entry`) | S-08 (branch) | RL-03, RL-04 |
| **D6 child-wire** | `https://keryx.local/schemas/harness/harness-child-contract-extension.schema.json` | S-09 (child) | RL-05, RL-06 |

All owning schemas are registered in `schema-version-registry.json` with
`storedVersion: 1`, `acceptedRange: "^1"`, `migrationId: "identity-v1"`.

---

## Consequences for Later Waves

- **W5 (P-01)** — provider-neutral request/event/error/capability ports with
  attempt-scoped streams and unknown extensions; **no provider SDK type crosses
  the port** (D4).
- **W9 (B-01, B-02)** — append-only branch metadata, fork/current-leaf,
  immutable ancestors, no-merge-v1; typed compaction with evidence preservation
  (D5).
- **W12 (CA-01, CA-02)** — canonical `subagent-dispatch`/`subagent-result` with
  parent/session/attempt extensions, STATUS framing, child isolation and budget
  (D6).
- **W14 (RP-01)** — first real provider adapter behind an explicit capability
  and privacy/retention contract; provider storage off by default; depends on
  D4 (implementation-plan.md W14 row: `Depends R0-03, D-04`).

No Release 0 or Release 1 wave may resolve an OPEN item below; each is bound to
its owning later task.

---

## OPEN Items (Explicitly Deferred — Never Guess)

The following deferred questions are recorded verbatim from prd.md §Decisions and
Open Questions and ADR-0001 §Open Items. No worker is authorized to resolve any
of these while freezing D-04. Each is carried as an OPEN row in
`research-ledger.md`.

| Item | Deferred question (verbatim intent) | Deferred to | Status |
|---|---|---|---|
| **OPEN-1** | "the concrete first real provider and credential shape" (prd.md §Decisions and Open Questions) | Release 2+ W14 task RP-01 | **OPEN** |
| **OPEN-2** | "per-role budget values beneath the global ceilings" (prd.md §Decisions and Open Questions) | Release 1 W2 (TM-01) / W5 (P-01) | **OPEN** |
| **OPEN-3** | "artifact retention windows" per class under team vs solo policy (prd.md §Decisions and Open Questions) | Release 1 W11 task FI-01 | **OPEN** |
| **OPEN-4** | "the exact compatibility migration for moving the existing corpus harness to `src/eval/`" (prd.md §Decisions and Open Questions) | Release 0 prerequisite W3 task EV-01 | **OPEN** |

These mirror ADR-0001 OPEN-1…OPEN-4 and are neither narrowed nor resolved here.
Freezing D-04 selects the provider-state, branch, and child-wire *contracts*; it
does not select the first real provider, any budget value, any retention window,
or the corpus-migration path.

---

## Traceability

**Normative sources** (frozen, never modified):
- [provider-protocol.md](../../requirements/keryx-project-agent-harness/provider-protocol.md) — provider boundary, normalized request/events, error taxonomy, capability matrix, credentials (D4 / S-02).
- [artifact-lifecycle.md](../../requirements/keryx-project-agent-harness/artifact-lifecycle.md) — §Compaction branch model, atomicity, replay (D5 / S-08).
- [agent-protocol.md](../../requirements/keryx-project-agent-harness/agent-protocol.md) — §Phase 4 child dispatch and STATUS normalization (D6 / S-09).
- [specification.md](../../requirements/keryx-project-agent-harness/specification.md) — §Core Runtime Contracts › Model Provider (S-02), §Session / §CLI Surface (S-08), §Child Agent Model (S-09), §Normative Contract Registry.
- [prd.md](../../requirements/keryx-project-agent-harness/prd.md) — §Decisions and Open Questions (deferred questions).
- [brainstorm.md](../../requirements/keryx-project-agent-harness/brainstorm.md) — §Selected Decisions D3 (event-sourced session core), D4 (tool registry before prompt features), D8 (existing contracts reused); §Critical Questions.
- [implementation-plan.md](../../requirements/keryx-project-agent-harness/implementation-plan.md) — §W1 row D-04; W5/W9/W12/W14 consequence rows.
- [ADR-0001](./ADR-0001-d01-release0-boundary.md) — Release 0 boundary (D-04 depends on D-01) and OPEN-1…OPEN-4.
- [schemas/](../../requirements/keryx-project-agent-harness/schemas/) — owning schemas + `schema-version-registry.json`.
- [research-ledger.md](./research-ledger.md) — provenance table for D-04.

---

## Acceptance Gate

This ADR satisfies acceptance criterion **AC4** from flow 003:

> D-04 — ADR-0004 freezes provider-state, branch model, and child wire-framing
> as decision records, each linked to its owning schema (provider/model +
> `provider-descriptor` for S-02, `branch-metadata` for S-08,
> `harness-child-contract-extension` for S-09) and to a `research-ledger.md`;
> every deferred question is recorded as OPEN and none is silently resolved.

- ✓ Three decision records (D4 provider-state, D5 branch-model, D6 child-wire),
  each with Decision, owning-schema link (file + real `$id` + scenario),
  frozen constraints, and later-wave consequences.
- ✓ Schema-link table (Decision | owning schema `$id` | scenario | research-ledger
  ref) covering `provider-descriptor` (S-02), `branch-metadata` (S-08),
  `harness-child-contract-extension` (S-09).
- ✓ Linked to `research-ledger.md`.
- ✓ Every deferred question recorded as OPEN (OPEN-1…OPEN-4); none silently
  resolved.
- ✓ Frozen requirements package and decision-registry.md unmodified.

---

**Decision made by**: Flow 003 (W1 decisions) documentation worker (T8 / D-04)
**Date frozen**: 2026-07-12
**Approver**: Contract review (deferred to review workflow, flow 003 T9)
