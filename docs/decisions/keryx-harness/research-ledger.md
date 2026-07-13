# Research Ledger — Keryx Harness

**Version**: 0.1.0
**Created**: 2026-07-12
**Flow**: 003 (W1 decisions)
**Seeded by**: D-04 (ADR-0004 — provider state, branch model, child wire framing)

---

## Purpose

This ledger records the research and decision provenance behind the Keryx
harness contracts. It is the `research-ledger.md` referenced by
[ADR-0004](./ADR-0004-d04-provider-branch-child.md) (AC4). Each row links a
question/topic to either a **frozen** decision or an **OPEN** deferral, with a
source citation and the owning schema. Later waves (W5, W9, W12, W14, W16 E-01)
append rows; they do not rewrite frozen rows or resolve OPEN rows outside the
task each OPEN is bound to.

Ledger ID convention: `RL-NN` for frozen provenance rows, `OPEN-N` for deferred
questions (aligned with ADR-0001 / prd.md §Decisions and Open Questions).

---

## D-04 Provenance (frozen)

| Ledger ID | Question / Topic | Frozen decision or OPEN | Source citation | Owning schema |
|---|---|---|---|---|
| **RL-01** | How is provider state kept provider-neutral so Anthropic / OpenAI-compatible / local / future providers stay replaceable? | **FROZEN** — provider-neutral, event-sourced runtime; no provider SDK type crosses the `ProviderPort`; local Keryx event/session log is authoritative | provider-protocol.md §Purpose, §Provider Adapter Responsibilities; specification.md §Architectural Position; brainstorm.md D3 (event-sourced session core); implementation-plan.md §W5 P-01 exit ("no provider SDK types cross the port") | `provider-descriptor.schema.json` (`$id` `https://keryx.local/schemas/harness/provider-descriptor.schema.json`) |
| **RL-02** | Are provider-side storage, retention, and continuation allowed in Release 0? | **FROZEN** — OFF by default and excluded from Release 0; `remoteState.storage/retention/continuation` are `const: false`; instructions reconstructed locally per request | provider-protocol.md §Provider Capability Matrix; ADR-0001 exclusion 7 (no provider-side storage) | `provider-descriptor.schema.json` (`remoteState` object) |
| **RL-03** | What is the branch model — fork point, current leaf, ancestor mutability? | **FROZEN** — append-only branch with `branchId`, `forkEntryId`, current leaf, and immutable ancestors; branch switch atomic, ancestry preserved | artifact-lifecycle.md §Compaction; specification.md §Session, §CLI Surface (`session branch`); implementation-plan.md §W9 B-01 | `branch-metadata.schema.json` (`$id` `https://keryx.local/schemas/harness/branch-metadata.schema.json`) |
| **RL-04** | Is branch merge in scope for v1? Does compaction preserve evidence? | **FROZEN** — no-merge-v1 (merge excluded from v1); compaction is typed derived context that never deletes history or evidence and never promotes an untrusted summary | branch-metadata.schema.json description ("merge is excluded from v1"); artifact-lifecycle.md §Compaction; implementation-plan.md §W9 B-02 | `branch-metadata.schema.json`; `compaction-entry.schema.json` (`$id` `https://keryx.local/schemas/harness/compaction-entry.schema.json`); `checkpoint.schema.json` |
| **RL-05** | How is the child-agent wire framed without a second source of truth? | **FROZEN** — reuse canonical `subagent-dispatch` / `subagent-result` contracts; `canonicalContract` enum is `["subagent-dispatch","subagent-result"]`; STATUS lines normalized into the durable result | agent-protocol.md §Phase 4; specification.md §Child Agent Model; brainstorm.md D8 (existing contracts reused) | `harness-child-contract-extension.schema.json` (`$id` `https://keryx.local/schemas/harness/harness-child-contract-extension.schema.json`) |
| **RL-06** | What may the harness child extension add beyond the canonical contracts? | **FROZEN** — only parent run/session ids, attempt id/number, branch/context/policy fingerprints, budget reservation, and durable-result artifact reference; not a second task/result authority | agent-protocol.md §Phase 4 ("harness extension may add only …"); specification.md §Child Agent Model | `harness-child-contract-extension.schema.json` (required: `canonicalContract, canonicalContractVersion, parentRunId, sessionId, attempt, branchId, contextManifestHash, policyFingerprint, budgetReservation, durableResultArtifact`) |

---

## Deferred Questions (OPEN — never guessed)

These rows record questions deliberately deferred by prd.md §Decisions and Open
Questions and ADR-0001 §Open Items. Each stays OPEN until its bound task; no
worker may resolve it while freezing D-04.

