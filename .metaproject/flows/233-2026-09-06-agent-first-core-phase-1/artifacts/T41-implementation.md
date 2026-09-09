# T41 implementation — stop canonical re-serialization from altering meaning and from losing the redaction signal

Spec written before coding: `T41-spec.md`. Reviewer's probes were run before any edit (§4, "before").

## Defect 1 — T24R2#F-002: an out-of-double-range integer and `-0` came back as different numbers

### Decision: preserve the original bytes byte-exactly. Not `format-unsafe`, and never a different number.

`policies.md` §"Redaction и security scan" line 20 is the governing text: *return the safe part with
`redaction.state=redacted` when it preserves the operation schema; use `format-unsafe` only when the
schema admits no marker and there is no provided safe representation.* For
`{"n":12345678901234567890}` a safe representation demonstrably exists — the original bytes. The
structural walk validated the parsed structure and removed nothing; the original literal is a
faithful spelling of that same approved structure, so returning it preserves the operation schema
exactly and preserves the value exactly. Refusing it would be a false rejection of a payload with a
safe representation, which `policies.md` calls the defect rather than the caution, and which
T24R#F-003 already recorded once. Re-serializing it is worse still: the floor would emit a
corrupted identifier, silently.

### How

`bytesAreCanonicalFor(content, canonicalText)` compared two **strings**: the original with
inter-token whitespace stripped, against `JSON.stringify(validatedValue)`. That test answers "no" for
a payload that merely *spells* the same structure differently, and the substitution it then makes is
not always the same value.

It is replaced by `bytesAreFaithfulTo(content, validatedValue)`, which compares the byte stream
against the **structure** the walk validated. A scanner walks the original bytes in lockstep with the
validated value:

- **object** — each member's decoded key must be a key of the expected object that has **not already
  been consumed**; each member value must match; at the close, every expected key must have been
  matched. Member order is free.
- **array** — same length, element-wise.
- **string** — the literal decoded with `JSON.parse` must equal the expected string.
- **number** — `Number(rawLiteral) === expected`, so `1e3`, `1.0`, `-0` and an integer beyond double
  range are all faithful spellings of the double the walk saw, and the *literal* is what survives.
- keywords — exact.
- Anything the scanner cannot follow, and any trailing content, is **not** faithful; it falls back to
  the canonical form. Preservation is never the fallback.

`src/security/output-validation.ts:563` now reads
`bytesAreFaithfulTo(content, result.value) ? { ...result, text: content } : { …canonical, state:"redacted" }`.

### Why this does not hand back the hiding channel the previous rule closed

The class T24 F-002 closed is a duplicate serialized member whose dropped value carries content the
walk never saw. The object rule deletes each matched key from the expected set and refuses a key it
has already seen, so a duplicate fails **before its value is read** — whatever it holds, however it
is escaped, padded, or nested, and whether the duplication is spelled in the value or in the key
(`"k"` and `"k"` decode to the same key and collide in the same map).

Congruence is strictly stronger than the string test it replaces: it proves that every decoded key
and every decoded scalar in the byte stream equals the corresponding member of the approved
structure and that no extra member exists. The bytes therefore decode, in any conformant JSON
consumer, to exactly the value the floor approved.

It also makes the surviving label truthful. For valid JSON — and `JSON.parse` has already succeeded
at this point — the only way the text can carry more than its parse is a duplicate object member. So
"not faithful" and "a member was dropped" are the same event, and `state:"redacted"` /
`serialized-content-normalized` now names a real removal in every case that reaches it.

`format-unsafe` is untouched: it is still reachable only from the structural walk. All five committed
duplicate-member shapes, the fourteen the reviewer added, `duplicateSurvivorNumericCredential` and
`duplicateSecretKey` behave exactly as before (§4).

## Defect 2 — T24R2#F-003: a rewrite that removed nothing was labelled a redaction

Fixed by the same rule, not by a second one. Escape spelling (`—`, `’`, `\/`),
value-preserving number spelling (`1.0`, `1e3`) and `JSON.parse`'s integer-like key reordering are
all faithful spellings, so those payloads are now returned byte-for-byte with `state:"none"` and no
redaction is claimed. The reason token and the state machine are unchanged, so no caller contract
moved; what changed is that the branch that claims a redaction is no longer reached by payloads with
nothing removed.

Repository corpus: **22 → 0** mislabelled files, with byte-preserved **1974 → 1996** and rejections
**0 → 0** (§4).

## Defect 3 — the persistence signal: NOT IMPLEMENTED, out of ownership

