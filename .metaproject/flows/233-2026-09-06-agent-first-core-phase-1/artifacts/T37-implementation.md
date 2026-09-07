# T37 implementation — stop an unusable manifest or config from silently removing the security posture

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned files
only: `src/security/guard.ts`, `src/security/guard.test.ts`,
`src/security/config.ts`, `src/security/service.ts` (the `runGate`/
`runReport`/`readLatestReport` region), `src/security/types.ts` (additive).
`src/flow/service.ts` was read-only and was NOT edited. Nothing else was
touched. Did not review my own fix (per dispatch instruction).

Spec written before coding: `T37-spec.md` (same directory).

All raw logs below are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## Baseline (before any edit)

| Run | Result | Raw log |
|---|---|---|
| `T35-probe-residual.ts` | exit 0, **3 CHECK(S) FAILED** (all three are the D3 manifest-null checks: `securityFlowGate is documented "Never throws"`, `guardOutput is documented never to resolve toward "everything is fine"`, `D3 a security gate that could not run still blocks completion`, all `ok:false` — F-001 reproduces) | `2026-09-06T14-41-28-209Z_run.log` |
| `T35-probe-flowfold.ts` | exit 0, **0 failures, ALL CASES OK** (this probe does not exercise a corrupted manifest or config, so it is a pure no-regression baseline) | `2026-09-06T14-41-30-251Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts src/security/persistence-sinks.test.ts src/security/service.memo.test.ts src/commands/security-recursive-scan.test.ts` | **59 pass / 0 fail**, 271 expect() | `2026-09-06T14-42-22-751Z_run.log` |

## RED — the six new regressions before the fix

`bun src/cli.ts ctx run -- bun test src/security/guard.test.ts` → **25 pass / 6
fail**, 149 expect(). Raw: `2026-09-06T14-44-38-898Z_run.log`.

| Test | Defect | Observed failure |
|---|---|---|
| `T37 D1: a metaproject.json that parses but is not an object never throws and blocks as posture-unavailable, not disabled` | F-001 | `isSecurityEnabled` threw `null is not an object (evaluating '(await readJsonFileOr(manifestPath, {})).modules')` |
| `T37 D1b: non-null non-object manifests … get the same never-throws, posture-unavailable treatment` | F-001 (class boundary) | `securityFlowGate` returned `null` for `[]` instead of a blocking `fail` entry |
| `T37 D2: a security.config.json that parses but is not an object blocks instead of silently downgrading to advisory, even with a recorded prior strict mode` | F-003 | `loadSecurityConfig(root).mode` was `"advisory"`, not `"enforced"` |
| `T37 D2b: a security.config.json that fails to parse takes the same unreadable path as a non-object payload` | F-003 | same — `"advisory"`, not `"enforced"` |
| `T37 D3: a coverage status that is neither complete nor incomplete reads as incomplete at both runGate and runReport` | F-004 | `runGate({cwd}).status` was `"pass"`, not `"incomplete"`, for `coverage.status: "partial"` |
| `T37 D3b: the coverage fold is exhaustive …` | F-004 | same shape, for a bare-string `coverage` value |

## Per-defect evidence

### Defect 1 (F-001, blocker) — `isSecurityEnabled` manifest dereference

