# T85 — spec: close T84#F-001 (unmemoised destination read) and T84#F-003 (escape-blind description pairing)

Scope, verbatim from the dispatch: the two fixable findings of T84. **T84#F-002 (reference definitions
inside container blocks) is accepted and documented by decision of the user and is not mine to revisit**;
I add no container handling and no external markdown parser. T84#F-004 is a record correction with no
code. Files I may touch: `src/security/detect/exfil.ts` and `src/security/detect/exfil.test.ts` only.
`docs/requirements/keryx-agent-first-core/policies.md` is the orchestrator's, not mine.

## Baseline, measured before any edit (this tree, `codex/agent-first-core`)

`src/security/detect/exfil.ts` hashes `63ea36a6606edd2b6d734d2ee0efc10ab146dd223d348a81c87a4f5eb3d623d0`
— byte-identical to the hash T83 recorded at the end of its round and T84 re-recorded at the end of
its review, so the tree is the one both of them examined.

Three probes, run unmodified before any edit. Raw:
`.metaproject/data/gdctx/raw/T85-before-{destfail-check,destfail-4boundary,T82-cost-ladder}.log`.

| Probe | Result |
|---|---|
| `T84b-destfail-check.ts` | `destFailWhitespaceTail` 450.1 → 1 773.9 → 7 018.0 ms across 50 001 → 100 000 → 200 001 bytes (exponent ≈2.0); `destFailNewlineTail` 473.4 → 1 759.1 → 7 079.7 ms; one `redactToolOutput` call at 262 144 bytes: **12 227.5 ms** |
| `T84b-destfail-4boundary.ts` | 196 610 bytes → `{mcp: 6 949.3, persist: 6 952.1, transport: 6 854.9, seam: 6 784.4}` ms, `allOverOneSecond: true` |
| `T82-cost.ts ladder` | `overOneSecond: []`, `superLinear: ["manyDefsThenBangRun"]` — exactly what T83 recorded after its own change |

T84#F-001 reproduces at full strength. Note on the probe's harness: `T84b-destfail-check.ts` compares a
frozen copy at `$T84_TMP/exfil-prechange.ts` against the shipped module. T84's reconstruction (a
pre-T83 copy) no longer exists — its `mkdtemp` directory was removed at the end of that session. I did
not rebuild it: the pre-T83 question is settled and re-asked by nobody in this round. I point
`T84_TMP` at a frozen copy of the **pre-T85** file instead, so the probe's `preMs`/`postMs` columns
become the before/after of *this* change, measured inside the reviewer's own unmodified probe. Before
any edit the two columns agree within noise on all six rows, which is the harness's own sanity check.

## Finding one — T84#F-001, the unmemoised destination read

### The mechanism, re-derived rather than accepted

`readDefinitionDestination(content, afterColon)` sets `REFERENCE_DESTINATION.lastIndex = afterColon`
and execs `/\s*(?:<([^<>\n]*)>|(\S+))/y`. On `"[a\n".repeat(k) + "]:" + " ".repeat(h)`:

- `closes` holds exactly one `]`, at `3k`. Every one of the `k` line starts is `[a`, so every one of
  them passes the line-start test and binary-searches to the same `first = 3k`.
- `content[first + 1] === ":"`, so **reading 1 fires on every line start**, each calling
  `readDefinitionDestination(content, 3k + 2)` — the same offset every time.
- At that offset the remainder is `h` spaces to end of input. `\s*` consumes all `h`, then neither
  `<…>` nor `\S+` can match at end of input; the engine gives back one space at a time and retries the
  alternation, `h` times. One call is Θ(h) and returns `null`.
- `null` means `resumeAt` is **not** advanced (`:811` runs only inside `if (destination)`), so nothing
  suppresses the next line start. `k` line starts × Θ(h) work = Θ(n²).

This is the whole defect. It is on the destination side and touches no part of the label-cost chain.

### The repair

Memoise `readDefinitionDestination` by `afterColon`, mirroring `readInlineDestination`'s existing
memoisation by `descriptionEnd` (`:1027-1055`) — the precedent the reviewer named, in the same file,
for the same reason. A `Map<number, …>` created once per `readReferenceDefinitions` call and passed to
both call sites (`:804` reading 1, `:836` reading 2).

