# T58 implementation — a forced-closed posture must not become the recorded `previous` state

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Files
changed: `src/security/service.ts` (the state-write region of `analyze()`,
around line 95), `src/security/self-protect.ts` (a doc comment on `writeState`
only — no behaviour change), `src/security/security.test.ts` (three new
regressions). `src/security/config.ts`, `src/security/guard.ts`,
`src/security/guard.test.ts`, `src/security/types.ts`,
`src/commands/security.ts`, `src/health/service.ts`, `src/flow/service.ts`,
`src/security/detect/exfil.ts` were read-only and are byte-unmodified by me
(confirmed: I never called Edit/Write on any of them; only `Read`). Spec
written before coding: `T58-spec.md` (same directory).

All raw logs are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## What T54 left open (T39 F-008)

`analyze()` (`service.ts`) unconditionally wrote `currentState(config)` —
`{ mode: config.mode, policies }` — into `.metaproject/data/security/raw/state.json`
as `previous` for the next run's `evaluateSelfProtection` call. When
`loadSecurityConfig` forces `config.mode` to `"enforced"` because the config
file was unusable (T37) or its declared `mode` was outside the closed
`SecurityMode` union (T54), that forced value got persisted as if it were the
operator's real setting. Repairing the config afterward compared the real
mode against that synthesized `previous` and could raise a `mode-downgrade`
warning + incident for a downgrade that never happened.

## The three options, and why I chose "skip the write"

The dispatch named three plausible shapes: skip the write entirely, record the
operator's declared settings without the forced mode, or record the forced
posture with a marker the comparison understands. Full reasoning is in
`T58-spec.md`; summarized:

- **Record declared settings without the forced mode** is not viable as
  stated. For the fully-unreadable cases (`null`, unparseable JSON, a
  non-object payload) there is no declared mode at all — the file did not
  yield one, so there is nothing to record instead of the forced value. For
  the unrecognized-mode case there is a declared string, but it is by
  definition not a `SecurityMode` member, and `SecurityState.mode` is typed to
  that closed union; widening it to accept an arbitrary string would let
  `MODE_RANK[...]` go `undefined` again for a future comparison — reopening
  exactly the blind spot T39 F-002 closed at the loader.
- **Record with a marker the comparison understands** closes the
  false-positive half (repair-to-same-mode raising a spurious incident) but,
  while designing the regression for "a genuine downgrade must still be
  detected," I found it does **not** close the mirror-image failure by
  itself: a marked/synthesized `previous` only tells the NEXT comparison to
  skip when THAT particular previous is synthetic — it does not reach back
  to the last genuine value, so a later real reconfiguration still compares
  against the synthesized value rather than the true prior state, and a real
  downgrade from a HIGHER real mode to something still above the synthesized
  one goes undetected. Making the marker also solve that requires the write
  to preserve the last genuine mode/policies alongside the marker instead of
  overwriting them — which is the "skip the write" behavior with an added
  audit field, not a materially different mechanism.
- **Skip the write** (chosen): `previous` keeps carrying the last config the
  loader could actually read, for as long as the config stays broken. Once it
  is readable again, every comparison is real-vs-real, which closes both
  failure directions with a one-line change and no type or comparison-logic
  change.

## What changed

`src/security/service.ts`, `analyze()`:

```ts
// A forced-closed posture (`config.configUnreadable`) is a derived, momentary
// fact about a config THIS run could not read -- not the operator's
// configured mode or policies (T39 F-008). Recording it as `previous` would
// make the NEXT comparison (a repair to the same mode, or a genuine change)
// read a synthetic value as if it were real, which can both fabricate a
// downgrade that never happened and mask one that did (T58-spec.md). Leave
// `previous` for the next run exactly as it is: the last config this loader
// could actually read.
if (!config.configUnreadable) {
  await writeState(cwd, currentState(config));
}
```

`src/security/self-protect.ts`: a doc comment added above `writeState`
stating the invariant its one caller must uphold (never pass a forced/derived
state) — documentation only, no behavior change; `writeState`'s body,
signature, and every other function in the file are untouched.

Deliberately **not** touched: `evaluateSelfProtection`'s comparison logic. A
live, in-window comparison — the freshly-loaded (possibly forced) `config`
against a REAL `previous` — is unchanged. If an operator's real recorded mode
is `gateway` (rank 3) and the config then breaks, the forced `enforced`
(rank 2) compared against the real `gateway` still produces a `downgraded`
warning on that run. This is not the fabricated-`previous` defect this task
closes — the current run's effective enforcement genuinely is lower than
`gateway` right now, because the config that would establish `gateway` is
broken. Suppressing that would be a scope decision this dispatch does not
ask for; the acceptance criteria's own framing ("a subsequent run with a
repaired one" raises no spurious incident) is about repairs, not about the
broken run itself.

## Three-case description of what a reader of the recorded state sees

