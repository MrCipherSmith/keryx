# T54 implementation — close the mode axis, narrow the manifest widening, and say what is true about the persistence signal

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Files
changed: `src/security/config.ts`, `src/security/guard.ts`,
`src/security/guard.test.ts` — nothing else. `src/security/service.ts`,
`src/security/self-protect.ts`, `src/commands/security.ts`,
`src/health/service.ts` and `src/flow/service.ts` were read-only and are
byte-unmodified. No `types.ts` / `schemas.ts` change was needed: `SecurityMode`
and `configUnreadable` already exist and the schema already enumerates the four
modes. Spec written before coding: `T54-spec.md` (same directory).

All raw logs are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## Baseline (before any edit)

| Run | Result | Raw log |
|---|---|---|
| Reviewer's probe `bun …/T39-posture.ts` (run directly, not through `ctx run` — compaction drops the per-case rows that are the evidence) | 38 rows; B11–B16 reproduce F-002 (`guardAllowed:true` on a planted `AKIA…` with `guardGate:"fail"`, flow gate `{"status":"pass","detail":"security ENFORCED: informational (advisory does not block)"}`); A8/A9/A17 reproduce F-005 (a readable manifest with no `modules` key blocks); `leaky:true` on 0 rows | `2026-09-06T15-51-47-000Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts` (RED, the 6 new regressions added first) | **33 pass / 5 fail**, 253 expect() | `2026-09-06T15-53-54-576Z_run.log` |

The five RED failures are exactly the five new behaviours: `T54 D1`, `D1b`, `D2`,
`D2b`, `D3`. `T54 D1c` is a non-regression pin (absent `mode` key stays advisory;
the four recognized modes resolve verbatim) and passes before and after by
design.

## Defect 1 (major, T39 F-002) — a `mode` outside the closed union resolved to report-only

**Where it was.** `SecurityMode` is a closed four-member union
(`types.ts:93`) and the shipped schema enumerates it (`schemas.ts:139`), but
`mergeSecurityConfig` took `parsed.mode ?? base.mode` on trust and
`loadSecurityConfig` never validated it. Every consumer that branches on the
mode tests for the STRICT values and falls through to the permissive side:
`isBlockingMode` (`guard.ts`), `exitCodeFor` / `reportExitCode`
(`commands/security.ts`), and `MODE_RANK[config.mode]` (`self-protect.ts:88`),
which is `undefined` for an unrecognized value so the §14 downgrade check stayed
silent about it too.

**What changed.**

1. `src/security/config.ts` — a runtime `SECURITY_MODES` set plus an
   `isSecurityMode` predicate, and a validation step at the end of
   `loadSecurityConfig`, the only reader of `security.config.json`:

   ```ts
   const merged = mergeSecurityConfig(parsed);
   const declaredMode = (parsed as { mode?: unknown }).mode;
   const configuredMode = declaredMode === undefined ? merged.mode : declaredMode;
   if (!isSecurityMode(configuredMode)) {
     return { ...merged, mode: "enforced", configUnreadable: true };
   }
   return merged;
   ```

   Three deliberate details.
   - It reuses **T37's existing forced-closed shape** (`mode: "enforced"` +
     `configUnreadable: true`) rather than adding a reason string or a branch:
     `guardOutput` (`guard.ts:244`) and `securityFlowGate` (`:376`) already
     consume that flag through their `POSTURE_UNAVAILABLE_REASON` branches, so
     there is no new leak surface and no new constant.
   - It spreads `merged`, not the bare defaults. The rest of the file parsed
     fine; the operator's `policies` and the `configChecksum` that §14 verifies
     against them are still theirs, and discarding them would silently disarm
     the checksum-tamper detection for a config with a typo'd mode. The
     unusable-*payload* branch above still uses the defaults, because there is
     nothing usable there to keep.
   - It validates the **declared** value, not `merged.mode`. `mergeSecurityConfig`
     applies `??`, so a present `"mode": null` would otherwise arrive already
     replaced by the permissive default. An **absent** key is a different case
     and still resolves to `advisory` — that is the ordinary "no mode configured"
     a bare `{}` produces (`T37 D2c`, probe B7, still non-blocking).

