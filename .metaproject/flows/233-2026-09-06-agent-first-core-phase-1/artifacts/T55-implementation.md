# T55 implementation — three defects T39 found beyond T38/T50's exhaustive-mapping rewrites

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned
files only: `src/commands/security.ts` + `src/commands/security-gate-exit.test.ts`
+ `src/commands/security.check-input.test.ts` (read, unaffected — see below),
`src/health/service.ts` + `src/health/service-gate-exit.test.ts`.
`src/security/config.ts`, `src/security/guard.ts`, `src/security/detect/exfil.ts`
were not touched (owned by concurrent workers this round). Spec written
before coding: `T55-spec.md` (same directory).

All raw logs below are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## Reviewer's probe, before and after (dispatch-mandated)

`T39-exit.ts`, run unchanged:

| Row | Before | After |
|---|---|---|
| S2 `reportExitCode mode="enforced"` | `{"pass":0,"fail":0,"needs-approval":0,"incomplete":0,"banana":0}` | `{"pass":0,"fail":1,"needs-approval":1,"incomplete":1,"banana":1}` |
| H6 no `gate` key | `threw: "undefined is not an object (evaluating 'latest.gate.status')"` | `threw: null, result: {"status":"fail","exitCode":1,"reasons":["no report; run \`keryx health run\` first"]}` |
| H7 `gate` is a bare array | same throw as H6 | same fixed result as H6 |
| H8 `gate` is a string | `{"exitCode":1}` (status/reasons `undefined`, no throw but malformed) | `{"status":"fail","exitCode":1,"reasons":["no report; run \`keryx health run\` first"]}` |

Raw: before `.metaproject/data/gdctx/raw/T55-probe-before.log`; after
`.metaproject/data/gdctx/raw/T55-probe-after.log`. Full command:
`bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T39-exit.ts`.

**S3 needs a note.** T39-exit.ts's own S3 row calls
`reportExitCode(report.gate, report.mode)` **directly** — it never invokes
`handleReport`/`securityCommand`, the real CLI entry point. That direct call
is, by construction, unaffected by this fix: the fix relocated *which value*
`handleReport` passes as `mode` (from `report.mode` to `await modeOf(cwd)`),
not `reportExitCode`'s own behavior for whatever `mode` it is handed. So S3
reads `cliExitCode: 0` before AND after — correctly, since it is testing "if
you pass the artifact's mode you get the old answer," which remains true of
the pure function. To verify the *actual* fix (defect 1), I wrote a
supplementary probe that drives the real entry point,
`T55-verify-real-cli.ts` (same directory), reproducing S3's exact fixture
(workspace `ci`, stored artifact `mode: "advisory"`, `gate: "fail"`) through
`securityCommand(["report", "--json"], root)`:

```
{"label":"T55 real CLI: keryx security report, workspace ci + stored mode advisory + gate fail","exitCode":1,"expected":1,"matches":true}
```

This is 1, not 0 — the real command surface is fixed. (Confirmed also by the
new CLI-level regression test in `security-gate-exit.test.ts`, see below.)

## Defect 1 (F-003, major) — `security report`'s exit code now sources mode from the workspace

**Before** (`src/commands/security.ts:558`, read prior to any edit):
```ts
process.exitCode = reportExitCode(report.gate, report.mode);
```
**After**:
```ts
process.exitCode = reportExitCode(report.gate, await modeOf(cwd));
```

**Decision: take the mode from the workspace's own configuration, not from
the artifact.** The dispatch offered two options — source from the
workspace, or validate `report.mode` as strictly as `report.gate`. Validating
the mode's *shape* (rejecting non-enum garbage) does not fix the reported
scenario: `"advisory"` is a perfectly valid `SecurityMode` value, so any
shape/enum check that would accept it as a legitimate `report.gate` peer
would equally accept it here, leaving a workspace that switched to `ci`
after an `advisory` scan still governed by the stale artifact. Sourcing from
`await modeOf(cwd)` removes the trust boundary outright and matches the two
other exit-code call sites in this same file (`:250`, `:515`), which already
ask the workspace, never the payload. `report.mode` is still printed
unchanged (`:551`, and in the `--json` object) as the artifact's own
provenance — a distinct question from which posture this process exits
under.