**Soundness.** The regex is sticky, so `exec` can only match at `lastIndex`; the result is therefore a
pure function of `(content, afterColon)`, and `content` is fixed for the lifetime of the map. This is
the identical argument the sibling's comment already makes. The returned object is read-only at both
call sites (`destination.url`, `.start`, `.end`), as it already is for the sibling.

**Behaviour change: none.** A result cache over a pure function cannot change any answer. The
regression that pins it is therefore a *cost* regression, not a behaviour one.

### What it does to the cost argument — the new part, derived not asserted

The label-side chain (keys are the label's bytes up to the first `]` ⇒ no key contains `]` ⇒ candidate
spans carry no bracket ⇒ pairwise disjoint ⇒ total ≤ `content.length`) is **untouched**: this change
adds no candidate span, no key, and no slice.

The destination side gains an argument it never had. With the cache, `readDefinitionDestination` runs at
most once per **distinct** `afterColon` offset. Each run costs Θ(w) where w is the length of the
whitespace run starting at that offset (forward consumption plus one retry per given-back character,
each retry O(1)). Those runs are **pairwise disjoint**:

> Let `o₁ < o₂` be two distinct offsets the scanner passes. Each is the index just past a `:` which is
> itself just past a `]`, so `content[o₂ - 1] === ":"`, a non-whitespace character at index `o₂ - 1 ≥ o₁`.
> The run at `o₁` ends at the first non-whitespace character at or after `o₁`, hence at or before
> `o₂ - 1`. So run(`o₁`) ⊆ [`o₁`, `o₂ - 1`) and run(`o₂`) starts at `o₂`: disjoint.

Total destination work is therefore at most `content.length`, i.e. linear, with no budget and no bound
on any length — the same shape of argument as the label side, and it is what the file was missing.

Cache size is at most one entry per `]:` in the document, i.e. O(n), the same order as `closes`.

## Finding two — T84#F-003, escape-blind bracket pairing on the description side

### The mechanism

`indexContent` (`:570-601`) builds `closes` and `balanced` with a plain stack that reads **every** `]`
as a close. For `![a\]](URL)` the escaped `]` at index 4 is taken as the pair's close, so
`descriptionEnds` offers `balanced = 5` and `first + 1 = 5` — the same wrong position twice — and the
CommonMark-correct end (6, just past the real `]`) is never a candidate. `readInlineDestination` finds
`]` where it needs `(` and the construct is not recognised as an image at all.

### The constraint that shapes the repair

`exfil.ts:529-531` records that escapes are deliberately not honoured **because honouring them would
REMOVE matches**: `![a\](URL)` is flagged today, renders no image, and the floor may not move in the
release direction. Making the stack escape-aware *in place*, as the reviewer's one-line suggestion
reads, does exactly that — it deletes the only candidate end `![a\](URL)` has.

So the repair is **additive, never substitutive**. `descriptionEnds` keeps both existing candidates,
in their existing order, and **appends** up to two escape-aware ones:

| # | End | Status |
|---|---|---|
| 1 | the balanced end over the escape-blind stack | existing, unchanged, still first |
| 2 | the first `]` at any depth | existing, unchanged, still second |
| 3 | the balanced end over an **escape-aware** stack | new, appended |
| 4 | just past the first **unescaped** `]` | new, appended |

deduplicated against each other exactly as 2 is deduplicated against 1 today. Appending rather than
inserting is what makes the change conservative in the direction that matters: `readBracketConstructs`
iterates the ends in order, the inline pass takes the **first** inline construct and the reference pass
breaks at the **first** resolving one, so any construct found today is still found, still first, and
still at the same offset. A new candidate can only produce a construct where none existed.

Candidates 3 and 4 are both kept for the same reason 1 and 2 both are: they catch different shapes.
Candidate 4 closes `![a\]](URL)`, `![a\]][b]` and the rest of T84's class B; candidate 3 closes the
nested spelling `![a[b]\]c](URL)`, where the first unescaped `]` is an inner one and only a depth walk
that ignores the escape reaches the real end.

Both are built only when the document contains a backslash (`content.includes("\\")`, one native scan).
When it does not, the escape-aware structures are the escape-blind ones by reference, ends 3 and 4
deduplicate away, and the cost and memory are byte-for-byte today's.

### What it does to the cost argument — re-derived, because this one does touch the chain