2. `src/security/guard.ts` — `isBlockingMode` is now an exhaustive switch over
   the four modes with the **default arm on the blocking side**, matching
   `securityFlowGate`'s own gate switch, `isPassGate`, `runGate` and
   `gateExitCode`. After change 1 an unrecognized mode cannot reach it; this is
   the second line, so a fifth mode added to the union later cannot inherit
   "does not block" by omission. Note the informational detail string
   `security ${mode}: …` is now reachable only for `advisory`/`gateway`, so an
   unrecognized value can no longer be echoed into a gate detail either.

3. `src/security/guard.ts` header — the module comment's posture-exception
   sentence now names the third case ("or a config that declares a `mode`
   outside the closed `SecurityMode` union"), which is what T39 F-007(c)
   recorded as false.

**Deliberate widening, disclosed.** `{"mode":null}` (probe B14) moves from
`advisory` to forced-closed. The reviewer measured it as advisory and did not
class it as F-002, because `??` reads `null` as "not specified". I class it with
`42` and `true` instead: the key is present and its value is not a mode, and
leaving it out would leave a four-byte edit — `"enforced"` → `null` — as a way
past the very check this task adds, on a config whose §14 downgrade warning is
the only other signal. It is a strict-direction move and it is not in the
protected set the dispatch names.

**Evidence.**

| Payload | Before | After |
|---|---|---|
| `{"mode":"bananas"}` (B11) | `cfgMode "bananas"`, `guardAllowed true`, gate `{"status":"pass","detail":"security bananas: informational…"}` | `cfgMode "enforced"`, `guardAllowed false`, `guardGate "incomplete"`, gate `{"status":"fail","detail":"security posture unavailable: check could not complete"}` |
| `{"mode":"ENFORCED"}` (B12) | as above with `ENFORCED` | as above |
| `{"mode":"enforced "}` (B13), `{"mode":null}` (B14), `{"mode":42}` (B15), `{"mode":true}` (B16) | allowed, informational `pass` | blocked, gate `fail` |
| `{}` (B7), absent config (B1), `advisory`/`enforced`/`ci` (B8–B10) | — | **unchanged, byte-identical rows** |

Raw before `2026-09-06T15-51-47-000Z_run.log`, after
`2026-09-06T15-55-27-000Z_run.log`. Regressions: `T54 D1`, `T54 D1b` (eleven
unrecognized bodies: case, whitespace, a plausible-but-wrong `"report-only"`,
non-strings, `[]`, `{}`), `T54 D1c` (the permissive-side pin). All assert the
reason/detail contain neither the workspace root nor the unrecognized value nor
the planted key.

## Defect 2 (minor, T39 F-005) — the manifest guard blocked a manifest that merely has no `modules`

**Determination: align with the rest of the repository — an absent `modules`
block means the module is disabled, not that the manifest is unreadable.** The
security path does not need to differ here, and I did not make it differ.

Why, in order of weight:

1. **Every other manifest reader in the repository reads it that way** —
   `capability/seam.ts:70`, `commands/ctx.ts:131`, `testing/capability.ts:26`,
   `gdskills/project-skills.ts:664,681`, `gdskills/export.ts:199`. `guard.ts`
   was alone in reading a readable statement as a fault, and a divergence
   between two sibling readers of the same file is precisely what produced
   T35 F-001 in the first place.
2. **It is not the shape T37 argued for.** T37's Concerns 3 disclose widening to
   all non-object manifest *bodies*. A well-formed object with no `modules` key
   is not a body that "is not the object it must be" — it is a readable manifest
   whose statement is "no modules are configured". The extra `if` was widened by
   omission, not by decision, which is exactly how the reviewer framed it.
3. **Today's behaviour was inverted.** An **absent** manifest is non-blocking
   (probe A1) while a **present, well-formed, empty** one blocked (A8): strictly
   more information producing a strictly harsher verdict. No principle in this
   phase produces that ordering.
4. **Nothing is lost by aligning.** "Module disabled" is already reachable, and
   non-blocking, by writing `{"modules":{}}` (A14) or
   `{"modules":{"security":{"enabled":false}}}` (A15) — both untouched. An
   absent `modules` grants an attacker no capability a two-byte edit did not
   already grant. Against that, blocking cost a refusal of every guarded write
   (memory, wiki, testing, gdskills, metrics, sac, workspace, harness) and a
   failed `flow complete`, under a message that said the manifest could not be
   read when it had been read fine.

**What changed** (`src/security/guard.ts`, `resolveManifestSecurityState`):

- `modules === undefined` → `{ enabled: false, manifestUnreadable: false }`.
- `modules` present but not a plain object → `manifestUnreadable: true`
  (unchanged: A10–A13 still block).

**And the change the narrowing required.** Before this task, a manifest that
exists but does **not parse** reached the blocking branch only because
`readJsonFileOr(manifestPath, {})`'s `{}` fallback happens to have no `modules`
key — an accident of the fallback value, not a guard, as the reviewer noted.
Narrowing (1) alone would therefore have silently un-blocked A7 (unparseable),
A18 (empty file) and A19 (whitespace), verdicts the dispatch says must not move.
So the reader now uses an explicit sentinel — a module-local
`MANIFEST_UNREADABLE` `Symbol`, the same instrument `config.ts` already uses for
`CONFIG_UNREADABLE` — and says "did not parse" instead of inferring it. Those
three cases are byte-identical before and after.

**Consequence, disclosed:** A17 (`{"__proto__":{"modules":{"security":{"enabled":true}}}}`)
moves from blocking to `enabled:false`, non-blocking. `JSON.parse` gives that
payload an **own** `__proto__` data property and does not touch the prototype
chain, so the object's own `modules` is absent — it is precisely the F-005 shape
and the narrowing necessarily covers it. The property the reviewer actually
verified is unchanged and is now pinned by a test: no enablement is inherited
from the payload (`isSecurityEnabled` → `false`, gate `null`, so the module is
off rather than on) and `Object.prototype.modules` is still `undefined` (probe
row D1, byte-identical).

**Evidence.** Probe rows A8, A9, A17: `guardAllowed false` / gate `fail` →
`guardAllowed true` / gate `NULL(module disabled)`. Rows A1, A2–A7, A10–A16,
A18, A19 byte-identical. Regressions: `T54 D2` (`{}`, `{"name":"demo"}`,
`{"modules":{}}` all disabled and non-blocking) and `T54 D2b` (unparseable,
empty, whitespace still block; the `__proto__` payload disabled with the
prototype untouched).

## Defect 3 (info, T39 F-008) — a forced posture persisted as the operator's configured mode

**In scope and done:** the forced posture remains a *returned flag* and is never
written to disk by anything this task owns. `loadSecurityConfig` returns
`configUnreadable: true` in memory — for the unreadable-config case T37 added and
now for the unrecognized-mode case too — and writes nothing. `T54 D3` pins it
for both payloads: after `loadSecurityConfig` + `guardOutput` +
`securityFlowGate`, the config file's bytes are still exactly what the fixture
wrote. The reviewer's own C1 row (bytes, `mtimeMs` and the `.metaproject/`
listing unchanged) is byte-identical before and after.

