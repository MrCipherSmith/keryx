# E-01: Release 1 Capability/Evidence Matrix

**Status:** Draft (flow 019, task E-01 / dispatch 019-T6)
**Flow:** 019 (flow-orchestrator, Release 1 boundary re-run)
**Depends on:** H-01 (the provider red-team suite, this flow, task T5)
**Baseline verified at matrix-authoring time:** `bun test` — **1160 pass / 0
fail**, 4287 `expect()` calls, 161 files; `tsc --noEmit` clean; `package.json`
`dependencies` — `{}`. Branch: `claude/keryx-harness-phase-1-109f34` (feature
worktree `feature-keryx-harness-impl`).

This document is the Release 1 counterpart to
[E-01-release0-evidence-matrix.md](./E-01-release0-evidence-matrix.md), which
it does not overwrite. It mirrors that document's structure and covers only
the Release 1 waves (W8–W15) plus the H-01 provider red-team suite run in
this flow. Release 0 (W1–W7 + W16(R0)) is reused unchanged and is not
re-litigated here.

---

## Purpose

This document is the `E-01` deliverable required by `implementation-plan.md`
(frozen spec, per flow 019 `context.md`): "Update package index, research
ledger, migration notes, and capability/evidence matrix," with the evidence
requirement "traceability gate; every claim marked implemented / planned /
deferred." Every path and commit cited below was checked against the working
tree — `git log --oneline -1 <hash>`, `git show --stat <hash>`, `ls`, and
`bun test <path>` — before being listed; no path or commit is asserted from
memory. Where a claim in the flow's `context.md` did not match the verified
code (session-migration versioning; see the Migration Notes section), the
matrix below records the verified behavior, not the unverified claim.

---

## Capability / Evidence Matrix