- **Config fine.** No change from before this task: `analyze()` reads
  `previous`, compares it to the real config, writes the real config forward.
- **Config broken** (unusable payload or unrecognized mode). The comparison
  still runs against the real `previous` on disk and can still warn — most
  visibly the config's own `configChecksum` tamper check, which is unaffected
  because it compares `config.policies`/`config.configChecksum` directly, not
  `previous`. What is new: the write is skipped, so this run's forced value
  never lands on disk as a future `previous`.
- **Config repaired.** `previous` is whatever the last config actually read —
  never a forced value, no matter how many broken runs happened in between.
  A repair to the same real mode raises nothing; a repair to a genuinely
  weaker mode raises the incident it should.

**First run whose config is already broken, no prior `state.json`.**
`readState` returns `null`. `evaluateSelfProtection`'s mode-downgrade and
policy-disabled comparisons are both `if (previous)`-guarded, so neither runs.
The checksum check can still act in principle, but for a fully-unreadable
payload the forced config's `configChecksum` is `undefined` (built from
`mergeSecurityConfig({})`, which never sets it), so `verifyConfigChecksum`
treats that as a match and raises nothing. With this fix the write is also
skipped, so `state.json` continues not to exist for as many broken runs as
occur. The first time a readable config is seen, the state is created for the
first time from real values. This behaves exactly as if the broken runs never
happened, because none of them could honestly contribute a `previous` —
covered by `T58 D3` below.

## Regressions (`src/security/security.test.ts`)

| Test | Asserts | Failed before because |
|---|---|---|
| `T58 D1` | real `advisory` recorded → config breaks (forced `enforced`) → `readState` still `advisory` → repair to the SAME `advisory` → no `downgraded` warning, no `mode-downgrade` incident | the broken run's forced `enforced` overwrote the recorded `advisory`; `readState` after the broken run returned `"enforced"`, not `"advisory"` |
| `T58 D2` | real `gateway` recorded → config breaks (forced `enforced`, lower rank) → `readState` still `gateway` → genuine reconfigure to `ci` (a real downgrade from `gateway`) → the `downgraded` warning and `mode-downgrade` incident DO fire | `readState` after the broken run returned `"enforced"`, not `"gateway"` — a check that ran to completion but on the wrong data, so the assertion on the intermediate `readState` call is what failed, not a downstream symptom |
| `T58 D3` | broken config from the first run, no prior state → no warnings, `readState` stays `null` across repeated broken runs → repair → no spurious warning, `readState` now holds the real mode | `readState` after the broken run returned the forced `{mode:"enforced", policies:{...}}` object instead of `null` |

RED: `bun src/cli.ts ctx run -- bun test src/security/security.test.ts` → **11
pass / 3 fail**, 62 expect() — exactly the three new tests, each failing at
the intermediate `readState` assertion that pins the bug (not at a later,
derived assertion), confirming each test exercises the actual defect. Raw
`2026-09-06T16-07-12-182Z_run.log`.

GREEN: same command → **14 pass / 0 fail**, 71 expect(). Raw
`2026-09-06T16-07-29-562Z_run.log`.

