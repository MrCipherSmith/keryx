# T54 spec — validate the security `mode` where it is loaded, and narrow the manifest widening

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`).
Written before any code change. Findings: `T39-review.md` F-002 (major), F-005
(minor), F-008 (info), plus `T42-review.md` T42#F-004 (doc defect).

Owned files: `src/security/config.ts`, `src/security/guard.ts`,
`src/security/guard.test.ts`; additive only in `src/security/types.ts` /
`src/security/schemas.ts` if a type genuinely requires it. Everything else is
read-only, including `src/security/service.ts`, `src/security/self-protect.ts`,
`src/commands/security.ts`, `src/health/service.ts`, `src/flow/service.ts`.

## Measured starting state (reviewer's own probe, unmodified)

`bun .metaproject/flows/233-…/artifacts/T39-posture.ts`, raw
`.metaproject/data/gdctx/raw/2026-09-06T15-51-47-000Z_run.log`:

| Row | Payload | Today |
|---|---|---|
| B11 | `{"mode":"bananas"}` | `cfgMode "bananas"`, `guardAllowed true` with `guardGate "fail"`, flow gate `{"status":"pass","detail":"security bananas: informational (advisory does not block)"}` |
| B12 | `{"mode":"ENFORCED"}` | same, detail `security ENFORCED: informational …` |
| B13 | `{"mode":"enforced "}` | same |
| B15 / B16 | `{"mode":42}` / `{"mode":true}` | same, `cfgMode` is the raw `42` / `true` |
| B14 | `{"mode":null}` | `cfgMode "advisory"` (the `??` in `mergeSecurityConfig` treats `null` as "not specified") |
| A8 / A9 | `{}` / `{"name":"demo"}` | **blocks**: `guardAllowed false`, gate `fail`, reason "security posture unavailable…" |
| A17 | `{"__proto__":{"modules":{…}}}` | blocks (it is an object whose **own** `modules` key is absent) |
| A1 / A7 / A18 | absent / unparseable / empty manifest | absent → allowed + gate `null`; unparseable and empty → block |
| B7 | `{}` config | advisory, allowed, informational `pass` |

## Defect 1 (major) — an unrecognized `mode` resolves to report-only

`SecurityMode` is closed (`types.ts:93`) and the shipped schema enumerates it
(`schemas.ts:139`), but `loadSecurityConfig` never validates the field and
`isBlockingMode` (`guard.ts:181`) is a two-value allowlist whose fallthrough is
the permissive side. `self-protect.ts:88`'s `MODE_RANK[config.mode]` is
`undefined` for an unrecognized mode, so the downgrade check is blind to it too.

**Change A — `src/security/config.ts`.** After the mergeable-payload check that
T37 added, validate the mode and reuse T37's existing forced-closed shape:

- `isSecurityMode(value)`: `typeof value === "string"` and one of
  `advisory | enforced | ci | gateway` (the same four the schema enumerates).
- In `loadSecurityConfig`, the mode that must be recognized is the one the file
  **declares**: `parsed.mode` when the key is present, otherwise the merged
  (default) mode. `undefined` is "no mode configured" — the ordinary case a bare
  `{}` produces, which must stay `advisory` (B7 / `T37 D2c`).
- An unrecognized declared mode returns `{ ...merged, mode: "enforced",
  configUnreadable: true }` — the merged config, not the bare defaults, because
  everything except the mode parsed fine and the user's `policies` (and the
  `configChecksum` that §14 tamper detection verifies against them) are still
  the operator's own. No new reason string, no new branch in the consumers: the
  existing `configUnreadable` branches in `guardOutput` (`guard.ts:244`) and
  `securityFlowGate` (`:376`) already fail closed and are already leak-safe.

`mergeSecurityConfig` is **not** changed: it is exported and called elsewhere
with already-trusted input, and T37 deliberately put the file-shape decision in
`loadSecurityConfig`, the only reader of `security.config.json`.

Deliberate call on `{"mode":null}` (B14): the key is **present** and its value is
not a mode, so it is the same class as `42` and `true` and is forced closed.
This moves B14's measured verdict (advisory → blocked). It is a strict-direction
move, it is not in the protected set the dispatch names (non-object manifest and
config shapes, absent manifest, absent config, legitimate empty config), and
leaving it out would leave a 4-byte edit — `"enforced"` → `null` — as a way past
the very check this task adds. Disclosed as a deliberate widening.

**Change B — `src/security/guard.ts`.** `isBlockingMode` becomes an exhaustive
switch over the four modes with the default arm on the **blocking** side, the
same shape as `securityFlowGate`'s gate switch (`:400-409`), `isPassGate`
(`commands/security.ts`), `runGate` (`security/service.ts`) and `gateExitCode`
(`health/service.ts`). Defence in depth: after Change A an unrecognized mode
never reaches it, but a fifth mode added to the union later must not inherit
"does not block" by omission.

Acceptance: an unrecognized mode is never more permissive than `enforced`, the
strictest recognized mode.

## Defect 2 (minor) — the manifest guard blocks a manifest that merely has no `modules`

`resolveManifestSecurityState` (`guard.ts:157-160`) returns
`manifestUnreadable: true` when `modules` is **absent**, not only when it is
present and unusable.

**Determination: align with the rest of the repository — absent `modules` means
the module is disabled, not that the manifest is unreadable.** Reasons:

1. Every other manifest reader in the repo reads it that way
   (`capability/seam.ts:70`, `commands/ctx.ts:131`, `testing/capability.ts:26`,
   `gdskills/project-skills.ts:664,681`, `gdskills/export.ts:199`).
2. It is not the shape T37 argued for. T37's disclosure covers non-object
   manifest *bodies*; a well-formed object with no `modules` key is readable, and
   what it says is "no modules are configured".
3. Today's behaviour is internally inverted: an **absent** manifest is
   non-blocking (A1) while a **present, well-formed, empty** one blocks (A8) —
   strictly more information producing a strictly harsher verdict.
4. The security path does not need to differ here, because nothing is lost:
   "module disabled" is exactly what the operator gets by writing
   `{"modules":{}}` (A14) or `{"modules":{"security":{"enabled":false}}}` (A15),
   both non-blocking today and untouched. Absent `modules` grants no capability
   an attacker did not already have with a two-byte edit.

**Change C — `src/security/guard.ts`.** In `resolveManifestSecurityState`:
`modules === undefined` → `{ enabled: false, manifestUnreadable: false }`;
`modules` present but not a plain object → `manifestUnreadable: true` (unchanged).

**Change D — `src/security/guard.ts`, required by Change C.** Today a manifest
that exists but does not *parse* reaches the blocking branch only because
`readJsonFileOr(manifestPath, {})`'s fallback `{}` happens to have no `modules`
key — an accident of the fallback value, not a guard. Once absent `modules` stops
blocking, that accident would silently un-block A7 (unparseable), A18 (empty file)
and A19 (whitespace), which the reviewer verified as closed and which must not
move. So the manifest reader adopts the sentinel `loadSecurityConfig` already
uses: a module-local `Symbol` fallback, `=== MANIFEST_UNREADABLE` →
`manifestUnreadable: true`. This makes "did not parse" explicit instead of
inferred.

Consequence to disclose: A17 (`{"__proto__":{"modules":{…}}}`) moves from
blocking to `enabled:false` (non-blocking). `JSON.parse` gives that payload an
**own** `__proto__` data property and does not touch the prototype chain, so the
object's own `modules` is absent — it is exactly the F-005 shape and the
narrowing necessarily covers it. The property the reviewer actually checked is
preserved and pinned by a new test: no enablement is inherited from the payload
and `Object.prototype.modules` stays `undefined`.

## Defect 3 (info) — a forced posture is persisted as if it were the configured mode

`src/security/service.ts:95` does `await writeState(cwd, currentState(config))`
unconditionally, and `currentState` (`src/security/self-protect.ts:39`) reads
`config.mode`. With T37's repair — and, after Change A, with a typo'd mode too —
a run against an unusable config records `mode: "enforced"` in
`.metaproject/data/security/raw/state.json`; repairing the config to `advisory`
then trips `MODE_RANK[config.mode] < MODE_RANK[previous.mode]`
(`self-protect.ts:88`) and raises a `mode-downgrade` incident for a downgrade
that never happened.

Every place that can close it is outside this task's ownership: the write
(`service.ts:95`), the state materializer (`self-protect.ts:39`) and the rank
comparison (`self-protect.ts:88`). `loadSecurityConfig` cannot decline to be
persisted — `currentState` reads only `mode` and `policies`, and dropping the
forced `enforced` from the returned object is exactly the fail-open T37 closed
(and would move the reviewer's C1 verdict, `unreadable config → enforced →
CLI exit 1`).

**Plan: implement the in-scope half and name the out-of-scope half exactly.**
`configUnreadable` — the flag the dispatch points at — is already on the returned
config and is what a caller checks; this task documents the one-line guard the
owning task must add (`if (!config.configUnreadable) await writeState(cwd,
currentState(config));` at `service.ts:95`) and adds no partial or fake fix.
Reported as a concern with the exact change, not as a task-level block, because
defect 1 (major) and defect 2 are fully in scope and blocking the whole dispatch
on an informational finding would leave the major open.

## Doc defect (T42#F-004) — `prepareOutputForPersistence`'s three-way claim

`guard.ts:53-74` claims the return lets a caller tell apart three shapes of an
allowed result via `redaction`. Not true end to end: `guardOutput` already ran
`validateSerializedOutput` and stored the cleaned text in `guard.redacted`, so
the materializer's second pass finds nothing and reports `state:"none"` for
masked content and for a dropped duplicate alike. Rewrite the paragraph to state
the two-pass architecture: `redaction` describes the **second** pass (`none` on
the `guardOutput` path), `bytesPreserved` is the reliable "did anything change"
signal because it compares against the caller's `original`, and "what changed and
why" comes from `guard.decision.findings`. Comment only; no behaviour change.

## Regressions (RED first, in `src/security/guard.test.ts`)

| Test | Asserts | Fails before because |
|---|---|---|
| `T54 D1: an unrecognized mode string is never more permissive than the strictest recognized mode` | `{"mode":"bananas"}` and `{"mode":"ENFORCED"}`: `loadSecurityConfig` → `mode "enforced"` + `configUnreadable true`; `guardOutput` blocked with the constant reason; `securityFlowGate` → `fail`; leak-safe | today `mode` is the raw string, the write is allowed and the gate is an informational `pass` |
| `T54 D1b: a recognized mode in the wrong case or with stray whitespace is not that mode` | `"ENFORCED"`, `"Ci"`, `"enforced "`, `" ci"` all forced closed | same |
| `T54 D1c: a non-string mode is forced closed, and a mode key that is absent is not` | `42`, `true`, `null`, `[]`, `{}` forced closed; absent key and `{}` config stay `advisory` non-blocking | `42`/`true`/`null` resolve to a permissive mode today |
| `T54 D1d: every recognized mode still resolves verbatim` | `advisory`/`gateway` informational pass; `enforced`/`ci` block a planted key with the truthful finding reason | non-regression pin (passes before and after) |
| `T54 D2: a readable manifest with no modules key means the module is disabled, not unreadable` | `{}` and `{"name":"demo"}` → `guardOutput` allowed, `securityFlowGate` `null`; `{"modules":{}}` unchanged | today both block |
| `T54 D2b: a manifest that does not parse still blocks, and no enablement is inherited from a payload` | unparseable, empty, whitespace → block; `__proto__` payload → `enabled false`, gate `null`, `Object.prototype.modules` still `undefined` | the unparseable cases would regress to allowed without the sentinel |
| `T54 D3: the forced-closed posture is not the operator's configured mode` | `loadSecurityConfig` marks it `configUnreadable: true` for the unreadable and the unrecognized-mode cases, and never writes to the config file on disk | documents the flag the persistence guard must consult; the persisted-state half is out of ownership and is named in the report |

No existing test is deleted or weakened. `T37 D1`, `D1b`, `D2`, `D2b`, `D2c` and
the `T33 root trigger` loop must all still pass unchanged.

## Verification plan

Reviewer probe before/after; the new regressions RED then GREEN;
`bun src/cli.ts ctx run -- bun test src/security/guard.test.ts
src/security/persistence-sinks.test.ts src/security/service.memo.test.ts
src/security/output-validation.test.ts`; `bun run typecheck`; `bunx eslint` on
every changed file. All raw logs under `.metaproject/data/gdctx/raw/`.

## Constraints honoured

No git state change, no network, no model calls, no `bun test` without file
arguments, no dependency/lockfile change, no `flow.json` or
`acceptance-criteria.md` edit, fixtures under `mkdtemp` only, the only
key-shaped string is the synthetic `AKIAIOSFODNN7EXAMPLE` `guard.test.ts`
already uses, and nothing is ever written to a real
`.metaproject/security.config.json`.