**Out of this task's ownership, and not faked:** the actual persistence is
`await writeState(cwd, currentState(config))` at `src/security/service.ts:95`,
via `currentState` at `src/security/self-protect.ts:39`, compared later by
`MODE_RANK[config.mode] < MODE_RANK[previous.mode]` at `self-protect.ts:88`.
All three files are read-only for this dispatch. `config.ts` cannot decline to
be persisted: `currentState` reads only `mode` and `policies`, and dropping the
forced `enforced` from the returned object is exactly the fail-open T37 closed —
it would also move the reviewer's C1/C-series verdict that an unreadable config
yields `enforced` and CLI exit 1.

The exact change the owning task must make, one line:

```ts
// src/security/service.ts:95 — a forced posture is derived and momentary, not
// the operator's configured mode, so it must not become `previous` for §14.
if (!config.configUnreadable) {
  await writeState(cwd, currentState(config));
}
```

(Equivalently, record the forced posture as a distinct state in
`self-protect.ts` so the rank comparison does not treat it as an operator
choice.) Reported as a concern with the exact edit rather than as a task-level
`BLOCKED`, because defects 1 and 2 are fully in scope and blocking the dispatch
on an informational finding would have left the major one open. Note this
defect's reach **grows** with defect 1's fix — a typo'd mode now also produces a
forced `enforced` — which raises its priority for the owning task without
changing who owns it.

