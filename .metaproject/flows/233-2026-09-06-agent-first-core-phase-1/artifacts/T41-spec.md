# T41 spec — stop canonical re-serialization from altering meaning and from losing the redaction signal

Written before any code change. Baseline probes were executed first (raw logs in §6).

## 1. The two defects, restated from the reviewer's own measurements

**T24R2#F-002 (major).** `validateSerializedContentForTransport` decides byte preservation by the
textual test `withoutInsignificantWhitespace(content) === JSON.stringify(validatedValue)`. When that
test fails the *canonical re-serialization* is substituted. For a number literal outside IEEE-754
double range the substitution is lossy — `{"n":12345678901234567890}` comes back
`{"n":12345678901234567000}` — and `-0` comes back `0`. The floor therefore changes the value it
exists to protect. `prepareOutputForPersistence` returns only `{allowed, content}` and drops the
`redaction` object, so a durable sink receives the altered bytes with no signal at all.

**T24R2#F-003 (minor).** The same textual test fails for a payload whose only divergence is
*spelling*: a non-ASCII character written `—`, a solidus written `\/`, `1.0` for `1`, or an
integer-like key that `JSON.parse` reorders. Nothing sensitive is present and nothing is removed, yet
the bytes are rewritten and the result is labelled `state:"redacted"` with
`serialized-content-normalized`. Measured baseline: **22 of 2047** repository JSON files.

## 2. Decision: preserve byte-exactly, do not refuse

The governing text is `docs/requirements/keryx-agent-first-core/policies.md` §"Redaction и security
scan", line 20:

> Если safe часть сохраняет operation schema, вернуть её и `redaction.state=redacted` с безопасной
> причиной … Если схема не допускает маркер … и нет предусмотренного safe representation —
> `format-unsafe`.

`format-unsafe` is reserved for a structure with **no safe representation**. For
`{"n":12345678901234567890}` a safe representation demonstrably exists: the original bytes. The
structural walk already validated the parsed structure and found nothing to remove; the original
literal is a faithful spelling of that same safe structure, and returning it preserves the operation
schema exactly. Refusing it would be the false rejection T24R#F-003 recorded as a defect, not
caution. **Decision: preserve the original bytes byte-exactly. Never re-emit a different number, and
never refuse a payload whose bytes are a faithful spelling of a structure the walk approved.**

The same decision resolves F-003 in one rule rather than two: escape spelling is also a faithful
spelling, so those payloads are preserved with `state:"none"` and no redaction is claimed.

## 3. The rule that replaces the textual comparison

Replace `bytesAreCanonicalFor(content, canonicalText)` — a comparison of two *strings* — with
`bytesAreFaithfulTo(content, validatedValue)` — a comparison of the byte stream against the
*structure* the walk validated.

A literal-faithful scanner walks the original bytes in lockstep with `validatedValue`:

| Node | Congruent when |
|---|---|
| object | every member's decoded key is a key of the expected object, **no key appears twice**, each member value is congruent, and the member count equals the expected key count. Member *order* is not compared. |
| array | same length, element-wise congruent. |
| string | the literal decoded with `JSON.parse` equals the expected string (so `—`, `\/` and `A` are congruent to the characters they spell). |
| number | `Number(rawLiteral) === expected` (so `1e3`, `1.0`, `12345678901234567890` and `-0` are congruent to the doubles they parse to). |
| `true` / `false` / `null` | exact keyword. |

Trailing content after the top-level value, or any anomaly the scanner cannot follow, is **not**
congruent — the scanner fails closed to the canonical form, never to preservation.

### Why this cannot become the hiding channel the previous rule closed

The class T24 F-002 closed is: a duplicate serialized member whose dropped value carries content the
walk never saw, because `JSON.parse` keeps only the last occurrence.

- The object rule deletes each matched key from the expected set and refuses a key it has already
  seen. A duplicate member therefore fails congruence **before** its value is even inspected —
  regardless of what it holds, how it is escaped, how it is padded with whitespace, how deep it sits,
  or whether the duplicate is spelled in the *key* (`"k"` vs `"k"`, which decode identically and
  so collide in the same map).
