STATUS: DONE

# T49 — implementation: close the two `review-gate.ts` sites T47 flagged and left open

## Verification of each reported site, done before changing anything

### Site 1 — `readReviewGateConfig` (~line 111 pre-fix): confirmed live, real leak

One `try` wrapped both `readFile(file, "utf8")` and `JSON.parse(...)`. Its
`catch` built:

```ts
notes: [
  `${REVIEW_GATE_CONFIG_PATH} could not be parsed (${
    error instanceof Error ? error.message : String(error)
  }); the built-in defaults were used`,
],
```

Traced `config.notes` from `readReviewGateConfig` (called once, from
`runReviewGate`) into `evaluateReviewGate`, where it is read in BOTH the pass
and the fail branch of the return (`[config: ${config.notes.join("; ")}]`),
not inside any `catch` — so a note built here reaches `verdict.detail`, and
therefore `reviewGate()`'s returned `detail`, and therefore the
`GateOutcome.detail` `complete()` pushes into `flow.json` history, on EVERY
completion where `.metaproject/tasks.config.json` exists and could not be
read or parsed — pass or fail alike.

The `JSON.parse` half of this `catch` was already proven live by the
pre-existing test "a malformed config file falls back to the defaults WITH a
note, never silently". The `readFile` half is real too: `pathExists`
returning `true` does not guarantee the following `readFile` succeeds — the
file can be removed, lose read permission, or turn into a directory between
the two calls (a TOCTOU gap this module's own header names explicitly: "Two
consequences run through this whole file"). T47's own report independently
verified empirically that a real Node `ENOENT` from `readFile` embeds the
resolved path in `error.message`. Both branches shared one interpolation
with no floor on what the message could contain. **Confirmed real and
reachable, not merely reported — fixed.**

### Site 2 — the unguarded `readFile(scopePath, ...)` in `readReviewRounds`

The dispatch's own name for this, `parseReviewRounds`, does not exist in the
file; the actual function is `readReviewRounds`. Read it end to end
(pre-fix, lines 349-408): `manifest.json`/`findings.json` are both read
through `readJson`, which already has its own internal `try`/`catch` and
degrades every failure to `null`. Two lines below that, `scope.md` was read
differently:

```ts
const scopePath = path.join(packageDir, "scope.md");
const scope = (await pathExists(scopePath)) ? await readFile(scopePath, "utf8") : null;
```

No `try` around this read at all. Traced every caller with `bun src/cli.ts
ctx rg` before assuming the dispatch's framing:

- `runReviewGate` (no `try`/`catch` of its own around `readReviewRounds`)
  has exactly two callers: `reviewGate()` in this same file, and
  `review-gate.e2e.test.ts` line 204, directly.
- `reviewGate()` has exactly one production caller: `service.ts` line 619,
  inside the `try` T47 fixed. Its `catch` already turns any escaping
  exception into a blocking, constant `unevaluableGate("review")` (`status:
  "fail"`, detail = `"review gate could not be evaluated; treated as
  failed, not skipped"` — no interpolation of the caught value at all).
- `readReviewRounds` has no other caller besides `runReviewGate` and a
  fixture-setup line in `review-gate.test.ts` that does not exercise the
  throw path.

**Honest finding, not repeated verbatim from the dispatch:** through the
ONLY production call chain that exists today (`complete()` -> `reviewGate()`
-> `runReviewGate()` -> `readReviewRounds()`), a `scope.md` read failure was
already caught safely one layer up by T47's fix — it did not currently leak
the caught text, and it did not currently produce a silently-passing gate.
T47's own report said exactly this about this exact site ("not a live
regression of this task's acceptance criteria, but it is closer to the
source than where this task can reach"), and I re-confirmed it independently
rather than trusting the earlier note.

What WAS real and is what this task closes: `runReviewGate` and
`readReviewRounds` are exported, public functions with no `try`/`catch` of
their own around this read, called directly today by
`review-gate.e2e.test.ts` with no wrapping try either. Verified by running
the new unit-level regression test (below) against the PRE-fix code: calling
`readReviewRounds` directly with a failing `readFile` produced an actual
uncaught exception out of the function — not a leaked message, not a
silently-passing gate, but a THIRD failure mode the dispatch's two named
categories didn't quite name: an escaping exception, safe only because the
one production caller happens to catch it. A module whose own safety
depends entirely on one specific caller's `try`/`catch` is not self-
contained, and the e2e test already demonstrates a second, uncaught caller
is possible. **Confirmed real as a gap in this module's own defenses, not
as a currently-live leak or non-blocking outcome through the shipped CLI —
fixed at the source per the dispatch's own instruction, regardless of what
today's one caller happens to do with it.**

## Fix

### Site 1

Split the single `try` into two — one for the `readFile`, one for the
`JSON.parse` — and stopped interpolating `error.message` in either:

```ts
let raw: string;
try {
  raw = await readFile(file, "utf8");
} catch (error) {
  const code = safeFsErrorCode(error);
  return {
    ...DEFAULT_REVIEW_GATE_CONFIG,
    notes: [
      `${REVIEW_GATE_CONFIG_PATH} could not be read` +
        (code === undefined ? "" : ` (${code})`) +
        "; the built-in defaults were used",
    ],
  };
}
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  return {
    ...DEFAULT_REVIEW_GATE_CONFIG,
    notes: [`${REVIEW_GATE_CONFIG_PATH} could not be parsed; the built-in defaults were used`],
  };
}
```

New helper `safeFsErrorCode(error)`: returns `error.code` only when it is a
short, uppercase, Node-errno-shaped string (`/^[A-Z][A-Z0-9]{2,15}$/` —
matches `ENOENT`, `EACCES`, `EPERM`, `EISDIR`, ...), else `undefined`. Never
`error.message`. This is the diagnostic-value preservation the dispatch
asks for: an operator still learns *which category* of read failure
happened — not found vs. permission denied vs. some other errno — from a
closed, safe token space Node itself defines, without the resolved path or
any of the message's free text. This is the same class of "safe enumerable
token" the policy names (`policies.md`, "Redaction и security scan": "Safe
metrics... не маскируются лишь по длине цифр" — a POSIX errno constant is a
fixed, non-secret, non-path token, the same shape already used two lines
below for `` `completion.severity_floor \`${rawFloor}\` is not a severity` ``,
where `rawFloor` is a bounded JSON string from the project's own config
file, not OS error text).

