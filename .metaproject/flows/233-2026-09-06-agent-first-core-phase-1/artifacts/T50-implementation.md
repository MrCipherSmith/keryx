# T50 implementation — close `src/health/service.ts`'s `gate()` exit-code denylist

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned
files only: `src/health/service.ts`, new `src/health/service-gate-exit.test.ts`.
`src/health/types.ts`, `src/health/gate.ts`, and `src/commands/health.ts`
were read only (for the sibling style and the vocabulary), never edited.
Nothing under `src/security/` or `src/flow/` was touched. Spec written
before coding: `T50-spec.md` (same directory).

All raw logs below are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## My own verification of the reported site (not taken on trust)

T48's Concerns section named `src/health/service.ts`'s `gate()` method
(`:132-149` at the time it was read) as a sixth instance of the same
denylist shape. I re-derived this myself rather than repeating the claim:

1. Read `gate()` in the current file (`src/health/service.ts:132-149`
   before this change):
   ```ts
   async gate(input: HealthGateInput): Promise<HealthGateResult> {
     const latest = await readLatest(input.cwd);
     if (!latest) {
       return { status: "fail", exitCode: 1, reasons: [...] };
     }
     const status = latest.gate.status;
     const exitCode =
       status === "fail" ||
       status === "incomplete" ||
       (status === "warn" && input.strictWarn)
         ? 1
         : 0;
     return { status, exitCode, reasons: latest.gate.reasons };
   },
   ```
2. Traced where `status` comes from: `latest = await readLatest(input.cwd)`,
   and `readLatest` (`service.ts:29-51`) does
   `JSON.parse(await readFile(file, "utf8")) as HealthReport & { record?: string }`
   — an **unchecked type assertion** over a file on disk
   (`.metaproject/data/health/artifacts/latest.json`, or its `record`
   pointer target). Nothing validates the parsed JSON against the
   `GateStatus` union at runtime.
3. Confirmed this is a genuine runtime seam, not a type-only concern, by
   using the same fixture technique the *existing* test suite already
   relies on for this exact method: `src/commands/health-incomplete.test.ts`
   hand-writes `latest.json` (`writeLatest`/`incompleteReport`) and calls
   `createCodeHealthService().gate({ cwd })` against it. I wrote an
   equivalent fixture with `gate.status: "banana"` (my
   `service-gate-exit.test.ts`, case 4) and it reached `gate()`'s `status`
   variable unchanged and unvalidated — proving reachability, not assuming
   it.
4. Ran the new test suite **before** touching `service.ts`: the
   unrecognized-value case failed exactly as predicted —
   `service.gate({ cwd: root })` for `status: "banana"` returned
   `exitCode: 0`, not `1` (RED run below). Every other case (pass control,
   fail, incomplete, warn at both `strictWarn` settings) already passed —
   confirming those five arms were already correct and this is precisely
   the sixth-instance fallthrough, nothing more, nothing less.

**Conclusion: the reported defect is real and reachable with an
unenumerated value** — a hand-edited, corrupted, or older/newer-schema
`latest.json` produces a `status` string outside `"pass" | "warn" |
"incomplete" | "fail"`, and the pre-fix fold silently gave it exit code
`0`, indistinguishable from a genuine `pass`. I changed the code.

## The value enumeration and its method

Same closed vocabulary as T48 documented for `src/commands/health.ts`'s
`runExitCode`, re-confirmed here by reading `src/health/gate.ts` directly
rather than trusting the prior report: `GateStatus` (`src/health/types.ts:132`)
is `"pass" | "warn" | "incomplete" | "fail"`, produced exclusively by
`computeGate` when a report is freshly generated in-process. `gate()`,
however, does not consume a freshly generated report — it reads whatever
was last written to disk, which is the boundary where the closed type
stops being enforced.

- `fail` — an established threshold violation. Blocks always.
- `incomplete` — a required source that is unavailable, failed to execute,
  or failed/never attempted to parse. Blocks always, independent of
  `strictWarn`.
- `warn` — a regression between the warn/fail thresholds, coverage below
  the soft floor, or an optional source that is configured but failed.
  Blocks only when `strictWarn` is set.
- `pass` — none of the above triggered. Never blocks.

A skipped **optional** source never becomes a `GateStatus` value of its
own — it only appends an `OPTIONAL: ... skipped` reason string while
`status` can stay `pass`. This fix touches only the `exitCode` fold, not
`status` or `reasons`, so that distinction is unaffected.

## The fix

`src/health/service.ts` — the type-only import from `./types` gained
`GateStatus`:

```diff
 import type {
   CodeHealthService,
+  GateStatus,
   HealthBaselineInput,
```

A new exported helper, `gateExitCode`, placed above
`createCodeHealthService` — an exhaustive `switch` over `GateStatus` with
the default arm on the blocking side:

```ts
export function gateExitCode(status: GateStatus, strictWarn: boolean): number {
  switch (status) {
    case "pass":
      return 0;
    case "warn":
      return strictWarn ? 1 : 0;
    case "fail":
    case "incomplete":
      return 1;
    default:
      return 1;
  }
}
```

`gate()`'s body now delegates to it instead of the denylist:

```diff
       const status = latest.gate.status;
-      const exitCode =
-        status === "fail" ||
-        status === "incomplete" ||
-        (status === "warn" && input.strictWarn)
-          ? 1
-          : 0;
+      const exitCode = gateExitCode(status, Boolean(input.strictWarn));
       return { status, exitCode, reasons: latest.gate.reasons };
```

`status` itself — the field returned to every caller
(`src/mcp/tools.ts:641`, `src/commands/flow.ts:118`,
`src/harness/tool/metaproject-adapter.ts:112`, `src/commands/health.ts`'s
`runGate`) — is an unchanged pass-through of `latest.gate.status`; only the
`exitCode` fold changed. This mirrors `runExitCode`
(`src/commands/health.ts`), `isPassGate` (`src/commands/security.ts`), the
switch in `runGate` (`src/security/service.ts`) and `securityFlowGate`
(`src/security/guard.ts`) in *shape* only — health keeps its own
`GateStatus` vocabulary, not `SecurityGate`; no cross-module import was
added.

### Truth table — every recognized value is byte-identical to before

| `status` | `strictWarn` | old (denylist) | new (switch) | changed? |
|---|---|---|---|---|
| `pass` | false | 0 | 0 | no |
| `pass` | true | 0 | 0 | no |
| `warn` | false | 0 | 0 | no |
| `warn` | true | 1 | 1 | no |
| `incomplete` | false | 1 | 1 | no |
| `incomplete` | true | 1 | 1 | no |
| `fail` | false | 1 | 1 | no |
| `fail` | true | 1 | 1 | no |
| unrecognized (`"banana"`) | false | 0 | **1** | **yes — the fix** |
| unrecognized (`"banana"`) | true | 0 | **1** | **yes — the fix** |

Only the previously-reachable-but-unenumerated fallthrough changes.

## Regression tests

### New file: `src/health/service-gate-exit.test.ts`

Four tests, calling `createCodeHealthService().gate()` directly against
hand-written `latest.json` fixtures — the same seam
`health-incomplete.test.ts` already exercises for this method, kept under
`src/health/` per this task's ownership (no import from `src/commands/`):

1. `pass` control at both `strictWarn` settings — stays `status: "pass"`,
   `exitCode: 0`.
2. `fail` and `incomplete`, each at both `strictWarn` settings — blocks
   unconditionally (`exitCode: 1`), independent of `strictWarn`.
3. `warn` — `strictWarn` absent: `exitCode: 0`, `status` stays `"warn"`
   (asserted `not.toBe("pass")`, so "never signed as passed" is checked on
   the field a consumer would branch on, not inferred only from the exit
   code); `strictWarn: true`: `exitCode: 1`.
4. Unrecognized/corrupted `status` (`"banana"`, written straight into the
   fixture JSON and read back through the real `readLatest()` parse path —
   no `as unknown as GateStatus` cast needed, since this seam is a JSON
   file on disk rather than an in-process value): `exitCode: 1` at both
   `strictWarn` settings, and `status` asserted `not.toBe("pass")`.

RED (before the fix, fixtures and assertions already in place, only
`service.ts` still had the denylist):

```
3 pass
1 fail
14 expect() calls
```
Raw: `2026-09-06T15-23-35-145Z_run.log`. The one failure was the predicted
inversion: the unrecognized-value case's `exitCode` was `0`, not `1`,
exactly matching this report's truth-table prediction. The three other
tests (pass control, fail/incomplete, warn) already passed — the five
already-correct arms were, in fact, already correct.

GREEN (after adding `gateExitCode` and wiring `gate()` to it):

```
4 pass
0 fail
17 expect() calls
```
Raw: `2026-09-06T15-23-57-657Z_run.log`.

### No existing test encoded the bug