| Capability | Wave | Status | Source file(s) | Test(s) | Commit |
|---|---|---|---|---|---|
| **RS-01** — Durable resume: fingerprint-matched leaf reconstruction, immutable prior attempts, bounded transient-retry (`runWithResume`), evidence/approval survive resume | W8 | implemented | `src/harness/resume/fingerprint.ts`, `src/harness/resume/store.ts`, `src/harness/resume/resume.ts` | `src/harness/resume/resume.test.ts` | `c279e3a` |
| **RS-02** — Crash/recovery decision (`recoverFrom`): failpoint matrix (crash-pre-effect → safe-reexecute; crash-post-effect+confirmed → reconciled; indeterminate/missing-receipt → blocked-unknown-outcome; torn-write → last schema-valid entry; cancellation → cancelled-resumable) | W8 | implemented | `src/harness/resume/recovery.ts` | `src/harness/resume/recovery.test.ts`, `src/harness/resume/recovery.hardening.test.ts` | `c279e3a` |
| **B-01** — Append-only branching: fork/leaf/immutable-ancestor metadata, deep-frozen branch + ancestors, atomic leaf-pointer switch, `mergeBranches` always rejects (no-merge-v1) | W9 | implemented | `src/harness/branch/branch.ts` | `src/harness/branch/branch.test.ts` | `33f8e8d` |
| **B-02** — Typed compaction: provenance-carrying derived entries (`sourceEntryIds` → `derivedEntryId`, `summaryHash`), `assertEvidencePreserved` throws on dropped source, `rebuildBoundedContext` re-derives with `summaryHash` | W9 | implemented | `src/harness/branch/compaction.ts` | `src/harness/branch/compaction.test.ts` | `33f8e8d` |
| **M-01** — Guarded mutation preconditions: canonical action-fingerprint, fail-closed `checkApproval` (valid only for approved/matching/unexpired/unconsumed/interactive), `guardAction` denies path traversal, symlink escape, shell injection, private/loopback/metadata egress, direct credential access | W10 | implemented | `src/harness/mutation/fingerprint.ts`, `src/harness/mutation/approval.ts`, `src/harness/mutation/guard.ts` | `src/harness/mutation/approval.test.ts`, `src/harness/mutation/guard.test.ts` | `8ed5373` |
| **M-02** — Monitored mutation execution: fake `MutationAdapter` under trusted-local + valid single-use approval persists a schema-valid execution receipt + evidence; unattended-untrusted blocked without isolation; indeterminate outcome → `needs-reconciliation` feeding W8 `recoverFrom` to block unsafe retry | W10 | implemented | `src/harness/mutation/execute.ts` | `src/harness/mutation/execute.test.ts` | `8ed5373` |
| **FI-01** — `ManagedFlowPort`: maps `CompletionGateResult` + `evidenceRefs` + `runLink` to a single Task Manager `taskDone(...)` call (pass→completed, fail→failed, blocked→blocked); harness never writes `flow.json` (D-02); `src/flow` `taskDone` extended additively (optional `evidenceRefs?`/`runLink?`) | W11 | implemented | `src/harness/flow/managed-flow-port.ts`; additive `src/flow/service.ts` (`taskDone` at line 243, `evidenceRefs`/`runLink` handling at lines 257–261) | `src/harness/flow/managed-flow-port.test.ts`; prior `src/flow` suite (`migration.test.ts`, `disposition.test.ts`) stays green, unmodified | `d2f8ca4` |
| **FI-02** — Completion parity: harness gate ⟺ Task Manager task completion; a failing gate cannot launder into a completed task (`isFailureDisposition`); single-coordinator invariant (exactly one `taskDone` call, spy-asserted) | W11 | implemented | `src/harness/flow/parity.ts` | `src/harness/flow/parity.test.ts` | `d2f8ca4` |
| **CA-01** — Canonical child contract: adapts `subagent-dispatch`/`subagent-result` with the frozen `harness-child-contract-extension` metadata (parent/session/attempt/branch/context/policy fingerprints, budget reservation, durable result artifact); STATUS-first prose converted to canonical result before persistence; CLI⟺JSONL-RPC transport parity | W12 | implemented | `src/harness/child/contract.ts` | `src/harness/child/contract.test.ts` | `550f372` |
| **CA-02** — Fail-closed child isolation + spawn: isolated child context/session (append-only into parent, cannot mutate parent state/evidence); budget inheritance fail-closed (child reservation ⊆ parent remaining); policy inheritance fail-closed on three layers (trustMode not broader, per-capability containment unconditional, isolation never downgraded); child never writes `flow.json` | W12 | implemented | `src/harness/child/isolation.ts`, `src/harness/child/spawn.ts` | `src/harness/child/isolation.test.ts`, `src/harness/child/spawn.test.ts` | `550f372` |
| **PA-01** — Bounded ready-set wave scheduler: `planWaves` is a pure function producing dependency-satisfied, `maxConcurrency`-capped waves in stable order; aggregate budget reservations across waves never exceed parent remaining (fail-closed deny on breach); transitive-dependent exclusion on cancellation; cycle detection denies with no partial waves; fail-closed on degenerate `maxConcurrency` | W13 | implemented | `src/harness/parallel/scheduler.ts` | `src/harness/parallel/scheduler.test.ts` | `8ec1016` |
| **H-01** — Security & recovery hardening: broadened SSRF/private-egress detection (encoded IPv4, all private ranges incl. metadata/CGNAT); NaN-date fail-closed in approval expiry; `SC_R18_UNREGISTERED_EXTENSION_DENIED` closed (fail-closed `registerExtension`); `SC_R16_BUDGET_RESERVATION` closed (planned/reserved/consumed/remaining reconcile, fail-closed on over-consumption); recovery/replay/migration/performance regression-lock suites | W15 | implemented | `src/harness/mutation/guard.ts` (broadened egress predicate + `isPrivateEgressHost`), `src/harness/mutation/approval.ts` (NaN-date fix), `src/harness/extension/registry.ts`, `src/harness/budget/reconcile.ts` | `src/harness/mutation/guard.ssrf.test.ts`, `src/harness/mutation/guard.ssrf-encoded.test.ts`, `src/harness/mutation/approval.nan.test.ts`, `src/harness/extension/registry.test.ts`, `src/harness/budget/reconcile.test.ts`, `src/harness/migration.hardening.test.ts` | `de46260` |
| **H-02** — Deferred extension capability contract (docs, no runtime enablement): defines extension capability grants + isolation for a later release without enabling them | W15 | implemented (as a documentation deliverable — the deferral itself, not the extension runtime) | `docs/decisions/keryx-harness/H-02-deferred-extension-capability-contract.md` | n/a (docs artifact; the deferred scenarios it documents are test-evidenced as *not yet implemented*, see Deferred List below) | `de46260` |
| **RP-01** — First real provider adapter: `AnthropicProvider` implements `ProviderPort` via thin fetch/SSE (no SDK); `describe()`/`descriptorDocument()` validate against the frozen schema with `remoteState.storage/retention/continuation = false`; live fetch gated behind an explicit capability grant (no grant → fail-closed, no network call); egress guarded by the reused W15 private-egress predicate (`isPrivateEgressHost`, additive export on `guard.ts`); 9-kind provider-error taxonomy fail-closed with no spurious `model_end`; API key redacted from every error message | W14 | implemented | `src/harness/provider/anthropic/anthropic-provider.ts`, `src/harness/provider/anthropic/sse.ts`; additive `src/harness/mutation/guard.ts` (`isPrivateEgressHost` export) | `src/harness/provider/anthropic/anthropic-provider.test.ts`, `src/harness/provider/anthropic/sse.test.ts` | `109c63c` |
| **H-01 (this flow) — provider-negatives red-team suite**: consolidated offline red-team suite over the W14 adapter driving `stream()` to a terminal event for timeout/stalled-body, rate-limit (429 ± `retryAfterMs`), malformed event, torn-SSE truncation, zero-byte/empty body, egress-deny (incl. encoded private/loopback/metadata base URL), cancellation (`AbortSignal`), and authentication (401) — each asserting the correct `ProviderErrorKind` + `retryable` and no credential leak | W15 (this flow, task T5) | implemented | `src/harness/provider/anthropic/anthropic-provider.ts` (fail-closed fix: guarded body read on abort → terminal `cancelled` `provider_error` instead of an uncaught throw; empty/zero-byte body → terminal `malformed` `provider_error` instead of a silent zero-event success) | `src/harness/provider/anthropic/anthropic-negatives.hardening.test.ts` (10 tests, 72 `expect()` calls, verified green in isolation: `bun test src/harness/provider/anthropic/anthropic-negatives.hardening.test.ts` → 10 pass / 0 fail) | uncommitted at matrix-authoring time (this flow's T5 dispatch; the fail-closed fix is the sole runtime-code change for flow 019 per AC5) |

All `implemented` rows above were spot-verified against the working tree in
this session: `git log --oneline -1 <hash>` resolved every cited commit to
the expected subject line; `git show --stat <hash>` listed the cited source
paths; `ls` confirmed every test file exists on disk; `bun test
src/harness/provider/anthropic/anthropic-negatives.hardening.test.ts` was run
directly and returned 10 pass / 0 fail; the full-suite baseline (`bun test`)
returned 1160 pass / 0 fail; `bun run typecheck` (`tsc --noEmit`) returned
clean.

---

## Deferred List (status = deferred)

These are `@release-2`-tagged scenarios in `acceptance.feature` that Release
1 (W8–W15) does not implement. Each is already recorded, with the same
disposition, in
[H-02-deferred-extension-capability-contract.md](./H-02-deferred-extension-capability-contract.md)
(§ "Coverage disposition" table); this matrix cross-references that table
rather than re-deriving it, to avoid drift between the two documents.

| Scenario | Acceptance tag | Status | Deferred to |
|---|---|---|---|
| `SC_R08_CHILD_DISPATCH_CANONICAL_RESULT` | `@R8 @R9 @release-2 @positive` (`acceptance.feature:376`) | deferred | Release 2+, first extension-execution wave — extends CA-01's canonical-contract adapter to a registered-extension dispatch path, which does not exist yet |
| `SC_R08_NEEDS_CONTEXT_ADAPTER` | `@R8 @R12 @release-2 @positive` (`acceptance.feature:459`) | deferred | Release 2+, first extension-execution wave |
| `SC_R08_BOUND_PARALLEL_WAVE` | `@R8 @R12 @release-2 @positive` (`acceptance.feature:467`) | deferred | Release 2+ — extends PA-01's scheduler to a registered-extension-bound wave, not yet in scope |
| `SC_R18_REGISTERED_EXTENSION_PROVENANCE` | `@R18 @R5 @release-2 @positive` (`acceptance.feature:333`) | deferred | Release 2+, first extension-execution wave — `registry.ts` (W15/H-01) only implements the fail-closed *denial* of an unregistered extension; provenance tracking for a *registered* one is not yet built |
| `SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY` | `@R8 @R18 @R15 @release-2 @negative` (`acceptance.feature:384`, task `CA-01`) | deferred | Release 2+, first extension-execution wave |
| `SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY` | `@R18 @R5 @release-2 @negative` (`acceptance.feature:576`, task `H-02`) | deferred | Release 2+, first extension-execution wave — a distinct scenario from the CA-01 one above (different task tag, same "escalation requires policy" invariant re-asserted from the extension-registry side) |
| `SC_R13_TUI_DEFERRED` | `@R13 @release-2 @positive` (`acceptance.feature:520`, task `R0-03`) | deferred | Release 2+ — TUI remains a later adapter over the stable CLI/JSONL-RPC runtime ports; no runtime-contract change required to add it later |
| `SC_R04_SHELL_CONTAINMENT` (live process-group enforcement only) | `@R4 @R15 @release-1 @positive` (`acceptance.feature`, task `M-01`) | **partial** — the *structural* containment is implemented and test-evidenced (argv/env-allowlist action fingerprint, shell-injection denial, approval-gating, fail-closed isolation — `src/harness/mutation/{guard,fingerprint,approval,execute}.ts` + tests, `8ed5373`); the *runtime* assertion (a running process-group command enforcing timeout / output-limit / cwd / cancellation) is NOT built or test-evidenced because Release 1 ships no real subprocess executor (mutation runs through a fake/injected adapter — D-04/W10 posture) | Release 2+ real-subprocess executor wave (disclosed per E-02 finding F-1, mirroring the R0 boundary's F-1) |

### Closed in Release 1 (previously deferred, now implemented)

| Scenario | Previously deferred at | Closed by | Evidence |
|---|---|---|---|
| `SC_R12_TRANSIENT_RETRY` — retry one transient provider error within budget, recording a new attempt without exceeding the reservation | W7 → W8 (per R0 matrix) | W8 (`c279e3a`) — `runWithResume` in `src/harness/resume/resume.ts` | `src/harness/resume/resume.test.ts` |
| `SC_R18_UNREGISTERED_EXTENSION_DENIED` — reject an extension lacking a pinned manifest and capability grant at discovery time | n/a → H-02/W15 (per R0 matrix, marked vacuously satisfied pre-Release-1) | W15 (`de46260`) — `registerExtension` in `src/harness/extension/registry.ts` | `src/harness/extension/registry.test.ts` |
| `SC_R16_BUDGET_RESERVATION` — reconcile planned/reserved/consumed/remaining budget values across a provider attempt | W7 → follow-up (per R0 matrix, no wave assigned) | W15 (`de46260`) — `src/harness/budget/reconcile.ts` | `src/harness/budget/reconcile.test.ts` |
| W10 SSRF/loopback-encoding + NaN-date hardening concerns (flagged in the W10 flow's own T9 review as deferred to W15, not a breach of fail-closed at the time) | W10 → W15 | W15 (`de46260`) — broadened `guard.ts` egress predicate + `approval.ts` NaN-date fix | `src/harness/mutation/guard.ssrf.test.ts`, `src/harness/mutation/guard.ssrf-encoded.test.ts`, `src/harness/mutation/approval.nan.test.ts` |

---

## Research Ledger Update

RP-01 (W14) resolved research-ledger `OPEN-1` ("concrete first real provider
and credential shape"), previously recorded in
[research-ledger.md](./research-ledger.md) as "Still OPEN … bound to future
W14": the chosen adapter is the **Anthropic Messages API**, implemented as a
thin `fetch` + hand-written incremental SSE parser
(`src/harness/provider/anthropic/sse.ts`) — **no provider SDK** — so
`package.json` `dependencies` stays `{}`. Test fixtures are **recorded SSE
transcripts** replayed through an injected/mocked `fetch`
(`as unknown as typeof fetch`), matching the W6 fake-provider fixture
pattern; the entire adapter test suite (`anthropic-provider.test.ts`,
`sse.test.ts`, and this flow's `anthropic-negatives.hardening.test.ts`) is
offline and deterministic — the live network path exists but fires only
behind an explicit capability grant and never runs in CI. Provider remote
state (`storage`, `retention`, `continuation`) is declared **off by default**
(`false`) in `descriptorDocument()`, per the frozen provider-descriptor
schema — no server-side conversation storage or continuation is enabled by
this adapter. `OPEN-2` (per-role budget values) is further narrowed by W15's
`src/harness/budget/reconcile.ts`, which reconciles planned/reserved/
consumed/remaining *shapes* but — consistent with the R0 matrix's
"field shape frozen, value policy still OPEN" note — still does not fix
concrete per-role budget *values*; that remains open. `OPEN-3` (artifact
retention windows per class under team vs solo policy) remains open: W11's
`ManagedFlowPort` passes `evidenceRefs`/`runLink` through to Task Manager but
does not define retention-window policy.

---

## Migration Notes

### Flow (Task Manager) `schemaVersion` 1 → 2 — additive `taskDone` fields (W11, FI-01)

Unchanged in kind from the R0 matrix's TM-01 entry, extended by W11: `src/flow/service.ts`'s
`taskDone(...)` (line 243) now accepts optional `evidenceRefs?`/`runLink?`
(handled at lines 257–261) so `ManagedFlowPort` can pass harness completion
evidence through to Task Manager. This is purely additive — no existing
`taskDone` caller or field is changed — and the migration itself remains the
W2-established **read-time-only** `schemaVersion: 1 → 2` normalization in
`src/flow/store.ts` (line 57, "Deterministic schemaVersion 1 -> 2 migration
(TM-01 §4.2). Applied on read."): a loaded `schemaVersion: 1` flow is
normalized to `2` in memory; `writeFlow` always persists `2`; no file is
rewritten until the next mutation. All 34 prior `src/flow` tests
(`migration.test.ts`, `disposition.test.ts`) stayed green and unmodified
across W8–W15 (verified: `d2f8ca4`'s commit message states "all 34 prior
src/flow tests stay green").

### Session `schemaVersion` — verified correction to the flow's `context.md` claim

Flow 019's `context.md` (T1) describes this as a "session v1→v2" migration.
**That does not match the verified code.** `src/harness/session/session.ts`
defines a single constant `SCHEMA_VERSION = 1` (line 31); `migrateSession`
(lines 240–284) deterministically upgrades a **prior schemaVersion-0-style**
session (undated/pre-schema shape) into the current schema-1 shape — it does
not migrate 1→2, and no schemaVersion 2 exists for sessions in Release 1. The
migration is: deterministic (two runs over identical input are byte-identical,
tested at `session.test.ts:344-345`), non-mutating of the caller's input,
supplies deterministic non-empty defaults for absent fields, and rejects any
`schemaVersion` greater than the current constant with a typed
`SchemaMigrationError` (tested at `session.test.ts:373`,
`/schemaVersion/i` throw assertion). No destructive migration path exists —
every branch either upgrades or rejects; nothing is silently dropped. This
correction is recorded here rather than silently adopting the inaccurate
"v1→v2" framing, per this flow's own traceability requirement that every
claim be checked against the real code.

### No destructive migration in Release 1

Across all of W8–W15, every schema-version-touching path found in this
review (flow `1→2`, session `0-style→1`) is additive/read-time-normalizing.
No Release 1 wave introduces a destructive migration, a forced rewrite, or a
schema downgrade path.

---

## Invariants Held Across Release 1

- **D-02 (harness never writes `flow.json`)**: `ManagedFlowPort` (W11,
  `managed-flow-port.ts`) is the sole harness→Task-Manager bridge and calls
  only `FlowService.taskDone(...)`; `FI-02`'s parity suite asserts *exactly
  one* `taskDone` call per completion (single-coordinator invariant,
  `parity.test.ts`). Child agents (W12) also never write `flow.json` —
  `NEEDS_CONTEXT`/blocked/failed dispositions return to the parent as an
  `EvidenceRecord`, and the parent alone owns completion. The parallel
  scheduler (W13) is a pure function returning a plan; it writes nothing.
- **Fail-closed across every new authority boundary**: mutation guard/approval
  (W10, hardened W15), child policy/budget inheritance (W12: trustMode not
  broader, per-capability containment unconditional, isolation never
  downgraded), scheduler budget aggregation and degenerate-`maxConcurrency`
  handling (W13), extension registration (W15, `registry.ts`), and the
  provider adapter's capability-gated egress + 9-kind error taxonomy + this
  flow's two closed gaps (stalled-body → `cancelled`, empty-body →
  `malformed`) (W14 + this flow's H-01).
- **Offline / deterministic tests**: every Release 1 test file listed above
  uses injected clocks/ids, mocked or recorded-fixture `fetch`
  (`as unknown as typeof fetch`), and no `Date.now`/`Math.random`/live
  network — consistent with the R0 gate-evidence methodology
  (`E-02-release0-review-package.md` §"Gate evidence").
- **`package.json` `dependencies`: `{}`** — unchanged across all of W8–W15;
  RP-01 (W14) in particular adds a real external-API integration
  (Anthropic Messages API) with zero new runtime dependency, via hand-written
  `fetch` + SSE parsing.
- **Frozen requirements package, ADR-0001…0004, `src/eval/`, `src/contracts/`,
  and canonical schemas**: not modified by any Release 1 wave commit
  (`git show --stat` on each cited commit shows no touch to those paths,
  beyond H-02's own new docs file and each wave's own flow package under
  `.metaproject/flows/`).

---

## Traceability to the frozen E-01 acceptance criterion (AC2, flow 019)

> "E-01 Release 1 evidence matrix — maps each Release 1 capability (W8
> resume, W9 branch/compaction, W10 mutation, W11 flow integration, W12 child
> agents, W13 parallel scheduling, W15 hardening incl. SSRF/NaN/extension/
> budget, W14 real provider) to a real source file, a real test, and a real
> commit hash … and every claim is marked implemented / planned / deferred
> (traceability gate); a research-ledger update and migration notes are
> included. The doc edits NO runtime or frozen file."

- Every Release 1 capability named in AC2 has a row above with a verified
  source path, test path, and commit hash (RS-01/RS-02, B-01/B-02,
  M-01/M-02, FI-01/FI-02, CA-01/CA-02, PA-01, H-01, H-02, RP-01), plus the
  H-01 provider-negatives red-team row for this flow's own T5 deliverable.
- Every row is explicitly marked `implemented`; the seven `@release-2`
  scenarios above are explicitly marked `deferred` with the release/wave
  that will cover them; the four previously-deferred R0 scenarios now closed
  in Release 1 are recorded as `closed`. No row in this document claims
  `planned` — Release 1 is fully built at matrix-authoring time; nothing in
  this document is aspirational.
- A research-ledger update (RP-01 provider choice, fixture strategy,
  storage/retention/continuation off) and migration notes (flow 1→2
  additive, session 0-style→1, corrected from the flow context's "v1→v2"
  claim) are both included above.
- This document is the only file this task created or modified; no runtime
  code, frozen requirements package, canonical schema, `src/contracts`,
  ADR-0001…0004, `flow.json`, `acceptance-criteria.md`, other flow file, or
  the Release 0 evidence matrix was touched.

---

**Last updated**: 2026-07-13
**Updated by**: Flow 019 documentation worker (T6 / E-01)
**Status**: Draft — pending E-02 independent review (flow 019, task T7).
