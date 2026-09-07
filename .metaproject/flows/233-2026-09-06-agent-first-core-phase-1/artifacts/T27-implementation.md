# T27 implementation report — strict guard/flow-gate propagation of incomplete evidence

## Result

`src/security/guard.ts` now refuses `incomplete` engine evidence in strict
contexts instead of quietly treating it as a pass, while advisory mode keeps
reporting it truthfully. Four changes, all inside `guard.ts`:

1. **`guardOutput` (enforced/ci)**: the blocking condition now includes
   `decision.gate === "incomplete"` alongside the existing `fail` /
   `needs-approval`. Incomplete engine evidence (for example an unreadable
   HMAC key, which the engine's `check()` already turns into
   `{ gate: "incomplete", action: "warn", findings: [] }` rather than
   throwing) blocks the write in `enforced`/`ci`, with the same masked,
   leak-safe `reason` used for other blocked decisions.
2. **`guardOutput` (advisory)**: unchanged — advisory returns the full
   decision object (including the truthful `incomplete` gate and empty
   findings) with `allowed: true`. No new code was needed here; the existing
   report-only branch already forwards the decision as-is.
3. **`formatGuardWarning`**: previously returned `null` whenever
   `findings.length === 0`, which silently dropped an `incomplete` gate with
   no findings. It now returns a constant, leak-safe
   `[<label>] incomplete: security evidence unavailable` message for that
   case, and still returns `null` for a genuine zero-finding `pass`. The
   existing non-empty-findings branch already interpolates `decision.gate`
   into its summary, so a finding plus an `incomplete` gate were already
   visible together (AC6/AFC-17) — no change needed there.
4. **`securityFlowGate`**: `result.status === "incomplete"` (from
   `runGate` reading a stored `latest.json` with `gate: "incomplete"`) now
   maps to `{ status: "fail", ... }` instead of falling through to `pass`.
   The `try`/`catch` around `createSecurityService(cwd).gate({ cwd })` no
   longer returns `status: "skipped"` with the raw `error.message`
   interpolated into `detail` — `src/flow/service.ts:668`
   (`gates.every((gate) => gate.status !== "fail")`) treats `skipped` as
   non-blocking, so a gate that could not even run was silently passing
   flow completion. The catch branch now returns a constant
   `{ status: "fail", detail: "security gate unavailable: check could not
   complete" }` that echoes no error text, path, or source bytes.

**Stale comments refreshed**: the file-header comment claimed "when the
`security` module is disabled the guard is a zero-cost no-op" — false, since
`guardOutput` and `redactRaw` already run the mandatory deterministic floor
(`validateSerializedOutput`) before checking whether the module is enabled,
and a format-unsafe payload is blocked regardless of mode/enablement. The
header and the `guardOutput`/`securityFlowGate` doc comments were rewritten
to state the floor applies first, and to describe the new `incomplete`
handling instead of the old two-gate (`fail`/`needs-approval`) list.

No test file changes were needed — all 4 RED tests in
`src/security/guard.test.ts` were satisfiable purely from `guard.ts`; none of
the existing expectations were wrong.

## Acceptance evidence

| Criterion | Status | Evidence |
|---|---|---|
| AC6 (AFC-17): a found violation and an incomplete coverage state are visible at the same time; incomplete is never relabeled as pass | met | `formatGuardWarning`'s non-empty-findings branch already interpolates `decision.gate` (so `incomplete` + findings both show); the new zero-findings branch surfaces `incomplete` on its own. `guard.test.ts` parametrized "guard preserves incomplete engine evidence in {enforced,ci,advisory} mode" tests, 3/3 passed |
| AC8: no required failed/incomplete check is relabeled PASS; strict (enforced/ci) guards and the strict flow gate refuse incomplete evidence while advisory retains truthful diagnostics | met | `guardOutput` enforced/ci block `allowed:false` on `incomplete`; advisory keeps `allowed:true` with the true decision; `securityFlowGate` maps stored `incomplete` reports and gate-unavailable errors to `fail`, not `pass`/`skipped`. Tests: "strict flow gate refuses incomplete security evidence" and the 3 parametrized guard tests, all passing |
| Policy fold (policies.md): FAIL on threshold violation; INCOMPLETE when a required check is missing/skipped/unparsed/unfinished; strict CI accepts only PASS; guard.test.ts's 17 tests pass; no raw error/path/content leaks | met | `src/security/guard.test.ts`: 17/17 passed. `securityFlowGate`'s catch branch and `formatGuardWarning`'s incomplete message are both constant strings — no `error.message`, `cwd`, or file path interpolated. The parametrized tests assert `JSON.stringify(result)).not.toContain(root)` |

