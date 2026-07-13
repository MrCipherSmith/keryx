# Keryx Project Agent Harness — Release 0 flow-orchestrator Handoff

**Status:** Complete (flow 010, dispatch 010-T7, task E-03 / W16)
**Date:** 2026-07-13
**Author:** Flow 010 documentation worker (T7 / E-03)
**Gate:** implementation-plan.md §W16 — E-03 may only be created "if no
BLOCKER/P0/P1 remains" after E-02. **Met**: the E-02 independent review
(`E-02-release0-review-package.md`) reports **no BLOCKER/P0/P1**, a **GO** ship
recommendation, and only 1×P2 + 2×P3 advisories. This handoff is therefore
created per that gate.
**Scope:** Documentation only. No code, test, ADR, frozen-requirements-package,
`flow.json`, or `acceptance-criteria.md` file was modified to produce this
handoff (only this file was created; `E-01-release0-evidence-matrix.md` was
updated to fix the F-1 disclosure gap, and `decision-registry.md` may carry a
short pointer note — both are this package's own artifacts, not the frozen
package).

---

## 1. Status — Release 0 achieved

Per the frozen acceptance criteria (`docs/requirements/keryx-project-agent-harness/acceptance.feature`,
Release 0 = W1–W7 scope from `implementation-plan.md`), the Release 0 offline,
read-only vertical slice is **implemented, tested, and independently
reviewed with no blocking finding**:

- **E-01** (`E-01-release0-evidence-matrix.md`): every Release 0 capability
  mapped to status / source / test evidence / commit. Now discloses **three**
  deferred `@release-0` scenarios (see §6), corrected from two per the E-02
  F-1 finding.
- **E-02** (`E-02-release0-review-package.md`): independent review across
  architecture, contract, logic, security, testing/replay, performance, and
  Gherkin lenses. Verdict: **no BLOCKER/P0/P1**; ship recommendation **GO**.
- **E-03** (this document): the release-evidence handoff, created because the
  E-02 gate is met.

## 2. DAG / wave status

Wave order and dependency DAG as defined in
`docs/requirements/keryx-project-agent-harness/implementation-plan.md`
("Dependency waves" table and per-wave task contracts):

| Wave | Boundary | Tasks | Release | Status | Commit |
|---|---|---|---|---|---|
| W1 | Decisions and platform boundary | D-01…D-04 | prerequisite | ✅ done | `690b376` |
| W2 | Task Manager prerequisite and migration | TM-01…TM-03 | prerequisite | ✅ done | `99952a5` |
| W3 | Existing corpus-harness relocation | EV-01 | prerequisite | ✅ done | `39a884b` |
| W4 | Contract registry, validator, fixtures | C-01…C-03 | Release 0 | ✅ done | `2b92515` |
| W5 | Provider and tool ports | P-01…P-02 | Release 0 | ✅ done | `d5fa7c0` |
| W6 | Fake provider and fake tools | F-01…F-02 | Release 0 | ✅ done | `3b06260` |
| W7 | Release 0 read-only vertical slice | R0-01…R0-03 | Release 0 | ✅ done | `ca57c56` |
| W8 | Durable resume | RS-01…RS-02 | Release 1 | not started | — |
| W9 | Branching and compaction | B-01…B-02 | Release 1 | not started | — |
| W10 | Guarded mutation and approval | M-01…M-02 | Release 1 | not started | — |
| W11 | Flow integration | FI-01…FI-02 | Release 1 | not started (needs W2, satisfied) | — |
| W12 | Child agents | CA-01…CA-02 | Release 1 | not started | — |
| W13 | Parallel scheduling | PA-01 | Release 1 | not started | — |
| W14 | Real provider adapters | RP-01 | Release 2+ | not started | — |
| W15 | Security and recovery hardening | H-01…H-02 | Release 1/2+ | not started | — |
| W16 | Documentation and release evidence | E-01…E-03 | each boundary | **this flow** (E-01 ✅, E-02 ✅, E-03 ✅ — this document) | uncommitted at authoring time |

W1–W7 are each backed by a distinct commit (verified via `git show --stat`
against the working tree at authoring time), and each wave's task contract,
dependencies, and evidence/exit criteria are unchanged from
`implementation-plan.md`. W8–W15 have no artifact yet — they are Release 1/2+
scope and have not started, consistent with `decision-registry.md`'s W2–W16
package index note.

## 3. Frozen AC proposal for Release 0

Proposed frozen Release 0 acceptance baseline, summarized from the flow
003–009 per-wave frozen ACs and the E-01 capability matrix:

- **AC-R0-1 (D-01…D-04 boundary):** Release 0 scope is offline/read-only —
  fake provider, one read-only tool, provider-neutral event loop, append-only
  session, context manifest, evidence linking, CLI/JSONL/RPC parity, offline
  replay — with explicit exclusions (no mutation, shell, network, child
  agents, parallel tool calls, executable extensions, provider storage, TUI).
  Signed in ADR-0001…0004 (`decision-registry.md`, D-01…D-04 rows, all
  **SIGNED**).