**Truth table**: no recognized-value cell of `reportExitCode`'s own mapping
moved for this defect (that is defect 2, below) — this changes only *which
argument* `handleReport` passes in, not the function's mapping.

## Defect 2 (F-003, major; T39 "Judgement calls" #2) — `reportExitCode`'s `enforced` arm now matches `ci`

**Before**:
```ts
export function reportExitCode(gate: string, mode: string): number {
  return mode === "ci" && !isPassGate(gate) ? 1 : 0;
}
```
**After**:
```ts
export function reportExitCode(gate: string, mode: string): number {
  if (mode === "ci" || mode === "enforced") {
    return isPassGate(gate) ? 0 : 1;
  }
  return 0;
}
```

This is a **dispatch-mandated ruling to implement, not a re-litigation**.
T38 disclosed the `ci`-only scope as a literal reproduction of F-002's own
suggested fix. T39 measured the actual consequence — `enforced` returned 0
not just for the disclosed `needs-approval` residual but for `fail` and
`incomplete` too — and ruled in "Judgement calls" #2 that the asymmetry must
close, because (a) it is measurably larger than disclosed, (b) the stated
rationale ("report aggregates a stored scan") does not distinguish `ci` from
`enforced` — it applies to both, and `ci` already refuses, and (c) every
other fold in both modules already treats `ci`/`enforced` as one pair
(`isBlockingMode`, `exitCodeFor`, `securityFlowGate`). The fix mirrors
`exitCodeFor` (`:853-858`) exactly, so `reportExitCode` now carries the same
shape as its sibling instead of a second, narrower rule.

### Truth table — exactly what moved, and what did not

| `mode` | `gate` | before | after | changed? |
|---|---|---|---|---|
| `ci` | `pass` | 0 | 0 | no |
| `ci` | `fail`/`needs-approval`/`incomplete`/unrecognized | 1 | 1 | no |
| `enforced` | `pass` | 0 | 0 | no |
| `enforced` | `fail` | 0 | **1** | **yes — this task** |
| `enforced` | `needs-approval` | 0 | **1** | **yes — this task** |
| `enforced` | `incomplete` | 0 | **1** | **yes — this task** |
| `enforced` | unrecognized | 0 | **1** | **yes — this task** |
| `advisory`/`gateway`/anything else | any | 0 | 0 | no — §11 control, untouched |

`exitCodeFor` (site 1, `security scan`/`check-*`) and `isPassGate` are
**unchanged** — `exitCodeFor` already treated `ci`/`enforced` identically
since T38; this defect lived in `reportExitCode` alone.

### Existing test corrected (not deleted or weakened)

