# T33 implementation — the security gate path no longer fails open

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned files
only: `src/security/config.ts`, `src/security/service.ts` (the `readLatestReport`
/ `runReport` / `runGate` region), `src/security/types.ts` (additive),
`src/security/guard.ts`, `src/security/guard.test.ts`. Nothing else was edited.
`src/flow/service.ts`, `src/security/path-scan.ts`, `src/security/schemas.ts` and
`src/security/service.memo.test.ts` were read only.

Spec written before coding: `T33-spec.md` (same directory).

All raw logs below are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## Baseline (before any edit)

| Run | Result | Raw log |
|---|---|---|
| `T28-gate-probe.ts` | exit 0; **8 of 13** cases report `pass` where policy requires not-pass (a, b, b2, b3, b4, b5, b6, e) | `2026-09-06T13-58-21-484Z_run.log` (SUMMARY at line 155) |
| `T30-probe-failopen.ts` | exit 0, **4/4 probe assertions PASS** — i.e. the fail-open reproduces on demand: `loadSecurityConfig` throws, `guardOutput` returns `allowed:true` with a `pass` decision, `securityFlowGate` returns `null` | `2026-09-06T13-58-34-420Z_run.log` |
| `bun test src/security/guard.test.ts src/security/persistence-sinks.test.ts src/commands/security-recursive-scan.test.ts src/security/output-validation.test.ts` | **55 pass / 0 fail**, 224 expect() | `2026-09-06T13-58-39-149Z_run.log` |

## RED — the five regressions before the fix

`bun test src/security/guard.test.ts` → **18 pass / 6 fail**, 59 expect().
Raw: `2026-09-06T14-00-52-539Z_run.log` (per-test verdicts at lines 18-86).

| Test | Defect | Observed failure |
|---|---|---|
| `T33 D1: runGate reads missing or unparseable evidence as incomplete, never pass` | D1 | `pass` for absent / truncated / empty |
| `T33 D2: the gate fold is exhaustive over recognized gates and refuses the rest` | D2 | `pass` for `needs-approval`, missing `gate`, `"banana"`, `[]`, `null` |
| `T33 D3: guardOutput refuses a write when the security posture cannot be read` | D3 | `allowed: true`, `decision.gate: "pass"` |
| `T33 D4: securityFlowGate blocks instead of vanishing when the posture cannot be read` | D4 | returned `null` (gate omitted from flow completion) |
| `T33 D5: a stored needs-approval report blocks flow completion` | D5 | `{status: "pass"}` |
| `T33 root trigger: a non-object security.config.json falls back instead of throwing` | root | `TypeError: null is not an object (evaluating 'parsed.policies')` in `mergeSecurityConfig` |

(The sixth, `T33 D2b`, is a non-regression pin: a genuine `pass` artifact must
still read `pass` end to end. It passes before and after, by design.)

## Per-defect evidence

### Root trigger — `src/security/config.ts` `loadSecurityConfig`

`readJsonFileOr` only guards JSON that does not *parse*; `null`, `[]`, `42`,
`"advisory"` all parse and then reach `parsed.policies`. Added
`isMergeableConfigPayload` — a non-null, non-array object — and routed anything
else through the function's own documented malformed-JSON fallback
(`mergeSecurityConfig({})`).

- After: `T30-probe-failopen.ts` line 1 now reads
  `FAIL: trigger confirmed: loadSecurityConfig(cwd) throws … -- did not throw`,
  and the probe exits 1. Raw `2026-09-06T14-03-09-158Z_run.log`. **That
  inversion is the pass condition**: the probe asserts the defect is present, so
  its failure is the evidence the defect is gone. The probe short-circuits after
  the trigger check by its own design, so the remaining three assertions are
  reported as not meaningful rather than as passes.