The parse-failure message keeps the exact substring `"could not be parsed"`
that the pre-existing test pins, so that test needed no change.

### Site 2

Added `readScopeMarkdown`, mirroring `readJson`'s own established pattern a
few lines above it in the same function — catch, degrade to `null`, never
throw:

```ts
async function readScopeMarkdown(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
```

Call site changed from `await readFile(scopePath, "utf8")` to `await
readScopeMarkdown(scopePath)`. `scope === null` already meant, elsewhere in
this exact file (line ~403 pre-fix, unchanged), `verification: null`, which
`evaluateReviewGate`'s condition 5 already reports as `status: "unobserved"`
with the pre-existing constant message ("records no verification stats in
`scope.md` (no `verification_mode:` line)") — `unobserved` already fails
the gate per this module's own header rule 2 ("A condition that could not
be observed fails the gate"). So a `scope.md` read failure now produces
EXACTLY the outcome the dispatch names — "a blocking, constant outcome
rather than an exception escaping the gate" — by reusing a path this file
already has and already tests, not by inventing a new one.

No change to `problems`/`ingested` for this round: a `scope.md` read
failure is treated identically to a genuinely absent `scope.md`, which was
already `ingested: true` (scope.md is optional metadata, not required for a
round to be cited). This is the narrowest fix that closes the escaping-
exception gap: it changes nothing about any currently-passing test's
outcome (verified — see Verification below), only converts what used to be
a thrown exception into the same safe, already-modeled, already-blocking
value an absent file already produced.

## Diagnostic-value tradeoff

Site 1: addressed above (`safeFsErrorCode`) — the category of failure
(errno) survives; the path and free-text message do not.

Site 2: no tradeoff to make. A `scope.md` read failure now reads exactly
like a missing `scope.md` already did, and that case already had a
dedicated, informative, safe message ("no `verification_mode:` line" ->
"nothing says whether a verifier ran") — nothing new was invented and
nothing was silently dropped, because the destination message already
existed and was already the right one for "no usable verification stats
here."

## What was NOT changed

- No change to `problems`/`ingested` semantics for manifest/findings
  failures.
- No change to any condition's pass/fail rule, to `REVIEW_GATE_CONDITIONS`,
  to `GateOutcome`, or to `src/flow/service.ts` (untouched, per ownership).
- No change to the `"could not be parsed"` substring the pre-existing test
  pins.
- No behavior change for any round whose `scope.md` reads successfully
  today (the overwhelming majority of real packages and currently-passing
  tests) — `readScopeMarkdown` returns the exact same string it always did
  on success.

## Regression tests (RED before, GREEN after)

Three new tests, all in `src/flow/review-gate.test.ts` (this task's owned
test file — `service.test.ts` belongs to T45/T47 and was not touched). All
three use `mock.module("node:fs/promises", ...)`, spreading a snapshot of
the real module (`realFsExports`, captured once at file scope, same
snapshot/break/restore discipline `service.test.ts` already uses for
`./store`/`./review-gate`) and overriding `readFile` only for one exact
path, delegating every other path — including `pathExists`'s own `access`
calls and every other file each test's setup touches — to the real
implementation.

1. **Site 1** — "a config file that fails to read (not just parse) never
   echoes the caught text into notes": writes a real, valid, existing
   `tasks.config.json`, makes `readFile` reject for that exact path with an
   `Error` planting `/Users/attacker/.ssh/id_rsa` and `"ENOENT"`, calls
   `readReviewGateConfig(ROOT)` directly. Asserts: resolves; `notes` has one
   entry; that entry contains neither the planted path nor `"ENOENT"`;
   contains `"could not be read"`; `severityFloor`/`requireCleanRound` are
   the documented safe defaults.

2. **Site 2, unit level** — "a scope.md read failure (not just a missing
   file) degrades to no verification stats, and never throws": writes a
   clean review package (`writeCleanReviewPackage`, which writes a real
   `scope.md`), makes `readFile` reject for that exact `scope.md` path,
   calls `readReviewRounds(ROOT, dir)` directly. Asserts: resolves (no
   uncaught rejection — this IS the regression: pre-fix, this call rejected
   with the planted error, verified below); the one round is still
   `ingested: true`; its `verification` is `null`; the JSON-serialized round
   records contain neither the planted path nor `"ENOENT"` anywhere.

