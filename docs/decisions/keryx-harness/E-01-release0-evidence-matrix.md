# E-01: Release 0 Capability/Evidence Matrix

**Status:** Draft (W16 task E-01)
**Date:** 2026-07-13
**Flow:** 010 (flow-orchestrator, dispatch 010-T5)
**Depends on:** H-01 (per implementation-plan.md §W16); H-01 (W15 hardening) has
not run in this worktree — this matrix documents the Release 0 vertical slice
(W1–W7) delivered to date, and explicitly marks W8+ items as planned/deferred.
No claim below states a Release 1/2 capability as implemented.

---

## Purpose

This document is the `E-01` deliverable required by
`implementation-plan.md` §W16: it maps every Release 0 capability to an
implementation status, a real source path, a real test-evidence path, and the
verified commit that delivered it. Every path cited below was checked against
the working tree (`ls` / `keryx ctx rg` / `git show --stat`) before being
listed — no path is asserted from memory.

---

## Capability / Evidence Matrix

| Capability | Wave | Status | Source | Test Evidence | Commit |
|---|---|---|---|---|---|
| D-01 — Release 0 boundary and measurable success criteria | W1 | implemented | `docs/decisions/keryx-harness/ADR-0001-d01-release0-boundary.md` | docs artifact (reviewed T9, `decision-registry.md` AC1 SATISFIED) | `690b376` |
| D-02 — Single coordinator, ownership matrix, inward ports | W1 | implemented | `docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md` | docs artifact (reviewed T9, AC2 SATISFIED) | `690b376` |
| D-03 — Security profiles and required containment | W1 | implemented | `docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md` | docs artifact (reviewed T9, AC3 SATISFIED) | `690b376` |
| D-04 — Provider state, branch model, child wire framing | W1 | implemented | `docs/decisions/keryx-harness/ADR-0004-d04-provider-branch-child.md` | docs artifact (reviewed T9, AC4 SATISFIED); `docs/decisions/keryx-harness/research-ledger.md` (RL-01…RL-06) | `690b376` |
| Task Manager additive fields (`dependsOn`, `attempts`, `disposition`, `acRefs`, `evidenceRefs`, `budget`, `runLink`) + schemaVersion 1→2 migration | W2 | implemented | `src/flow/types.ts`, `src/flow/store.ts`, `src/flow/service.ts`, `src/flow/machine.ts` | `src/flow/migration.test.ts`, `src/flow/disposition.test.ts` (34/0 in `src/flow`) | `99952a5` |
| Fixture-corpus evaluator relocation `src/harness/` → `src/eval/` | W3 | implemented | `src/eval/corpus.ts`, `src/eval/gate.ts` | `src/eval/corpus.test.ts`, `src/eval/block-d-corpora.test.ts` | `39a884b` |
| Contract registry, deterministic Draft-2020-12-capable validator, fixture matrices | W4 | implemented | `src/contracts/validator.ts`, `src/contracts/resolver.ts`, `src/contracts/keyword-coverage.ts`; `docs/decisions/keryx-harness/contract-inventory.md` | `src/contracts/fixtures.test.ts` (79 tests: positive/negative/keyword-coverage/mutation/migration/fixture-hash) | `2b92515` |
| Provider-neutral request/event/error/capability port (attempt-scoped streams, unknown-extension preservation) | W5 | implemented | `src/harness/provider/provider-port.ts`, `src/harness/provider/types.ts` | `src/harness/provider/provider-port.test.ts` | `d5fa7c0` |
| Registered tool definition/registry/call port (schema, budget, cancellation, provenance, replay metadata) | W5 | implemented | `src/harness/tool/tool-port.ts`, `src/harness/tool/registry.ts`, `src/harness/tool/types.ts` | `src/harness/tool/tool-port.test.ts` | `d5fa7c0` |
| Deterministic fake-provider transcript fixtures (deltas, malformed/unknown events, errors, cancellation, usage, retry boundary) | W6 | implemented | `src/harness/provider/fake-provider.ts`; `src/harness/provider/fixtures/transcripts/{text-deltas,tool-call,malformed-event,unknown-extension,provider-error,cancellation,finish-usage,retry-boundary}.json` | `src/harness/provider/fake-provider.test.ts` | `3b06260` |
| One registered read-only fake tool with hash-bound recorded results | W6 | implemented | `src/harness/tool/fake-tool.ts` | `src/harness/tool/fake-tool.test.ts` | `3b06260` |
| R0 startup — disabled-capability floor + enabled-startup preconditions (typed `environment_blocked`) | W7 | implemented | `src/harness/startup.ts`, `src/harness/config.ts` | `src/harness/startup.test.ts` (18 tests; SC_R01_OFFLINE_START, SC_R01_CAPABILITY_OFF_NO_LOAD, SC_R02_TRUSTED_STARTUP, SC_R02_MISSING_PRECONDITION, SC_R14_DETERMINISTIC_FLOOR) | `ca57c56` |
| R0 session — append-only session tree, context manifest, resume without duplication, schema migration | W7 | implemented | `src/harness/session/session.ts`, `src/harness/session/types.ts`, `src/harness/context/manifest.ts` | `src/harness/session/session.test.ts` (14 tests), `src/harness/context/manifest.test.ts` (SC_R06_APPEND_ONLY_SESSION, SC_R06_RESUME_NO_DUPLICATE, SC_R06_SCHEMA_MIGRATION, SC_R07_BOUNDED_CONTEXT) | `ca57c56` |
| R0 policy — deterministic allow/ask/deny, hard-deny, headless fail-closed, stale-approval invalidation, role no-escalation, flow-file-edit denial | W7 | implemented | `src/harness/policy/engine.ts`, `src/harness/policy/types.ts` | `src/harness/policy/engine.test.ts` (28 tests; SC_R05_POLICY_OUTCOME, SC_R05_HARD_DENY, SC_R05_HEADLESS_ASK, SC_R05_STALE_APPROVAL, SC_R08_ROLE_CANNOT_ESCALATE, SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED) | `ca57c56` |
| R0 completion — evidence-linked completion gate, redaction-before-persistence, non-fabricated metrics | W7 | implemented | `src/harness/completion/gate.ts`, `src/harness/completion/metrics.ts`, `src/harness/evidence/redaction.ts`, `src/harness/evidence/types.ts` | `src/harness/completion/gate.test.ts` (21 tests, incl. metrics), `src/harness/evidence/redaction.test.ts` (SC_R10_EVIDENCE_FREE_COMPLETION_REJECTED, SC_R10_VERIFIED_COMPLETION, SC_R10_UNDISPOSED_BLOCKER_REJECTED, SC_R11_REDACTION_BEFORE_PERSISTENCE, SC_R16_EXACT_ESTIMATED_UNKNOWN_METRICS, SC_R16_UNRELIABLE_METRIC_NOT_TREATED_AS_EXACT) | `ca57c56` |
| R0 run + CLI/JSONL-RPC parity + offline replay | W7 | implemented | `src/harness/run/run.ts`, `src/harness/run/cli.ts`, `src/harness/rpc.ts`, `src/harness/replay/replay.ts` | `src/harness/run/run.test.ts`, `src/harness/rpc.test.ts`, `src/harness/replay/replay.test.ts` (13 tests; SC_R04_READ_ONLY_TOOL, SC_R04_MALFORMED_TOOL_INPUT, SC_R04_TOOL_TIMEOUT, SC_R04_TOOL_OUTPUT_OVERFLOW, SC_R12_BUDGET_EXHAUSTION, SC_R12_LOOP_DETECTION, SC_R12_REPLAY_MISMATCH, SC_R13_CLI_RPC_PARITY, SC_R13_TRANSPORT_CANNOT_CHANGE_POLICY, SC_R14_OFFLINE_REPLAY, SC_R17_OFFLINE_REPLAY_MATCHES) | `ca57c56` |

