# E-02: Release 2 Independent Review Package

**Status:** Complete (flow 029, dispatch 029-T6, task E-02)
**Date:** 2026-07-14
**Reviewer:** Flow 029 independent review worker (managed review, `review-orchestrator`)
**Scope reviewed (Release 2 = R2-1…R2-5 + R2-postreview + R2-postreview-2):**
`src/harness/extension/{execute,provenance,bound-wave}.ts`,
`src/harness/process/{executor,real-process-adapter}.ts`,
`src/commands/{select,shell}.ts`, `src/harness/provider/make-provider.ts`, and
the additive `isKnownCapability` export in `src/harness/child/isolation.ts` —
against the frozen requirements package
(`docs/requirements/keryx-project-agent-harness/**`, the seven `@release-2`
scenarios plus the runtime half of `SC_R04_SHELL_CONTAINMENT`), ADR-0001…0004,
the canonical contract schemas, and the E-01 Release 2 evidence matrix
([E-01-release2-evidence-matrix.md](./E-01-release2-evidence-matrix.md)).
**Read-only** except the creation of this one document. No source, test, ADR,
frozen-requirement, canonical schema, `flow.json`, `acceptance-criteria.md`, the
R0/R1 review packages, or per-wave review was modified.

This is the Release 2 counterpart to
[E-02-release1-review-package.md](./E-02-release1-review-package.md), which it
does not overwrite. It mirrors that document's structure (severity scale,
per-lens verdicts, findings table, consistency check, routing audit) and covers
only the Release 2 surface; Release 0 (W1–W7 + W16(R0)) and Release 1 (W8–W15 +
W14) are reused unchanged and are not re-litigated here.

---

## Executive verdict

> **Any BLOCKER / P0 / P1 remaining? — NO.**
>
> The assembled Release 2 slice (bounded policy-governed extension execution,
> registered-extension provenance, bound-parallel-wave scheduling over registered
> extensions, the interactive CLI provider/model adapter, and the real-subprocess
> executor that closes the Release 1 F-1 `SC_R04` live-enforcement gap) is
> architecturally sound (reuse-only/additive — each wave composes prior modules
> with 0 behavior-changing edits to them), contract-conformant (canonical
> subagent-dispatch/result round-trip and provenance records validate against the
> frozen schemas; the frozen `CanonicalSubagentStatus` enum is untouched),
> fail-closed on every new authority boundary, and covered by non-vacuous
> deterministic offline tests. `tsc --noEmit` is clean and `bun test` is **1338
> pass / 2 skip / 0 fail**. The full **5-lens** Release 2 review
> (security / highload+logic / architecture / clean-code / testing) found
> **0 BLOCKER / 0 HIGH**. Its **5 MED** findings — most notably an SSRF
> divergence in the `select.ts` provider-detection path — were **found and closed**
> TDD in flow 027 / PR #30; its **7 LOW/INFO** findings were closed in flow 028 /
> PR #31; a single **known-limitation (H)** — cap-less-child tool-call aggregate
> accounting — is **documented as deferred** with an evidence-based rationale
> (a deny would fail-close the entire executor path; `inheritBudget` remains
> correct).

**Ship recommendation:** **GO** — promote the Release 2 package and proceed to
the E-03 Release 2 handoff. No open P0/P1/P2 remains; the single H item is a
documented runtime-enforcement known-limitation, not a shipped-claim defect.

---

## Severity scale (mirrors R0/R1)

| Severity | Meaning |
|---|---|
| **BLOCKER** | Ships a broken or unsafe Release 2 claim; must fix before any handoff. |
| **P0** | A fail-open on a security/authority boundary, or a broken frozen contract. Must fix. |
| **P1** | A correctness defect that can produce a wrong durable outcome under a realistic input. Must fix before the handoff. |
| **P2** | A traceability / disclosure / coverage-precision gap that does not break a shipped claim. Should fix before the handoff is declared complete. |
| **nit** | Cosmetic or forward-looking hardening suggestion; optional. |

