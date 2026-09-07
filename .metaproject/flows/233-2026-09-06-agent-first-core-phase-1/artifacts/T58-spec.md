# T58 spec — a forced-closed posture must not become the recorded `previous` state

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Written
before any code change. Extends `T37-implementation.md` (Defect 3) and
`T54-implementation.md` (Concern 1), which closes `T39-review.md` F-008 (info):
"A forced-`enforced` posture is persisted into `state.json`, so restoring a
valid advisory config raises a spurious downgrade incident."

Owned files: `src/security/self-protect.ts` and its focused tests (the
self-protection scenarios in `src/security/security.test.ts`, which import
`evaluateSelfProtection`/`writeState`/`currentState` directly and exercise them
end to end through `analyze()`), and only the state-write region of
`src/security/service.ts` (`analyze()`, around line 95). Everything else —
`src/security/config.ts`, `src/security/guard.ts`, `src/security/types.ts`,
`src/commands/security.ts`, `src/health/service.ts`, `src/flow/service.ts`,
`src/security/detect/exfil.ts` — is read-only.

## What is broken today

`analyze()` (`service.ts:90-95`):

```ts
const previous = await readState(cwd);
const selfProtection = evaluateSelfProtection(config, previous);
if (selfProtection.incidents.length > 0) {
  await appendIncidents(cwd, selfProtection.incidents);
}
await writeState(cwd, currentState(config));
```

`currentState(config)` (`self-protect.ts:39`) reads `config.mode` verbatim.
When `config.configUnreadable` is `true` — an unusable config (T37) or an
unrecognized `mode` (T54) — `config.mode` is not the operator's configured
mode; it is `loadSecurityConfig`'s forced-strictest fallback. The
unconditional `writeState` call persists that synthesized value into
`.metaproject/data/security/raw/state.json` as if it were a real, previously
observed operator choice. Two distinct failures follow, both from the same
line:

1. **False positive.** Real mode is `advisory` (rank 1). Config breaks →
   forced `enforced` (rank 2) gets written as `previous`. Config is repaired
   back to the *same* `advisory` it always was → `MODE_RANK[advisory] <
   MODE_RANK[enforced]` → a `mode-downgrade` incident fires for a downgrade
   that never happened.
2. **Masked true positive** (found while designing the regression, not in the
   review). Real mode is `gateway` (rank 3). Config breaks → forced `enforced`
   (rank 2) overwrites the recorded `gateway`. Operator then genuinely
   reconfigures to `ci` (rank 2) — a real downgrade from `gateway`. Compared
   against the corrupted `previous` (`enforced`, also rank 2), `ci` is not a
   rank decrease, so the genuine downgrade is silently missed. The same
   defect that fabricates incidents also erases real ones, because both
   directions read `previous` off a value that was never the operator's.

## What the recorded state is for, and who reads it

`data/security/raw/state.json` has exactly one writer (`writeState`,
`self-protect.ts:138`) and exactly one reader (`readState`, `self-protect.ts:126`),
and `readState` has exactly one caller: `analyze()` at `service.ts:90`, which
immediately feeds it to `evaluateSelfProtection` as `previous`. Confirmed by
`ctx rg` over every non-test file for `readState|writeState|state.json`
(raw `2026-09-06T16-02-56-990Z_rg.log`) — no other module, command, or MCP
tool reads this file. So "what a reader of the recorded state sees" reduces to
exactly one question: what does the NEXT `evaluateSelfProtection` call
conclude by comparing its freshly-loaded `config` against `previous`?

`evaluateSelfProtection` draws two conclusions from `previous`: a mode-rank
comparison (`self-protect.ts:88`) and a per-policy enabled→disabled comparison
(`self-protect.ts:101-113`, via `currentState(config).policies`). Both are
"was the posture weakened since we last had a real reading of it" checks —
the self-protection module's own header says so: "a mode downgrade or a
disabled policy is always surfaced." A forced-closed run has no real reading
to contribute to that question, in either direction: it does not know what
the operator's mode or policies genuinely are (that is exactly what
"unreadable" means), so it cannot honestly serve as `previous` for a future
comparison, and it is not comparing against `previous` on the operator's
behalf either — the strictest-recognized-mode substitution is a
best-available guess to keep DECIDING blocked, not a fact the operator stated.