- **AC-R0-2 (startup):** disabled-capability floor is true no-load; enabled
  startup requires explicit preconditions; missing precondition yields a
  typed `environment_blocked` result, never silent allow. Covered:
  `SC_R01_OFFLINE_START`, `SC_R01_CAPABILITY_OFF_NO_LOAD`,
  `SC_R02_TRUSTED_STARTUP`, `SC_R02_MISSING_PRECONDITION`,
  `SC_R14_DETERMINISTIC_FLOOR`.
- **AC-R0-3 (provider/tool loop):** provider events normalize deterministically
  (deltas, malformed/unknown events, transient/permanent errors); the one
  registered read-only tool executes with hash-bound recorded results, budget,
  cancellation, and provenance; a malformed/timeout/overflow tool call fails
  closed without a receipt or side effect. Covered: `SC_R03_*`, `SC_R04_*`.
- **AC-R0-4 (session/context):** session is append-only, idempotent on resume
  (no duplicate entries), schema-migratable; context manifest is bounded and
  rejects stale/untrusted sources. Covered: `SC_R06_*`, `SC_R07_*`.
- **AC-R0-5 (policy):** deterministic allow/ask/deny; hard-deny is terminal
  and unoverridable; headless `ask` fails closed to `deny`; stale/consumed
  approvals never authorize; role is advisory and cannot escalate; direct
  `flow.json`/managed-flow-state edits are always denied (D-02 invariant).
  Covered: `SC_R05_*`, `SC_R08_ROLE_CANNOT_ESCALATE`,
  `SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED`.
- **AC-R0-6 (completion/evidence):** completion gate passes only with all
  required gates + evidence + no undisposed blocker + a final message; a
  final message alone never passes; redaction happens before persistence;
  metrics are never fabricated (exact/estimated/unknown tagging honoured).
  Covered: `SC_R10_*`, `SC_R11_*`, `SC_R16_EXACT_ESTIMATED_UNKNOWN_METRICS`,
  `SC_R16_UNRELIABLE_METRIC_NOT_TREATED_AS_EXACT`.
- **AC-R0-7 (run/transport/replay):** hard budget boundary stops before an
  over-ceiling call; loop detection trips at threshold; CLI and JSONL/RPC are
  semantically identical and a transport cannot change policy; offline replay
  is effect-free and reports mismatches as typed results, never a live
  fallback. Covered: `SC_R12_BUDGET_EXHAUSTION`, `SC_R12_LOOP_DETECTION`,
  `SC_R12_REPLAY_MISMATCH`, `SC_R13_*`, `SC_R14_NETWORK_OR_PROVIDER_ACCESS_DENIED`,
  `SC_R15_*`, `SC_R17_*`.
- **AC-R0-8 (contracts):** every durable/public payload is registered with a
  stable `$id`, owner, persistence class, and migration policy
  (`contract-inventory.md`); the deterministic validator proves full keyword
  coverage with no external JSON-Schema runtime dependency; positive,
  negative, mutation, migration, and fixture-hash matrices exist per schema
  family (`src/contracts/fixtures.test.ts`, 79 tests).

This baseline is proposed as the frozen Release 0 AC set for
flow-orchestrator/Task Manager tracking; it summarizes (does not replace) the
authoritative scenario definitions in `acceptance.feature` and the frozen
per-wave ACs recorded in the flow 003–009 journals.

## 4. Gates (verification-gate state)

Cited from `E-02-release0-review-package.md` ("Gate evidence" table, verified
directly against the working tree at review time):

| Gate | Result |
|---|---|
| Type check (`bun run typecheck` / `tsc --noEmit`) | clean — no errors |
| Test suite (`bun test`) | **797 pass / 0 fail**, 3076 `expect()` calls, 135 files, 6.85s |
| Runtime dependencies (`package.json` `dependencies`) | `{}` — no runtime dep added |
| Security boundary — network calls in `src/harness src/contracts src/eval` | 0 matches |
| Security boundary — fs-write / subprocess | 0 real calls (6 matches are comments/tests only) |
| Security boundary — provider SDK imports | 0 real imports (3 matches are comments only) |
| Security boundary — non-determinism (`Date.now`/`Math.random`/`setTimeout`) | 0 real calls in runtime |
| Durable payload schema validity | all validated in tests against frozen `*.schema.json` (e.g. `run/run.test.ts:299-303` validates `HarnessRunOutput`) |

All figures independently re-verifiable via `keryx ctx rg` over
`src/harness src/contracts src/eval` per the E-02 methodology.

## 5. Constraints (carried forward, still binding for all future waves)

- **Offline / read-only**: Release 0 has no network, mutation, unrestricted
  shell, child agents, parallel tool calls, executable extensions, provider
  storage, or TUI (ADR-0001, D-01).
- **Reuse-only**: no new runtime dependency; the deterministic contract
  validator is hand-written over Node built-ins (`package.json` `dependencies`
  = `{}`).
- **Deterministic**: every source of non-determinism (clock, id sequence) is
  injected via `deps`; no real `Date.now`/`Math.random`/`setTimeout` in the
  runtime.
