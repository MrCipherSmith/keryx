# T44 spec — carry the redaction outcome through `prepareOutputForPersistence`

Written before any code change. This closes the half of T41 that its own worker reported as
correctly out of ownership: `T41-implementation.md` §"Defect 3", `T41-spec.md` §7, and
`T24-recheck2.md` finding `T24R2#F-002` ("`prepareOutputForPersistence` returns only
`{allowed, content}` and drops `redaction` entirely, so every persistence caller … receives the
altered value with no signal at all").

## 1. The defect, restated

`prepareOutputForPersistence` (`src/security/guard.ts:57`) calls `validateSerializedOutput`, which
already computes an `OutputRedaction` outcome (`state: "none" | "redacted" | "format-unsafe"` plus
`reasons`) and, on the allowed branch, the exact bytes it is returning. Today the function discards
both and returns only `{ allowed: true; content: string }`. A caller — every durable sink
(`src/memory/write.ts`, `src/wiki/service.ts`, `src/wiki/enrich.ts`, `src/sac/wiki-owner-writer.ts`,
`src/sac/session-wrap-up.ts`, `src/gdskills/project-skills.ts`, `src/metrics/lifecycle.ts`,
`src/testing/service.ts`, `src/testing/coverage-map.ts`, `src/commands/workspace.ts`,
`src/harness/tool/builtin/workspace-lifecycle-tool.ts`) — cannot tell three outcomes apart even
though the underlying validator already distinguished them:

1. the returned bytes are the caller's original bytes, untouched;
2. the returned bytes are a re-serialized/masked form because content was redacted (a secret, PII,
   or an exfil span was found and replaced); and
3. the returned bytes are the canonical form because the original bytes carried a duplicate JSON
   member whose earlier value `JSON.parse` silently drops (T24 F-002's class — the safe canonical
   form is emitted specifically because the walk could not prove those bytes faithful).

The correctness defect T24R2#F-002 named (a lossy re-serialization of an out-of-range integer) is
already fixed at the source by T41 — `validateSerializedContentForTransport` now returns the
original bytes whenever they are a structurally faithful spelling of the validated value, never a
re-serialized different number. What remains, and what this task closes, is purely the *signal*.

## 2. The change

Widen `prepareOutputForPersistence`'s return type additively. Starting point is the exact snippet
`T41-implementation.md` §"Defect 3" wrote out, re-verified against the current file (re-read at
`src/security/guard.ts:57`, matching the line number the previous worker cited even though the file
has since gained the T37 manifest/config posture logic elsewhere):

```ts
export function prepareOutputForPersistence(
  guard: GuardResult,
  original: string,
):
  | {
      allowed: true;
      content: string;
      redaction: Extract<OutputRedaction, { state: "none" | "redacted" }>;
      bytesPreserved: boolean;
    }
  | { allowed: false; reason: string; redaction?: Extract<OutputRedaction, { state: "format-unsafe" }> } {
  if (!guard.allowed) {
    return { allowed: false, reason: guard.reason ?? "security gate blocked" };
  }
  const safe = validateSerializedOutput(guard.redacted ?? original);
  return safe.ok
    ? {
        allowed: true,
        content: safe.text,
        redaction: safe.redaction,
        bytesPreserved: safe.text === original,
      }
    : {
        allowed: false,
        reason: "format-unsafe: output cannot be persisted safely",
        redaction: safe.redaction,
      };
}
```

### One deviation from the proposal's literal types, decided before coding

The proposal typed `redaction` as the full `OutputRedaction` union on both branches. `OutputRedaction`
already has the narrower shape available: `validateSerializedOutput`'s own return type
(`OutputValidationResult`) types the `ok:true` branch's `redaction` as
`Extract<OutputRedaction, { state: "none" | "redacted" }>` and the `ok:false` branch's as
`Extract<OutputRedaction, { state: "format-unsafe" }>` — `safe.redaction` already carries that exact
narrowed type at the call site. Declaring `prepareOutputForPersistence`'s return type with the same
`Extract<...>` narrowing (rather than the wider `OutputRedaction`) is not a behavior change — the
runtime value is identical either way — but it lets a caller's type system rule out
`state:"format-unsafe"` on the allowed branch and rule out `state:"none"|"redacted"` on the refused
branch, which is exactly the "reads naturally against the surrounding code" the dispatch asked this
worker to verify. `guard.ts` already imports the wider `OutputRedaction` type only to re-export it;
this task adds a genuine local type-only import (`import type { OutputRedaction } from
"./output-validation";`) so the `Extract<...>` expressions resolve, and keeps re-exporting the name so
no importer of `type { OutputRedaction } from "./guard"` is affected.

No other deviation. `bytesPreserved` compares the final `safe.text` against `original` — the
argument passed in, not `guard.redacted ?? original` — so a caller finds out whether it is getting
back the literal bytes it started with, not merely whether the floor's own structural walk left
`guard.redacted` untouched. That matches the acceptance criterion's wording ("whether the returned
bytes are the original ones") and is what the proposal already wrote.

### Why the refused branch's `redaction` field is optional, not always present

Two distinct causes reach `allowed: false`:

- `!guard.allowed` — the security engine's own gate decision already refused the write (a
  `SecurityDecision`, a different shape entirely: `gate`/`action`/`findings`, not
  `state`/`reasons`). There is no `OutputRedaction` value to attach here; forcing one would be
  fabricated. This sub-case has no `redaction` key, matching current behavior for `reason`-only
  refusals (verified: none of the ten production callers found in §3 read a `redaction` key off a
  refused result, so this remains additive there too).