- Regression: `T33 root trigger: …` — for each of `null`, `[]`, `42`,
  `"advisory"`: `loadSecurityConfig` resolves to the defaults, a planted AWS-shaped
  key is now **detected** (`decision.findings.length > 0`, `decision.gate !== "pass"`)
  where the reproducer previously observed `gate: "pass"` with zero findings, and
  `securityFlowGate` returns a gate entry instead of `null`.

### D1 — missing or unparseable evidence is not a pass (`service.ts`)

`readLatestReport` now returns a discriminated `LatestReportOutcome`
(`report` | `absent` | `unusable`) instead of `SecurityReport | null`. `runGate`
maps `absent` and `unusable` to `incomplete` with the constant reasons
`no security report; run \`keryx security scan\` first` and
`security report unusable; re-run \`keryx security scan\``. `runReport` builds
`buildReport([], config, "incomplete")` instead of `"pass"` for both.

- After (probe): cases a, b, b2 → `incomplete`, `runReport` gate `incomplete`.
  Raw `2026-09-06T14-04-49-334Z_run.log` (SUMMARY at line 158).
- Regression `T33 D1` also asserts the reasons contain neither the workspace
  root nor the word `JSON` (no raw error text).

### D2 — the fold is exhaustive, and the stored shape is validated (`service.ts`)

The two-value denylist with an unconditional `pass` fallthrough is replaced by a
`switch` over the four recognized `SecurityGate` values, reached only after
`hasRecognizedGate` confirms the parsed value is a non-null, non-array object
carrying one of those four strings. Anything else is `unusable` → `incomplete`.
The `default:` arm is on the blocking side so a future union member cannot
inherit a pass.

Validation is deliberately narrower than `SECURITY_REPORT_SCHEMA`, and the
reason is in the code comment: full-schema rejection buys nothing against
tampering (anyone who can write `latest.json` can write a schema-valid report
with `gate: "pass"` just as cheaply) while it would relabel every legitimate
`fail` / `needs-approval` artifact that is merely older or narrower than the
current schema as `incomplete`, collapsing the distinction this task exists to
preserve.

- After (probe): b3, b4, b5, b6 → `incomplete`; e (`needs-approval`) →
  `needs-approval`; c → `incomplete`; d, g → `fail`; f → `pass`. **13 of 13
  cases correct, 0 false passes.** Raw `2026-09-06T14-04-49-334Z_run.log`.
- One case changed verdict beyond the review's list, deliberately: **case h**
  (`gate: "pass"` with `coverage.status: "incomplete"`) went `pass` →
  `incomplete`. This is the same fold `runScanPath` applies before it writes
  (`service.ts:174-176`, untouched), applied again at read time: an artifact
  claiming a pass over coverage it itself calls incomplete can only be
  hand-written or tampered. T28 scored case h `n/a` because `runScanPath` never
  writes it; leaving it as a pass would have left the one remaining door open.

### D3 — `guardOutput` no longer degrades to allow (`guard.ts`)

The mode load moved into its own `try`. A workspace that has **enabled**
security but cannot read its own posture now returns
`{ allowed: false, decision: { gate: "incomplete", … }, reason: "security posture unavailable: check could not complete" }`.
The engine `check` keeps a separate catch that degrades to an `incomplete`
decision, which then flows through the existing mode fold — so advisory still
never blocks and keeps truthful diagnostics, and enforced/ci still block. No
behavior changed for any workspace whose config loads.

- Regression `T33 D3` forces the load failure with `mock.module` over `./config`
  (restored in `finally` from an eagerly snapshotted namespace) and asserts
  `allowed === false`, `decision.gate === "incomplete"`, and that the reason
  contains neither the thrown error's sentinel text nor the workspace root nor
  the planted key.
- The three committed `guard preserves incomplete engine evidence in <mode> mode`
  tests still pass unchanged, which is the proof the advisory path is intact.

### D4 — `securityFlowGate` participates instead of vanishing (`guard.ts`)