Step (i) — "a key is the label's bytes up to its first `]`, so no key contains `]`" — is a fact about
`readReferenceDefinitions`, the **definition** side. This change is entirely on the **use** side and
does not alter a single key. Step (ii), `normaliseLabel`, is untouched. So the parts of the chain the
dispatch names as load-bearing are not in the blast radius at all.

What is in the blast radius is step (iii), disjointness of candidate spans, and the work per open.
Three claims, each derived:

1. **The new ends add no shortcut/collapsed slicing at all.** For those forms the label span is
   `[open + 1, descriptionEnd - 1)`. A new end is used only when it differs from end 2 (otherwise it
   is deduplicated), and end 2 is just past the **first** `]` at or after `open`. So a differing new
   end is strictly greater, and the span therefore contains that first `]`. `readLabel`'s
   `countInRange(index.closes, start, end) > 0` rejection — which reads the **escape-blind** `closes`
   and is deliberately left reading it — fires in O(log n) and returns `null` **before any slice**.
   The shortcut/collapsed path's total slicing is exactly what it is today.

2. **Full-reference spans stay pairwise disjoint.** For the full form the span is `[d + 1, c)` where
   `content[d] === "["` and `c` is the first `]` at or after `d + 1` — and this lookup keeps using
   `index.closes`, unchanged, which is also what keeps it in agreement with T83's truncated keys (for
   `![a\]][b\]]` the use side must produce `b\`, and it does only if the ref-id close is the
   escape-blind first one). A surviving span carries no `]` and, at the ordinary `[` threshold of 0,
   no `[`; so `d` is the last `[` before `c` and the span is a function of `c` alone. Two spans with
   `c₁ < c₂`: span 2 carries no `]`, and `c₁` is one, so `c₁ ≤ d₂` and the spans are disjoint. Total
   length ≤ `content.length`, independently of how many candidate ends fed them.

3. **Per-open work at most doubles, asymptotically unchanged.** At most 4 candidate ends instead of 2;
   each costs O(log n) binary searches plus, for the full form, a slice already bounded by (2) and by
   `LABEL_WORK_FACTOR * content.length`. `LABEL_WORK_FACTOR` stays a multiplier on the input and is not
   changed, and it is still not a bound on any length.

The one thing (1)-(3) do **not** settle is `BRACKET_OPEN.lastIndex`: a construct found where none was
before advances the scan past an image's description, so opens that are scanned today may be skipped.
That is faithful (an image's description is alt text and a renderer fetches nothing inside it) but it is
a direction this floor is not allowed to move in by argument alone. It is therefore an **empirical**
obligation of this round, not a claim: the parity fuzz below must show zero releases, and every prior
matrix must hash unchanged.

## Tests (RED first), in `src/security/detect/exfil.test.ts`

Each written to fail on the current tree, one per finding as the dispatch requires:

- `T85#F-001 (cost)` — `destFailWhitespaceTail` and `destFailNewlineTail` at the sizes T84 measured,
  plus a shared-`]:`-offset shape and a many-distinct-`]:` shape of my own, under the same 500 ms
  budget the file's other perf tests use. Fails today at ~7 000 ms.
- `T85#F-003 (bypass)` — every escape-blind description spelling T84 named (`b01`, `b02`, `b03`,
  `b05`, `b07`, `b08`, `x09`) plus mine: the nested-balanced spelling, an escaped `]` in a link's text
  wrapping an image, an escaped backslash before a real `]` inside a description (closed today, must
  stay closed), a doubly-escaped close, and the collapsed and nested-in-link forms T84 traced as
  surviving by coincidence — asserted at the detector and at all four public boundaries.
- `T85#F-003 (no release)` — `![a\](URL)`, the shape `:529-531` exists for, still flagged; and the
  candidate-order property: a document that resolves today resolves to the same offset.

## Verification to report

The three probes before and after; all 19 prior matrices before and after by hash via `T83-matrices.sh`;
`T83-parity.ts` and a parity fuzz of my own covering the inline/paren shapes T83's atom set does not
reach, diffed before/after for **releases: 0**; a differential check against `marked` for every new
spelling; `T84-bypass.ts` and `T84-escape.ts` re-run (class B rows must flip, class A rows must not —
they are the accepted limitation); a cost table with exponents over T81's, T82's, T84's and my own
shapes at all four public boundaries up to a megabyte; the benign corpus count; `bun test` on the four
focused suites; `bun run typecheck`; `bunx eslint` on both changed files.