## Options considered

1. **Skip the write entirely when `config.configUnreadable`.** `previous`
   keeps carrying the last config the loader could actually read. A repair to
   the same real mode compares truth against truth (no incident); a repair to
   a genuinely weaker mode still compares truth against truth (incident
   fires); a run whose config was *already* broken on the very first
   invocation never establishes a `previous` at all until the config becomes
   readable, so the comparison has nothing to falsely accuse.
2. **Record the operator's declared settings without the forced mode.** Not
   viable as stated: for the fully-unreadable cases (`null`, unparseable JSON,
   a non-object payload) there IS no declared mode to record — the file did
   not yield one. For the unrecognized-mode case there is a declared string,
   but it is by definition not a member of `SecurityMode`, so `SecurityState`
   (a closed-union `mode: SecurityMode` field) cannot hold it without
   widening the type to accept arbitrary strings, which would let an
   unrecognized value flow into `MODE_RANK[...]` (`undefined`) and reintroduce
   the exact blind spot T39 F-002 fixed at the loader.
3. **Record the forced posture with a marker the comparison understands.**
   Add e.g. `synthesized: boolean` to `SecurityState`, always write, and teach
   `evaluateSelfProtection` to skip the mode/policy comparisons when
   `previous.synthesized` is true. Closes the false-positive half. Does
   *not* close the masked-true-positive half above by itself, because a
   *later*, non-synthesized comparison still reads `previous.mode` as
   `"enforced"` (the last successfully-written value) rather than the real
   `"gateway"` that preceded it — the marker only tells the comparison to
   skip when `previous` itself is synthetic, not to reach further back to the
   last genuine value. Making it also close the masked case requires the
   write to preserve the last genuine mode/policies alongside the marker
   (i.e., "don't overwrite, but note that a forced run happened") — at which
   point it is option 1 with an added audit field, not a different mechanism.

## Decision: option 1, skip the write

`writeState` runs the operator's exact configured `mode`/`policies` forward as
`previous` for the entire duration a broken config forces a substitute value.
Once the config is readable again — same mode or a genuinely different one —
`previous` is compared against truth, not against a synthesized stand-in, so
neither failure above (fabricated incident, masked incident) can occur. This
is also the narrowest change available: one line in the write region
`service.ts:95` already names, no type change, no new field, and it does not
touch `evaluateSelfProtection`'s comparison logic at all, so nothing about a
live, in-window signal changes — a comparison against a *real* `previous`
that is currently forced to a lower rank than that `previous` (e.g. `gateway`
→ forced `enforced`) still fires today and keeps firing; that is a truthful
statement about the current run's effective enforcement level, not the
fabricated-`previous` defect this task closes, and changing it would be scope
creep into a decision this dispatch does not ask for.

```ts
// src/security/service.ts, analyze(), replacing the unconditional writeState:
// A forced-closed posture (`config.configUnreadable`) is a derived, momentary
// fact about a config this run could not read -- not the operator's
// configured mode or policies (T39 F-008). Recording it as `previous` would
// make the NEXT comparison (a repair to the same mode, or a genuine change)
// read a synthetic value as if it were real, which can both fabricate a
// downgrade that never happened and mask one that did (see T58-spec.md).
// `previous` for the next run is left exactly as it was: the last config this
// loader could actually read.
if (!config.configUnreadable) {
  await writeState(cwd, currentState(config));
}
```

## What a reader of the recorded state sees, in each of the three cases

- **Config fine.** Unchanged from today: every `analyze()` call reads
  `previous`, compares it to the real `config.mode`/`policies`, and writes the
  real values forward. No behaviour change on this path at all.
- **Config broken** (unusable payload or unrecognized mode). `evaluateSelfProtection`
  still runs and can still warn/incident on THIS run — checksum-mismatch is
  unaffected (it compares `config.policies`/`config.configChecksum` directly,
  not `previous`, and is unaffected by the write), and a mode/policy
  comparison against the real `previous` can still fire if the *forced* value
  happens to rank below it (the `gateway`→forced-`enforced` case above,
  disclosed as an honest signal, not a defect). What changes: `previous` on
  disk is left untouched — the write is skipped — so this run's forced value
  never becomes a future `previous`.