`prepareOutputForPersistence` is at **`src/security/guard.ts:52`**, not in `src/security/service.ts`
as the dispatch's ownership line states. Carrying the redaction outcome requires:

1. `src/security/guard.ts:52-63` — widen the return type and populate it:

```ts
export function prepareOutputForPersistence(
  guard: GuardResult,
  original: string,
):
  | { allowed: true; content: string; redaction: OutputRedaction; bytesPreserved: boolean }
  | { allowed: false; reason: string; redaction?: OutputRedaction } {
  if (!guard.allowed) {
    return { allowed: false, reason: guard.reason ?? "security gate blocked" };
  }
  const safe = validateSerializedOutput(guard.redacted ?? original);
  return safe.ok
    ? { allowed: true, content: safe.text, redaction: safe.redaction, bytesPreserved: safe.text === original }
    : { allowed: false, reason: "format-unsafe: output cannot be persisted safely", redaction: safe.redaction };
}
```

2. `src/security/persistence-sinks.test.ts:24` and `:39` — two `toEqual` assertions that pin the
   result shape exactly and would have to accept the new fields (a strengthening, not a weakening).

Both files are outside this dispatch's ownership, and `src/security/guard.ts` is named as a
concurrent worker's file with an explicit "stay entirely out". Per the dispatch's own instruction —
"If you believe another file must change, stop and reply STATUS: BLOCKED naming the exact change" —
this half is reported rather than performed.

Worth recording for whoever picks it up: the **correctness** defect is gone at its source. No
persistence caller can now receive a re-serialized number, because such a payload is byte-preserved.
What remains missing is the *signal* — a caller still cannot tell a byte-preserved result from one
whose duplicate member was dropped, or from one the guard redacted.

## 4. Evidence — exact counts, before and after