The per-wave 5-lens reviews classified their findings on the conventional
**BLOCKER / HIGH / MED / LOW / INFO** scale; the mapping to this package's scale
is: the 5 MED (all closed in #30) sit at **P1/P2** equivalence and are **closed**;
the 7 LOW/INFO (all closed in #31) sit at **nit/P2** equivalence and are
**closed**; the H known-limitation is a documented **deferred nit-class**
runtime-enforcement item. **Zero** BLOCKER/P0/P1 remain open.

---

## Gate evidence (verified directly against the working tree at review time)

| Gate | Command | Result |
|---|---|---|
| Type check | `bunx tsc --noEmit` | **clean — no errors** (exit 0) |
| Test suite | `bun test` | **1338 pass / 2 skip / 0 fail**, 4774 `expect()` calls, 173 files, ~6.1s |
| Runtime dependencies | `package.json` `dependencies` | `{}` — no runtime dep added across any R2 wave (R2-4 CLI uses stdlib `node:readline`; R2-5 uses stdlib `node:child_process`) |
| D-02 (harness never writes `flow.json`) | `keryx ctx rg 'writeFlow\|flow\.json' src/harness/extension src/harness/process` | **only comments** — 3 matches, all documentation comments in `execute.ts`, `bound-wave.ts`, `provenance.test.ts` asserting "NEVER writes flow.json"; no write call |
| Egress guard reused in CLI detection | `keryx ctx rg 'isPrivateEgressHost\|isLoopbackHost' src/commands/select.ts` | reused verbatim — `import { isLoopbackHost, isPrivateEgressHost } from "../harness/mutation/guard"` and applied before probe (`select.ts:85`: `if (isPrivateEgressHost(host) && !isLoopbackHost(host)) …` skips fetch) |

The 2 skips are the flag-gated real-subprocess smoke tests
(`KERYX_ALLOW_REAL_SUBPROCESS=1`), CI-inert by design. The runtime remains
offline, deterministic, and dependency-free by construction: every Release 2
offline test injects clocks/ids and a mocked/recorded-fixture `fetch`; the only
new external-effect surfaces (the R2-4 provider probe and the R2-5 real
subprocess adapter) are capability/flag-gated and egress- or allowlist-guarded
before any effect.

---

## Per-lens verdicts

### 1. Architecture — **PASS**
- **Reuse-only / additive composition.** Each Release 2 wave composes prior
  modules and introduces **zero behavior-changing edits** to them. R2-1
  `execute.ts` composes the W12 canonical child adapter + W15 registry + W10
  approval + W8 immutable attempts; R2-2 `provenance.ts` is a pure new module
  over W15 with **zero prior-module edits**; R2-3 `bound-wave.ts` reuses W13
  `planWaves` + R2-1 `dispatchExtension` + W12 `inheritBudget` + W15 registry; R2-5
  `process/` composes W10 `guardAction`/`actionFingerprint`/`ExecutionReceipt` +
  W12 `inheritBudget` + W7 evidence. The only additive prior-module change is the
  single `isKnownCapability` export in `child/isolation.ts` (no behavior change).
- **D-02 (harness never writes `flow.json`) upheld.** The `ctx rg` D-02 scan over
  both `src/harness/extension` and `src/harness/process` returns **only comments**
  asserting the invariant — no write path. Every R2 module is either a pure
  function (`bound-wave.ts`, `provenance.ts`, the executor core) or an adapter
  that reaches its single injected side-effecting boundary (`ProcessAdapter`,
  `fetch`), never flow-state. Parent completion continues to flow through exactly
  one reused W11 `ManagedFlowPort.taskDone`.
- **Dependency-free.** `package.json` `dependencies` stays `{}`; the R2-4 CLI adds
  interactive selection on stdlib `node:readline` and R2-5 spawns via stdlib
  `node:child_process`, so no SDK/framework enters the tree.
- **Provider instantiation centralized (#31/B).** The R2-postreview-2 polish
  introduced `src/harness/provider/make-provider.ts` as the sole place
  instantiating Anthropic/Ollama/Fake (with missing-`ANTHROPIC_API_KEY` → fake
  fallback); `shell.ts` and `harness.ts` route through it — a consolidation, not a
  new boundary.

### 2. Contract — **PASS**
- **Canonical subagent-dispatch/result round-trip (R2-1).** `dispatchExtension`
  maps a registered extension + a coordinator's reserved child budget to a
  canonical `subagent-dispatch` that validates against the **frozen** schema, with
  `allowed_actions` bounded **exactly** to the grant (never broader), and
  normalizes a STATUS-first result to a canonical `subagent-result` **before**
  persistence (`SC_R08_CHILD_DISPATCH_CANONICAL_RESULT`).
- **Provenance record without authority widening (R2-2).**
  `registerExtensionWithProvenance` persists an `ExtensionProvenanceRecord`
  (`manifestHash` + `grantId` + a **fresh copy** of the granted capabilities +
  a W12/W7-shaped `Provenance`); the review proved the record is alias-immune —
  mutating the grant array does not leak into the record.
- **ExecutionReceipt / evidence schema-valid (R2-5).** The contained-process
  outcome carries a W10 `ExecutionReceipt` and W7 evidence; #31/F normalized the
  outcome `evidenceRefs` to the receipt's prefixed encoding for consistency.
- **Frozen `CanonicalSubagentStatus` enum untouched.** The #31/E fix for
  bound-wave planning-time evidence deliberately avoided the frozen enum — a local
  builder emits `kind:custom` / `artifact.kind:extension-dispatch-planned` instead
  of stamping `child-result:DONE`, and W12 `spawn.ts` is left untouched.
- No reviewed change alters a frozen schema, ADR, `src/contracts`, or `src/eval`
  (the E-01 matrix's per-commit `git show --stat` cross-check confirms additive
  source + tests only).

### 3. Logic — **PASS**
- **Extension escalation is a three-gate fail-closed AND (R2-1).**
  `evaluateExtensionGrant` treats requested ⊆ granted as bounded/ok; a broader
  tools/provider request is an escalation **denied unless all three** of an
  explicit policy `allow` ∧ parent-linked provenance ∧ a valid W10 approval are
  present — each missing piece independently denies, an out-of-enum value fails
  closed, and a denied escalation grants **nothing** (no silent authority gain).
  `provenance.ts` `evaluateRegisteredExtensionCapability` re-asserts this from the
  registry side by verbatim delegation.
- **Bound-wave concurrency + budget via `planWaves` (R2-3).** `planExtensionWave`
  denies the whole plan if any `registration.ok===false` (no partial binding),
  then delegates the concurrency ceiling, aggregate-budget reservation, and
  cycle/degenerate deny to the reused W13 `planWaves`; per-attempt evidence is
  distinct, non-aliased, and immutable.
- **Executor gate-order + observation classification (R2-5).**
  `runContainedProcess` enforces argv/env allowlist → budget (`inheritBudget`) →
  `adapter.spawn` exactly once in the approved cwd → classify; the adapter never
  spawns on a deny, and every bound hit (timeout / output-overflow / cancel /
  spawn-error) is a recorded **NON-success** (never `completed`).
- **The #30 logic fixes.** `executor.ts` now surfaces `exitCode` on the
  `completed` outcome (a non-zero in-bounds exit stays `completed` for containment
  semantics but is recoverable); the extracted **pure** `classifyProcessResult`
  maps only a genuine deadline (`ETIMEDOUT` / `SIGKILL`+deadline) to
  `deadline-exceeded`, while a crash signal (SIGSEGV/SIGTERM) → `spawn-error` —
  **never** a false deadline or `completed` (unit-tested offline without spawning).

### 4. Security — **PASS** (five MED found-and-fixed in flow 027; one H documented-deferred)
- **SSRF in provider detection FOUND → FIXED (#30/1).** The review found that
  `select.ts` `probeOllamaModels` fetched a caller-supplied `--base-url` host
  **without** the egress guard the `OllamaProvider` chat path already applies. The
  fix reuses `isPrivateEgressHost`/`isLoopbackHost` **before** fetching, verified
  by the gate scan (`select.ts:85`): a private / link-local / metadata host omits
  ollama with **no fetch issued**; loopback stays probeable. This closes the SSRF
  divergence — detection is now fail-soft and egress-guarded, matching the chat
  path.
- **Extension escalation requires policy ∧ provenance ∧ approval** — see Logic;
  the adversarial escalation sweep found no bypass (three sequential AND-gates;
  the denied result carries no capabilities; the real W10 `checkApproval` is
  injected, not reimplemented).
- **No secret logged.** Env values in the subprocess path and the
  `ANTHROPIC_API_KEY` in the CLI/provider path are never written to output, disk,
  or the returned shape; the R2-4 `/connect` slash command is guidance-only and
  never stores/enters/logs the credential.
- **Crash ≠ deadline (#30/3).** The signal classifier prevents a crashed process
  from being mislabeled a `deadline-exceeded` or (worse) a `completed` success.
- **H (cap-less child tool-call aggregate accounting) — DEFERRED (documented).**
  The review's original "deny" recommendation was **invalidated by implementation
  evidence**: `inheritBudget` is a shared primitive the R2-5 executor relies on,
  and a subprocess makes **zero** tool calls, so a cap-less budget under a
  `maxToolCalls`-capped parent is a legitimate 0-cost sub-budget, **not**
  "unlimited." A blanket budget-inheritance-level deny would **fail-close the
  entire executor path** (≈14 tests). Proper bounding of a genuinely-unbounded
  *multi-tool-call* child is a **runtime-enforcement** concern (e.g. rejecting a
  policy decision with an unbounded grant on a capped path), not a primitive-level
  deny; `inheritBudget` and `scheduler.ts` remain unchanged and correct. The "H
  (deferred)" test blocks lock the current correct behavior with the rationale
  documented (#31).

### 5. Testing / replay — **PASS**
- **Deterministic / offline by construction.** Every R2 offline test injects
  clocks/ids, uses a mocked/recorded-fixture `fetch`, and calls no
  `Date.now`/`Math.random`. The real-subprocess adapter's wall-clock and spawn are
  confined to the flag-gated (`KERYX_ALLOW_REAL_SUBPROCESS=1`), **CI-inert** smoke
  path (the 2 skips); the pure `classifyProcessResult` takes an injected
  `deadlineHit` so it is unit-tested without spawning.
- **Mutation-proof executor pins (#30/4).** Two branch pins were added — external
  cancel over a clean exit, and the executor's own finer output-limit
  reclassification — so a mutation flipping those branches is caught.
- **Per-attempt evidence isolation.** R2-3 gives each wave attempt its own
  distinct, non-aliased, immutable `EvidenceRecord`; #31/E preserved that
  isolation while removing a misleading `child-result:DONE` stamp from planning
  time, and #31/A stamps `causal.*` ids so contained-process evidence joins its
  originating run.
- **Coverage growth is real, not tag-stubbed.** The suite grew across the waves
  (R2-4 +21, R2-1 +23, R2-2 +22, R2-3 +11, R2-5 +18 offline +3 smoke, hardening
  +49, polish +15) to **1338 pass / 2 skip / 0 fail**; #31/G made the previously
  tautological smoke guard observable (the capability-gated constructor throws
  without the flag) while staying CI-inert.

### 6. Performance — **PASS (advisory only)**
- **Pure deterministic scheduler.** `planExtensionWave` and `planWaves` are pure
  functions with no real async, no `Date.now`/`Math.random`, bounded ready-set
  iteration, and monotonic aggregate-budget decrement across waves — no unbounded
  loop and no live scheduling in tests.
- **Real subprocess adapter is off-CI and synchronous.** The `spawnSync`-based
  adapter runs, reaps, and reads real exit/output while enforcing the deadline;
  it is confined to the flag-gated path and never runs in CI, so it adds no
  steady-state cost to the suite. The disclosed synchronous-port constraint
  (deadline kill is leader-only; a full process-group kill of grandchildren is a
  documented async follow-up) is an accepted design boundary, and the offline core
  still models the full no-orphan process-group contract via the fake adapter.

### 7. Gherkin — **PASS**
All seven `@release-2` scenarios (plus the runtime half of the `@release-1`
`SC_R04_SHELL_CONTAINMENT` that Release 2 closes) map to an asserting test carrying
real assertions, not a tag stub — see the coverage cross-check below. The E-01
matrix's per-scenario source/test/commit traceability was spot-verified against
the working tree, and the H known-limitation is disclosed in the E-01 Deferred
List rather than silently omitted.

---

## Consolidated severity-ranked findings

**Open findings against this Release 2 package: none.** The 5-lens review found
**0 BLOCKER / 0 P0 / 0 P1 / 0 P2**. Every finding it raised is either **closed**
or a **documented known-limitation**:

| ID | Wave sev | Lens | Finding | Resolution | Resolving PR |
|---|---|---|---|---|---|
| M-1 | MED | Security | `select.ts` `probeOllamaModels` fetched a caller-supplied `--base-url` host without the egress guard (SSRF divergence from the chat path). | **CLOSED** — reused `isPrivateEgressHost`/`isLoopbackHost` guard applied before fetch (`select.ts:85`); no fetch on a private host, loopback still probeable. | flow 027 / PR #30 |
| M-2 | MED | Logic | `executor.ts` `completed` outcome did not surface `exitCode` (recoverable non-zero exits opaque). | **CLOSED** — `exitCode` surfaced; bound-hits unchanged/non-success. | flow 027 / PR #30 |
| M-3 | MED | Logic | Crash signal could be misclassified as `deadline-exceeded`/`completed`. | **CLOSED** — pure `classifyProcessResult`; only genuine deadline → `deadline-exceeded`, crash signal → `spawn-error`. | flow 027 / PR #30 |
| M-4 | MED | Testing | Executor branch coverage gaps (cancel-over-clean-exit; output-limit reclassification). | **CLOSED** — two mutation-proof branch pins. | flow 027 / PR #30 |
| M-5 | MED | Clean-code | Duplicated dispatch/result extension build in `execute.ts`. | **CLOSED** — single `buildExt` helper (behavior identical). | flow 027 / PR #30 |
| L-1…L-7 | LOW/INFO | Testing / arch / clean / evidence | Orphaned evidence causal ids; provider-factory duplication; misc DRY (`USAGE`/`applySelection`/menu loop); provenance default-root coverage; bound-wave planning-evidence status leak; outcome `evidenceRefs` normalization; tautological smoke guard. | **CLOSED** — #31 items A–G (causal ids stamped, `make-provider.ts` factory, DRY refactors, coverage added, planning-evidence isolation with frozen enum untouched, `evidenceRefs` normalized, smoke guard observable + CI-inert). | flow 028 / PR #31 |
| **H** | LOW/INFO | Highload / logic | Cap-less child tool-call aggregate accounting under a capped parent. | **DEFERRED (documented known-limitation)** — a deny would fail-close the entire executor path; a subprocess makes 0 tool calls so a cap-less sub-budget is legitimate, not "unlimited"; proper multi-tool-call bounding is a runtime-enforcement concern. `inheritBudget`/`scheduler.ts` unchanged and correct; "H (deferred)" tests lock the behavior. | flow 028 / PR #31 (deferred) |

The final suite is green at **1338 pass / 2 skip / 0 fail**; every closure landed
TDD (RED → GREEN → adversarial security re-review PASS: #30 6/6 checks, #31 8/8
checks), and each PR body records `git diff`-verified reuse-only prior modules.

---

## Coverage cross-check (seven `@release-2` scenarios + the R2-closed `SC_R04` runtime half)

All covered by an asserting test; each traced to its wave in the E-01 matrix.

| Scenario (`acceptance.feature`) | Wave / AC | Covered by |
|---|---|---|
| `SC_R08_CHILD_DISPATCH_CANONICAL_RESULT` (:376, `@positive`) | R2-1 / AC-R2-1 | `extension/execute.test.ts` — canonical dispatch/result round-trip, grant-bounded `allowed_actions` |
| `SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY` (:384, `@negative`) | R2-1 / AC-R2-1 | `extension/execute.test.ts` — three-gate AND, each missing piece denies |
| `SC_R08_NEEDS_CONTEXT_ADAPTER` (:459, `@positive`) | R2-1 / AC-R2-1 | `extension/execute.test.ts` — `retryWithContext` same-id, add-only, prior attempt immutable |
| `SC_R18_REGISTERED_EXTENSION_PROVENANCE` (:333, `@positive`) | R2-2 / AC-R2-2 | `extension/provenance.test.ts` — provenance record, authority-not-widened (alias-immune) |
| `SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY` (:576, `@negative`) | R2-2 / AC-R2-2 | `extension/provenance.test.ts` — registry-side escalation deny (verbatim R2-1 delegation) |
| `SC_R08_BOUND_PARALLEL_WAVE` (:467, `@positive`) | R2-3 / AC-R2-3 | `extension/bound-wave.test.ts` — concurrency ceiling, aggregate budget, per-attempt evidence isolation |
| `SC_R13_TUI_DEFERRED` (:520, `@positive`) | R2-4 / AC-R2-4 | `commands/select.test.ts`, `commands/shell.test.ts` — CLI adapter (variant A), no runtime-contract change |
| `SC_R04_SHELL_CONTAINMENT` runtime half (:422, `@release-1`, closes F-1) | R2-5 / AC-R2-5 | `process/executor.test.ts`, `process/real-process-adapter.classify.test.ts`, `…smoke.test.ts` — gate-order fail-closed, bound-hit never `completed` |

The Release 1 F-1 disclosure — that `SC_R04_SHELL_CONTAINMENT`'s runtime
execution-control half was deferred to the first real-shell-execution wave — is
**now closed** by R2-5 (E-01 Deferred List "Closed in Release 2" row; flow 026,
`183d826`, PR #29). No `@release-2` scenario is left unimplemented; the sole
carried-forward item is the documented H known-limitation.

---

## Consistency with frozen decisions
- **ADR-0001 (D-01 boundary):** Release 2 keeps the deterministic/offline
  invariant — the two new effect surfaces (R2-4 provider probe, R2-5 real
  subprocess) are capability/flag-gated and CI-inert; the offline cores use
  injected clocks/ids and fakes. Upheld.
- **ADR-0002 (D-02 ownership):** the harness never writes flow-state — the D-02
  `ctx rg` scan over `src/harness/{extension,process}` returns only invariant
  comments; every R2 module is a pure function or an adapter over an injected
  boundary, and completion still routes through the single reused W11
  `ManagedFlowPort.taskDone`. Upheld.
- **ADR-0003 (D-03 containment):** fail-closed on every new authority boundary —
  extension escalation (policy ∧ provenance ∧ approval), registered-only
  deny-first bound-wave, executor argv/env-allowlist → budget → spawn gate-order,
  and the SSRF-guarded CLI probe. Upheld.
- **ADR-0004 (D-04 provider/branch/child):** provider-neutral instantiation
  centralized in `make-provider.ts` with no SDK leak; the canonical child
  dispatch/result contract is adapted, not forked; child/extension isolation is
  fail-closed and never owns completion. Upheld.
- **Frozen schemas / `CanonicalSubagentStatus` enum / `src/contracts` / `src/eval`
  / ADRs:** not modified by any Release 2 wave beyond the single additive
  `isKnownCapability` export in `isolation.ts` (no behavior change); the #31/E
  planning-evidence fix specifically avoided the frozen enum. The `dependencies`
  registry stays `{}`. No contradiction with the frozen requirements package or
  the E-01 Release 2 matrix.

---

## Routing audit
- `graph_used`: no — `not-relevant` (targeted file-level review of the enumerated
  Release 2 scope; structure was already mapped by the E-01 matrix and the PR
  bodies).
- `wiki_used`: no — `not-relevant` (review is against the frozen requirements
  package, ADRs, and canonical schemas directly, which are the normative source).
- `ctx_used`: **yes** — the gate evidence (D-02 scan, egress-guard reuse, the
  `dependencies` check) ran through `keryx ctx rg`
  (`bun ./src/cli.ts ctx rg`).
- `raw_rg_used`: **yes (bounded)** — targeted `grep` over the single
  `acceptance.feature` file to enumerate the `@release-2` scenario line numbers
  and over the runbook to locate the Release 2 state section. Reason: reading
  exact line anchors in two already-located files; the code-boundary evidence
  searches (D-02, egress) were `ctx rg`.

---

**Verdict line:** No BLOCKER / P0 / P1 / P2 remains open. The full 5-lens Release 2
review found 0 BLOCKER/HIGH; its 5 MED were closed in flow 027 / PR #30, its 7
LOW/INFO in flow 028 / PR #31, and 1 known-limitation (H) is documented-deferred.
Gates: `bunx tsc --noEmit` clean; `bun test` **1338 pass / 2 skip / 0 fail**;
`dependencies` `{}`; D-02 upheld (comments only); egress guard reused in
`select.ts`. **Ship recommendation: GO** — proceed to the E-03 Release 2 handoff.

**Last updated:** 2026-07-14
**Updated by:** Flow 029 independent review worker (T6 / E-02)