No existing test was deleted, weakened, or had an expectation changed. The
two pre-existing self-protection scenarios in `security.test.ts` ("enforced→
advisory downgrade + checksum mismatch...", "a mode downgrade at check() time
writes an incident") are unmodified and still pass — the second of the two
seeds `previous` via a direct `writeState` call rather than through a
broken-config `analyze()` run, so it is unaffected by this change and stands
as the pin that a genuinely recorded `previous` still triggers a genuine
downgrade.

## Verification (after)

| Check | Result | Raw log |
|---|---|---|
| `bun src/cli.ts ctx run -- bun test src/security/security.test.ts` (RED) | **11 pass / 3 fail**, 62 expect() | `2026-09-06T16-07-12-182Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/security/security.test.ts` (GREEN) | **14 pass / 0 fail**, 71 expect() | `2026-09-06T16-07-29-562Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/security/` (required command) | **233 pass / 0 fail**, 1315 expect(), 22 files | `2026-09-06T16-08-38-195Z_run.log` |
| Wider sweep: `bun test src/flow/security-gate.test.ts src/flow/service.test.ts src/commands/security.check-input.test.ts src/commands/security-hooks-init.test.ts src/commands/security-gate-exit.test.ts src/commands/security-recursive-scan.test.ts src/sac/proposal-lifecycle.test.ts src/wiki/enrich.test.ts src/security/project-root.test.ts` | **154 pass / 0 fail**, 497 expect(), 9 files | `2026-09-06T16-08-10-964Z_run.log` |
| `bun run typecheck` (`tsc --noEmit`) | clean, exit 0 | ran directly (no stdout/stderr; a bare `tsc --noEmit` produces none on success) |
| `bunx eslint src/security/service.ts src/security/self-protect.ts src/security/security.test.ts` | clean, no output, exit 0 | ran directly (no output on success) |

Baseline before any edit: `bun src/cli.ts ctx run -- bun test
src/security/security.test.ts src/security/guard.test.ts
src/security/persistence-sinks.test.ts src/security/service.memo.test.ts
src/security/output-validation.test.ts` → **98 pass / 0 fail**, 650 expect().
Raw `2026-09-06T16-06-49-238Z_run.log`.

`git status --porcelain -- .metaproject/security.config.json
.metaproject/data/security` is empty before and after — no real config or
state file on disk was ever written by this task's own execution; every
fixture is the existing `mkdtemp` `root` in `security.test.ts`, removed in the
file's own `afterEach`.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| A forced-closed posture does not become the recorded configured mode, and repairing the config afterwards produces no incident that did not happen. | met | `T58 D1`: `readState` after a broken run still reads the real `"advisory"`, not the forced `"enforced"`; repairing to the same real mode raises no `downgraded` warning and no `mode-downgrade` incident. |
| A genuine mode downgrade is still detected, and a first run whose config is already broken behaves sensibly and is described in the report. | met | `T58 D2`: a real downgrade from `gateway` to `ci` across a broken-config window still fires, because `previous` was never corrupted to the forced `enforced` in between. `T58 D3` + the "First run..." section above: no `previous` is ever established while the config stays broken, so there is nothing to falsely accuse; the first readable config establishes real state, exactly as if the broken runs never happened. |
| Nothing the earlier repairs closed reopens: an unusable or unrecognized-mode config still fails closed at the guard and the flow gate, the config file on disk is never written, and reasons stay constant and leak-safe. | met | `guard.ts`/`config.ts`/`guard.test.ts`/`types.ts` are byte-unmodified (never edited, only read) — `T37`/`T54`'s blocking behavior at `guardOutput`/`securityFlowGate` is untouched by construction. No new reason string was introduced; the new tests assert on `warnings`/incident `type`, never on reason text. The wider sweep (154/0) re-runs the exact suites T37/T54 verified against. `git status` on the real config/state paths is empty throughout. |
| Regressions fail before and pass after; the security and flow focused suites stay green. | met | RED 3 fail → GREEN 0 fail (`security.test.ts`). Required command `bun src/cli.ts ctx run -- bun test src/security/`: 233/0. Flow-adjacent sweep: 154/0. `typecheck` and `eslint` both clean. |

## Concerns

None. The fix is the exact one-line change T54's Concern 1 named, in the file
region it named, with no scope beyond the recorded-state interaction: no
change to `evaluateSelfProtection`'s comparison logic, no change to
`guard.ts`/`config.ts`/`types.ts`, no new reason string, no new field on
`SecurityState`.

One thing worth naming rather than hiding: the live, in-window comparison
(current forced `config.mode` against a real `previous`) is left exactly as
it was, and can still fire a `downgraded` warning while a config is broken if
the forced value's rank is lower than a real, higher previous mode (the
`gateway` → forced-`enforced` shape used in `T58 D2` to prove genuine
downgrades survive). This is disclosed as intended behavior, not a residual
defect: it is a true statement about the current run's effective enforcement
level, not a fabricated fact about the operator's configured mode, and
suppressing it would be a different, unrequested decision about the *live*
signal rather than the *recorded* one this task was scoped to fix.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set, the
exact line region, and the exact prior findings (T39 F-008, T37, T54); the one
open question — who else reads `state.json` — is a text-shape question `ctx
rg` answers directly, not a structural one); wiki_used: no (not-relevant — the
normative sources are `policies.md`, the frozen `acceptance-criteria.md`, and
the cited prior task artifacts, all read directly); ctx_used: yes (every code
search via `bun src/cli.ts ctx rg`, every test/typecheck/eslint run via `bun
src/cli.ts ctx run` or a direct `bun run`/`bunx` invocation whose output is
short enough not to need routing, all raw logs cited above); raw_rg_used: no —
every project-code search went through `ctx rg`, and every project-code read
used the `Read` tool with bounded offsets, per this repo's hook that blocks
bare `sed`/`grep`/`cat`/`find`.`

## Constraint compliance

No git state changed; no flow CLI or flow state touched; no `flow.json` or
`acceptance-criteria.md` edit; no network; no model calls; no dependency or
lockfile change; no `bun test` without file arguments; every fixture the
existing synthetic `mkdtemp` workspace in `security.test.ts`, removed in its
own `afterEach`; no real credential used (the new tests never plant a secret —
they are not testing detection, only the self-protection state machine); never
wrote to a real `.metaproject/security.config.json` or
`.metaproject/data/security/`; `src/security/config.ts`, `src/security/guard.ts`,
`src/security/guard.test.ts`, `src/security/types.ts`,
`src/commands/security.ts`, `src/health/service.ts`, `src/flow/service.ts`,
`src/security/detect/exfil.ts` are unmodified by me.
