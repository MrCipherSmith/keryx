# E-02: Release 0 Independent Review Package

**Status:** Complete (flow 010, dispatch 010-T6, task E-02)
**Date:** 2026-07-13
**Reviewer:** Flow 010 independent review worker (managed review)
**Scope reviewed:** `src/harness/**`, `src/contracts/**`, `src/eval/**` vs the
frozen requirements package (`docs/requirements/keryx-project-agent-harness/**`),
ADR-0001…0004, contract-inventory, TM-01, and the E-01 evidence matrix.
**Read-only** except the creation of this one document. No code, test, ADR,
frozen-requirement, `flow.json`, or per-wave review was modified.

---

## Executive verdict

> **Any BLOCKER / P0 / P1 remaining? — NO.**
>
> The assembled Release 0 offline read-only slice is architecturally sound,
> contract-conformant, fail-closed on every security lens checked, and covered
> by non-vacuous deterministic tests. `tsc --noEmit` is clean and `bun test` is
> **797 pass / 0 fail**. One **P2** and two **P3** advisories remain, none of
> which breaks a shipped Release 0 claim.

**Ship recommendation:** **GO** — ship the Release 0 vertical slice; address the
single P2 (evidence-matrix disclosure of a third deferred `@release-0` scenario)
before the E-03 release-evidence handoff is declared complete.

---

## Gate evidence (verified directly against the working tree at review time)

| Gate | Command | Result |
|---|---|---|
| Type check | `bun run typecheck` (`tsc --noEmit`) | **clean — no errors** |
| Test suite | `bun test` | **797 pass / 0 fail**, 3076 `expect()` calls, 135 files, 6.85s |
| Runtime dependencies | `package.json` `dependencies` | `{}` — no runtime dep added |
| Security boundary (`keryx ctx rg` over `src/harness src/contracts src/eval`) | network (`net/http/https/fetch/WebSocket/tls/dgram`) | **0 matches** |
| | fs-write / subprocess (`writeFile/mkdir/unlink/child_process/spawn/exec/Bun.write`) | 0 real calls (6 matches = 1 comment in `tool/types.ts:187`, 5 in a `*.test.ts`) |
| | provider SDK (`anthropic/openai/@ai-sdk/genai/langchain`) | 0 real imports (3 matches = comments in `provider-port.test.ts`) |
| | non-determinism (`Date.now/Math.random/new Date()/setTimeout`) | 0 real calls in runtime (27 matches are comment prose + type names + tests) |

The runtime is offline, deterministic, and dependency-free by construction:
every source of non-determinism (clock, id sequence) is injected via `deps`.

---

## Per-lens verdicts

### 1. Architecture — **PASS**
- Clean port/runtime layering: provider (`provider/provider-port.ts`), tool
  (`tool/tool-port.ts`, `tool/registry.ts`), policy (`policy/engine.ts`),
  session (`session/session.ts`), completion (`completion/gate.ts`), evidence
  (`evidence/redaction.ts`) are independent modules; the run loop
  (`run/run.ts`) assembles them by import and rewrites none.
- **D-02 single-coordinator invariant upheld:** the harness never writes
  `flow.json`. The fs-write scan found zero write calls in the runtime, and
  `policy/engine.ts:92-96,190-197` denies any tool call targeting `flow.json`
  or `flows/**.json` even with a valid matching approval
  (`isManagedFlowFile`). Task Manager remains the only flow-state writer.
- Transports do not re-implement semantics: `rpc.ts:76` (`runViaRpc`) and the
  CLI both delegate to the same `runOffline`, so CLI/RPC parity is structural.
- No provider SDK type crosses the domain port (`provider-port.ts:8` reuses the
  W4 validator and imports no SDK; the fixtures are provider-neutral).

### 2. Contract — **PASS**
- Durable payloads validate against their frozen schemas *in the tests*, not
  just by assertion of shape: `run/run.test.ts:299-303` validates the terminal
  `HarnessRunOutput` against `harness-run-output.schema.json`
  (`valid === true`, `errors === []`). `validateAgainstSchema` is used across 16
  harness/contract test files (startup, policy, gate, session, evidence, tool,
  provider, contract fixtures).
- `harness-run-output.schema.json` declares `unresolvedRisks` and
  `unresolvedBlockerIds`; the code's `HarnessRunOutput` matches the schema's
  `additionalProperties:false` surface, and the `status:"completed"` conditional
  (`gate.status==="pass"`, `artifacts minItems 1`, `unresolvedBlockerIds maxItems 0`)
  is honoured — `runOffline` only reaches `completed` when the gate passes and no
  blocker remains.
- All runtime records are `schemaVersion: 1`; envelope/versioning is consistent.

### 3. Logic — **PASS**
- Run-loop event ordering is correct: `tool_call_start` records the tool name,
  `tool_call_end` gates execution; only a policy `allow` reaches the executor
  (`run.ts:318-320`).