The mode-load catch returns `{ status: "fail", detail: "security posture unavailable: check could not complete" }`.
`null` is now reserved for the single intentional case (module disabled), which
its doc comment now states. Confirmed against the consumer first:
`src/flow/service.ts:657-670` pushes nothing for `null`, and `:672` folds with
`gates.every((gate) => gate.status !== "fail")` — so `null`, `pass` and
`skipped` are all equally non-blocking there.

- Regression `T33 D4` asserts non-`null`, `status: "fail"`, and a detail that
  echoes neither the error nor the path.

### D5 — the flow-gate status mapping is exhaustive (`guard.ts`)

The two-value ternary is a `switch`: `pass -> pass`;
`fail` / `needs-approval` / `incomplete` / anything unrecognized -> `fail`.
`runGate`'s status union gained `needs-approval` (`SecurityGateStatus` in
`types.ts`, additive; `securityFlowGate` is its only in-repo consumer), so the
gate keeps the three outcomes apart — violation, approval requirement,
unavailable evidence — while only a verified `pass` leaves completion unblocked.

- Regression `T33 D5`: stored `needs-approval` in an enforced workspace →
  `{ status: "fail", detail: "security gate: needs-approval" }`. The T30 probe's
  live demonstration of `pass` end to end is closed at both frames.
- `T33 D2` additionally asserts the flow-gate status for **all ten** artifact
  states in its table: `fail` for every one that is not a verified pass.

### Comments corrected (T30 F-003, info)

`// Advisory-safe: an engine error must not break the caller.` above the
`guardOutput` catch is gone with the catch it mislabelled; `guardOutput`'s and
`securityFlowGate`'s doc comments now describe the real scope of each branch.
The file header's statement that the mandatory deterministic output floor
applies regardless of module state is untouched.

## Verification (after)

| Check | Result | Raw log |
|---|---|---|
| `T28-gate-probe.ts` | exit 0; **13/13 cases correct, 0 false passes** (was 8 false passes) | `2026-09-06T14-04-49-334Z_run.log` |
| `T30-probe-failopen.ts` | **exit 1, 1 assertion FAILED — the trigger no longer reproduces** (was exit 0, 4/4 reproducing) | `2026-09-06T14-03-09-158Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts src/security/persistence-sinks.test.ts src/commands/security-recursive-scan.test.ts src/security/output-validation.test.ts` | **68 pass / 0 fail**, 339 expect() | `2026-09-06T14-04-49-125Z_run.log` |
| New regressions | RED **6 fail** → GREEN **0 fail** (7 tests added to `guard.test.ts`: 17 → 24) | RED `2026-09-06T14-00-52-539Z_run.log`; GREEN `2026-09-06T14-04-49-125Z_run.log` |
| `bun run typecheck` (`tsc --noEmit`) | clean, exit 0 | `2026-09-06T14-04-38-344Z_run.log` |
| `bunx eslint src/security/guard.ts src/security/guard.test.ts src/security/service.ts src/security/config.ts src/security/types.ts` | clean, no output, exit 0 | `2026-09-06T14-04-43-404Z_run.log` |
| Wider sweep: `bun test src/security/security.test.ts src/flow/security-gate.test.ts src/commands/security.check-input.test.ts src/commands/security-hooks-init.test.ts src/security/service.memo.test.ts` | **61 pass / 0 fail**, 222 expect() | `2026-09-06T14-05-13-176Z_run.log` |

The selection went 55 → 68 tests. **7** of the 13 are mine (`guard.test.ts`
17 → 24); the other **6** appeared in `persistence-sinks.test.ts` /
`output-validation.test.ts` between the baseline run at 13:58 and the final run
at 14:04, from a concurrent worker. Both runs are 0 fail.