### Deferred (explicitly out of Release 0 vertical-slice scope)

| Capability | Wave | Status | Source | Test Evidence | Commit | Reason deferred |
|---|---|---|---|---|---|---|
| `SC_R12_TRANSIENT_RETRY` — retry one transient provider error within budget, recording a new attempt without exceeding the reservation | W7 → **W8** | deferred | n/a (not implemented) | n/a | n/a | `src/harness/run/run.ts`'s `runOffline` performs no retry loop; the scenario overlaps W8 durable-resume/immutable-attempt semantics (`RS-01`, `RS-02`). The W7 flow's frozen AC1–AC6 scoped retry-adjacent coverage to budget/loop-detection only (`SC_R12_BUDGET_EXHAUSTION`, `SC_R12_LOOP_DETECTION`), not transient-error retry. T15 review (`.metaproject/flows/009-2026-07-12-keryx-harness-w7-release0-slice/journal.md`) recorded this as DONE_WITH_CONCERNS and recommended W8 as the covering wave. |
| `SC_R16_BUDGET_RESERVATION` — reconcile planned/reserved/consumed/remaining budget values across a provider attempt | W7 → **follow-up** | deferred | n/a (not implemented) | n/a | n/a | The W7 flow's frozen AC4 scoped `R16` coverage to metric *reliability* (`SC_R16_EXACT_ESTIMATED_UNKNOWN_METRICS`, `SC_R16_UNRELIABLE_METRIC_NOT_TREATED_AS_EXACT`, both covered), not the planned/reserved/consumed/remaining budget-reservation reconciliation itself. T15 review flagged this as an uncovered `@release-0` scenario needing an explicit accept-and-defer decision; no covering wave has been assigned yet (recommend a dedicated reconciliation task before Release 0 is declared complete against the full acceptance suite). |
| `SC_R18_UNREGISTERED_EXTENSION_DENIED` — reject an extension that lacks a pinned manifest and capability grant at discovery time | n/a → **H-02 / W15 (Release 1-2+)** | deferred (vacuously satisfied) | n/a (no extension-registration/discovery surface exists in Release 0) | n/a | n/a | Tagged `@release-0`/`@task-H-02` (`acceptance.feature:325-330`), but its owning task `H-02` is explicitly scoped to **W15 / Release 1-2+** (`implementation-plan.md:143`, "extension contract is explicitly later scope"). The scenario is *vacuously satisfied* today: Release 0 has no extension-registration or discovery mechanism at all (only provider unknown-extension *preservation* and the `credentialRef` local field exist), so nothing unregistered can gain authority. Flagged by the E-02 independent review (F-1) as an evidence-matrix disclosure gap — this row corrects it; the deferred count is now three. |