- **Config repaired.** `previous` is whatever the last config actually read
  (never a forced value), so the comparison is real-vs-real: a repair to the
  same mode raises nothing, a repair to a genuinely weaker mode raises the
  incident it should, and neither outcome depends on how many broken runs sat
  in between.

**First run whose config is already broken, no prior state.json at all.**
`readState` returns `null` (file absent). `evaluateSelfProtection`'s mode and
policy comparisons are both `if (previous)`-guarded, so neither runs; only the
checksum check can act, and for a fully-unreadable payload `config.configChecksum`
is `undefined` (the forced config is built from `mergeSecurityConfig({})`,
which never sets it), so `verifyConfigChecksum` treats that as a match and
raises nothing either. With this fix, the write is also skipped, so
`state.json` still does not exist afterward. This repeats for every
subsequent broken run: no `previous` is ever established until a config the
loader can actually read is seen, at which point the state is created for the
first time from real values. Sensible: it behaves exactly as though the
broken runs never happened, because none of them could honestly contribute a
`previous`.

## Regressions (RED first, added to `src/security/security.test.ts`)

| Test | Asserts | Fails before because |
|---|---|---|
| `T58 D1: a forced-closed posture never becomes the recorded previous mode, so repairing to the SAME real mode raises no incident` | real `advisory` recorded → config breaks (forced `enforced`) → `readState` still `advisory` → repair to `advisory` → no `downgraded` warning, no `mode-downgrade` incident | today the broken run's forced `enforced` overwrites the recorded `advisory`; the repair compares `advisory` against the wrong `previous` and fires |
| `T58 D2: a genuine downgrade across a broken-config window is still detected, not masked` | real `gateway` recorded → config breaks (forced `enforced`, lower rank) → `readState` still `gateway` → genuine reconfigure to `ci` (a real downgrade from `gateway`) → `downgraded` warning and `mode-downgrade` incident DO fire | today the broken run's forced `enforced` overwrites the recorded `gateway`; `ci` compared against `enforced` is not a rank decrease, so the real downgrade is missed |
| `T58 D3: a first run whose config is already broken records no state and raises no incident; the state is established once the config is readable` | broken config, no prior `state.json` → `analyze()` → `configUnreadable: true`, no warnings, `readState` still `null` → repair → no spurious warning, `readState` now holds the real mode | documents the existing no-`previous` guard stays correct once the write is also skipped; not a behaviour change by itself, but pins the combination |

Non-regression: `T37 D2/D2b/D2c`, `T54 D1/D1b/D1c/D2/D2b/D3` (all in
`guard.test.ts`, untouched) and the existing self-protection scenarios in
`security.test.ts` ("enforced→advisory downgrade + checksum mismatch...", "a
mode downgrade at check() time writes an incident") must keep passing
unmodified — the latter already seeds `previous` via a direct `writeState`
call (not through a broken-config `analyze()` run), so it is unaffected by
this change; it stays as the pin that a *real* recorded `previous` still
triggers a *real* downgrade.

## Verification plan

RED (new tests fail) then GREEN, `bun src/cli.ts ctx run -- bun test
src/security/security.test.ts src/security/guard.test.ts
src/security/persistence-sinks.test.ts src/security/service.memo.test.ts
src/security/output-validation.test.ts`, `bun run typecheck`, `bunx eslint` on
every changed file. All raw logs under `.metaproject/data/gdctx/raw/`.

## Constraints honoured

No git state change, no network, no model calls, no `bun test` without file
arguments, no dependency/lockfile change, no `flow.json` or
`acceptance-criteria.md` edit, fixtures under `mkdtemp` only (the existing
`root`/`beforeEach`/`afterEach` in `security.test.ts`), no real credential
(content strings are non-secret placeholders — this task does not need a
planted key, since it is not testing detection), nothing is ever written to a
real `.metaproject/security.config.json`, and `src/security/config.ts`,
`src/security/guard.ts`, `src/security/guard.test.ts`, `src/security/types.ts`
stay byte-unmodified.