No committed test was deleted, weakened, or had its expectation changed. Two
existing fixtures (`{gate:"fail"}` and `{gate:"incomplete"}`, both partial
report shapes) keep their exact verdicts under the narrow validation described
in D2 — a further reason not to reach for full-schema rejection.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC6 (AFC-17): a found violation and an incomplete coverage state are visible at the same time; incomplete is never relabeled as pass. | met | Probe cases g (`fail` + `coverage.incomplete` → `fail`, violation preserved) and h (`pass` + `coverage.incomplete` → `incomplete`, no relabel). `runScanPath`'s own fold untouched, so T34's non-recursive outcome still reports `incomplete` (probe section "non-recursive directory scan", same raw log). |
| AC8: no required failed or incomplete check is relabeled PASS; strict guards and the strict flow gate refuse incomplete evidence; advisory retains truthful incomplete diagnostics; partial acceptance is not full phase completion. | met | 13/13 probe cases; `T33 D2` asserts the flow gate blocks on every non-pass state; `T33 D3`/`D4` close both posture-unavailable paths; the three committed advisory `incomplete` tests still pass unchanged. |
| Policy fold (policies.md): FAIL on a threshold violation; INCOMPLETE when a required check is missing, skipped, unparsed or unfinished; strict CI accepts only PASS; reasons and details are constant and leak-safe. | met | Mapping table in `T33-spec.md`; every reason and detail is a string literal (`NO_REPORT_REASON`, `UNUSABLE_REPORT_REASON`, `INCOMPLETE_COVERAGE_REASON`, `POSTURE_UNAVAILABLE_REASON`), asserted free of the workspace root, the error sentinel and the planted key in `T33 D1`/`D3`/`D4`. |

## Concerns

1. **A destroyed config still downgrades the mode to `advisory`.** With the root
   trigger repaired, a `security.config.json` containing `null` now loads the
   **default** config, whose mode is `advisory` — so in that workspace
   `guardOutput` detects the planted secret (gate `fail`, findings present) but
   still returns `allowed: true`, because advisory never blocks. That is the
   pre-existing malformed-JSON fallback this dispatch explicitly asked for, and
   §14 self-protection catches it as a mode downgrade in any workspace that has
   run before (`state.json` records the previous mode). Refusing to operate
   without a readable config would be a different, larger policy decision, in
   `config.ts` semantics this task was not scoped to make. Flagging it so the
   phase can decide deliberately.
2. **`T33 D3`/`D4` use `mock.module`.** After the root-cause fix,
   `loadSecurityConfig` is total for any fixture I can build, so the two catch
   branches are unreachable without a module mock. The mock is restored in
   `finally` from an eagerly snapshotted namespace (a live namespace reference
   restores the *mock*, which cost one RED iteration to discover); the whole
   file and the wider sweep are green afterwards.
3. **Case h changed verdict beyond the reviewers' list** (see D2). Deliberate,
   justified above, and pinned by a test.

## Changed files

- `src/security/config.ts` — `isMergeableConfigPayload`; non-object payloads take
  the existing defaults fallback instead of throwing.
- `src/security/service.ts` — `LatestReportOutcome`, `hasRecognizedGate`,
  constant reasons, exhaustive `runGate` fold, `runReport` synthesizes
  `incomplete`. `runScanPath` untouched.
- `src/security/types.ts` — additive `SecurityGateStatus`; `SecurityService.gate`
  now returns it.
- `src/security/guard.ts` — split mode-load catch (refuses instead of allowing),
  engine-error catch degrades to an `incomplete` decision, `securityFlowGate`
  mode-load catch returns a blocking `fail`, exhaustive status `switch`,
  corrected comments.
- `src/security/guard.test.ts` — 7 tests added (5 defect regressions, 1
  non-regression pin, 1 root-trigger reproducer).

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set and the
symbols; no discovery or blast-radius question arose); wiki_used: no
(not-relevant — the normative sources are policies.md and the frozen
acceptance-criteria.md, both supplied as context_refs and read directly);
ctx_used: yes (every search via keryx ctx rg, every command via keryx ctx run,
all raw logs cited above); raw_rg_used: no — three bounded `grep`/`sed` reads of
gdctx raw logs carried the documented `# keryx:raw` escape with the reason that
routing probe JSON back through ctx compaction removes the per-case statuses
that are the evidence itself. No search over project code bypassed ctx.`