## Verification

- Target file `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts`: 17 passed, 0 failed, 49 expect() calls; raw `.metaproject/data/gdctx/raw/2026-09-06T13-13-10-267Z_run.log`.
- Full required selection `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts src/security/persistence-sinks.test.ts src/security/service.memo.test.ts`: 39 passed, 1 failed, 107 expect() calls; raw `.metaproject/data/gdctx/raw/2026-09-06T13-13-14-202Z_run.log`. The 1 failure is the pre-existing `src/security/service.memo.test.ts:162` expectation ("one service keeps the config it loaded; a fresh one picks up the change") — unrelated to `guard.ts`, owned by T29, not modified.
- Lint `bun src/cli.ts ctx run -- bunx eslint src/security/guard.ts src/security/guard.test.ts`: pass, no output; raw `.metaproject/data/gdctx/raw/2026-09-06T13-13-42-865Z_run.log`.
- Typecheck `bun src/cli.ts ctx run -- bun run typecheck`: pass; raw `.metaproject/data/gdctx/raw/2026-09-06T13-13-54-612Z_run.log`.

No git state changes, no network, no model calls, no dependency changes, no flow file edits.

## Changed files

- `src/security/guard.ts`: `guardOutput` now blocks `incomplete` in enforced/ci; `formatGuardWarning` reports `incomplete` even with zero findings; `securityFlowGate` maps a stored `incomplete` report and an unavailable gate to `fail` (constant, leak-safe detail, no more `skipped` masking a non-blocking outcome); stale no-op/fail-open comments refreshed.

## Concerns

- `guardOutput`'s outer `try`/`catch` (around `loadSecurityConfig(cwd)` and `createSecurityService(cwd).check(...)`) still degrades to `ALLOW_DECISION` (`allowed: true`, `gate: "pass"`) on any thrown error, including a `loadSecurityConfig` failure that is unrelated to engine evidence. This path is pre-existing, not covered by any T27 RED test, and out of `guard.ts`-only scope to redesign (it would need a `service.ts`/`config.ts` decision about what "config load failed" should map to). Flagging it for whichever task next reviews strict-mode fail-open paths, since it is a config-level failure being treated the same as "not applicable," not "incomplete."
- Per dispatch instruction: `runGate` in `src/security/service.ts` still returns `status: "pass"` when there is no stored `latest.json` at all (and, by the same `!latest` branch, for any report whose JSON fails to parse). This was left unchanged — `service.ts` is owned by another worker this run, and the dispatch explicitly says not to touch it; noting it here for T28's review as instructed.
- The pre-existing `src/security/service.memo.test.ts:162` failure (memo/fresh-service redaction expectation mismatch) is confirmed still present and unrelated to `guard.ts`; not fixed, per dispatch (owned by T29).

## Routing audit

`graph_used: not-relevant (single-file targeted fix with an explicit dispatch and file list; no structural/blast-radius question); wiki_used: yes (policies.md + T20-implementation.md + T27-spec.md read for the policy fold and prior incomplete-gate contract); ctx_used: yes (all searches via `bun src/cli.ts ctx rg`, all commands via `bun src/cli.ts ctx run`); raw_rg_used: no.`