- **No new dep / SDK / network / fs-mutation**: enforced by the E-02 security
  scans (§4 above) and structurally by the port design (no provider SDK type
  crosses `provider-port.ts`).
- **D-02 — harness never writes `flow.json`**: Task Manager /
  `flow-orchestrator` is the sole managed-flow task/run/completion writer.
  `policy/engine.ts:92-96,190-197` (`isManagedFlowFile`) denies any tool call
  targeting `flow.json` or `flows/**.json` even with a valid matching
  approval — verified as a hard, unconditional deny, not merely a convention.

## 6. Out-of-scope / deferred

### 6a. Deferred `@release-0` scenarios (three, all disclosed)

| Scenario | Owner / covering wave | Note |
|---|---|---|
| `SC_R12_TRANSIENT_RETRY` | → **W8** (durable resume) | Run loop performs no retry (`retries: 0`); overlaps W8's immutable-attempt semantics. Provider-level error taxonomy is already covered. |
| `SC_R16_BUDGET_RESERVATION` | → **follow-up** (no wave assigned yet) | Metric *reliability* is covered; planned/reserved/consumed/remaining budget-reservation reconciliation is not. Recommend a dedicated reconciliation task before the full acceptance suite is declared green. |
| `SC_R18_UNREGISTERED_EXTENSION_DENIED` | → **H-02 / W15** (Release 1-2+) | Vacuously satisfied today — no extension-registration/discovery surface exists in Release 0, so nothing unregistered can gain authority. Disclosed per E-02 finding F-1 (see `E-01-release0-evidence-matrix.md` deferred section, now three rows). |

### 6b. Release 1+ waves (not started)

- **W8 — Durable resume** (RS-01…RS-02): reconstruct current leaf with
  worktree/toolchain fingerprints and immutable attempts; crash/torn-write/
  cancellation cut-point handling. *Naturally covers `SC_R12_TRANSIENT_RETRY`
  on completion (see §7).*
- **W9 — Branching and compaction** (B-01…B-02): append-only branch metadata,
  fork/current leaf, immutable ancestors, no-merge-v1; typed compaction entry
  with provenance and evidence preservation.
- **W10 — Guarded mutation and approval** (M-01…M-02): policy profiles,
  canonical action fingerprints, single-use approvals, path/argv/env rules;
  monitored trusted-local mutation with execution receipts.
- **W11 — Flow integration** (FI-01…FI-02): consume harness evidence/gate
  artifacts through the evolved Task Manager API; single coordinator owns
  retries, review/fix, and completion transitions. *Depends on W2 (Task
  Manager evolution), which is already satisfied (`99952a5`).*
- **W12 — Child agents** (CA-01…CA-02): adapt canonical
  `subagent-dispatch`/`subagent-result` with parent/session/attempt
  extensions; child isolation, context budget, provenance.
- **W13 — Parallel scheduling** (PA-01): bounded ready-set waves, aggregate
  reservations, cancellation, loop detection under concurrency.
- **W14 — Real provider adapters** (RP-01): first real provider adapter
  behind an explicit capability and privacy/retention contract; storage off
  by default.
- **W15 — Security and recovery hardening** (H-01…H-02): security, recovery,
  replay, migration, performance, and red-team hardening suites; deferred
  extension capability grants and isolation (covers `SC_R18_*` fully).

## 7. Next

**Release 1 starts at W8 (durable resume).** W8's immutable-attempt /
reconstruct-leaf work naturally covers `SC_R12_TRANSIENT_RETRY` as part of its
own scope (a retried attempt is exactly a new immutable attempt against the
same leaf), so no separate retry-loop task is needed ahead of W8. `SC_R16_BUDGET_RESERVATION`
should get an explicit owning task before the full acceptance suite (not just
the per-wave frozen ACs) is declared green — recommend scoping it either
inside W8 or as a small standalone follow-up task. `SC_R18_UNREGISTERED_EXTENSION_DENIED`
remains correctly deferred to H-02/W15 and needs no earlier action.

## Evidence links

- [E-01-release0-evidence-matrix.md](./E-01-release0-evidence-matrix.md) —
  capability/evidence matrix (updated with the three-item deferred list).
- [E-02-release0-review-package.md](./E-02-release0-review-package.md) —
  independent review package (GO, no BLOCKER/P0/P1, F-1/F-2/F-3 findings).
- [decision-registry.md](./decision-registry.md) — package index (D-01…D-04,
  W2–W16 artifacts).
- [contract-inventory.md](./contract-inventory.md) — durable/public payload
  registry.
- [TM-01-task-manager-evolution.md](./TM-01-task-manager-evolution.md) — Task
  Manager additive-field evolution specification.
- `docs/requirements/keryx-project-agent-harness/implementation-plan.md` —
  normative DAG, wave order, and verification gates.

---

**Last updated:** 2026-07-13
**Updated by:** Flow 010 documentation worker (T7 / E-03)
**Status:** Handoff complete — Release 0 ready to promote; Release 1 planning
should begin at W8.