All three deferred rows are tagged `@release-0` in `acceptance.feature` (lines
497, 548, and 326), so they remain open acceptance gaps against the full
Release 0 scenario suite even though the W7 flow's own frozen AC1–AC6 (a
narrower, orchestrator-scoped acceptance package) passed. This distinction is
preserved rather than silently closed.

---

## Migration Notes

### Corpus relocation (W3, EV-01)

The fixture-corpus evaluator (`corpus.ts`, `gate.ts`, `corpus.test.ts`,
`block-d-corpora.test.ts`) moved from `src/harness/` to `src/eval/` via a
direct `git mv` rename (not a staged alias), resolving ADR-0001 OPEN-4. `git
diff -M --stat` showed 0 insertions/0 deletions — the move was byte-identical.
One external importer (`src/security/detect/mcp.test.ts`) was repointed from
`../../harness/{corpus,gate}` to `../../eval/{corpus,gate}`. This freed
`src/harness/` to become the reserved home for the new agent runtime built in
W5–W7. Full detail: `docs/decisions/keryx-harness/EV-01-corpus-relocation.md`.

### Task Manager schemaVersion 1 → 2 (W2, TM-01/TM-02/TM-03)

`TM-01-task-manager-evolution.md` specifies an additive, all-optional
evolution: every new field (`dependsOn`, `attempts`, `disposition`, `acRefs`,
`evidenceRefs`, `budget`, `runLink`) is optional; no existing field is removed
or made required. Migration is **read-time only**: `readFlow` normalizes a
loaded `schemaVersion: 1` flow to `schemaVersion: 2` in memory; no file is
written until the next mutation; `writeFlow` always persists `schemaVersion:
2`; `keryx flow check` accepts both `schemaVersion: 1` and `2` (previously it
rejected anything other than `1`). Existing flows on disk
(`.metaproject/flows/001…003`) remain byte-untouched and continue to load.
Fixture coverage for this migration lives in `src/flow/migration.test.ts` and
`src/flow/disposition.test.ts`.