- `!safe.ok` (`validateSerializedOutput` returned `format-unsafe`) — this is the case that has a real
  `OutputRedaction`, and it is attached.

The acceptance criterion "the refused branch also carries its outcome" is met by the second cause,
which is the only one that has an outcome to carry; the first cause's outcome is already fully
described by `reason` (unchanged).

## 3. Callers enumerated before touching the return shape

Method: `bun src/cli.ts ctx rg "prepareOutputForPersistence" src` (2026-09-06T14:53:05Z; raw log
`.metaproject/data/gdctx/raw/2026-09-06T14-53-05-621Z_rg.log`) found every reference across the tree,
then each production call site's surrounding lines were read directly (`Read`, not `ctx run`, since
each excerpt is small and exact line numbers are needed) to see what field it destructures off the
result. A second sweep (`bun src/cli.ts ctx rg "output\.allowed|output\.content|output\.reason|
safeSession\.|safeWrapUp\.|safeDiff\.|materialized\."` over the ten production files;
`.metaproject/data/gdctx/raw/2026-09-06T14-53-16-864Z_rg.log`) confirmed the exact field accesses.

Production callers (10 files, all read in full at the call site):

| File | Fields read off the result |
|---|---|
| `src/memory/write.ts:101-103` | `.allowed`, `.reason`, `.content` |
| `src/wiki/service.ts:829-841` | `.allowed`, `.reason`, `.content` |
| `src/wiki/enrich.ts:856-880`, `:1133` | `.allowed`, `.reason`, `.content` |
| `src/sac/wiki-owner-writer.ts:129-132` | `.allowed`, `.reason`, `.content` |
| `src/sac/session-wrap-up.ts:140-153` | `.allowed`, `.reason` (via a ternary over three results) |
| `src/gdskills/project-skills.ts:269-277` | `.allowed`, `.reason`, `.content` |
| `src/testing/service.ts:162-171` | `.allowed`, `.content`, `.reason` |
| `src/testing/coverage-map.ts:239-247` | `.allowed`, `.content`, `.reason` |
| `src/commands/workspace.ts:113-120` | `.allowed`, `.reason`, `.content` |
| `src/harness/tool/builtin/workspace-lifecycle-tool.ts:220-229` | `.allowed`, `.reason`, `.content` |

None destructures the result, spreads it into an object compared by exact shape, or otherwise depends
on the result having exactly two/three keys. Every one reads only `allowed`/`content`/`reason`, so
adding `redaction` and `bytesPreserved` is additive for all ten.

Test callers (found by the same `ctx rg`):

| File | What it does with the result |
|---|---|
| `src/security/persistence-sinks.test.ts` (owned by this task) | Multiple `toEqual` assertions on the **whole** result object at lines 24 and 39 (exact-shape, will break — widened by this task, §4) plus `.allowed`/`.content` field reads elsewhere (unaffected) |
| `src/security/detect/exfil.test.ts:339` (NOT owned by this task — actively being edited by the concurrent T37/exfil worker, git status shows it modified with a 272-line diff in progress) | `expect(prepareOutputForPersistence(GUARD_PASS, clean)).toEqual({ allowed: true, content: clean })` — an exact-shape assertion on the whole result object. **This will start failing once `redaction`/`bytesPreserved` are added**, because `toEqual` fails on an actual object carrying keys the expected object does not have. |

This second row is the one caller this task cannot make safe without touching a file outside its
grant (`src/security/guard.ts`, `src/security/guard.test.ts`,
`src/security/persistence-sinks.test.ts`, and additive `types.ts` only — "nothing else"). It is not a
case of "another file must change to *implement* this task" (the implementation is complete and
correct without touching it), so it is not a `STATUS: BLOCKED` trigger — it is a known, disclosed
side effect on a file this task is explicitly forbidden to edit because a concurrent worker owns it.
Recorded here before coding, reported again in `T44-implementation.md` and in the final STATUS
response as a concern, exactly as `T41-implementation.md` disclosed the guard.ts/persistence-sinks
conflict it found in the other direction.

## 4. Existing assertions that must be widened (owned files only)

`src/security/persistence-sinks.test.ts`:

- Line 24: `expect(prepareOutputForPersistence(pass, "token=raw")).toEqual({ allowed: true, content:
  "token=raw" })` — `"token=raw"` is not valid JSON, so it takes the text branch; nothing matches, so
  `redaction: { state: "none", reasons: [] }` and `bytesPreserved: true`. Widened to expect those two
  extra fields.
- Line 39 (first assertion in "materializer uses the guard's redacted output and refuses blocked
  writes"): `expect(prepareOutputForPersistence(redacted, "token=raw")).toEqual({ allowed: true,
  content: "token=[REDACTED]" })` — `guard.redacted` is `"token=[REDACTED]"`, not itself further
  redacted by the floor (`state:"none"`), but not equal to `original` (`"token=raw"`), so
  `bytesPreserved: false`. Widened accordingly. The second assertion in the same test (the blocked
  branch, `{ ...redacted, allowed: false, reason: "blocked" }`) is untouched: `!guard.allowed` short
  circuits before `redaction` exists, so its expected shape does not change.

No other assertion in this file compares the whole result object by exact shape (verified by reading
the file in full); the rest read `.allowed`/`.content` individually or use `toMatchObject`, which
already ignores extra keys.

## 5. Regressions to add (RED before GREEN), distinguishing the three outcomes

All in `src/security/persistence-sinks.test.ts`, extending the existing fixtures rather than adding
parallel ones, plus one end-to-end regression in `src/security/guard.test.ts` that drives the same
distinction through the real `guardOutput()` (not a hand-built `GuardResult`), so the signal is proven
at both the unit and the integration layer:

1. **Bytes preserved unchanged** — the widened line-24 assertion above already is this regression:
   before this change `redaction`/`bytesPreserved` do not exist on the result at all, so the widened
   `toEqual` fails (RED); after, it passes with `bytesPreserved: true`, `redaction.state: "none"`.
2. **Content masked** — extend "materializer applies the secret floor even when a guard omitted
   redaction" (currently asserts only `.content` and `JSON.parse(...)`) to also assert
   `output.redaction.state === "redacted"`, `output.redaction.reasons` contains a secret policy id,
   and `output.bytesPreserved === false`. Also extend the numeric-credential refusal in the same test
   (`{ password: 123456789 }`) to assert the refused result's `redaction` equals
   `{ state: "format-unsafe", reasons: ["sensitive-numeric-field"] }` — this is the "refused branch
   also carries its outcome" half of the acceptance criterion.
3. **Duplicate member dropped** — extend the `DUPLICATE_MEMBER_SHAPES` loop (five shapes, already
   proving the credential never survives) to also assert `output.redaction.state === "redacted"`,
   `output.redaction.reasons` contains `"serialized-content-normalized"`, and
   `output.bytesPreserved === false` for every shape — this is exactly the scenario named in the
   dispatch: "a duplicate member dropped so the safe canonical form was emitted."
4. **End-to-end, in `src/security/guard.test.ts`** — one new test that calls the real `guardOutput()`
   against a temp workspace with `security: true, mode: "advisory"` on content carrying a real secret,
   pipes the result through `prepareOutputForPersistence`, and asserts `bytesPreserved === false` with
   `redaction.state === "redacted"` and the secret absent from `content` — proving the signal survives
   the full seam, not only a hand-built `GuardResult` fixture.

Not touched: `src/security/detect/exfil.test.ts` (out of ownership, disclosed in §3),
`src/security/output-validation.ts` / `.test.ts` (T41's rule, must stay green, no reason to touch it),
`src/security/service.ts` (`validateSerializedOutput` needs no change — it already returns the
`redaction` this task threads through), `src/security/types.ts` (no type there needs widening;
`GuardResult` itself is unchanged, and `OutputRedaction` already exists in `output-validation.ts`).

## 6. Baseline, executed through `bun src/cli.ts ctx run`, before any edit

`bun src/cli.ts ctx run -- bun test src/security/guard.test.ts src/security/persistence-sinks.test.ts
src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts
src/security/service.memo.test.ts` — recorded in `T44-implementation.md` §"Evidence" with the raw log
path, run before the widened assertions are written (so the RED step is the widened assertions
failing against the current two-field return shape, not this baseline run, which passes with the
current test file).

## 7. Verification plan

1. Write the widened assertions and new regressions first (RED): run the focused suite, confirm
   `persistence-sinks.test.ts` fails exactly at the widened/new assertions and nothing else moves.
2. Implement the `guard.ts` change (GREEN): re-run the same focused suite, confirm 0 failures.
3. Run `bun run typecheck` and `bunx eslint` on every changed file.
4. Confirm the mandated suite list stays green with exact counts, and record raw log paths for
   before/after.
5. Do not run `src/security/detect/exfil.test.ts` as part of this task's verification (it is not in
   the mandated list) but note in the implementation report that it is expected to start failing at
   line 339 until its owner widens that one assertion, and why.