`src/commands/security-gate-exit.test.ts`, the test formerly titled
`"enforced: unchanged — security report's strict check is ci-only, per T35
F-002's own suggested fix"` asserted exactly the behavior T39 ruled must
close (`reportExitCode(gate, "enforced") === 0` for every non-pass gate).
Retitled `"enforced: now matches ci — closed by T39 F-003 / Judgement call
#2"` and its five assertions inverted to the fixed truth table above, with a
comment recording why (T39-review.md "Judgement calls" #2), per the
constraint that a committed expectation encoding a defect must be corrected
and the change justified in writing, not silently flipped or removed.

## Defect 3 (F-004, minor) — `readLatest` now validates the shape around the gate value, not only the value

**Before** (`src/health/service.ts`, read prior to any edit):
```ts
async function readLatest(cwd: string): Promise<HealthReport | null> {
  ...
  try {
    const latest = JSON.parse(...) as HealthReport & { record?: string };
    if (typeof latest.record === "string") {
      ...
      return JSON.parse(await readFile(recordFile, "utf8")) as HealthReport;
    }
    return latest;
  } catch {
    return null;
  }
}
```
`gate()` then did `const status = latest.gate.status;` unguarded — sound for
T50's fix (an unrecognized `status` *value* now fails closed via
`gateExitCode`'s default arm), but a `latest.json` with no `gate` key, or
`gate` as a non-object, made this line throw a raw `TypeError` out of the
method, bypassing the module's own "no report; run `keryx health run`
first" refusal that already exists one branch up for a genuinely absent
report.

**Fix**: a private shape predicate, `hasGateShape`, mirroring
`hasRecognizedGate`/`readLatestReport` in `src/security/service.ts` for the
identical problem — validates the object is non-null/non-array and its
`gate` field is itself a non-null/non-array object with a string `status`
and an array `reasons`. Applied inside `readLatest` at both return points
(the direct payload and the `record`-pointer indirection), so a malformed
report is `null` — unusable evidence, folded into the exact same "no report"
outcome the absent-file case already produces — for both of `readLatest`'s
two callers (`gate()` and `status()`), rather than a second guard per call
site:

```ts
function hasGateShape(value: unknown): value is HealthReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const gate = (value as { gate?: unknown }).gate;
  if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
    return false;
  }
  const status = (gate as { status?: unknown }).status;
  const reasons = (gate as { reasons?: unknown }).reasons;
  return typeof status === "string" && Array.isArray(reasons);
}
```

Deliberately does **not** require `status` to be one of the four recognized
`GateStatus` values — that stays `gateExitCode`'s job (T50), already
exhaustive with a blocking default arm once the shape is sound enough to
reach it. Confirmed this by re-running the `banana`/`incomplete`/`warn`
controls (H3/H4/H5 in the probe) unchanged after this fix — an unrecognized
*value* on an otherwise well-shaped `gate` object still reaches
`gateExitCode`'s default arm exactly as T50 left it; it is only the missing
or malformed *shape* that now short-circuits to the "no report" outcome one
level earlier.

### Consequence traced through both callers (the only two `readLatest` call sites in this file)

- `gate()` (`:187-199` before this change): `latest === null` already
  returns `{status:"fail", exitCode:1, reasons:["no report; run \`keryx
  health run\` first"]}`. No new branch added to `gate()` itself — it reuses
  the existing absent-report outcome, which is what "unusable evidence...
  rather than an exception escaping to the caller" asks for.
- `status()`: `latest?.gate.status ?? null` — with `latest` now `null`
  instead of a shape that would have thrown, this falls through to `gate:
  null`, the same value already returned for a genuinely absent report,
  instead of a `TypeError`. Not separately required by the dispatch but a
  direct, correct consequence of validating once at the function both
  callers share.

### Truth table

No `(status, strictWarn)` cell T50 pinned moved. This defect is entirely
about payloads that never reached that table before (no `gate` key; `gate`
as a bare array; `gate` as a string) because they threw, or returned
`status`/`reasons` as `undefined`, before the table was consulted. After the
fix all three collapse into the existing `null` → `{status:"fail",
exitCode:1}` path — not a new table cell, the same one "no report" already
used.

## Regression tests

### `src/commands/security-gate-exit.test.ts`

- Corrected the `enforced`-is-`ci`-only test (defect 2, above).
- Two new CLI-level tests in the `"security report — ci + stored
  needs-approval"` describe block:
  - `"the artifact cannot choose its own strictness: workspace ci + stored
    mode advisory + fail now refuses"` (defect 1) — workspace `ci`, stored
    `mode: "advisory"`, `gate: "fail"` → `exit === 1` (was `0`).
  - `"the inverse control: workspace advisory + stored mode ci + fail stays
    report-only"` — the live workspace mode governs in either direction, not
    only when it happens to be the stricter one.
- Updated the stale doc comment above `writeLatest` that described
  `report.mode` as driving the exit code (no longer true after defect 1).

### `src/health/service-gate-exit.test.ts`

Two new tests, writing raw `latest.json` fixtures directly (not through
`writeLatestGate`, which always writes a well-shaped `gate` object), through
the real `readLatest()` parse path:

- `"gate() treats a stored report with no gate key as unusable evidence, not
  a thrown error"` — a report with every field except `gate` →
  `{status:"fail", exitCode:1, reasons:["no report; run \`keryx health run\`
  first"]}`.
- `"gate() treats a stored report whose gate is a bare array as unusable
  evidence, not a thrown error"` — `gate: []` → same outcome.

### `src/commands/security.check-input.test.ts`

Read in full (owned focused test file per the dispatch). Contains no
reference to `reportExitCode`/`report.mode`/`handleReport` — confirmed with
`ctx rg` (zero matches) — so nothing in it encodes either security defect;
left unmodified.

### RED / GREEN

RED was established by direct quotation of the pre-edit source at each
call site (both `handleReport`'s exit-code line and `gate()`'s unguarded
`latest.gate.status`), read in full before any edit and reproduced verbatim
above — not by a git-state-changing revert-and-rerun, which the dispatch's
constraints prohibit ("no git state changes"). The supplementary probe
(`T55-verify-real-cli.ts`) and the reviewer's own probe (H6/H7/H8, S2's
`enforced` row) independently confirm the fixed behavior at the real
command/service surfaces. GREEN, full focused suite:

```
148 pass
0 fail
472 expect() calls
Ran 148 tests across 22 files.
```
(baseline before any of this task's edits, same command: 144 pass / 0 fail /
460 expect() — the +4 tests / +12 expect() are exactly the four new
regressions above; every pre-existing test in the run still passes.)

## Verification

| Check | Result | Raw log |
|---|---|---|
| Reviewer's probe `T39-exit.ts`, before | S2 `enforced` all-0; H6/H7 throw; H8 malformed-but-no-throw; S3 (see note above, unaffected by construction) | `.metaproject/data/gdctx/raw/T55-probe-before.log` |
| Reviewer's probe `T39-exit.ts`, after | S2 `enforced` matches `ci`; H6/H7/H8 all `{"status":"fail","exitCode":1,"reasons":["no report; run \`keryx health run\` first"]}`; S3 unchanged by construction (see note) | `.metaproject/data/gdctx/raw/T55-probe-after.log` |
| Supplementary probe `T55-verify-real-cli.ts` (defect 1, real CLI entry point) | `exitCode: 1` (was `0` under the pre-edit source quoted above) | run inline, see "Reviewer's probe" section above |
| This task's own regressions, before (baseline) | 144 pass / 0 fail / 460 expect() | `.metaproject/data/gdctx/raw/2026-09-06T16-01-00-960Z_run.log` |
| This task's own regressions, after | 148 pass / 0 fail / 472 expect() | `.metaproject/data/gdctx/raw/2026-09-06T16-02-44-894Z_run.log` and `2026-09-06T16-04-27-196Z_run.log` (re-run, identical) |
| `bun src/cli.ts ctx run -- bun test src/commands/security-gate-exit.test.ts src/commands/security.check-input.test.ts src/commands/security-recursive-scan.test.ts src/health/` | 148 pass / 0 fail / 472 expect() | `.metaproject/data/gdctx/raw/2026-09-06T16-04-27-196Z_run.log` |
| `bun run typecheck` | clean, no output, exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T16-04-06-640Z_run.log` |
| `bunx eslint src/commands/security.ts src/commands/security-gate-exit.test.ts src/health/service.ts src/health/service-gate-exit.test.ts` | clean, no output, exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T16-06-10-540Z_run.log` |

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC4 (AC-05) / AC8: no required failed or incomplete check is relabeled PASS at any surface including the process exit code; a strict mode accepts only a pass; an artifact under judgement cannot select the strictness applied to it. | met | Defect 1: `security report`'s exit code now sources mode from `modeOf(cwd)`, never `report.mode` — proven at the real CLI entry point (`T55-verify-real-cli.ts`: `exitCode 1`, was `0`). Defect 2: `reportExitCode`'s `enforced` arm now accepts only `pass`, matching `ci`. Defect 3: a health report with no usable `gate` shape is `{status:"fail", exitCode:1}`, never a thrown exception that could leave a caller treating an unhandled error as "skipped"/"unknown". |
| Policy (policies.md): FAIL on an established threshold violation; INCOMPLETE when a required check is missing/skipped/unparsed/unfinished; strict CI accepts only PASS; optional skip warns and is never signed as passed; messages stay constant and leak-safe. | met | `isPassGate`/`gateExitCode` (unchanged, already exhaustive per T38/T50) still enforce FAIL/INCOMPLETE/PASS exactly as before. Both strict security modes (`ci`, `enforced`) now accept only PASS via `reportExitCode`. The health "unusable evidence" reason (`"no report; run \`keryx health run\` first"`) is the pre-existing constant, leak-safe string — no new interpolation, no path, no source bytes. |
| Regressions fail before the change and pass after, covering: a stored report whose recorded mode is more permissive than the workspace's, the enforced arm on a failing and on an incomplete gate, and a stored report with no gate key. Everything the previous rewrites closed stays closed; the recognized-value truth tables do not move except where this task deliberately changes them, and each change is stated. | met | Four new regression tests cover exactly those three scenarios plus the `gate: []` shape variant. Every pre-existing test in the four owned/read focused files (144 of them) still passes unmodified except the one corrected assertion (defect 2), whose correction is justified above. Both truth-table changes (defect 2's `enforced` rows; nothing else) are stated explicitly with before/after tables. |