- Completion gating is correct: `evaluateCompletion` reaches `pass` only when all
  required gates pass, all required evidence is present, no undisposed blocker
  remains, **and** a final message was emitted — a final message alone never
  passes (`completion/gate.ts:160-167`).
- Budget and loop guards are sound: the hard budget boundary stops before
  starting an over-ceiling call (`run.ts:322-327`); loop detection trips at
  `LOOP_THRESHOLD` occurrences so strictly fewer executions happen for a runaway
  repeat (`run.ts:329-336`).
- Session is genuinely append-only + idempotent-on-resume: `entryId` is the
  content-key hash of `(payload, parent)`, so a replayed append lands on the
  same id instead of duplicating accepted evidence (`session/session.ts:92-94,
  126-133`); entries are `deepFreeze`d; `migrateSession` is deterministic and
  rejects an unsupported future `schemaVersion` with a typed error.

### 4. Security — **PASS**
- **D-03 fail-closed** holds on every path checked:
  - Hard deny is terminal and unoverridable by approval/role/interactivity, and
    is evaluated first (`engine.ts:179-187`).
  - Headless `ask` fails closed to `deny` (`engine.ts:233-241`).
  - Stale/consumed approvals do not authorize — a grant only lifts `ask→allow`
    when bound to the current `actionFingerprint` and not consumed
    (`engine.ts:104-110`).
  - Role is advisory only and never grants forbidden authority
    (`engine.ts:221-231`; test `engine.test.ts:397`).
  - Credential/destructive risks never auto-allow under a read-only profile
    (`engine.ts:66-68`; test `engine.test.ts:293`).
  - Flow-file edits are denied (`engine.ts:190-197`).
- **Context-trust guard** fails closed: a source is policy-trusted only when
  fresh, explicitly `trustedAsPolicy`, and of `exact` reliability
  (`engine.ts:263-267`).
- **Redaction-before-persistence** is correct: on a flagged scan only a masked
  preview + hash + category + provenance survive; a failed scan is a *blocking*
  state that persists nothing (`evidence/redaction.ts:80-108`).
- **No network / fs-write / subprocess / provider SDK / non-determinism** in the
  runtime (see gate-evidence scans above). Release 0 is offline and
  deterministic by construction.

### 5. Testing / replay — **PASS**
- Tests assert behaviour and validate against frozen schemas (not vacuous):
  e.g. `run/run.test.ts` drives the real `FakeProvider`, `FakeToolExecutor`, and
  `ToolRegistry` end-to-end and schema-validates the output.
- Replay is effect-free by construction: `replay/replay.ts` carries no
  provider/executor/network handle and is a pure synchronous hash comparison; a
  divergence returns a typed `ReplayMismatch` rather than any live fallback
  (`replay.ts:135-159`).
- Coverage of the 49 `@release-0` scenarios was cross-checked scenario-by-
  scenario (see the Gherkin lens). All are covered except the two known-deferred
  and one undisclosed gap (finding F-1).

### 6. Performance — **PASS (advisory only)**
- Disabled-capability floor is a true no-load: `startRun` returns
  `{kind:"disabled"}` before constructing any manifest/event/provider
  (`startup.ts:52-54`), and there is no provider dependency to import at all.
- Context manifest is bounded by `MAX_CONTEXT_BYTES`/`MAX_CONTEXT_TOKENS`
  (`startup.ts:87`); no unbounded loops — every stop condition (budget, loop,
  overflow, timeout) is a hard boundary modelled through injected stubs.

### 7. Gherkin — **PASS with one disclosure gap**
Every `@task-R0-0x` scenario maps to a real, asserting test. The two documented
deferrals (`SC_R12_TRANSIENT_RETRY`, `SC_R16_BUDGET_RESERVATION`) have **zero**
references anywhere in `src` (verified), correctly marked non-blockers. One
further `@release-0` scenario is uncovered **and undisclosed** — see F-1.

---

## Consolidated severity-ranked findings