- Congruence proves a stronger property than the old string test: every decoded scalar and every
  decoded key in the byte stream is *equal to* the corresponding member of the structure the walk
  validated, and there are no extra members. So the bytes decode, in any conformant JSON consumer, to
  exactly the value the floor approved. There is nothing left over to hide anything in.
- For valid JSON — and `JSON.parse` has already succeeded at this point — the **only** way the text
  can carry more than its parse is a duplicate object member. Congruence failure and
  "content was dropped" are therefore the same event, which is what makes the surviving
  `state:"redacted"` label truthful rather than a false claim (F-003's complaint).
- Whitespace between tokens is skipped and carries no content; whitespace *inside* a string literal
  is part of the literal and is compared through the decoded value.
- `format-unsafe` stays reachable only from the structural walk. This change touches no failure path.

## 4. Persistence signal

`prepareOutputForPersistence` must carry the floor's `redaction` outcome instead of discarding it, so
a caller can distinguish a byte-preserved result from a re-serialized one. **That function lives in
`src/security/guard.ts:52`, not in `src/security/service.ts`** as the dispatch states, and both
`src/security/guard.ts` and the two exact-equality assertions in
`src/security/persistence-sinks.test.ts:24,39` that would have to accept the new field are outside
this dispatch's ownership (`guard.ts` is named as a concurrent worker's file). See §7.

## 5. Regressions to add (RED before GREEN), in `src/security/output-validation.test.ts`

1. `an out-of-double-range integer literal survives byte-exactly` — `{"n":12345678901234567890}` and
   a nested/array variant come back byte-identical, `state:"none"`, and the low digits are intact.
2. `negative zero keeps its sign` — `{"n":-0}` byte-identical, `state:"none"`.
3. `value-preserving spellings are not reported as a redaction` — `\uXXXX` escape spelling, escaped
   solidus, `1.0`, `1e3`, and an integer-like key order all byte-identical with `state:"none"`.
4. `a duplicate member is still not preserved when its spelling is faithful` — the five committed
   duplicate shapes plus an escape-spelled duplicate key stay `state:"redacted"` and secret-free
   (the rule must not be weakened by the new congruence).
5. `trailing bytes after the top-level value are never preserved` — fail-safe control.

Existing tests that must keep passing untouched: every test in
`src/security/output-validation.test.ts`, the five `DUPLICATE_MEMBER_SHAPES` in
`src/security/persistence-sinks.test.ts`, `src/mcp/structural-redaction.test.ts`,
`src/security/detect/exfil.test.ts`, `src/mcp`.

## 6. Baseline (before), executed through `bun src/cli.ts ctx run`

- repository JSON sweep: `filesScanned 2047, unparseable 0, bytePreserved 1974, rejected 0,
  normalizedOnly 22, redactedForContent 51` —
  raw `.metaproject/data/gdctx/raw/2026-09-06T14-39-12-894Z_run.log`
- validator probe: `f002.bigIntegerPrecision` and `f002.negativeZero` `state=redacted
  reasons=serialized-content-normalized bytesRestored=false`; `escapeSpelling`, `solidusEscape`,
  `exponentSpelling`, `trailingZeroDecimal`, `integerLikeKeyOrder`, `unicodeKeyOrder` likewise —
  raw `.metaproject/data/gdctx/raw/2026-09-06T14-39-19-674Z_run.log`

## 7. Ownership conflict recorded before coding

The dispatch grants "the `validateSerializedOutput` and `prepareOutputForPersistence` regions of
`src/security/service.ts`". `prepareOutputForPersistence` is not in that file. Implementing the
persistence signal requires `src/security/guard.ts` (owned by a concurrent worker, explicitly
out of bounds) and a two-line assertion update in `src/security/persistence-sinks.test.ts`. Per the
dispatch's own instruction — "If you believe another file must change, stop and reply STATUS:
BLOCKED naming the exact change" — that half is reported, not performed. §2 and §3 remove the
correctness defect at its source, so no persistence caller receives an altered number regardless.
