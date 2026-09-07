# T49 — spec: close the two `review-gate.ts` leak-adjacent sites T47 flagged and left open

## Starting point

T47 (`T47-implementation.md`, "Out of scope, flagged") closed the two
remaining leak sites in `src/flow/service.ts`'s `complete()` (gates 1 and 4's
catch arms), and — while confirming gate 4's catch never deliberately throws —
read `src/flow/review-gate.ts` and flagged, without fixing (out of that
task's file ownership), two sites in that file:

1. `readReviewGateConfig` (~line 111): a `JSON.parse`/`readFile` failure is
   caught and folded into a `notes` entry that interpolates `error.message`
   verbatim; the function's own doc comment says "the note is rendered into
   the gate detail" — reachable through the *pass/fail* branch of gate 4's
   `verdict.detail`, not the `catch` arm T47 fixed.
2. A read next to what T47's report calls `parseReviewRounds` (the function
   is actually `readReviewRounds`, ~line 388-389): `readFile(scopePath,
   "utf8")` is called with only a preceding `pathExists` check (a TOCTOU
   gap, not a guarantee) and no `try`/`catch` of its own.

This task closes both, in `review-gate.ts` only (ownership: this file and its
focused tests under `src/flow/`; `service.ts` stays untouched).

## Verification of each site, done before writing this spec

### Site 1 — `readReviewGateConfig`, confirmed live and reachable

Read the function as it stands (lines 114-155). One `try` wraps BOTH
`readFile(file, "utf8")` and `JSON.parse(...)`. Its `catch` builds:

```ts
notes: [
  `${REVIEW_GATE_CONFIG_PATH} could not be parsed (${
    error instanceof Error ? error.message : String(error)
  }); the built-in defaults were used`,
],
```

Traced where `notes` goes: `readReviewGateConfig` is called once, from
`runReviewGate` (line 1730), which passes `config` straight into
`evaluateReviewGate`'s `input.config`. `evaluateReviewGate` reads
`config.notes` in exactly two places — both branches of its own return, not
inside any `catch`:

```ts
// pass branch (~1497):
(config.notes.length === 0 ? "" : ` [config: ${config.notes.join("; ")}]`)
// fail branch (~1514/1521):
const configNote = config.notes.length === 0 ? "" : ` [config: ${config.notes.join("; ")}]`;
```

So a note built here reaches `verdict.detail` on EVERY completion — pass or
fail — whenever `.metaproject/tasks.config.json` exists and could not be read
or parsed. `verdict.detail` becomes `reviewGate()`'s returned `detail`, which
`complete()` in `service.ts` pushes straight into `GateOutcome.detail` — the
durable, `flow.json`-persisted record T47's own table names as the leak
surface (`buildIssueComment` skips `detail`, but the failed-gates transition
reason does not).

**Reachable content:** the existing test "a malformed config file falls back
to the defaults WITH a note, never silently" already proves the `JSON.parse`
branch is live (a `SyntaxError` from invalid JSON). The `readFile` branch of
the same `catch` is live too, though harder to trigger deterministically —
`pathExists(file)` returning `true` does not guarantee the following
`readFile` succeeds (the file can be removed, become a directory, or lose
read permission between the two calls; T47's own report independently
verified empirically that a Node `ENOENT` from `readFile` embeds the
resolved path, `open '<path>'`). Both branches funnel into the same
interpolation with no floor on what `error.message` can contain. **Confirmed
real, not merely reported.**

### Site 2 — the unguarded `readFile(scopePath, ...)` in `readReviewRounds`

Read `readReviewRounds` end to end (lines 349-408). Confirmed: `problems` is
populated only from `manifest.json`/`findings.json` failures via `readJson`
(350-419), which has its own internal `try`/`catch` and returns `null` on
any failure rather than throwing. `scope.md` is read differently, two lines
below the `findings.json` block:

```ts
const scopePath = path.join(packageDir, "scope.md");
const scope = (await pathExists(scopePath)) ? await readFile(scopePath, "utf8") : null;
```

No `try` around this `readFile` at all. If it throws — permission denied, a
race where the file is removed between `pathExists` and `readFile`, or
`scope.md` turning out to be a directory — the exception propagates out of
`readReviewRounds`, out of the `for` loop, out of `runReviewGate` (no
`try`/`catch` there either — confirmed by reading `runReviewGate`, lines
1722-1796), all the way to whoever called it.

**Who actually reaches this:** searched with `bun src/cli.ts ctx rg` for
every caller.

- `runReviewGate` has exactly two callers: `reviewGate()` in this same file
  (line 1931), and `review-gate.e2e.test.ts` (line 204), directly.