| ID | Severity | Lens | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| F-1 | **P2** | Gherkin / evidence-accuracy | `SC_R18_UNREGISTERED_EXTENSION_DENIED` is tagged `@release-0` (acceptance.feature ~L465) but is neither implemented, tested, nor listed among the E-01 matrix's "2 deferred scenarios." Its owning task **H-02** is scoped to **W15 / Release 1-2+** ("extension contract is explicitly later scope", implementation-plan.md:143). The scenario is *vacuously satisfied* in Release 0 — there is no extension-registration/discovery surface at all, so nothing unregistered can gain authority — but the matrix's "2 deferred" count is therefore an undercount (actual ≥ 3). | `ctx rg` for extension registration in `src/harness` finds only provider *unknown-extension preservation* and the `credentialRef` local field — no registration mechanism. E-01 matrix "Deferred" section lists only `SC_R12_TRANSIENT_RETRY` and `SC_R16_BUDGET_RESERVATION`. | Before E-03 is declared complete, E-01 should disclose `SC_R18_UNREGISTERED_EXTENSION_DENIED` as a third deferred/vacuously-covered `@release-0` scenario (H-02 / W15), noting its vacuous satisfaction. Documentation-only; no code change. |
| F-2 | P3 | Logic | A malformed-input tool call that the executor rejects still increments `executedToolCalls` before the `try/catch` (`run/run.ts:350-361`), so a rejected call counts toward the tool-call budget and `metrics.toolCalls`. | `run.ts:350` (`executedToolCalls += 1`) precedes `run.ts:353-361` (invoke + catch → blocker + `continue`). | Acceptable (conservative) for Release 0 — SC_R04_MALFORMED_TOOL_INPUT's "no receipt/side effect" still holds. Optionally increment only after a successful invoke, or track attempted-vs-executed separately. |
| F-3 | P3 | Testing / replay | `replayOffline` compares the `RunResult`'s already-stored `*Hash` fields to the fixture rather than re-deriving them from primitive events/state, so it detects fixture tampering but not a divergence in the hash-derivation itself. | `replay/replay.ts:79-93` (`recomputeHashes` is an identity read of `run.*Hash`). Hashes are themselves derived from canonicalized events/state in `run.ts:430-439`. | Sufficient for validate-log Release 0. Consider re-deriving hashes from raw events in `replayOffline` to strengthen the guarantee in a later wave. |

**Deferred (documented non-blockers, classified per dispatch as P2/P3):**

| Scenario | Class | Status |
|---|---|---|
| `SC_R12_TRANSIENT_RETRY` (@release-0, positive) — run-loop retry of a transient provider error within budget | P2 (deferred) | Disclosed in E-01; run loop performs no retry (`retries: 0`). Provider-level error taxonomy IS covered (`provider-port.ts:74-88`, retry-boundary fixture). Covering wave: W8. |
| `SC_R16_BUDGET_RESERVATION` (@release-0, positive) — planned/reserved/consumed/remaining budget reconciliation | P2 (deferred) | Disclosed in E-01; metric *reliability* IS covered. No covering wave assigned yet — recommend a dedicated reconciliation task before the full acceptance suite is declared green. |

---

## Coverage cross-check (49 `@release-0` scenarios)

All 49 verified covered by an asserting test **except**:
`SC_R12_TRANSIENT_RETRY` (deferred, disclosed), `SC_R16_BUDGET_RESERVATION`
(deferred, disclosed), and `SC_R18_UNREGISTERED_EXTENSION_DENIED` (F-1,
undisclosed, vacuously satisfied). Twelve scenarios are covered under
alternative in-file naming (the P-01 provider suite uses "AC" naming; policy
`credential`/`read` cases sit inside the `SC_R05`/`SC_R04` suites; evidence
linkage sits inside the session suite) — each was opened and confirmed to carry
real assertions, not a tag stub.

---

## Consistency with frozen decisions
- **ADR-0001 (D-01 boundary):** Release 0 = offline read-only slice; the code
  matches (disabled floor, environment-blocked precondition, no live provider).
- **ADR-0002 (D-02 ownership):** harness never writes flow-state; upheld.
- **ADR-0003 (D-03 containment):** fail-closed policy + redaction; upheld.
- **ADR-0004 (D-04 provider/branch/child):** provider-neutral port with unknown-
  extension preservation; branch/child are later-wave and correctly absent.
- **contract-inventory / schema-version-registry:** every durable family is
  `schemaVersion 1` and validated by the hand-written deterministic validator
  (no external JSON-Schema runtime dependency).

---

## Routing audit
- `graph_used`: no — `not-relevant` (targeted file-level review of a known,
  enumerated scope; structure was already mapped by the E-01 matrix).
- `wiki_used`: no — `not-relevant` (review is against the frozen requirements
  package and ADRs directly, which are the normative source here).
- `ctx_used`: **yes** — all security-boundary and coverage searches ran through
  `keryx ctx rg`.
- `raw_rg_used`: **yes (bounded)** — three targeted `grep` calls over
  single/known files to confirm a `ctx rg` match's exact content
  (`tool/types.ts:187` comment; runtime non-determinism exclusion;
  `types.ts` fs-write match). Reason: confirming that a specific already-located
  `ctx rg` match is a comment/type-name, not a real call. Primary search was
  `ctx rg` in every case.

---

**Verdict line:** No BLOCKER / P0 / P1 remains. 1 × P2 (F-1, evidence-matrix
disclosure) + 2 × P3 advisories + 2 documented deferrals. **Ship recommendation:
GO**, with F-1 disclosed in E-01 before the E-03 handoff is declared complete.