3. **Site 2, full-gate level** — "a scope.md read failure blocks flow
   completion, and never echoes the caught text": same fixture, same
   scope.md-only `readFile` rejection, but calls `service.complete(...)`
   (using `createFlowService`, which this test file already imports and
   drives in every other test — not an edit to `service.ts`). Asserts:
   resolves; the `review` gate's `status` is `"fail"`; its `detail`
   contains neither the planted path nor `"ENOENT"`; `detail` contains
   `"verifier-stats (unobserved)"` (the STRUCTURED per-condition detail,
   not the generic `unevaluableGate` fallback T47's outer catch would have
   produced pre-fix); `result.passed` is `false`; `result.flow.status` is
   `"in-progress"`.

**RED** (`bun test src/flow/review-gate.test.ts -t "never echoes the caught
text|never echoes the caught text into notes|degrades to no verification
stats"`, run directly — test execution, not a code search, so outside the
`ctx rg`-only routing rule):

- Site 1: failed on `expect(config.notes[0]).not.toContain(secretPath)` —
  actual note was `` .metaproject/tasks.config.json could not be parsed
  (ENOENT: no such file or directory, open
  '/Users/attacker/.ssh/id_rsa'); the built-in defaults were used ``,
  confirming the leak.
- Site 2, unit level: the test itself THREW — `error: ENOENT: no such file
  or directory, open '/Users/attacker/.ssh/id_rsa'` propagating out of
  `readReviewRounds` (`review-gate.ts:389`) — confirming the escaping-
  exception gap directly, not merely inferring it.