`src/commands/health-incomplete.test.ts` (read in full, out of this
task's ownership so left untouched) exercises `gate()` only through
already-correct recognized-value paths (`incomplete` unconditionally,
`warn` at both `strictWarn` settings) — no assertion described the
fallthrough as intentional, so nothing needed correcting, only extending
in a new file.

## Verification

New regression file alone, GREEN: 4 pass / 0 fail / 17 expect() (raw
`2026-09-06T15-23-57-657Z_run.log`, above).

Full `src/health/` module suite (19 files — 18 pre-existing, unmodified,
plus the new file):

```
90 pass
0 fail
273 expect() calls
```
Raw: `2026-09-06T15-24-05-649Z_run.log`. Confirms every other health
source/scoring/gate/report test, and the health parser/coverage repair
this flow already landed, are untouched.

Out-of-ownership sibling coverage that depends on this same `gate()`
method, read-only-verified to still pass (not modified):

```
9 pass
0 fail
26 expect() calls
```
`src/commands/health-incomplete.test.ts` + `src/commands/health-gate-exit.test.ts`.
Raw: `2026-09-06T15-24-10-048Z_run.log`.

`bun run typecheck` (`tsc --noEmit`): clean, no output, exit 0. Raw:
`2026-09-06T15-24-21-815Z_run.log`.

`bunx eslint src/health/service.ts src/health/service-gate-exit.test.ts`:
clean, no output, exit 0. Raw: `2026-09-06T15-24-26-360Z_run.log`.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC4 / AFC-05: fixtures, a corrupted payload, a skipped required check and an incomplete area each produce the expected outcome, and violations are not lost when another check is unavailable. | met | `incomplete` (required-source-unavailable) and `fail` block unconditionally before and after this fix, pinned in the truth table and the unmodified `health-incomplete.test.ts` (still green). The new "corrupted payload" case — a `latest.json` with an unrecognized `gate.status` string, exactly AFC-05's "corrupted payload" — now blocks (`exitCode: 1`) instead of silently passing; this is the specific gap this task closed. |
| No health gate value that should block is treated as a pass by this method; the default arm blocks; an optional skip still warns and is never signed as passed. | met | `gateExitCode`'s `switch` is exhaustive with `default: return 1`. Truth table: all four recognized values byte-identical to before; the unrecognized-value case inverts 0 -> 1 at both `strictWarn` settings. `skippedOptional` never sets `GateStatus` in `computeGate` (traced in `gate.ts`, read-only) so optional-skip warnings are untouched by this exit-code-only change; `warn`'s own `status` field stays `"warn"` (never `"pass"`), asserted directly in the new test. |
| Regressions fail before the change and pass after; the health suites stay green and no currently passing invocation stops passing. | met | RED 3/1/14 -> GREEN 4/0/17 (`service-gate-exit.test.ts`, both raw logs above). Full `src/health/` suite 90/0/273 (19 files). Out-of-ownership sibling tests that call this same `gate()` method (`src/commands/health-incomplete.test.ts`, `src/commands/health-gate-exit.test.ts`) still 9/0/26, unmodified. `bun run typecheck` and `bunx eslint` both clean on every file this task touched. |

## Concerns

None found specific to this fix. For completeness: the three other
`.gate()` call sites that consume this method's `exitCode`
(`src/mcp/tools.ts:641`, `src/commands/flow.ts:118`,
`src/harness/tool/metaproject-adapter.ts:112`) were read (not edited, out
of this task's scope) to confirm none of them depend on the old
fallthrough returning `0` for an unrecognized value — each treats a
nonzero `exitCode` as "block"/"not clean", so the fix strengthens their
behavior rather than surprising them. No further sibling instances of this
shape were found while reading `gate()`'s neighbors in `service.ts`
(`status`, `sources`, `explain`, `updateBaseline` do not fold a `GateStatus`
into a boolean/exit code at all).

## Changed files

- `src/health/service.ts` — added `GateStatus` to the type-only import
  from `./types`; added exported `gateExitCode(status, strictWarn)`, an
  exhaustive `switch` over `GateStatus` with the default arm blocking,
  documented with a doc comment explaining the fix and cross-referencing
  the four sibling exhaustive folds by shape only (no shared
  vocabulary/import); `gate()`'s `exitCode` computation now delegates to
  it instead of the inline denylist.
- `src/health/service-gate-exit.test.ts` — new file, 4 tests / 17
  `expect()` calls: pass control, `fail`/`incomplete` unconditional
  blocking, `warn` at both `strictWarn` settings (including a `status`
  assertion that it is never relabeled `pass`), and the unrecognized-value
  default arm exercised through a real on-disk fixture.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file and
method, `gate()` in `src/health/service.ts`, carried forward from T48's
own reported finding; no discovery or blast-radius question arose beyond
reading the three other call sites of this method, done directly);
wiki_used: no (not-relevant — the normative source is policies.md,
supplied directly by the dispatch and read in full at the cited section,
"Health и security gate"); ctx_used: yes (every code search via `bun
src/cli.ts ctx rg`, every test/typecheck/eslint run via `bun src/cli.ts
ctx run`, all raw logs cited above by path); raw_rg_used: no — no bare
`rg`/`grep`/`find`/`cat` was run; every search and read went through
`keryx ctx rg`/`keryx ctx run` or the Read tool, and no raw-log read
needed a `# keryx:raw` escape (all `ctx run`/`ctx rg` summaries were small
enough to read compacted).`