| Ledger ID | Question / Topic | Frozen decision or OPEN | Source citation | Owning schema |
|---|---|---|---|---|
| **OPEN-1** | Concrete first real provider and credential shape | **OPEN** — deferred to Release 2+ W14 task RP-01 | prd.md §Decisions and Open Questions; ADR-0001 OPEN-1; implementation-plan.md W14 RP-01 | `provider-descriptor.schema.json` (real-provider adapter, storage off by default) |
| **OPEN-2** | Per-role budget values beneath the global ceilings | **OPEN** — deferred to Release 1 W2 (TM-01) / W5 (P-01) | prd.md §Decisions and Open Questions; ADR-0001 OPEN-2 | `model-request.schema.json` (budget/reservation fields); Task Manager task/run-link fields (TM-01) |
| **OPEN-3** | Artifact retention windows per class (session / evidence / compaction) under team vs solo policy | **OPEN** — deferred to Release 1 W11 task FI-01 | prd.md §Decisions and Open Questions; artifact-lifecycle.md §Retention; ADR-0001 OPEN-3 | `compaction-entry.schema.json`; `checkpoint.schema.json`; evidence-ledger family |
| **OPEN-4** | Exact compatibility migration for moving the existing corpus harness to `src/eval/` | **OPEN** — deferred to Release 0 prerequisite W3 task EV-01 | prd.md §Decisions and Open Questions; specification.md §Planned Module Map; ADR-0001 OPEN-4 | n/a (source-tree relocation; no owning payload schema) |

---

## Append Protocol (for later waves)

1. Add a new `RL-NN` row when a wave freezes a new contract decision; cite the
   normative source and owning schema `$id`.
2. Never rewrite or delete a frozen row; supersede with a new row that
   references the superseded id.
3. An `OPEN-N` row may only be resolved by the task it is bound to (see the
   deferred-questions table). Resolution replaces its status with FROZEN and
   adds the resolving source citation; the OPEN row's id is retained for
   traceability.
4. W16 task E-01 reconciles this ledger against the final capability/evidence
   matrix and marks every claim implemented / planned / deferred.

---

## Release 0 Reconciliation (W16 E-01)

This section reconciles the deferred-questions table (OPEN-1…OPEN-4) against
the actual outcomes of W1–W7 (the implemented Release 0 vertical slice), and
records the two acceptance scenarios that surfaced as uncovered during W7 and
remain OPEN pending a covering task. See
[E-01-release0-evidence-matrix.md](./E-01-release0-evidence-matrix.md) for the
full capability/evidence matrix this reconciliation is drawn from.

### OPEN-1…OPEN-4 status after W1–W7

| Ledger ID | Bound to | W1–W7 outcome |
|---|---|---|
| **OPEN-1** (concrete first real provider and credential shape) | W14 RP-01 (Release 2+) | **Still OPEN.** W1–W7 delivered only the provider-neutral port (`src/harness/provider/provider-port.ts`, W5) and a deterministic fake provider (`src/harness/provider/fake-provider.ts`, W6). No real provider adapter exists yet; OPEN-1 remains bound to future W14. |
| **OPEN-2** (per-role budget values beneath the global ceilings) | W2 (TM-01) / W5 (P-01) | **Partially resolved.** TM-01 (W2) specifies an optional `budget` field on the Task Manager task/run-link model (`src/flow/types.ts`), and the W5 provider/tool ports carry budget-shaped fields at the port level. Concrete per-role budget *values* (as opposed to the field shape) are not yet fixed — this is why `SC_R16_BUDGET_RESERVATION` (planned/reserved/consumed/remaining reconciliation) surfaced as deferred in W7; see the Deferred Scenarios table below. OPEN-2 is downgraded from fully OPEN to "field shape frozen, value policy still OPEN." |
| **OPEN-3** (artifact retention windows per class under team vs solo policy) | W11 FI-01 (Release 1) | **Still OPEN.** W1–W7 did not touch retention windows; this remains correctly bound to the future W11 Flow Integration task. |
| **OPEN-4** (compatibility migration for moving the corpus harness to `src/eval/`) | W3 EV-01 | **RESOLVED.** W3 (commit `39a884b`) performed a direct `git mv` rename (not a staged alias), documented in [EV-01-corpus-relocation.md](./EV-01-corpus-relocation.md). Byte-identical move (`git diff -M --stat` = 0 ins/0 del); one external importer repointed; frozen requirements package and ADR-0001 left untouched. |

### Newly surfaced deferred scenarios (from W7 T15 review)

These are not `OPEN-N` questions from D-04 — they are `@release-0`-tagged
acceptance scenarios in `acceptance.feature` that the W7 Release 0 vertical
slice (task R0-03) did not cover, discovered during the T15 independent
review recorded in
`.metaproject/flows/009-2026-07-12-keryx-harness-w7-release0-slice/journal.md`.
Recorded here per the E-01 acceptance criterion requiring the 2 deferred
scenarios to be explicit.

| Scenario | Acceptance tag | Deferred to | Reason |
|---|---|---|---|
| Retry one transient provider error within budget | `SC_R12_TRANSIENT_RETRY` | W8 (durable resume, RS-01/RS-02) | `runOffline` performs no retry loop; overlaps immutable-attempt/resume semantics not yet implemented. |
| Reserve and reconcile a run budget (planned/reserved/consumed/remaining) | `SC_R16_BUDGET_RESERVATION` | Follow-up (no wave yet assigned) | W7's frozen AC4 scoped `R16` coverage to metric *reliability* only; the budget-reservation reconciliation itself needs a dedicated covering task before Release 0 is declared complete against the full acceptance suite. |

---

**Last updated**: 2026-07-13
**Updated by**: Flow 010 documentation worker (T5 / E-01)
**Status**: Seeded with D-04 provenance (RL-01…RL-06) and deferred questions
(OPEN-1…OPEN-4); Release 0 reconciliation appended (W16 E-01) — OPEN-4
resolved, OPEN-2 partially resolved (field shape only), OPEN-1/OPEN-3 still
OPEN, 2 newly surfaced deferred scenarios recorded.