- `reviewGate()` has exactly one caller in production code: `service.ts`
  line 619, inside the `try` T47 fixed — its `catch` now calls
  `unevaluableGate("review")`, which is blocking (`status: "fail"`) and safe
  (a constant string built only from the gate's own name).
- `readReviewRounds` has no other caller than `runReviewGate` (and the
  fixture-setup line in `review-gate.test.ts`, which does not exercise the
  throw path).

**Honest finding, not repeated blindly from the dispatch:** through the
ONLY production call path that exists today (`complete()` -> `reviewGate()`
-> `runReviewGate()` -> `readReviewRounds()`), this throw is *already*
caught safely one layer up, by T47's fix. It does not currently leak, and it
does not currently produce a silently-passing gate — `service.ts`'s catch
already turns it into a blocking, constant-detail failure. T47's own report
said the same thing about this exact site: "not a live regression of this
task's acceptance criteria, but it is closer to the source than where this
task can reach."

What IS real, and is what this task closes: `runReviewGate` and
`readReviewRounds` are exported, public functions of this module, called
directly by `review-gate.e2e.test.ts` today with no wrapping `try` at all,
and nothing in `review-gate.ts` itself stops a throw here from escaping to
ANY caller that is not `service.ts`'s specific try/catch — the module's own
safety does not currently hold on its own. That is exactly the shape this
module's header rejects for its own conditions ("A condition that could not
be observed fails the gate... it does not become acceptable by being spelled
'we could not check'") applied one level down to how the module handles its
own I/O failures: right now an I/O failure here does not "fail the gate" at
all, it throws past the gate machinery entirely, and is caught blocking-safe
only by an accident of the one caller this module happens to have today. A
module whose own safety depends on a specific caller's try/catch is not
self-contained, and `service.ts`'s catch could in principle change shape
(or a second caller could appear, as the e2e test already demonstrates is
possible) without this file's own tests catching the regression.

**Conclusion:** both sites are real and both are fixed. Site 1 is a live,
directly-reachable leak (no caller-side safety net exists for it — it is a
`notes` array read by the pass branch too, not just a catch). Site 2 is not
a *live* leak or non-blocking-outcome today (T47's fix already makes the one
production path safe), but is a real gap in this module's own defenses that
this task closes at the source, per the dispatch's own instruction to make
an unguarded read "produce a blocking, constant outcome rather than an
exception escaping the gate" regardless of what a caller happens to do with
it today.

## Fix design

### Site 1

Split the single `try` into two, mirroring the two genuinely different
failure classes (unreadable file vs. unparseable content), and stop
interpolating `error.message` in either:

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

`safeFsErrorCode` is a new small helper: it returns `error.code` ONLY when
it is a short, uppercase, Node-errno-shaped string (`ENOENT`, `EACCES`,
`EPERM`, `EISDIR`, ...) — never `error.message`, which is the part that
embeds the path. This is the diagnostic-value preservation the dispatch asks
for: an operator still learns *which category* of read failure happened
(not found vs. permission denied vs. ...) from a closed, safe token space,
without the resolved path or any of the message's free text. `EACCES` is not
generic — it is one of Node's own fixed error name constants, exactly the
kind of "safe enumerable token" the policy allows (`policies.md`: "Safe
metrics, decimal values и IDs не маскируются лишь по длине цифр" — a POSIX
errno constant is the same class of safe, closed-vocabulary token).

The existing test `"a malformed config file falls back to the defaults WITH
a note, never silently"` writes literally invalid JSON (`"{ not json"`) to
an existing, readable file — that exercises the SECOND `try` (`JSON.parse`
fails, `readFile` succeeds) and asserts `notes[0]` contains `"could not be
parsed"`. The new message preserves that exact substring, so this test
needs no change and must still pass unmodified.

### Site 2

Wrap the `scope.md` read the same way `readJson` (a few lines above it, in
the same function) already wraps `manifest.json`/`findings.json`: catch and
degrade to `null`, never let the exception escape:

```ts
async function readScopeMarkdown(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
```
and
```ts
const scope = (await pathExists(scopePath)) ? await readScopeMarkdown(scopePath) : null;
```

`scope === null` already means, elsewhere in this exact file,
`verification: null` (line ~403), which `evaluateReviewGate`'s condition 5
already reports as `status: "unobserved"` with the constant message "records
no verification stats in `scope.md` (no `verification_mode:` line)" —
`unobserved` already fails the gate per this module's own rule 2. So this
fix produces EXACTLY the outcome the dispatch asks for — "a blocking,
constant outcome rather than an exception escaping the gate" — by reusing a
code path this file already has and already tests, not by inventing a new
one. It is also the narrowest possible change: a round whose `scope.md`
happens to be genuinely missing already behaves this way today, and a round
whose `scope.md` fails to be READ now behaves identically to one where it is
absent, rather than differently (crashing). No new field, no change to
`problems`/`ingested`, no change to any condition's pass/fail rule.

This mirrors `unevaluableGate` in spirit (per the dispatch: "consistent with
the shared helper the completion path already uses") without duplicating
its exact shape, because that shape (a `GateOutcome`) is not what this
function produces — `readReviewRounds` produces `ReviewRoundRecord[]`, one
level below a `GateOutcome`. The consistent principle carried over is: *a
read that cannot happen degrades to a safe, already-modeled "nothing was
established" value instead of throwing* — which is what `unevaluableGate`
does for a whole gate, and what `readScopeMarkdown` (matching `readJson`'s
own established pattern in this same function) now does for one field.

## What is NOT changed

- No change to `problems`/`ingested` semantics for manifest/findings
  failures (untouched).
- No change to any condition's pass/fail rule, to `REVIEW_GATE_CONDITIONS`,
  to `GateOutcome`, or to `service.ts`.
- No change to the `JSON.parse`-fails message's user-visible substring
  (`"could not be parsed"`) that the existing test pins.
- No behavior change for any round whose `scope.md` reads successfully
  today (the overwhelming majority of currently-passing tests and real
  packages) — the new wrapper returns the exact same string it always did
  on success.

## Regression tests (RED before, GREEN after), planned

Both added to `src/flow/review-gate.test.ts` (this task's owned test file;
`service.test.ts` belongs to T45/T47 and is not touched). Both use
`mock.module("node:fs/promises", ...)`, spreading every real export and
overriding only `readFile`, scoped to the exact path under test (every other
path — including `pathExists`'s own `access` calls and every other file this
test's setup touches — keeps using the real implementation), restored in
`finally`. This is the same snapshot/break/restore discipline
`service.test.ts` already uses for `./store` and `./review-gate`, applied to
`node:fs/promises` because that is where these two reads actually live.

1. **Site 1.** Write a real, existing `.metaproject/tasks.config.json`.
   Override `readFile` to reject with an `Error` whose message plants a
   filesystem path (`/Users/attacker/.ssh/id_rsa`) and the string `ENOENT`,
   for that exact file only. Call `readReviewGateConfig(ROOT)` directly.
   Assert: it resolves (does not reject), `notes` has exactly one entry,
   that entry contains neither the planted path nor `"ENOENT"`, contains
   `"could not be read"`, and the returned `severityFloor`/
   `requireCleanRound` are the safe defaults.

2. **Site 2.** Drive a flow to `complete()`-ready and write a clean review
   package (`writeCleanReviewPackage`, which writes a real `scope.md`).
   Override `readFile` to reject (same planted path + `ENOENT`) for that
   exact `scope.md` path only. Call `service.complete(...)` (this file
   already imports `createFlowService` and does this in every other test —
   using it here is not a `service.ts` edit). Assert: the call resolves (no
   uncaught rejection), the `review` gate's `status` is `"fail"`, its
   `detail` contains neither the planted path nor `"ENOENT"`, `detail`
   contains `"verifier-stats (unobserved)"`, `result.passed` is `false`, and
   `result.flow.status` is `"in-progress"` — i.e., blocking, constant, and
   silent about the caught text, all three in one assertion set.

Both are run once BEFORE the fix (to confirm a real RED — site 1 currently
leaks the path/`ENOENT` into `notes`; site 2 currently either crashes the
`await service.complete()` call with an uncaught rejection, or — if
`service.ts`'s catch happens to intercept it first — passes only because
`unevaluableGate("review")` already masks it, in which case the SITE-LEVEL
assertion to add is that `readReviewRounds`/`runReviewGate` themselves do
not throw, checked directly rather than only through `service.complete()`)
and once after.

## Verification plan

- `bun src/cli.ts ctx run -- bun test src/flow/review-gate.test.ts` (existing
  + 2 new)
- `bun src/cli.ts ctx run -- bun test src/flow/review-gate.e2e.test.ts
  src/flow/service.test.ts src/flow/security-gate.test.ts
  src/flow/task-gate.test.ts` — siblings, to catch any cross-file assumption
- `bun src/cli.ts ctx run -- bun test src/flow/` — full flow-focused suite
- `bun src/cli.ts ctx run -- bun run typecheck` — report only findings that
  reference files this task touched
- `bunx eslint` on every file changed
- Routing audit at the end, per dispatch instructions