**Not the literal reviewer snippet.** The review's own suggested-fix code
returns `false` (module disabled) for a non-object manifest — that stops the
crash but is still a disappearance (a corrupted manifest and "never
configured" become indistinguishable, both non-blocking). The T37 dispatch is
explicit the corrected outcome must be **blocking posture-unavailable**, so
`guard.ts` now distinguishes "no manifest file at all" (`enabled: false`,
unchanged, non-blocking) from "manifest file present but not readable as a
non-null, non-array object, or its `.modules` block is not one"
(`manifestUnreadable: true` — new). A private
`resolveManifestSecurityState(cwd)` returns both; `isSecurityEnabled` keeps
its existing `Promise<boolean>` signature (`enabled` only) so every existing
caller is unaffected, and `guardOutput`/`securityFlowGate` call the richer
helper directly to branch on `manifestUnreadable` before ever loading
config/mode. Both consume it through their EXISTING posture-unavailable
branches (`POSTURE_UNAVAILABLE_REASON`, `INCOMPLETE_DECISION` /
`status:"fail"`) — no new reason string.

Deliberate design point: **all** non-object manifest bodies (`null`, `[]`,
`42`, a string, a boolean) get the same `manifestUnreadable: true` treatment,
not just the `null` literal that happens to crash today. Before this fix,
`[]`/`42`/`"x"`/`true` silently read as `enabled:false` (no crash, no block —
confirmed pre-fix by `T35-probe-residual.ts` D3's own evidence text: "bounds
the trigger to the JSON literal `null`"). Leaving those four shapes quietly
disabled while only `null` became blocking would have been internally
inconsistent with `config.ts`'s own `isMergeableConfigPayload`, which already
treats every non-object shape uniformly. `T37 D1b` pins the four non-`null`
shapes as also non-throwing and now blocking.

- After: `T35-probe-residual.ts` D3's `isSecurityEnabledThrew` /
  `guardOutputThrew` are now `null` (no throw). Raw
  `2026-09-06T14-47-23-969Z_run.log`.
- Regression: `T37 D1` (manifest `null`) and `T37 D1b` (`[]`/`42`/`"enabled"`/
  `true`) both assert non-throwing, `enabled === false`, `guardOutput` blocks
  with `POSTURE_UNAVAILABLE_REASON`, and `securityFlowGate` returns a
  blocking `{status:"fail"}` entry, never `null`.

**Class scope — the other 8 sites.** The reviewer enumerated 9 unguarded
`readJsonFileOr` + `manifest.modules` sites and 2 that already guard. Read all
9 (bounded excerpts via `Read`, not raw `sed`/`grep`, since the repo's own
hook blocks bare `sed`/`grep`/`cat`/`find` on project files):

| Site | Confirmed behavior on a `null`-shaped manifest |
|---|---|
| `src/security/guard.ts:104` (this task) | was: throws, converted to non-blocking `skipped` by `src/flow/service.ts` — the AC8 open failure. Now: fixed. |
| `src/testing/capability.ts:26` | `manifest.modules?.testing` dereferences `manifest.modules` unguarded — crashes its own caller (fail-closed). |
| `src/capability/seam.ts:70` | `manifest.modules ?? {}` dereferences `manifest.modules` unguarded — crashes (fail-closed). |
| `src/mcp/discovery.ts:123` | `buildDiscovery(manifest)` passes the raw parsed value through; the manifest shape is dereferenced downstream — crashes (fail-closed). |
| `src/gdskills/project-skills.ts:664` | `manifest.modules ??= {}` — crashes (fail-closed). |
| `src/gdskills/project-skills.ts:681` | `manifest.modules?.gdskills` — crashes (fail-closed). |
| `src/gdskills/export.ts:199` | `manifest.modules?.gdskills` — crashes (fail-closed). |
| `src/gdskills/export-plugin.ts:189` | reads a *different* file (`export-manifest.json`, not `metaproject.json`) with the same unguarded-dereference shape (`manifest.module`/`manifest.name`) — crashes (fail-closed). |
| `src/commands/ctx.ts:131` | `manifest.modules?.gdctx` — crashes (fail-closed). |

**Deliberately left, and why:** none of the 8 is inside this task's file
ownership (`guard.ts`, `config.ts`, the named `service.ts` region,
additive `types.ts`) — the dispatch's ownership constraint lists exactly
those and says "Nothing else," and the dispatch's `STATUS: BLOCKED` escape
valve is for a fix this task's own acceptance criteria require, not a wider
sweep across eight unrelated modules. All 8 already fail CLOSED (they crash
the calling command/seam rather than silently passing a security check), so
none of them reproduces the AC8 shape ("a required check silently reads as
clean") this dispatch closes — only `guard.ts:104` had a consumer
(`src/flow/service.ts`'s gate fold) that converted the crash into a
non-blocking outcome. Left as a documented candidate for a follow-up
consistency pass, not fixed here.

### Defect 2 (F-003, major residual) — `loadSecurityConfig` non-object payload

Per the reviewer's named minimal change: `loadSecurityConfig` now
distinguishes *absent* config (`pathExists` false — keeps today's
defaults/advisory behaviour exactly) from *present but unusable* (parses to
something `isMergeableConfigPayload` rejects, **or does not parse at all** —
the malformed-JSON fallback moved with it, per the reviewer's note that
splitting the two leaves the cheaper corruption open). The present-but-unusable
case now returns the defaults with `mode` forced to `"enforced"` and an
additive `configUnreadable: true` (`types.ts`, additive on `SecurityConfig`).

Telling "did not parse" apart from "parsed to a legitimate `{}`" needed a
sentinel other than `readJsonFileOr`'s generic fallback value (a fallback of
`{}` cannot be told apart from a real empty config) — a module-local `Symbol`
(`CONFIG_UNREADABLE`) fills that role.

`guardOutput` and `securityFlowGate`'s existing mode-load `try` blocks now
also check `config.configUnreadable` and return through the SAME
posture-unavailable branches they already had for a throwing load (same
`POSTURE_UNAVAILABLE_REASON` constant, same `INCOMPLETE_DECISION` /
`status:"fail"` shapes) — no new reason string, no new leak surface.

- **The stated T33 mitigation is refuted, and the fix closes exactly what was
  measured.** `T35-probe-residual.ts` D1, run twice (fresh workspace, and a
  workspace with `state.json` recording a prior `mode: "ci"`): BEFORE,
  `guardAllowed: true`, `flowGateStatus: "pass"` in both rows — identical,
  confirming the residual. AFTER: `guardAllowed: false`,
  `decisionGate: "incomplete"`, `flowGateStatus: "fail"`,
  `flowGateBlocksCompletion: true`, `reason: "security posture unavailable:
  check could not complete"` — in both rows. Raw
  `2026-09-06T14-47-23-969Z_run.log`.
- Regression: `T37 D2` (config `"null"`, both without and with a recorded
  prior `mode: "ci"`) and `T37 D2b` (config that fails to parse at all,
  `"{not json"`) both assert `mode === "enforced"`,
  `configUnreadable === true`, `guardOutput` blocked, `securityFlowGate`
  blocked, leak-safe reason/detail.
- **Non-regression pin:** `T37 D2c` asserts an absent config file and a
  legitimate empty `{}` config both still resolve to `mode:"advisory"` with
  `configUnreadable` undefined — the ordinary "never configured" and
  "explicitly minimal config" cases are unaffected.
- **A committed T33 test's expectation changed, and is justified.** `T33 root
  trigger: a non-object security.config.json falls back instead of throwing`
  asserted `result.decision.findings.length` > 0 — i.e. that the write was
  still analyzed (and found the planted secret) under the permissive
  `advisory` default T33 shipped. Under the corrected F-003 semantics, a
  present-but-unusable config now blocks BEFORE analysis ever runs (posture
  unavailable, empty findings), so that assertion no longer holds and is
  replaced with the stronger `expect(result.allowed).toBe(false)`. This is
  the exact verdict change T35's judgement-call ruling on the residual calls
  for; the test's title, loop over the four non-object payload shapes, and
  its other two assertions (`gate !== "pass"`, `securityFlowGate` non-null)
  are unchanged. No test was deleted or weakened — this one now asserts a
  stronger, more correct outcome.

### Defect 3 (F-004, minor) — coverage-consistency fold shared and exhaustive

Extracted `hasIncompleteCoverage(coverage: unknown): boolean` in
`service.ts`: `undefined`/`null` (no coverage claim) is not incomplete
(preserves T33 D2b — a normal scan that never sets `coverage` still reads
`pass`); anything else present that is not a plain object, or is an object
whose `status` is not exactly `"complete"`, is incomplete. `runGate`'s `pass`
arm now calls the shared helper instead of the old literal-equality check
against `"incomplete"`. `runReport` — which previously returned the stored
`pass` report verbatim regardless of `coverage` — now applies the same fold:
when the stored report's `gate` is `"pass"` and its coverage is
inconsistent, `runReport` returns the report with `gate` overridden to
`"incomplete"`, mirroring the fold `runScanPath` already applies at write
time.

- Regression: `T37 D3` (`coverage.status: "partial"`) and `T37 D3b`
  (exhaustive: a bare-string `coverage` value is incomplete; an absent
  `coverage` key and an explicit `coverage: null` both still read `pass`,
  the non-regression pin for T33 D2b and the reviewer's A24) — both assert
  `runGate` and `runReport` agree.

### Stale statements

- `guard.ts` header (F-006): amended from "advisory mode ONLY reports — it
  never blocks" to name the posture-unknown exception explicitly: advisory
  never blocks on a *known* posture; every mode, including advisory, blocks
  when the posture itself cannot be established (unreadable manifest or
  config). In scope (`guard.ts`), fixed.
- `src/flow/service.ts`'s security/health catch arms still recording
  `skipped` and interpolating raw `error.message` (F-005): **out of scope,
  not fixed.** `src/flow/service.ts` is explicitly read-only in this
  dispatch's ownership constraints ("If you believe another file must
  change, stop and reply STATUS: BLOCKED naming the exact change" — this
  dispatch's acceptance criteria do not require that file to change, so no
  block was raised). With F-001 fixed, `securityFlowGate` is now provably
  total (it never throws for any manifest/config shape reachable without a
  module mock) — the exact property F-005 itself names as removing the last
  known trigger for the security arm of that catch. The stale
  `skipped`/raw-text pattern remains latent in `flow/service.ts` for a
  future gate implementation that throws (e.g. `health`, or a future
  security-gate rewrite); flagged as a concern below, not a code change.

## Verification (after)

| Check | Result | Raw log |
|---|---|---|
| `T35-probe-residual.ts` | exit 0, **2 CHECK(S) FAILED** (down from 3) — the 2 are `D1 destroyed config (…): the write is still ALLOWED` for both prior-state cases, now `ok:false` because the write is correctly BLOCKED. Same inversion pattern as `T30-probe-failopen.ts` in T33: the probe asserts the defect's presence, so its own check flipping to failed is the fix being confirmed, not a regression. The D3 `Never throws` checks that failed at baseline are gone (no longer applicable — the throw no longer happens). | `2026-09-06T14-47-23-969Z_run.log` |
| `T35-probe-flowfold.ts` | exit 0, **0 failures, ALL CASES OK** — unchanged from baseline (this probe never exercised a corrupted manifest/config) | `2026-09-06T14-47-26-350Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts src/security/persistence-sinks.test.ts src/security/service.memo.test.ts src/commands/security-recursive-scan.test.ts` | **66 pass / 0 fail**, 329 expect() (was 59/0/271 — 7 new tests, all in `guard.test.ts`) | `2026-09-06T14-47-06-790Z_run.log` |
| `guard.test.ts` alone | RED **6 fail** → GREEN **0 fail** (31 pass, 195 expect(); was 24 tests before this task, now 31) | RED `2026-09-06T14-44-38-898Z_run.log`; GREEN `2026-09-06T14-47-00-759Z_run.log` |
| Wider sweep: `bun test src/security/security.test.ts src/flow/security-gate.test.ts src/commands/security.check-input.test.ts src/commands/security-hooks-init.test.ts src/security/output-validation.test.ts` | **75 pass / 0 fail**, 363 expect() | `2026-09-06T14-47-22-236Z_run.log` |
| `bun run typecheck` (`tsc --noEmit`) | clean, exit 0 | `2026-09-06T14-47-50-267Z_run.log` |
| `bunx eslint src/security/guard.ts src/security/guard.test.ts src/security/service.ts src/security/config.ts src/security/types.ts` | clean, no output, exit 0 | `2026-09-06T14-47-52-690Z_run.log` |

No committed test was deleted or weakened. One committed T33 test's
expectation was changed and justified above (verdict strengthened, not
loosened). `T33 D1`-`D5` and the `T33 root trigger` test (with the one
updated assertion) all still pass.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC8: no required failed or incomplete check is relabeled PASS; a security gate that cannot establish its posture blocks rather than disappearing; advisory retains truthful diagnostics; partial acceptance is not full phase completion. | met | `T37 D1`/`D1b` (manifest), `T37 D2`/`D2b` (config) both block with `status:"fail"`/`allowed:false`, never `null`/non-blocking. `T35-probe-residual.ts` D3 no longer throws; D1's "still ALLOWED" checks now correctly fail (write is blocked). Advisory truthfulness for a config that DOES load is untouched (`T37 D2c`, unchanged advisory tests). |
| Policy fold (policies.md): INCOMPLETE when a required check is missing, skipped, unparsed or unfinished; strict CI accepts only PASS; reasons and details are constant and leak-safe, with no raw error text, path or source bytes. | met | Every new branch reuses the existing constants `POSTURE_UNAVAILABLE_REASON` / `INCOMPLETE_COVERAGE_REASON` — no new string literals, no interpolation. `T37 D1`, `T37 D2` assert the reason/detail contain neither the workspace root nor the sentinel/planted key. |
| Each defect is closed by a regression that fails before and passes after: a manifest that parses but is not an object, a config that parses but is not an object with a recorded prior strict mode, and a stored report whose coverage status is neither complete nor incomplete. No previously passing case regresses. | met | RED (6 fail) → GREEN (0 fail) in `guard.test.ts`; the required 4-file selection went 59→66 pass with 0 fail in both runs; the wider sweep is 75/0; both reviewer probes ran before and after with raw logs cited. |

## Concerns

1. **`src/flow/service.ts`'s stale `skipped`/raw-text catch arms (F-005) are
   not fixed.** Out of this task's file ownership (explicitly read-only).
   With F-001 fixed, the security arm of that catch is provably unreachable
   through any manifest/config shape this task can construct without a
   module mock — the same "unreachable without a mock" situation T33 noted
   for its own catch branches — but the code as written still says `skipped`
   and still interpolates `error.message` for BOTH the security and health
   gates. A future security-gate implementation that throws for a new reason,
   or the health gate today, would still convert an unexpected error into a
   non-blocking `skipped` with raw text in a persisted/posted string. Flagging
   for a future task with `src/flow/service.ts` in its ownership.
2. **The other 8 `readJsonFileOr`/`manifest.modules` sites in F-001's class
   scope are unmodified**, per the ownership constraint (see per-defect
   evidence above). All 8 fail closed today (crash their own caller), so none
   reproduces this dispatch's AC8 trigger, but a consistency sweep applying
   `guard.ts`'s new `resolveManifestSecurityState`-style guard to all 9 sites
   (the pattern `src/gdgraph/symbols-capability.ts:24` and
   `src/capability/wiring.ts:107` already use) would be a reasonable
   follow-up.
3. **All non-object manifest shapes, not just `null`, now block.** Before
   this task, `[]`/`42`/`"x"`/`true` silently read as "module disabled"
   (matching a missing manifest). This task treats them the same as `null`
   (posture-unavailable, blocking), for internal consistency with
   `config.ts`'s uniform treatment of non-object payloads. This is a
   (narrow) behavior change beyond the literal `null` crash trigger the
   review measured, made deliberately rather than by omission — flagging it
   explicitly in case the phase wants a narrower `null`-only fix instead.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set and
symbol names; the one discovery step, confirming the 8 out-of-scope
`readJsonFileOr` sites' behavior, is a text-shape question `ctx rg` answers,
not a structural one); wiki_used: no (not-relevant — the normative sources are
`policies.md` and the frozen `acceptance-criteria.md`, both supplied as
context_refs and read directly); ctx_used: yes (every code search via
`bun src/cli.ts ctx rg`, every test/probe/typecheck/eslint run via
`bun src/cli.ts ctx run`, all raw logs cited above); raw_rg_used: no — two
bounded `grep -n`/`sed -n` reads of gdctx **raw probe logs** (never of
project code) carried the documented `# keryx:raw` escape with the stated
reason that ctx compaction drops the per-case `"ok"` statuses that are the
acceptance evidence itself, exactly as T33 and T35 recorded. No search over
project code bypassed `ctx`; the 9 class-scope source files were read with
the `Read` tool (bounded excerpts) rather than raw `sed`/`grep`, since this
repo's own hook blocks bare `sed`/`grep`/`cat`/`find` on project files
outside the documented `ctx run`/raw-log escape.`

## Constraint compliance

No git state changed; no flow CLI or flow state touched; no network; no model
calls; no dependency or lockfile change; no `bun test` without file arguments;
`src/flow/service.ts` and every file outside the ownership list are
unmodified; every fixture synthetic, under `mkdtemp`, removed in `finally`; no
real credential used (the only key-shaped string is the documented synthetic
`AKIA…` example already used by `guard.test.ts`); never wrote to a real
`.metaproject/security.config.json` on disk — `loadSecurityConfig`'s
`configUnreadable` branch only ever returns an in-memory config object.