## Documentation defect (T42 review, T42#F-004) — `prepareOutputForPersistence`

The doc comment claimed the return "carries the deterministic floor's own
`redaction` outcome … so a caller can tell apart the three shapes an 'allowed'
result can take". Not true end to end: `guardOutput` runs the same floor first
and puts the cleaned text on `guard.redacted`, so the materializer's second pass
finds nothing and reports `state:"none"` for masked content and for a dropped
duplicate alike. The paragraph now states the two-pass architecture explicitly:
`redaction` describes the **second** pass (usually `none` on the `guardOutput`
path), `bytesPreserved` is the reliable "did anything change" signal because it
compares against the caller's `original`, "what changed and why" comes from
`guard.decision.findings`, and the three-way distinction does hold for a
hand-built `GuardResult` with `redacted` unset. Comment only — no behaviour
change, no test change.

## Verification (after)

| Check | Result | Raw log |
|---|---|---|
| Reviewer's probe `T39-posture.ts` (run directly) | 38 rows, `leaky:true` on **0**; exactly **9** rows moved — A8, A9, A17 (the F-005 narrowing) and B11–B16 (the F-002 fix); the other 29 rows, including C1 (no disk write) and D1 (prototype hygiene), are byte-identical to the before run | before `2026-09-06T15-51-47-000Z_run.log`, after `2026-09-06T15-55-27-000Z_run.log` |
| `bun test src/security/guard.test.ts` | RED **33 pass / 5 fail** → GREEN **38 pass / 0 fail**, 322 expect() (was 32 tests, now 38) | RED `2026-09-06T15-53-54-576Z_run.log`; GREEN `2026-09-06T15-55-19-720Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts src/security/persistence-sinks.test.ts src/security/service.memo.test.ts src/security/output-validation.test.ts` | **87 pass / 0 fail**, 598 expect() | `2026-09-06T15-55-44-906Z_run.log` |
| Wider sweep: `bun test src/security/security.test.ts src/flow/security-gate.test.ts src/commands/security.check-input.test.ts src/commands/security-hooks-init.test.ts src/commands/security-gate-exit.test.ts src/commands/security-recursive-scan.test.ts` | **78 pass / 0 fail**, 291 expect() | `2026-09-06T15-55-59-815Z_run.log` |
| Every other suite that touches the guard seams (`ctx rg -l "guardOutput\|securityFlowGate\|isSecurityEnabled" src --glob '*.test.ts'`): `bun test src/flow/service.test.ts src/security/project-root.test.ts src/sac/proposal-lifecycle.test.ts src/wiki/enrich.test.ts` | **85 pass / 0 fail**, 252 expect() | `2026-09-06T15-56-29-003Z_run.log` (file list `2026-09-06T15-56-23-254Z_rg.log`) |
| `bun run typecheck` (`tsc --noEmit`) | clean, exit 0 | `2026-09-06T15-56-11-341Z_run.log` |
| `bunx eslint src/security/config.ts src/security/guard.ts src/security/guard.test.ts` | clean, no output, exit 0 | `2026-09-06T15-56-16-406Z_run.log` |

