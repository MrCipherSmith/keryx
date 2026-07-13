# Flow 027 — R2 review hardening (fix 5 MED review findings)

Status: formalized
Source: full integrated review of the Release 2 new functionality (5-lens panel:
security / highload+logic / architecture / clean-code / testing-practices). No
BLOCKER/HIGH; five MED findings to close.

## Problem

The Release 2 surface (R2-1…R2-5, merged on main) passed the full review fail-closed,
deterministic, reuse-only, D-02, deps `{}`, frozen-clean — but the panel surfaced **five
MED findings** worth closing (hardening / observability / coverage), plus a few adjacent
trivial doc/comment corrections.

## Scope — the 5 MED findings

1. **[security] SSRF: unguarded provider-detection fetch** — `src/commands/select.ts`
   `probeOllamaModels` fires `deps.fetch(`${baseUrl}/api/tags`)` with NO host guard, while
   the chat path (`OllamaProvider.stream`) enforces the W15 loopback-opt-in/SSRF guard for
   the same host. `--base-url http://169.254.169.254` → blind metadata GET. FIX: apply the
   reused `isPrivateEgressHost`/`isLoopbackHost` (`src/harness/mutation/guard.ts`) before the
   fetch; fail-soft (omit ollama) on a private/metadata host; loopback stays allowed.
2. **[logic] non-zero exit → `completed`, exitCode dropped** — `src/harness/process/executor.ts`
   classifies a clean-exit as `{kind:"completed"}` and DROPS `observation.exitCode`. DECISION
   (taken): keep `completed` (SC_R04 is about CONTAINMENT, not command success) but SURFACE
   `exitCode` on the `completed` outcome so callers can branch. FIX: add `exitCode?` to the
   `completed` variant of `ContainedProcessOutcome`; propagate `observation.exitCode`.
3. **[logic] signal-killed child mislabeled `deadline-exceeded`** —
   `src/harness/process/real-process-adapter.ts` `result.signal !== null` labels ANY
   signal-killed child (SIGSEGV/OOM/external SIGTERM) as `deadline-exceeded`. FIX: only a
   genuine deadline (`ETIMEDOUT`, or `SIGKILL` with the deadline actually hit) → `deadline-
   exceeded`; other signals → a distinct crash/`spawn-error`-style observation. Extract a PURE
   classifier so it is unit-testable OFFLINE (no spawn).
4. **[testing] two unpinned executor branches** — `src/harness/process/executor.test.ts`:
   (a) external cancel overriding a CLEAN exit (`input.cancelled===true` + a clean observation)
   and (b) the executor's own finer output-limit reclassification of a clean-exit
   (`outputBytes > outputLimitBytes`) are untested — deleting either branch still passes CI.
   FIX: add both failing-without-the-branch cases.
5. **[clean-code] `dispatchExtension` duplication** — `src/harness/extension/execute.ts` builds
   `extension` + `resultExtension` via two ~15-field-identical `buildChildDispatchExtension`
   calls differing only in `canonicalContract`. FIX: extract a local `buildExt(contract)` helper
   over the shared input — behavior UNCHANGED (existing tests stay green).

Folded-in trivial adjacent corrections (same files): the real-adapter `observedHash` doc
(says "output", actually command-identity — a DOC fix; behavior is intentionally secret-safe)
and the stale `executor.test.ts` design-note claiming `input.cancelled` is forwarded to
`adapter.spawn` (it is not).

## Expected Outcome

All 5 MED findings fixed, TDD (RED → GREEN → review). No behavior regression; the fail-closed /
deterministic / secret-safe / D-02 / reuse-only posture PRESERVED (adversarially re-verified).
`tsc` clean; full `bun test` ≥ the new baseline (1306 pass / 2 skip) with new tests green.

## Out of Scope (do NOT touch)

- The LOW/INFO items (orphaned evidence causal ids; cap-less-child tool-call accounting — a
  pre-existing W13 concern; provider-factory duplication across shell/harness; misc DRY;
  provenance default-root test) — noted, deferred. No new dependency (`dependencies` stays
  `{}`), no framework, no network beyond the already-guarded fetch, no real spawn in the offline
  suite. The executor/adapter/extension NEVER write flow.json (D-02). Deterministic (injected
  id/clock; no `Date.now`/`Math.random` in the offline cores).
- Rewriting reused primitives (`guardAction`, `isPrivateEgressHost`/`isLoopbackHost`,
  `inheritBudget`, `ExecutionReceipt`, W7 evidence, `planWaves`) — REUSE them. If a prior module
  seems to need a real refactor, STOP and report.
- The frozen requirements package + ADR-0001…0004 + canonical schemas + `src/eval/` +
  `src/contracts/` — read/cite only. Commits/PR carry NO co-authorship trailer.
