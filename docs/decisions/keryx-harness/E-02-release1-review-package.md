# E-02: Release 1 Independent Review Package

**Status:** Complete (flow 019, dispatch 019-T7, task E-02)
**Date:** 2026-07-13
**Reviewer:** Flow 019 independent review worker (managed review, `review-orchestrator`)
**Scope reviewed (Release 1 = W8–W15 + W14):**
`src/harness/{resume,branch,mutation,flow,child,parallel,extension,budget}/**`,
`src/harness/provider/anthropic/**`, and the additive `src/flow` `taskDone`
extension — against the frozen requirements package
(`docs/requirements/keryx-project-agent-harness/**`, the 17 `@release-1`
scenarios), ADR-0001…0004, the canonical contract schemas, and the E-01
Release 1 evidence matrix
([E-01-release1-evidence-matrix.md](./E-01-release1-evidence-matrix.md)).
**Read-only** except the creation of this one document. No source, test, ADR,
frozen-requirement, canonical schema, `flow.json`, `acceptance-criteria.md`,
the R0 review package, or per-wave review was modified.

This is the Release 1 counterpart to
[E-02-release0-review-package.md](./E-02-release0-review-package.md), which it
does not overwrite. It mirrors that document's structure (severity scale,
per-lens verdicts, findings table, consistency check, routing audit) and covers
only the Release 1 surface; Release 0 (W1–W7 + W16(R0)) is reused unchanged and
is not re-litigated here.

---

## Executive verdict

> **Any BLOCKER / P0 / P1 remaining? — NO.**
>
> The assembled Release 1 slice (durable resume, append-only branching + typed
> compaction, guarded mutation + approval, flow integration, child agents,
> parallel scheduling, security/recovery hardening, and the first real provider
> adapter) is architecturally sound, contract-conformant, fail-closed on every
> security lens checked, and covered by non-vacuous deterministic offline tests.
> `tsc --noEmit` is clean and `bun test` is **1160 pass / 0 fail**. The two
> provider fail-closed gaps this flow surfaced (a stalled-body abort escaping as
> an uncaught throw; an empty body silently succeeding as a zero-event stream)
> were **found and fixed** during the flow and are now regression-locked. One
> **P2** advisory remains (a `@release-1` scenario whose execution-control
> assertion is not test-evidenced and is undisclosed), which breaks no shipped
> Release 1 claim.