No test was deleted or weakened, and no existing expectation was changed — the
six new tests are purely additive. `T33 root trigger`, `T37 D1`, `D1b`, `D2`,
`D2b`, `D2c`, `D3`, `D3b` all still pass unmodified.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC8: no required failed or incomplete check is relabeled PASS; a check that cannot establish its posture blocks rather than disappearing; an unrecognized configured mode never resolves to something more permissive than the strictest recognized mode. | met | Eleven unrecognized mode bodies now resolve to `enforced` + `configUnreadable`, block at `guardOutput` and return `{status:"fail"}` at `securityFlowGate` (`T54 D1`/`D1b`, probe B11–B16). `isBlockingMode`'s default arm blocks, so an unrecognized value cannot inherit "does not block" even if it ever reached there. The narrowing in defect 2 relabels nothing as PASS: it distinguishes "module disabled" (a stated posture) from "posture unavailable", and the unparseable/empty/whitespace manifests still block (`T54 D2b`, probe A7/A18/A19). |
| Policy (policies.md §"Health и security gate"): strict runs accept only a pass; reasons and details are constant and leak-safe, with no raw error text, path or source bytes. | met | Every new branch returns the existing `POSTURE_UNAVAILABLE_REASON` / `INCOMPLETE_DECISION` constants — no new string, no interpolation. `T54 D1` asserts the reason and detail contain neither the workspace root, nor the planted `AKIA…`, nor the unrecognized mode bytes; the probe reports `leaky:false` on all 38 rows. The one interpolating detail (`security ${mode}: informational`) is now reachable only for the two recognized report-only modes. |
| Regressions fail before and pass after, covering an unrecognized mode string, a recognized mode in the wrong case, the manifest-without-modules shape, and the persisted-posture case; everything the earlier repair closed stays closed. | met | RED 5 fail → GREEN 0 fail. `T54 D1` (unrecognized string), `D1b` (wrong case / whitespace / non-string), `D2` (manifest without `modules`), `D3` (forced posture is a flag, the config file's bytes are unchanged). The protected verdicts are byte-identical in the probe diff: every non-object manifest body (A2–A6), every non-object `modules` (A10–A13), every non-object and unparseable config (B2–B6, B17), an absent manifest (A1), an absent config (B1) and a legitimate empty config (B7). |

## Concerns

1. **T39 F-008 is only half closed, and the other half is one line in a file I
   do not own.** `src/security/service.ts:95` still persists the synthesized
   `enforced` into `state.json`, so repairing a config afterwards still raises a
   spurious `mode-downgrade` incident. The exact edit is quoted above. This
   task's fix *widens* the trigger (a typo'd mode now forces `enforced` too), so
   it is worth scheduling rather than deferring indefinitely.
2. **Two probe verdicts moved in the permissive direction by design**: A8/A9
   (readable manifest with no `modules`) and A17 (`__proto__` payload, the same
   shape). This is the F-005 determination the dispatch asked me to make, argued
   above; if the phase would rather keep the security reader stricter than every
   other manifest reader in the repo, the single `if (modules === undefined)`
   arm in `resolveManifestSecurityState` is the whole change to revert — the
   sentinel added alongside it must stay either way, because without it an
   unparseable manifest stops blocking.
3. **`{"mode":null}` is a deliberate strict-direction widening** beyond what the
   reviewer classed as F-002 (they measured it as advisory and left it out).
   Justified above; flagged in case the phase wants the narrower reading, in
   which case `configuredMode` should be `merged.mode` rather than the declared
   value.
4. **The sibling mode consumers are untouched, by ownership.**
   `exitCodeFor` / `reportExitCode` (`commands/security.ts`) and `MODE_RANK`
   (`self-protect.ts`) still take the mode on trust; they are now fed a
   validated value on every path that goes through `loadSecurityConfig`, but
   neither is exhaustive in its own right. `commands/security.ts` belongs to
   another worker in this wave.

## Routing audit

`graph_used: no (not-relevant — the dispatch pinned the exact file set and
symbol names, and the consumer enumeration is a text-shape question); wiki_used:
no (not-relevant — the normative sources are `policies.md` and the frozen
`acceptance-criteria.md`, both read directly); ctx_used: yes (every code search
via `bun src/cli.ts ctx rg`, every test/typecheck/eslint run via
`bun src/cli.ts ctx run`, all raw logs cited above); raw_rg_used: no — the two
`grep`/`diff` reads carrying the documented `# keryx:raw` escape were over
gdctx **raw probe logs**, never over project code, with the stated reason that
ctx compaction drops the per-case rows that are the acceptance evidence itself
(the same escape T33/T35/T37 recorded). Every project-code read used the `Read`
tool with bounded offsets.`

## Constraint compliance

No git state changed; no flow CLI or flow state touched; no `flow.json` or
`acceptance-criteria.md` edit; no network; no model calls; no dependency or
lockfile change; no `bun test` without file arguments; every fixture synthetic
and under `mkdtemp`, removed in `finally`; the only key-shaped string is the
synthetic `AKIAIOSFODNN7EXAMPLE` `guard.test.ts` already used; nothing was ever
written to a real `.metaproject/security.config.json` (`T54 D3` asserts the
fixture's bytes are unchanged); `src/security/service.ts`,
`src/security/self-protect.ts`, `src/commands/security.ts`,
`src/health/service.ts`, `src/flow/service.ts` and `src/security/detect/exfil.ts`
are unmodified.