## Concerns

None found specific to these three fixes. Two things worth naming for the
orchestrator, not left as silent gaps:

1. **T39-exit.ts's S3 row will keep reading `cliExitCode: 0` forever**,
   because it calls `reportExitCode(report.gate, report.mode)` directly
   rather than through `handleReport`. This is not a regression in the
   probe or in the fix — it is testing a different (and now non-existent)
   code path. Documented above and backed by a supplementary probe that
   drives the real entry point. If a future round wants the reviewer's own
   probe to demonstrate this fix directly, S3 would need to call
   `securityCommand`/`handleReport` instead of `reportExitCode` — a change
   to a reviewer artifact this task does not own and was not asked to make.
2. **`status()` in `src/health/service.ts` also benefits from this fix**
   (a malformed report no longer throws there either) as a direct
   consequence of guarding at the shared `readLatest`, not as separately
   requested scope — noted so it is not mistaken for an untested new
   behavior; it was not given its own regression test since the dispatch's
   named surface was `gate()`, and `status()`'s existing tests (unmodified,
   out of this task's ownership boundary for new coverage) do not exercise
   a malformed fixture.

## Changed files

- `src/commands/security.ts` — `handleReport` now sources its exit-code
  mode from `await modeOf(cwd)` instead of `report.mode` (defect 1);
  `reportExitCode` now treats `ci`/`enforced` identically, accepting only
  `pass` in both (defect 2); both doc comments rewritten to describe the
  fixed behavior and cross-reference T39 F-003 / Judgement call #2 instead
  of describing the pre-fix asymmetry as intentional.
- `src/commands/security-gate-exit.test.ts` — corrected the one assertion
  that encoded defect 2 as intentional; added two new CLI-level regressions
  for defect 1 (mismatched mode, both directions); updated a stale doc
  comment. No test deleted or weakened.
- `src/health/service.ts` — new private `hasGateShape` predicate; `readLatest`
  now returns `null` (not a value that would throw downstream) for a
  malformed report at both of its return points (defect 3).
- `src/health/service-gate-exit.test.ts` — two new regressions: no `gate`
  key, and `gate` as a bare array, both now the module's existing "no
  report" outcome instead of a thrown `TypeError`.
- `.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T55-spec.md` —
  written before coding.
- `.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T55-verify-real-cli.ts` —
  new supplementary probe (read-only against production code, `mkdtemp`
  fixture, removed in `finally`) driving the real `securityCommand` entry
  point for defect 1, since the reviewer's own probe does not.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact files,
functions and findings to fix; F-003/F-004 and the two prior implementation
reports named every call site directly, no discovery or blast-radius
question arose); wiki_used: no (not-relevant — the normative sources are
policies.md and the frozen acceptance-criteria.md, both supplied directly
by the dispatch and read at the cited sections); ctx_used: yes (every code
search via `bun src/cli.ts ctx rg`, every test/typecheck/eslint run via
`bun src/cli.ts ctx run`, raw logs cited above by path); raw_rg_used: no —
no bare `rg`/`grep`/`cat`/`find` was run; every search went through `keryx
ctx rg`, every command through `keryx ctx run`, and file excerpts were read
with the Read tool's offset/limit rather than `sed -n`.`