**Ship recommendation:** **GO** — promote the Release 1 package and proceed to
the E-03 handoff. Address the single P2 (evidence-matrix disclosure of
`SC_R04_SHELL_CONTAINMENT`'s deferred runtime-execution-control aspect) in E-01
before the E-03 handoff is declared complete.

---

## Severity scale (mirrors R0)

| Severity | Meaning |
|---|---|
| **BLOCKER** | Ships a broken or unsafe Release 1 claim; must fix before any handoff. |
| **P0** | A fail-open on a security/authority boundary, or a broken frozen contract. Must fix. |
| **P1** | A correctness defect that can produce a wrong durable outcome under a realistic input. Must fix before E-03. |
| **P2** | A traceability / disclosure / coverage-precision gap that does not break a shipped claim. Should fix before E-03 is declared complete. |
| **nit** | Cosmetic or forward-looking hardening suggestion; optional. |

---

## Gate evidence (verified directly against the working tree at review time)

| Gate | Command | Result |
|---|---|---|
| Type check | `bun run typecheck` (`tsc --noEmit`) | **clean — no errors** (exit 0) |
| Test suite | `bun test` | **1160 pass / 0 fail**, 4287 `expect()` calls, 161 files, ~6.3s |
| Runtime dependencies | `package.json` `dependencies` | `{}` — no runtime dep added; no provider SDK |
| Network in non-provider Release-1 runtime | `keryx ctx rg` for `fetch(`/`WebSocket`/`net.connect`/`https?.request`/`dgram`/`tls.` over `resume,branch,mutation,flow,child,parallel,extension,budget` | **0 matches** |
| Non-determinism in Release-1 runtime | `Date.now`/`Math.random` over all eight modules **plus** `provider/anthropic` (non-test) | **0 real calls** (clock/id injected via `deps`) |
| Provider egress | the only network call in the Release 1 runtime is the injected `this.deps.fetch` in `anthropic-provider.ts:279` | single, capability-gated, SSRF-guarded egress boundary |

The runtime is offline, deterministic, and dependency-free by construction: the
sole external-network path (the Anthropic adapter) fires only behind an explicit
capability grant, is guarded by the reused W15 private-egress predicate before
any fetch, and always receives its `fetch` via injection (`as unknown as typeof
fetch` in tests) — the global `fetch` is never touched.

---

## Per-lens verdicts

### 1. Architecture — **PASS**
- **Ports/adapters boundaries intact.** The provider adapter
  (`provider/anthropic/anthropic-provider.ts`) imports only the neutral W5 port
  types (`../types`), the pure W14 SSE parser (`./sse`), the reused W15 egress
  predicate (`isPrivateEgressHost` from `../../mutation/guard`), and the injected
  `fetch` — **no Anthropic SDK, no provider-wire type crosses the `ProviderPort`
  boundary** (asserted by `anthropic-provider.test.ts:247` — a source-level SDK-import
  scan). `package.json` `dependencies` stays `{}`.
- **D-02 (harness never writes `flow.json`) upheld.** `ManagedFlowPort`
  (`flow/managed-flow-port.ts`) is the single harness→Task-Manager bridge and
  performs *only* one injected `service.taskDone(...)` call — no `fs`, no
  `src/flow/store` import (`managed-flow-port.ts:69-82`). Child isolation
  (`child/isolation.ts`), the scheduler (`parallel/scheduler.ts`), and every
  hardening module (`extension/registry.ts`, `budget/reconcile.ts`) are pure
  functions that write nothing. The network scan above confirms zero fs-write /
  flow-state-write reachable from the Release 1 runtime.
- **Single coordinator.** `parity.ts` and `managed-flow-port.ts` route all
  completion through exactly one `taskDone`; the parallel scheduler returns a
  *plan*, never executes it, so it cannot become a second coordinator.
- **Additive-only composition.** The scheduler folds the reused W12
  `inheritBudget` rather than re-implementing budget math
  (`scheduler.ts:22,151`); the provider reuses the W15 SSRF predicate rather than
  forking it (`guard.ts:246` `isPrivateEgressHost` delegates verbatim to
  `isPrivateEgressToken`).

### 2. Contract — **PASS**
- **Frozen-schema validation is reused, not re-asserted.** The provider descriptor
  document validates against the frozen `provider-descriptor.schema.json` with
  `storage/retention/continuation = false` in a test that runs the real validator
  (`anthropic-provider.test.ts:369`), not a shape assertion.
- **Additive-only changes to prior modules.** `src/flow/service.ts` `taskDone`
  gained optional `evidenceRefs?`/`runLink?` only; all 34 prior `src/flow` tests
  (`migration.test.ts`, `disposition.test.ts`) stay green and unmodified (per the
  E-01 matrix, cross-checked against the 1160-green suite). Every durable record
  in the reviewed modules is `schemaVersion: 1` (`registry`/`reconcile`/
  `execute` receipts, `approval` request/result), consistent with the
  schema-version registry.
- **Canonical child contract.** `child/contract.ts` adapts the frozen
  `subagent-dispatch`/`subagent-result` shapes (per E-01 CA-01); the STATUS-first
  prose→canonical conversion is contract-bounded.
- No finding: no reviewed change alters a frozen schema, ADR, or the
  `src/contracts` surface (`git show --stat` on each cited commit and the
  working-tree diff show only additive source + this flow's provider fix + docs).

### 3. Logic — **PASS**
- **Mutation guard fail-closed order is correct** (`guard.ts:277-342`):
  scan-unavailable → deny; traversal/symlink-escape → deny; shell metachars →
  deny; private-egress → deny; credential/env-dump → deny; only a structurally
  clean action reaches `decide()`. Symlink escape resolves the injected
  (data-only) target and re-checks containment (`guard.ts:292-299`).
- **Child inheritance is fail-closed on every layer.** `inheritBudget`
  (`isolation.ts:60-92`) grants only a provable subset (boundary-equal allowed),
  and a child requesting a tool-call cap the parent does not expose is denied
  (`isolation.ts:71-77`) rather than granted-unlimited. `inheritPolicy`
  (`isolation.ts:165-223`) denies any escalation on trustMode, **unconditional**
  per-capability containment, or isolation downgrade — and `rankOf` returns
  `undefined` on an out-of-enum value, forcing a DENY instead of a fail-open
  comparison (`isolation.ts:137-139`).
- **Scheduler ceilings hold** (`scheduler.ts:109-163`): degenerate
  `maxConcurrency` denies rather than spins; the running `remaining` carries
  *across* waves so aggregate reservations can never exceed the parent budget;
  a dependency cycle denies the whole plan with no partial waves; cancellation
  excludes a task and its transitive dependents (`computeExcluded` fixpoint).
- **Completion parity is correct** (`parity.ts:41-90`): a non-`pass` gate
  (fail/blocked/unknown) can never coincide with a completed task — the
  laundering guard is evaluated before the per-status branches, so a
  failing/blocked/unknown gate never yields a false `completed` disposition.
- **Approval NaN-date is fail-closed** (`approval.ts:143-146`): an unparseable
  `now` or `expiresAt` yields `NaN`, and rather than falling through
  `NaN >= NaN === false` to `valid` (a fail-open), it returns `expired`.
- **Provider terminal-state logic is sound**: torn trailing record or
  started-but-no-`message_stop` → `malformed`, no `model_end`
  (`anthropic-provider.ts:469-483`); cancellation is checked before every emitted
  event so an aborted attempt ends with exactly one trailing `cancelled` error
  (`anthropic-provider.ts:487-497`).

### 4. Security — **PASS** (two gaps found-and-fixed in this flow)
- **SSRF / private-egress, including encoded forms, fails closed.** `guard.ts`
  denies plain tokens, a broadened regex set (IPv6 loopback, CGNAT, full
  172.16–172.31, unspecified `0.0.0.0`), **and** decoded encoded IPv4 (flat
  decimal/hex/octal, dotted mixed-radix + short forms, IPv4-mapped IPv6) via
  `decodeEncodedIPv4` + `isPrivateIPv4` (`guard.ts:63-237`). The Anthropic adapter
  reuses this predicate on `new URL(baseUrl).hostname` **before any fetch**
  (`anthropic-provider.ts:230-243`); the H-01 red-team suite proves `fetch` is
  never invoked for decimal/hex/octal loopback and hex-encoded metadata base URLs
  (`anthropic-negatives.hardening.test.ts:355-381`, `calls.length === 0`).
- **NaN-date fail-closed** — see Logic; a malformed timestamp expires the approval.
- **Extension registry denies fail-closed** (`registry.ts:54-65`): a missing
  pinned manifest or an empty capability grant denies with no mutation and no
  discovery-time authority granted (`SC_R18_UNREGISTERED_EXTENSION_DENIED`).
- **Child no-escalation** — see Logic (`inheritPolicy` three-layer containment).
- **Provider capability-gate + credential redaction.** No valid grant →
  fail-closed `authentication` error, `fetch` never invoked
  (`anthropic-provider.ts:217-224`). The `apiKey` is scrubbed from every string
  that leaves the module — HTTP-error bodies, thrown network causes, egress-deny
  messages (`redact`, `anthropic-provider.ts:213-214`); the red-team suite asserts
  `error.message.includes(API_KEY) === false` on every negative path.
- **The two just-fixed adapter gaps (recorded as FOUND + RESOLVED, not open):**
  1. *Stalled body → `cancelled`.* Before the fix, a deadline `AbortSignal` firing
     during `response.text()` (headers already received, body hung) rejected and
     escaped the generator as an uncaught throw. The additive guarded body read
     (`anthropic-provider.ts:325-342`) now maps the abort to the same terminal
     `provider_error(kind:"cancelled")` the fetch-level abort path yields — no
     `model_end`. Regression-locked by
     `anthropic-negatives.hardening.test.ts:122-171`.
  2. *Empty body → `malformed`.* A 200 with a zero-byte body parsed to zero
     records and would have yielded *nothing* — indistinguishable from a
     legitimate no-output attempt. The adapter now detects the zero-byte body
     before the parse loop and yields a terminal `provider_error(kind:"malformed")`
     (`anthropic-provider.ts:349-356`), regression-locked by
     `anthropic-negatives.hardening.test.ts:318-342`.
  Both are additive fail-closed fixes to `anthropic-provider.ts` — the sole
  runtime-code change for flow 019 (AC5); no existing allow-path or prior test is
  altered (the full suite grew from the 1150 baseline to 1160 with the new H-01
  tests, 0 fail).

### 5. Testing / replay — **PASS**
- **Offline determinism by construction.** The gate scans found zero
  `Date.now`/`Math.random`/live-network in the Release 1 runtime; every reviewed
  test injects clocks/ids and a mocked/recorded-fixture `fetch`. The H-01 suite
  drives the *real* `AnthropicProvider.stream()` to a terminal event on every
  case (non-vacuous) and uses a real `AbortController` under test control rather
  than a wall-clock timer (`anthropic-negatives.hardening.test.ts:38-41,131-151`).
- **Migration determinism.** The flow `1→2` and session `0-style→1` migrations are
  read-time-normalizing and additive (per E-01 Migration Notes; the session
  migration's determinism is pinned at `session.test.ts:344-345`, and it rejects a
  future `schemaVersion` with a typed error).
- **Replay effect-free.** No reviewed module carries a live provider/executor
  handle into a replay/reconciliation path; `executeGuardedMutation` reaches its
  sole side-effecting boundary (the injected `MutationAdapter`) only after every
  fail-closed gate, and never on a blocked path
  (`execute.ts:101-142`; `execute.test.ts` "no real fs/network mutation").
- Non-duplication is deliberate and documented: the H-01 suite's header
  enumerates exactly which W14 cases it does *not* re-assert and which genuine
  gaps it adds (`anthropic-negatives.hardening.test.ts:9-41`).

### 6. Performance — **PASS (advisory only)**
- **Bounded event/context growth.** The provider buffers one in-memory SSE body
  and folds it once into a bounded `bodies[]`; there is no unbounded accumulation
  and every stop condition (torn/truncated/empty/cancelled) is a hard boundary.
- **Deterministic SLO bounds via ceilings.** The scheduler caps each wave at
  `maxConcurrency` and enforces a monotonically-decrementing aggregate budget
  across waves (`scheduler.ts:135,145-158`); child `inheritBudget` is O(1). No
  reviewed path contains an unbounded loop — `computeExcluded` iterates to a
  fixpoint over a fixed task set, and the wave loop terminates because each
  iteration schedules ≥1 task or denies (`scheduler.ts:123-140`).

### 7. Gherkin — **PASS with one disclosure gap**
All 17 `@release-1` scenarios were cross-checked against real tests:

- **15 of 17** map directly to an asserting test carrying the scenario tag
  (`SC_R15_PATH_TRAVERSAL_DENIED`, `SC_R15_SHELL_INJECTION_DENIED`,
  `SC_R15_REDIRECT_PRIVATE_ADDRESS_DENIED`, `SC_R15_FAIL_CLOSED_ISOLATION`,
  `SC_R09_SINGLE_COORDINATOR`, `SC_R04_GUARDED_MUTATION`, `SC_R05_APPROVAL_RESUME`,
  `SC_R06_BRANCH_TREE`, `SC_R06_TYPED_COMPACTION`,
  `SC_R07_COMPACTION_REBUILDS_REFERENCES`, `SC_R09_TASK_MANAGER_MIGRATION`,
  `SC_R12_CRASH_CUT_PRE_EFFECT`, `SC_R12_CRASH_CUT_POST_EFFECT`,
  `SC_R15_SYMLINK_ESCAPE_DENIED`, `SC_R17_ISOLATED_REEXECUTE_DEFERRED`) — each
  verified present in `src` with real assertions, not a tag stub.
- **`SC_R03_REAL_ADAPTER_CAPABILITY`** is covered under **alternative in-file
  naming** ("AC2 — storage-off / privacy-retention contract" and "AC3 —
  capability gate" in `anthropic-provider.test.ts:359,472`): the descriptor
  advertises unsupported features as explicit omissions (`describe()`
  capabilities all `false` for the unsupported set), storage/retention/
  continuation are pinned `false` against the frozen schema, and the capability
  gate fails closed with no grant. This is the same "P-01 provider suite uses AC
  naming" pattern R0 documented — **not a gap.**
- **`SC_R04_SHELL_CONTAINMENT`** (see finding **F-1**): its structural half is
  covered (argv/env-allowlist fingerprint, shell-injection denial, approval-
  gating, fail-closed isolation), but its distinctive `Then` — "timeout, output,
  cwd, and cancellation controls are enforced" for a running *process-group
  command* — is **not test-evidenced and not disclosed** in the E-01 deferred
  list. It is inherently a future real-subprocess execution surface that the
  offline Release 1 does not build.

---

## Consolidated severity-ranked findings

| ID | Severity | Lens | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|
| **F-1** | **P2** | Gherkin / evidence-accuracy | `SC_R04_SHELL_CONTAINMENT` (`acceptance.feature:422`, `@release-1 @positive`, task `M-01`) asserts a *running* process-group command enforces "timeout, output, cwd, and cancellation controls." Release 1 builds the **structural** containment (argv/env-allowlist `actionFingerprint`, shell-metachar denial in `guardAction`, approval-gating, `SC_R15_FAIL_CLOSED_ISOLATION`) but **not** the runtime execution-control surface — `executeGuardedMutation` reaches a *faked* `MutationAdapter` as the sole side-effecting boundary and no real process-group/timeout/cancellation executor exists (consistent with the offline "no real fs/network mutation" invariant). The scenario has **zero** tag references in `src`, and is **not** in the E-01 matrix's deferred list (which enumerates only the seven `@release-2` scenarios). | `keryx ctx rg SC_R04_SHELL_CONTAINMENT src` → 0 matches; `grep -rn process.group src` → 0 real executor; `execute.ts:36-41,132` (fake adapter is the only effect surface); E-01 "Deferred List" omits it. | Documentation-only, before E-03 is declared complete: E-01 should disclose `SC_R04_SHELL_CONTAINMENT`'s **execution-control aspect** as deferred to the first real-shell-execution wave (its structural containment satisfied in Release 1), mirroring R0's F-1 disclosure of `SC_R18_UNREGISTERED_EXTENSION_DENIED`. No code change; no fail-closed breach (structural containment holds). |

**Found-and-resolved in this flow (recorded, not open):**

| ID | Was | Lens | Resolution |
|---|---|---|---|
| R-1 | **would-be P0** | Security / logic | Stalled-body deadline abort escaped `stream()` as an uncaught throw → now a guarded body read maps it to a terminal `cancelled` `provider_error` (`anthropic-provider.ts:325-342`; test `…hardening.test.ts:122-171`). |
| R-2 | **would-be P1** | Security / logic | Empty (zero-byte) 200 body yielded a silent zero-event success indistinguishable from a legitimate no-output attempt → now a terminal `malformed` `provider_error` (`anthropic-provider.ts:349-356`; test `…hardening.test.ts:318-342`). |

Both were surfaced by the H-01 red-team suite (T5) and closed by the sole
runtime-code change permitted for flow 019; the full suite is green at 1160/0.

---

## Coverage cross-check (17 `@release-1` scenarios)

All 17 verified covered by an asserting test **except** the execution-control
half of `SC_R04_SHELL_CONTAINMENT` (F-1, structural half covered; runtime half
undisclosed-deferred). `SC_R03_REAL_ADAPTER_CAPABILITY` is covered under
alternative AC naming (confirmed to carry real assertions, not a tag stub). The
seven `@release-2` scenarios enumerated in the E-01 matrix's Deferred List are
correctly **not** implemented here and were confirmed to have zero
implementing tests in `src`.

---

## Consistency with frozen decisions
- **ADR-0001 (D-01 boundary):** Release 1 extends the offline slice with a real
  provider whose live path is capability-gated and never runs in tests — the
  offline/deterministic invariant holds.
- **ADR-0002 (D-02 ownership):** the harness never writes flow-state;
  `ManagedFlowPort` is the sole bridge and calls only `taskDone` (single
  coordinator, `parity.ts`/`managed-flow-port.ts`). Upheld.
- **ADR-0003 (D-03 containment):** fail-closed on every new authority boundary —
  mutation guard/approval, child policy/budget inheritance, scheduler ceilings,
  extension registration, provider egress + error taxonomy. Upheld.
- **ADR-0004 (D-04 provider/branch/child):** provider-neutral port with no SDK
  leak; append-only branching with `mergeBranches` always-reject; child isolation
  fail-closed and never owns completion. Upheld.
- **Schemas / `src/contracts` / `src/eval` / ADRs:** not modified by any reviewed
  change (working-tree diff = the provider fix + the H-01 test + the E-01/E-02
  docs + this flow's package).

---

## Routing audit
- `graph_used`: no — `not-relevant` (targeted file-level review of the enumerated
  Release 1 scope; structure was already mapped by the E-01 matrix).
- `wiki_used`: no — `not-relevant` (review is against the frozen requirements
  package, ADRs, and canonical schemas directly, which are the normative source).
- `ctx_used`: **yes** — the `@release-1` scenario enumeration and the
  network/coverage boundary searches ran through `keryx ctx rg`.
- `raw_rg_used`: **yes (bounded)** — targeted `grep` over known single files to
  read exact `describe`/`test` titles the `ctx rg` summary truncated
  (`anthropic-provider.test.ts`, `execute.test.ts`) and to confirm the absence of
  a process-group executor. Reason: confirming the exact content / non-existence
  of an already-located match; the primary enumeration search was `ctx rg`.

---

**Verdict line:** No BLOCKER / P0 / P1 remains. 1 × P2 (F-1,
`SC_R04_SHELL_CONTAINMENT` execution-control disclosure) + 2 found-and-resolved
provider gaps (R-1/R-2, now regression-locked). Gates: `tsc --noEmit` clean;
`bun test` **1160 pass / 0 fail**; `dependencies` `{}`. **Ship recommendation:
GO** — proceed to E-03, with F-1 disclosed in E-01 before the handoff is declared
complete.

**Last updated:** 2026-07-13
**Updated by:** Flow 019 independent review worker (T7 / E-02)
