# T55 spec — three defects T39 found beyond T38/T50's exhaustive-mapping rewrites

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned
files only: `src/commands/security.ts` (+ its focused tests
`src/commands/security-gate-exit.test.ts`, `src/commands/security.check-input.test.ts`),
`src/health/service.ts` (+ its focused test `src/health/service-gate-exit.test.ts`).
`src/security/config.ts`, `src/security/guard.ts`, `src/security/detect/exfil.ts`
are owned by concurrent workers this round — read-only if at all, never edited.

Source findings: `T39-review.md` F-003, F-004, and "Judgement calls" #2
(the `reportExitCode` asymmetry ruling).

## Defect 1 (F-003, major) — `security report`'s exit code trusts the artifact's own `mode`

**Current**: `handleReport` (`src/commands/security.ts:558`) calls
`reportExitCode(report.gate, report.mode)`. `report.mode` comes from
`runReport` → `readLatestReport`, which is the *stored* `latest.json` —
`hasRecognizedGate` (`src/security/service.ts:216`) validates only `gate`,
never `mode`. Every other exit-code call site in this file
(`:250`, `:515`) sources mode from `await modeOf(cwd)` (→
`loadSecurityConfig`, the workspace's own config file). `security report`
is the odd one out.

**Two candidate fixes, as the dispatch asks to weigh**:

(a) Source the mode from the workspace (`await modeOf(cwd)`) instead of the
    artifact, matching `:250`/`:515`.
(b) Validate `report.mode` as strictly as `report.gate` (extend
    `hasRecognizedGate`'s shape check to `mode ∈ SecurityMode`), and keep
    reading it from the artifact.

**Decision: (a).** (b) only rejects *garbage* mode values (a string outside
the four); it does nothing about a mode that is a perfectly *valid* value
that is simply stale or attacker-chosen — the exact scenario the dispatch
names ("a stored report records an advisory mode and a failing gate" while
the workspace is `ci`). `"advisory"` passes any shape/enum check `hasRecognizedGate`
could apply, so (b) alone leaves the reported defect open. (a) removes the
trust boundary entirely: the strictness a stored artifact is judged by comes
from the same place every sibling call site in this file already gets it —
the live workspace configuration, which the artifact under judgement cannot
write. This is also the reviewer's own suggested fix and requires no new
validation machinery.

Keep printing `report.mode` in both the JSON and human output (`:546`,
`:551`) unchanged — that is the artifact's own provenance field, a
different question ("what did the scan that produced this record believe
its mode was") from "what exit code should this CLI invocation return",
which is the workspace's live posture.

**class_scope**: only `src/commands/security.ts:558`, the one call site
`report.mode` reaches for an exit-code decision. `:546`/`:551` (display)
are unaffected — display is not a judgement.

## Defect 2 (F-003, major; T39 "Judgement calls" #2) — `reportExitCode`'s `enforced` arm is more permissive than `ci`

**Current**:
```ts
export function reportExitCode(gate: string, mode: string): number {
  return mode === "ci" && !isPassGate(gate) ? 1 : 0;
}
```
`enforced` always returns 0 regardless of gate. T38 disclosed this as a
deliberate, literal reproduction of F-002's suggested fix and scoped it to
`ci`-only. T39 measured the consequence directly (S2:
`reportExitCode(gate, "enforced")` is 0 for `fail`, `needs-approval` AND
`incomplete`, not only the disclosed `needs-approval` residual) and ruled
in "Judgement calls" #2 that the asymmetry must close: `security report` in
`enforced` must not be the only place in the codebase where `enforced` is
more permissive than `ci`. This is a dispatch-mandated ruling to implement,
not a re-litigation.

**Fix**: make the two strict modes symmetric, mirroring `exitCodeFor`
(`:853-858`) exactly:
```ts
export function reportExitCode(gate: string, mode: string): number {
  if (mode === "ci" || mode === "enforced") {
    return isPassGate(gate) ? 0 : 1;
  }
  return 0;
}
```
`advisory`/`gateway` stay untouched (return 0 for every gate — the §11
report-only invariant, already a control in the existing test file).

**class_scope**: `src/commands/security.ts:575` (`reportExitCode`) only.
`isPassGate` and `exitCodeFor` are unchanged — `exitCodeFor` already treats
`ci`/`enforced` identically (T38); this defect was `reportExitCode` alone.

**What changes in the recognized-value truth table (must be stated, per the
dispatch)**: `reportExitCode(gate, "enforced")` for `fail`, `needs-approval`,
`incomplete` — 0 → 1. `reportExitCode(gate, "enforced")` for `pass` — 0 → 0
(unchanged). Every `ci` row and every `advisory` row — unchanged. This is
the one truth-table cell class this task deliberately moves; everything
else pins the existing table.

**Existing test to correct (not delete/weaken)**:
`src/commands/security-gate-exit.test.ts:91-99`, the test titled `"enforced:
unchanged — security report's strict check is ci-only, per T35 F-002's own
suggested fix"`. This test asserts the exact behavior T39 ruled must close.
Per the constraint "if a committed expectation encodes a defect, correct it
and justify the change in writing" — rewritten to assert `enforced` now
matches `ci` (pass → 0, every other recognized value → 1, unrecognized value
→ 1), with a comment recording why the assertion flipped (T39 F-003 /
Judgement call #2) instead of silently inverting it.

## Defect 3 (F-004, minor) — `readLatest`'s cast guards the gate *value*, not its *shape*

**Current**: `src/health/service.ts:36`,
`JSON.parse(...) as HealthReport & { record?: string }`, then `gate()`
(`:196`) does `const status = latest.gate.status;` unguarded. T50 closed the
*value* hole (an unrecognized `status` string now exits 1 via
`gateExitCode`'s default arm) but a `latest.json` with no `gate` key at all,
or `gate` as a bare array/string, still throws a raw `TypeError` out of
`gate()` — an unhandled exception at an agent-visible seam
(`keryx health gate`, the `health.gate` MCP tool), instead of the module's
own "no report; run `keryx health run` first" refusal that already exists
for the *absent-file* case one branch up.

**Fix, matching the shape already used on the security side**
(`hasRecognizedGate` / `readLatestReport` in `src/security/service.ts:216-237`):
add a private shape predicate and apply it at the single choke point that
already turns "no usable evidence" into the constant refusal
(`gate()`'s `if (!latest)` branch), by having `readLatest` itself return
`null` for a malformed shape instead of a value `gate()` cannot use safely:

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
`GateStatus` values — that is `gateExitCode`'s job (T50), already exhaustive
with a blocking default arm once the shape is sound. This predicate answers
a narrower, prior question: is this the object shape `gate()`/`status()`
can read at all without throwing. Same narrowing discipline the security
side's `hasRecognizedGate` already documents for the identical problem.

Applied inside `readLatest`, both at the direct-payload return and at the
`record`-pointer indirection's return, so a malformed report reached either
way is treated identically:

```diff
     if (typeof latest.record === "string") {
       ...
-      return JSON.parse(await readFile(recordFile, "utf8")) as HealthReport;
+      const recorded = JSON.parse(await readFile(recordFile, "utf8")) as HealthReport;
+      return hasGateShape(recorded) ? recorded : null;
     }
-    return latest;
+    return hasGateShape(latest) ? latest : null;
```

**Consequence, traced through both callers** (the only two `readLatest`
call sites in this file):

- `gate()` (`:187-199`): `latest === null` already returns
  `{status:"fail", exitCode:1, reasons:["no report; run \`keryx health run\`
  first"]}` — the exact "unusable evidence" outcome the dispatch asks for,
  reused rather than duplicated. No new message, no new branch in `gate()`
  itself.
- `status()` (`:161-185`): `latest?.gate.status ?? null` — with `latest`
  now `null` instead of a shape that would have thrown, this correctly
  falls through to `gate: null` (the same value it already returns for "no
  report at all"), rather than a `TypeError`. Not separately required by
  the dispatch, but a direct and correct consequence of validating at the
  one function both callers share, not two independent guards.

**class_scope**: `src/health/service.ts`'s `readLatest` only. `computeGate`
(`./gate.ts`) is untouched — it only ever produces the sound shape in
process, per T50's own reachability finding. `gateExitCode` is untouched —
T50 already closed the value axis; this closes the shape axis one level
above it.

**What changes in the recognized-value truth table**: none. Every
`(status, strictWarn)` cell T50 pinned is untouched — this defect is
entirely about payloads that never reach that table today (`H6`: no `gate`
key; `H7`: bare array; `H8`: `gate` as a string) because they throw or
return a value with `status`/`reasons` `undefined` before the table is
consulted. After the fix all three collapse into the existing `null` →
`{status:"fail", exitCode:1}` path, not a new table cell.

**New regression tests** (`src/health/service-gate-exit.test.ts`, this
task's focused file per T50's precedent): a `latest.json` with no `gate`
key, and one where `gate` is a bare array — both must produce
`{status:"fail", exitCode:1, reasons:["no report; run \`keryx health run\`
first"]}` from `service.gate({cwd})`, not a thrown error.

## Verification plan

1. Reviewer's probe (`T39-exit.ts`) before/after — S3 (defect 1), S2's
   `enforced` row (defect 2), H6/H7/H8 (defect 3).
2. This task's own regressions before/after in the two focused test files.
3. `bun src/cli.ts ctx run -- bun test src/commands/security-gate-exit.test.ts
   src/commands/security.check-input.test.ts
   src/commands/security-recursive-scan.test.ts src/health/`
4. `bun run typecheck`.
5. `bunx eslint` on every changed file.
6. `T55-implementation.md`, `T55-result.json` (validated against
   `subagent-result` schema).