All commands ran through `bun src/cli.ts ctx run`. Raw logs under
`/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

### Reviewer's repository JSON sweep (`T24-recheck2-repojson.ts`, unmodified)

| | files | unparseable | byte-preserved | rejected | normalized-only (mislabelled) | redacted-for-content |
|---|---|---|---|---|---|---|
| before | 2047 | 0 | **1974** | **0** | **22** | 51 |
| after | 2047 | 0 | **1996** | **0** | **0** | 51 |

- before: `2026-09-06T14-39-12-894Z_run.log`
- after: `2026-09-06T14-43-05-512Z_run.log`
- re-run on the final shipped code (one extra file in the tree — `T41-result.json`):
  `2026-09-06T14-48-06-435Z_run.log` — `filesScanned 2048, unparseable 0, bytePreserved 1997,
  rejected 0, normalizedOnly 0, redactedForContent 51`.

No regression in byte-preserved (+22, exactly the 22 previously mislabelled files), no new rejection,
no change in the content-redacted set.

### Reviewer's validator probe (`T24-recheck2-validator.ts`, unmodified)

- before: `2026-09-06T14-39-19-674Z_run.log`
- after: `2026-09-06T14-43-13-396Z_run.log`

Changed, exactly as intended — eight cases move from *rewritten and labelled redacted* to
*byte-preserved, no redaction claimed*:
`bigIntegerPrecision`, `negativeZero`, `exponentSpelling`, `trailingZeroDecimal`,
`integerLikeKeyOrder`, `escapeSpelling`, `solidusEscape`, `unicodeKeyOrder` —
all `state=none reasons= bytesRestored=true` (was `state=redacted
reasons=serialized-content-normalized bytesRestored=false`).

Unchanged, verified case by case: all thirteen duplicate shapes still
`state=redacted reasons=serialized-content-normalized bytesRestored=false leaksSecret=false
leaksCred=false`; `duplicateSurvivorNumericCredential` still `format-unsafe/sensitive-numeric-field`;
`duplicateSecretKey` still `format-unsafe/sensitive-property-name`; every ROW1 property-name verdict,
every ROW3 `$ref` verdict, every byte-preservation control, and all five T19 contract controls
identical.

### Focused suites

`bun src/cli.ts ctx run -- bun test src/security/output-validation.test.ts
src/security/persistence-sinks.test.ts src/mcp/structural-redaction.test.ts
src/security/detect/exfil.test.ts src/mcp` → **252 pass, 3 skip, 0 fail, 1081 assertions**.
Raw: `2026-09-06T14-42-55-342Z_run.log`.

### New regressions — failing before, passing after

Added to `src/security/output-validation.test.ts`:

| test | before | after |
|---|---|---|
| an out-of-double-range integer literal survives byte-exactly | FAIL — `{"n":12345678901234567890}` → `{"n":12345678901234567000}` | PASS |
| negative zero keeps its sign instead of being re-emitted as zero | FAIL — `{"delta":-0,"other":[-0]}` → `{"delta":0,"other":[0]}` | PASS |
| value-preserving spellings are preserved and never reported as a redaction | FAIL — `—` rewritten to `—`, state `redacted` | PASS |
| a faithfully spelled duplicate member is still replaced by the canonical form | PASS (guard rail — must not regress) | PASS |
| surrounding and inter-token whitespace is still preserved, extra members are not | PASS (guard rail) | PASS |

RED run: `2026-09-06T14-41-50-948Z_run.log` — **17 pass, 3 fail**.
GREEN run: `2026-09-06T14-42-47-939Z_run.log` — **20 pass, 0 fail, 167 assertions**.

The persistence-signal regression named in the dispatch was **not** written: it would have to assert
on `prepareOutputForPersistence`'s shape in `src/security/persistence-sinks.test.ts`, which is out of
ownership.

### Typecheck and lint on every changed file

- `bun run typecheck` → exit 0. Raw: `2026-09-06T14-44-10-668Z_run.log`.
- `bunx eslint src/security/output-validation.ts src/security/output-validation.test.ts
  src/mcp/redact-seam.ts` → exit 0, no output. Raw: `2026-09-06T14-44-17-883Z_run.log`.

Re-run after the final refactor (hoisting the JSON keyword table out of the scalar branch, behaviour
neutral), all on the shipped code:

- focused suites → **252 pass, 3 skip, 0 fail**. Raw: `2026-09-06T14-47-35-651Z_run.log`.
- `bun run typecheck` → exit 0. Raw: `2026-09-06T14-47-50-100Z_run.log`.
- `bunx eslint` on the same three files → exit 0. Raw: `2026-09-06T14-47-51-195Z_run.log`.

### Wider safety net

- `bun test src/memory src/wiki src/gdctx src/metrics src/sac` (every durable sink that consumes the
  floor) → **772 pass, 0 fail**. Raw: `2026-09-06T14-45-17-960Z_run.log`.
- `bun test src/security` → 210 pass, **6 fail**. All six are `T37 D1/D1b/D2/D2b/D3/D3b` in
  `src/security/guard.test.ts` — the concurrent T37 worker's in-flight RED tests about
  `metaproject.json` / `security.config.json` posture handling and the coverage fold. None of them
  touches serialization; none is caused by this change; the focused suite that covers this change is
  fully green. Raw: `2026-09-06T14-44-48-440Z_run.log`.

## 5. Files changed

- `src/security/output-validation.ts` — replaced `withoutInsignificantWhitespace` /
  `bytesAreCanonicalFor` with the literal-faithful scanner (`bytesAreFaithfulTo` and its helpers);
  the substitution site and the adapter doc comment now describe structural congruence.
- `src/security/output-validation.test.ts` — five new regressions (three RED for the defects, two
  guard rails for the rule that must not weaken). No existing test changed or removed.
- `src/mcp/redact-seam.ts` — comment only, so the seam's description of the rule stays true.

Not touched: `src/security/service.ts` (the `validateSerializedOutput` adapter needed no change — the
rule lives with the floor, deliberately), `src/security/guard.ts`, `src/security/detect/exfil.ts`,
`src/security/config.ts`, `src/security/path-scan.ts`, every test outside
`src/security/output-validation.test.ts`, the reviewer's probes, and every flow artifact except the
three this task is required to write.

## 6. Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the file set exactly, and the graph
  answers from the last build while the tree carries a large uncommitted multi-worker change set, so
  a graph answer could not be quoted as current. The one cross-file enumeration needed (callers of
  `prepareOutputForPersistence`) came from `ctx rg` over the current tree.
- `wiki_used: no (not-relevant)` — the governing texts are
  `docs/requirements/keryx-agent-first-core/policies.md`, the flow's `acceptance-criteria.md` and the
  reviewer's `T24-recheck2.md`; all were read directly.
- `ctx_used: yes` — every command, code search, probe and test run went through
  `bun src/cli.ts ctx run` / `ctx rg`.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find` over project code. Two bounded reads of
  gdctx raw logs used the documented `# keryx:raw` escape, with the reason stated inline: ctx
  compaction drops the per-case probe statuses and the per-test fail lines that are the evidence
  here.