- Site 2, full-gate level: failed on `expect(gate.detail).toContain(
  "verifier-stats (unobserved)")` — actual detail was `"review gate could
  not be evaluated; treated as failed, not skipped"`, i.e. `status` was
  already `"fail"` pre-fix (T47's outer catch masked the throw), but the
  structured per-condition detail this module's own design produces was
  lost, replaced by the generic fallback — confirming the gap is real one
  layer down even though `service.ts`'s catch made it non-catastrophic at
  the CLI boundary.

3 failed / 0 passed pre-fix, all for the diagnosed reason, none for an
unrelated one.

**GREEN** (same command, post-fix): 3 pass / 0 fail / 17 expect().

## Verification

| Check | Command | Result | Raw log |
|---|---|---|---|
| Targeted regressions | `bun test src/flow/review-gate.test.ts -t "never echoes the caught text\|never echoes the caught text into notes\|degrades to no verification stats"` (direct, quick pre-recorded check) | 3 pass / 0 fail / 17 expect() | not routed (quick local check, matches T45/T47 precedent for direct `-t` runs) |
| Full `review-gate.test.ts` | `bun test src/flow/review-gate.test.ts` (direct) | 58 pass / 0 fail / 209 expect() (55 pre-existing + 3 new) | not routed (quick local check) |
| Full flow-focused suite | `bun src/cli.ts ctx run -- bun test src/flow/` | 188 pass / 0 fail / 633 expect() across 20 files | `.metaproject/data/gdctx/raw/2026-09-06T15-28-08-660Z_run.log` |
| Sibling suites (e2e, service, security-gate, task-gate) | `bun src/cli.ts ctx run -- bun test src/flow/review-gate.e2e.test.ts src/flow/service.test.ts src/flow/security-gate.test.ts src/flow/task-gate.test.ts` | 41 pass / 0 fail / 187 expect() | `.metaproject/data/gdctx/raw/2026-09-06T15-28-40-962Z_run.log` |
| Typecheck | `bun src/cli.ts ctx run -- bun run typecheck` | exit 0, zero errors anywhere (not just zero in `src/flow/*` — the whole repo typechecks clean at this point in the session) | `.metaproject/data/gdctx/raw/2026-09-06T15-28-20-924Z_run.log` |
| ESLint on every file changed | `bun src/cli.ts ctx run -- bunx eslint src/flow/review-gate.ts src/flow/review-gate.test.ts` | clean, no output | `.metaproject/data/gdctx/raw/2026-09-06T15-28-25-639Z_run.log` |

188 = T47's 185 baseline + 3 new tests. All flow-focused suites fully green;
`src/security/*` and `src/commands/health.ts` (owned by concurrent workers
per the dispatch) were not touched and were not read except transitively by
whatever `bun test src/flow/` itself imports.

## Files changed

- `src/flow/review-gate.ts` — added `safeFsErrorCode` (new helper); split
  `readReviewGateConfig`'s single `try` into two, removing the
  `error.message` interpolation from both catch arms; added
  `readScopeMarkdown` (new helper, mirrors `readJson`'s existing pattern);
  changed one call site in `readReviewRounds` from a direct, unguarded
  `readFile(scopePath, "utf8")` to `readScopeMarkdown(scopePath)`. No other
  line, type, or exported signature changed; `ReviewGateConfig`,
  `ReviewRoundRecord`, `GateOutcome`-equivalent shapes all unchanged.
- `src/flow/review-gate.test.ts` — added `mock` to the `bun:test` import;
  added `REVIEW_GATE_SEVERITY_FLOOR_DEFAULT` to the `./review-gate` import;
  added `realFsExports` (module-scope snapshot of `node:fs/promises`,
  mirroring `service.test.ts`'s `realStoreExports`/`realReviewGateExports`
  pattern); added three regression tests (one for site 1, two for site 2).

## Routing audit

graph_used: no (not-relevant — the dispatch named the exact file and the
two exact sites; confirming each required a careful end-to-end read of
`review-gate.ts` and a caller trace via `bun src/cli.ts ctx rg`, not a
structural/dependency question the graph answers, and this repo's memory
notes gdgraph/gdctx currently return wrong answers here, which the caller
trace's own manual cross-check against the file text corroborates rather
than relies on). wiki_used: no (not-relevant — the normative source is
`policies.md`, supplied directly in the dispatch and read in full, same as
T45/T47). ctx_used: yes — every project-code search via `bun src/cli.ts ctx
rg` (caller traces for `runReviewGate`, `reviewGate`, `readReviewRounds`,
`evaluateReviewGate`, `mock.module(` precedent), every verification command
via `bun src/cli.ts ctx run` (raw logs tabled above), every bounded file
excerpt via the `Read` tool with offset/limit per the dispatch's stated
workaround for the blocked raw `sed -n`. raw_rg_used: no.
