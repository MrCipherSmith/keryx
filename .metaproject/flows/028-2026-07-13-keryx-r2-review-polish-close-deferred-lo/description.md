# Flow 028 — R2 review polish (close deferred LOW/INFO)

Status: formalized
Source: the deferred LOW/INFO items from the full 5-lens review of the Release 2 surface
(the MED items were closed in flow 027 / PR #30). User approved a small polish wave.

## Scope — 8 items (H is the only one touching a Release 1 module)

- **H [logic/security] cap-less child escapes aggregate tool-call accounting** — W12
  `src/harness/child/isolation.ts` `inheritBudget` + W13 `src/harness/parallel/scheduler.ts`
  `decrementRemaining`: when a `ChildTask.budgetRequest` OMITS `maxToolCalls` while the parent
  HAS a `maxToolCalls` budget, the child is granted with no cap and is never decremented — N
  cap-less children collectively bypass the tool-call budget. **DECISION (user): DENY** —
  fail-closed, symmetric with `inheritBudget`'s existing rule (a child requesting a cap when the
  parent has none is already denied). Deny a cap-less child under a capped parent; update the
  `inheritBudget` doc accordingly. **If this forces a real refactor of W12/W13 or breaks a
  legitimate intended cap-less-child scenario, STOP and report** (then reconsider clamp-to-remaining).
- **A [traceability] orphaned evidence causal ids** — `src/harness/process/executor.ts`
  `buildEvidence`: `causal.runId`/`sessionId`/`correlationId` are each freshly minted via
  `deps.idSeq()`, so the evidence correlates to nothing. Thread real run/session/correlation ids
  through `RunContainedProcessInput` into `buildEvidence` so the contained-process evidence joins
  back to its originating run.
- **B [clean/arch] provider-factory duplication** — `src/commands/shell.ts` (`realMakeProvider`) and
  `src/commands/harness.ts` both write the same `new AnthropicProvider|OllamaProvider|FakeProvider`
  switch (incl. the ANTHROPIC_API_KEY-missing fallback). Extract ONE `makeProvider(...)` factory
  (under `src/harness/provider/`) and have both wrappers call it.
- **C [clean] misc DRY** — `src/commands/harness.ts` duplicated `USAGE` line (2 branches) → a
  module const; `src/commands/shell.ts` duplicated selection-apply block (`/models` + `/provider`)
  → an `applySelection` helper; `src/commands/select.ts` unify the two menu-loop idioms.
- **D [testing] missing provenance default-root test** — `src/harness/extension/provenance.test.ts`:
  every case injects `registrationProvenance`, so the `?? DEFAULT_REGISTRATION_PROVENANCE` fallback
  is untested. Add a case omitting it → assert the derived record is `trustLevel:"derived"` and
  taint-linked to the registry root.
- **E [evidence-quality] planning-time evidence disposition** — `src/harness/extension/bound-wave.ts`
  `buildAttemptResult` hardcodes `status:"DONE"`, so `childResultToEvidence` stamps
  `artifact.kind="child-result:DONE"` for a PLANNED (not-yet-executed) attempt — a consumer could
  mistake it for completion. Use a neutral/PLANNED disposition. **If this requires extending a
  prior-wave (W12) disposition enum, STOP and report** (keep minimal / defer E).
- **F [consistency] evidenceRefs encoding** — `src/harness/process/executor.ts`: the receipt records
  `evidenceRefs: ["evidence:<id>", "observed-effect:<hash>"]` (prefixed) but the outcome's top-level
  `evidenceRefs` is `[evidence.evidenceId]` (bare). Normalize to one encoding (the prefixed form).
- **G [testing] tautological smoke guard** — `src/harness/process/real-process-adapter.smoke.test.ts`
  the always-on guard asserts a variable equals its own definition (proves nothing). Replace with an
  observable assertion (or drop the misleading claim); the real inertness is structural (skipIf +
  in-body dynamic import + constructor gate).

## Expected Outcome

All 8 items closed, TDD (RED → GREEN → review). No behavior regression; fail-closed / deterministic /
secret-safe / D-02 / deps `{}` posture preserved. H makes the tool-call aggregate accounting genuinely
fail-closed. `tsc` clean; full `bun test` ≥ the baseline (1325 pass / 2 skip) with new tests green.

## Out of Scope (do NOT touch)

- No new dependency (`dependencies` stays `{}`), no framework, no network beyond the already-guarded
  fetch, no real spawn in the offline suite. The executor/adapter/extension/scheduler NEVER write
  flow.json (D-02). Deterministic (injected id/clock; no `Date.now`/`Math.random` in the offline cores).
- Rewriting prior waves beyond the targeted fail-closed fixes above — REUSE/additive. H and E touch
  prior-wave modules ONLY as a minimal, behavior-tightening change; if either needs a real refactor,
  STOP and report.
- The frozen requirements package + ADR-0001…0004 + canonical schemas + `src/eval/` + `src/contracts/`
  — read/cite only. Commits/PR carry NO co-authorship trailer.