### Contract schema-version-registry usage (W4, C-01/C-02/C-03)

`contract-inventory.md` registers every durable/public payload
(34 `*.schema.json` files) against `schema-version-registry.json`, recording
`$id`, owner, persistence class, and migration policy for each family
(`harness-*`, `session-*`, `evidence-*`/`checkpoint`, `branch-*`/`compaction`,
`model/*`, `tool-*`, `approval-*`, `policy-*`/`completion`, `replay-*`,
`rpc/*`, and the child-agent contract-extension family). The deterministic
validator in `src/contracts/validator.ts` is hand-written over Node built-ins
(no external JSON-Schema library is a runtime dependency — `package.json`
`dependencies` is `{}`); keyword coverage is proven exhaustively by
`src/contracts/fixtures.test.ts`.

---

## Gates (Release 0 verification-gate state at this evidence point)

Verified directly against the working tree at matrix authoring time (not
carried forward from journal claims):

- **`tsc --noEmit`**: clean (no errors).
- **`bun test`**: **797 pass / 0 fail** (3076 `expect()` calls, 135 files).
- **`package.json` `dependencies`**: `{}` (no runtime dependency added across
  W1–W7; `optionalDependencies` — `web-tree-sitter`, `@modelcontextprotocol/sdk`
  — predate this package and are unrelated to the harness).
- **Frozen requirements package** (`docs/requirements/keryx-project-agent-harness/**`)
  and **ADR-0001…0004**: unmodified by this task (this task only creates
  `E-01-release0-evidence-matrix.md` and updates `research-ledger.md` /
  `decision-registry.md`, both of which are this package's own artifacts, not
  the frozen requirements package or frozen ADRs).

These figures corroborate, and in the `bun test` case extend, the per-wave
counts recorded in the flow journals (554 after W2/W3 baseline stabilization,
633 after W4, 677 after W5, 703 after W6, 797 after W7).

---

## Traceability to `implementation-plan.md` §W16 E-01 acceptance

> "E-01 — evidence-matrix maps every Release 0 capability to status + source
> path + test file + commit; research-ledger updated; migration notes
> recorded; package index (decision-registry) updated to include W2–W16
> artifacts; the 2 deferred scenarios explicitly marked; frozen requirements
> package NOT modified."

- Every row above cites a real, verified source path, test-evidence path (or
  states none exists, for the deferred rows), and commit.
- `research-ledger.md` is updated (see below) with a Release 0 section
  reconciling OPEN-1…OPEN-4 against W1–W7 outcomes.
- Migration notes recorded above for corpus relocation, Task Manager
  schemaVersion 1→2, and contract schema-version-registry usage.
- `decision-registry.md` is updated (see below) to index W2–W16 artifacts.
- The deferred scenarios are explicitly marked deferred with reasons — now
  **three**: `SC_R12_TRANSIENT_RETRY` (→ W8), `SC_R16_BUDGET_RESERVATION` (→
  follow-up), and `SC_R18_UNREGISTERED_EXTENSION_DENIED` (→ H-02 / W15,
  vacuously satisfied). The third was added per the E-02 independent review's
  F-1 finding (`E-02-release0-review-package.md`), which found the original
  "2 deferred" count to be an undercount; the acceptance-language quote above
  is the frozen implementation-plan wording and is preserved verbatim even
  though the actual list is now three.
- The frozen requirements package and ADR-0001…0004 were not modified by this
  task.

---

**Last updated**: 2026-07-13
**Updated by**: Flow 010 documentation worker (T5 / E-01); F-1 disclosure fix by Flow 010 documentation worker (T7 / E-03)
**Status**: E-02 independent review complete (GO, no BLOCKER/P0/P1) — F-1 disclosure fix applied; deferred list now three scenarios.
