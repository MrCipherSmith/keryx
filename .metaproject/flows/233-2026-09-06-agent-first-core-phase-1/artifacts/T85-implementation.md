STATUS: DONE_WITH_CONCERNS

# T85 — closing T84#F-001 (unmemoised destination read) and T84#F-003 (escape-blind description pairing)

Scope was the two fixable findings and nothing else. **T84#F-002 — reference definitions inside
container blocks — is accepted and documented by the user's decision and was not revisited**: no
container handling was added, no external markdown parser was adopted, and the twelve class-A rows in
`T84-bypass.ts` plus the five in `T84-escape.ts` still read `BYPASS` after this change, unchanged, by
design. T84#F-004 is a record correction with no code.

Files changed: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`. No change to
`docs/requirements/keryx-agent-first-core/policies.md` — the orchestrator owns it.

`exfil.ts` hashed `63ea36a6606edd2b6d734d2ee0efc10ab146dd223d348a81c87a4f5eb3d623d0` before any edit —
byte-identical to the value T83 recorded at the end of its round and T84 re-recorded at the end of its
review, so this change starts from the tree both of them examined. After:
`4e6668b8295ead46963385553b037d5718d7b35416cfea37bdfcf517e53bb44c`;
`exfil.test.ts` `aec80e0562be8f9964d3b400e9ba756a250289cbb153a4a425dcd2f28ae58e6b`.

## Baseline, reproduced before any edit

Three probes, unmodified. Raw: `T85-before-{destfail-check,destfail-4boundary,T82-cost-ladder}.log`.

| Probe | Before |
|---|---|
| `T84b-destfail-check.ts` | `destFailWhitespaceTail` 450.1 → 1 773.9 → **7 018.0** ms across 50 001 → 100 000 → 200 001 bytes; `destFailNewlineTail` 473.4 → 1 759.1 → **7 079.7**; one `redactToolOutput` at 262 144 bytes **12 227.5 ms** |
| `T84b-destfail-4boundary.ts` | 196 610 bytes → `{mcp: 6 949.3, persist: 6 952.1, transport: 6 854.9, seam: 6 784.4}` ms, `allOverOneSecond: true` |
| `T82-cost.ts ladder` | `overOneSecond: []`, `superLinear: ["manyDefsThenBangRun"]` — exactly T83's recorded values |

T84#F-001 reproduces at full strength, and T84#F-003 reproduces as six `BYPASS` rows in `T84-bypass.ts`
plus `x09EscapeInAltOnly` in `T84-escape.ts`.

**Harness note.** `T84b-destfail-check.ts` compares `$T84_TMP/exfil-prechange.ts` against the shipped
module. T84's reconstruction (a pre-**T83** copy) no longer exists; its `mkdtemp` directory was removed
at the end of that session. I did not rebuild it — the pre-T83 question is settled and this round
re-asks nobody's. `T84_TMP` points at a frozen copy of the pre-**T85** file instead, so the probe's
`preMs`/`postMs` columns are the before/after of *this* change, measured inside the reviewer's own
unmodified probe. Before any edit the two columns agreed within noise on all six rows, which is the
harness's own sanity check.

---

## Finding one — T84#F-001

### The mechanism, re-derived rather than accepted

On `"[a\n".repeat(k) + "]:" + " ".repeat(h)`: `closes` holds one `]`, every one of the `k` line starts
binary-searches to it, `content[first + 1] === ":"` so **reading 1 fires on every line start**, and each
calls `readDefinitionDestination` at the *same* offset. There the remainder is `h` spaces to end of
input: `\s*` consumes all of them, then neither `<…>` nor `\S+` can match at end of input, so the engine
gives back one space at a time and retries — Θ(h) per call, returning `null`. `null` does not advance
`resumeAt` (`:811` runs only inside `if (destination)`), so nothing suppresses the next line start.
`k × Θ(h)` = Θ(n²).

### The repair

`readDefinitionDestination` is memoised by `afterColon`, mirroring `readInlineDestination`'s existing
memoisation by `descriptionEnd` — the precedent the reviewer named, in the same file, for the same
reason. One `Map<number, DefinitionDestination>` per `readReferenceDefinitions` call, shared by both
call sites (reading 1 at `:804`, the escape-aware reading at `:836`).

Sound because the regex is **sticky**: `exec` can only match at `lastIndex`, so the result is a pure
function of `afterColon` over a `content` fixed for the map's lifetime. A result cache over a pure
function changes no answer, which is why the regression that pins it is a **cost** regression.

### What it does to the cost argument

The label chain is untouched — no key, no candidate span, no slice changes. The destination side gains
an argument it never had:

> With the cache the reader runs at most once per **distinct** offset, costing Θ(w) for the whitespace
> run at that offset. Those runs are pairwise **disjoint**: for `o₁ < o₂`, `content[o₂ − 1]` is the `:`
> that produced `o₂`, a non-whitespace character at an index ≥ `o₁`, so the run at `o₁` ends at or
> before `o₂ − 1`. Total destination work ≤ `content.length`.

Linear, with no budget and no bound on any length — the same shape of argument the label side carries.
Pinned empirically by two shapes built to defeat a cache by never repeating an offset:
`destFailManyDistinctOffsets` (exponent 0.80) and `destFailDistinctGrowingRuns` (1.09).

### Measured

| | before | after |
|---|---|---|
| detector, `destFailWhitespaceTail` @ 200 001 B | 6 971.4 ms | **24.9 ms** |
| detector, `destFailNewlineTail` @ 200 001 B | 6 976.5 ms | **6.4 ms** |
| `redactToolOutput` @ 262 144 B | 12 227.5 ms | **28.5 ms** |
| all four boundaries @ 196 610 B | 6 784–6 952 ms | **16.7–24.3 ms**, `allOverOneSecond: false` |

`T84-cost.ts ladder` — **the run T84 abandoned as impractically slow, now completed**:
`overOneSecondAtOrUnderOneMb: []`, `superLinear: []`, every exponent 0.63–1.13.
`destFailWhitespaceTail` at 1 048 576 bytes: **198 325.1 ms → 20.4 ms**.
`T84-cost.ts boundary` — **also abandoned by T84** — completed: `boundariesOverOneSecond: []`.

---

## Finding two — T84#F-003

### The constraint that shaped the repair, and why the one-line suggestion is not it

`exfil.ts:529-531` records that escapes are not honoured **because honouring them would REMOVE
matches**: `![a\](URL)` is flagged today, renders no image, and this floor may not move in the release
direction. Making `indexContent`'s stack escape-aware *in place* — which is how the reviewer's
suggestion reads — deletes the only candidate end that shape has.

So the repair is **additive**. `descriptionEnds` keeps both existing candidates, in order, and appends
two: the balanced end over an escape-aware stack, and the first **unescaped** `]`. Both are kept for the
same reason ends 1 and 2 both are — they catch different shapes. End 4 closes `![a\]](URL)` and the
full-reference spellings; end 3 closes the nested `![a[b]\]c](URL)`, where the first unescaped `]` is an
inner one and only a depth walk reaches the real end. On a document with no backslash the escape-aware
structures **are** the escape-blind ones by reference, both new ends deduplicate away, and cost and
memory are today's exactly.

### The part the argument did not settle, and what measuring it found

Appending guarantees the *candidate set* only grows. It does not settle `BRACKET_OPEN.lastIndex`: a
construct found where none existed advances the scan past a description, so opens scanned today can be
skipped. I wrote that down in the spec as an empirical obligation rather than a claim — and the fuzz
found a real release:

```
a[[a\]\\]: (URL)()](
![bc\](<URL>)
```

The first line's open at index 1 gained an escape-aware balanced end at the `(` on that line; the inline
destination grammar then ran across the newline, matched to the `)` at the end of line 2, and the whole
of line 2 became "inside a link's destination" — so its genuine `![bc\](<URL>)` image stopped being
scanned and stopped being a finding. One document, found by fuzzing, not by reading.

The fix is a rule, not a patch for that document: **a construct that exists only because of an
escape-aware end is flagged, but never moves the scan cursor.** Skipping is an optimisation justified by
a renderer resolving the outer construct, and for a candidate this file added itself that is exactly
what is not yet established. `BracketConstruct` carries `escapeAware`, `descriptionEnds` returns how
many of its ends are escape-blind, and all four cursor writes in the two passes are guarded.

With the guard, the fuzz reports **zero span moves**: not one finding present before is absent after.

### What it does to the cost argument

Steps (i) and (ii) — "a key is the label's bytes up to its first `]`" and `normaliseLabel` — are facts
about the **definition** side and about a function this change does not touch; no key moved. Step (iii)
and the per-open work are re-derived in `exfil.ts` itself and here:

1. **The new ends add no shortcut/collapsed slicing at all.** That span is `[open+1, descriptionEnd-1)`.
   A new end is used only when it differs from the first-`]` end (else deduplicated), so it is strictly
   greater and the span therefore contains that first `]`. `readLabel`'s `countInRange(index.closes, …)`
   rejection reads the **escape-blind** `closes` — deliberately, it is the necessary condition of (2),
   not a faithfulness choice — and fires in O(log n) **before any slice**.
2. **Full-reference spans stay pairwise disjoint.** The span is `[d+1, c)` with `c` the first `]` at or
   after `d+1`, read from the same escape-blind `closes` (which is also what keeps it in agreement with
   T83's truncated keys: `![a\]][b\]]` must produce `b\`, and it does). A surviving span carries no `]`
   and, at the ordinary threshold, no `[`, so it is a function of `c` alone; for `c₁ < c₂` the second
   cannot contain the `]` at `c₁`, so `c₁ ≤ d₂` and they are disjoint. Total ≤ `content.length`,
   however many ends fed them.
3. **Per-open work at most doubles.** Four candidate ends instead of two, each O(log n).
   `LABEL_WORK_FACTOR` is unchanged and is still a multiplier on the input, not a bound on a length.

Empirically: exponents 1.00–1.22 on the seven shapes built to maximise the new ends, none superlinear.

### Measured

Every one of T84's class-B rows closed, at the detector and at all four public boundaries:

| Probe | before | after |
|---|---|---|
| `T84-bypass.ts` | `b01,b02,b03,b05,b07,b08` **BYPASS**, each 0 findings / `state:"none"` / four boundary flags true | all six **closed**, 1 finding / `state:"redacted"` / no boundary carries the host. `b06NestedInLinkEscapedAlt` additionally goes 0 → 1 findings |
| `T84-escape.ts` | `x09EscapeInAltOnly` **BYPASS** | **closed**. Exactly one row changed; `findingWithoutRendererFetch` is the same six ids |
| both | class A: 12 + 5 rows BYPASS | **unchanged** — the accepted limitation |

`T85-marked.ts` (mine): 78 shapes — the twelve the regression pins plus a generated sweep over ten
escaped-`]` positions × six use forms — through `marked` and all four boundaries.
**`bypasses: []`, `rendererFetchesButNoFinding: []`.**

---

## Nothing else moved

### Prior matrices — 18 of 19 byte-identical

`T85-matrices.sh`, run before and after, each hash compared against `T83-after-<p>.log`, the values T84
re-verified. All 18 non-corpus probes: **identical before, identical after, identical to T83**
(`T42-exfil-attack 0646c508…`, `T24-recheck2-exfil 8c9bfec0…`, `T42-charrefs 698d8899…`,
`T53-extract ad20286b…`, `T53-resolve 06037910…`, `T53-base 3416d62e…`, `T53-boundary 398012ce…`,
`T42-boundary 7030455d…`, `T24-recheck2-boundary 83839962…`, `T52-base a04404db…`,
`T46-surfaces d8348c99…`, `T72-md 15866b62…`, `T72-gates e4d04c18…`, `T72-srcset 2e96f8d7…`,
`T72-doc 69df9705…`, `T77-doc bee36307…`, `T78-md 4a9034bc…`, `T78-corpus 3fb901e3…`).

Also byte-identical before and after: `T83-escape 52903b89…`, `T82-escape 9c6fdb9e…`,
`T82-dup d7463e48…`, `T83-parity 569e1cc7…`, and `T82-boundary budget 62595fb8…` — the last equal to
T83's own recorded value, so budget exhaustion still flags and the allowlist still releases.

### The corpus delta, enumerated with the vector rather than narrated (T78#F-003's demand)

`T53-corpus` moved. The **entire** diff of the before and after logs is two lines:

```
"filesScanned": 23466  ->  23513
"elapsedMs":    7081   ->  7557
```

Every finding count is byte-identical: `totalFindings` 635, `filesWithFindings` 104, every `byPolicy`
id, **`benignFilesWithFindings` 16, `benignFindings` 62**, Part B 7 flagged with the same seven ids.
The 47 new files are this round's own logs and artifacts, and none of them carries a finding. **The
benign corpus does not grow**, and the three new over-approximations below have zero instances in
23 513 real files.

Re-run once more with *every* artifact of this round on disk — including `T85-implementation.md`,
`T85-result.json` and the four new probes (`T85-final-T53-corpus.log`): the diff is again exactly
`filesScanned 23513 -> 23527` and `elapsedMs`, and nothing else. T83's spec moved the header because it
quoted `<img src="https://attacker.invalid/…">` verbatim; this round's prose writes `URL` where a host
would sit, so the count is genuinely unchanged rather than incidentally so.

### Differential fuzz

`T85-parity.ts` (mine) — 28 000 documents from a seeded generator over the characters the **description**
side is sensitive to (brackets, backslashes, **parentheses**, angle brackets, `!`, two URLs), half
random atom strings and half generated description × destination × use form. `T83-parity.ts`'s atom set
carries no parenthesis at all, so it never drives the inline destination path, which is the path both
new ends reach — that is why a second fuzz existed to write.

Two questions, and only the second is a safety property:

- **span moves: 0** — not one finding present before is absent after (150 before the cursor guard);
- **host releases: 0** — no attacker host survives redaction after that did not survive before;
- newly masked: 198 documents; additions: 653, and **`additionsWithoutBackslash: 0`** — every added
  finding comes from a document containing a backslash, which is exactly this change's reach.

### False positives, enumerated

Three new over-approximations, all one shape driven three ways: `g_nestedDeep_{inline,inlineAngle,fullRef}`
— `![a[b[c]d]\]e](URL)`, which `marked` renders no image for and which the escape-aware balanced end now
flags. Direction is toward flagging, the remedy is the allowlist, and the benign corpus has zero
instances. The pre-existing over-approximations are all preserved at 1 → 1 findings, including
`![a\](URL)` and `![a\](<URL>)` — the shapes `:529-531` exists for.

### Cost table

Detector ladder to a megabyte, best-of-three (`T85-cost.ts ladder`, `T84-cost.ts ladder`):

| shape | 1 MB ms | exponent | note |
|---|---|---|---|
| `destFailWhitespaceTail` | **20.4** | 0.73 | was 198 325.1 |
| `destFailNewlineTail` | 19.9 | 0.98 | |
| `destFailAngleTail` | 33.5 | 0.65 | |
| `destFailEscapedWhitespaceTail` | 30.2 | 0.63 | |
| `destFailManyDistinctOffsets` | 44.0 | 0.80 | mine — defeats the cache by never repeating an offset |
| `destFailDistinctGrowingRuns` | 10.7 | 1.09 | mine — the disjointness claim's empirical half |
| `escapedCloseRun` | 109.8 | 1.00 | mine |
| `nestedEscapedCloses` | 122.3 | 1.22 | mine |
| `backslashBracketNoise` | 94.0 | 1.22 | mine |
| `escapedCloseRunWithDef` | 264.1 | 1.14 | mine |
| `escapedAltAllResolving` | 74.5 | 0.95 | mine — the repair's own path |
| `resolvingBangUses` | 267.7 | 1.13 | T82's worst, re-measured |
| `escapedDefsAllResolving` | 132.7 | 0.95 | T83's worst, re-measured |

`overOneSecondAtOrUnderOneMb: []` and `superLinear: []` on **both** ladders.

Four public boundaries, best-of-three, to a megabyte: `boundariesOverOneSecond: []` on both sweeps.

> **Worst shape under a megabyte and its cost: T82's own `resolvingBangUses` at 1 048 576 bytes —
> 691.2 ms at `prepareOutputForPersistence`.** Pre-existing, and consistent with T82's own 676.8 ms and
> T83's 715.4 ms. The worst of my own shapes is `escapedCloseRunWithDef` at 1 048 615 bytes, **607.4 ms**
> at `dispatchCallTool`; its backslash-free control of the same class — which takes exactly the
> pre-change code path — reads 678–967 ms at the same size, so that cost is pre-existing, not opened
> here. Detector-only, the same shape reads 281.3 ms before and 326.6 ms after.

T82's six constant-size dials at 262 144 bytes: spreads 5.8 / 14.4 / 3.4 / 38.9 / 15.0 / 25.4 ms
(T83 recorded 2.3 / 14.9 / 4.1 / 36.8 / 25.5 / 31.5). Every dial moves cost by a bounded factor, none
by an order — property P holds.

### Suites, types, lint

- `bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts
  src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts` →
  **119 pass / 0 fail / 1 393 expect(), exit 0**. T84 recorded 115 / 0 / 1 281; the deltas are the four
  tests added here.
- Red evidence: on the pre-change tree the two pinning tests failed —
  `[destFailWhitespaceTail=6966.1ms, destFailNewlineTail=7217.1ms, destFailMixedWhitespaceTail=5638.0ms]`
  (and the case timed out at bun's 5 s default), and `b01FullRefEscapedAlt:false`.
- `bun run typecheck` (`tsc --noEmit`) → clean. `bunx eslint` on both changed files → 0 problems.

### Tooling disclosure

`bun` was invoked directly for every probe and suite rather than through `keryx ctx run`: the per-shape
timings and per-case verdicts ARE the evidence and this project's compaction elides them — the same
disclosure ten prior rounds have each made. **`keryx ctx rg`'s summary silently dropped rows in three of
three searches this round** (10 matches with 4 rows shown, 10 with 4, 12 with 4); each time the raw log
under `.metaproject/data/gdctx/raw/` was read directly with the hook's own escape marker and a stated
reason. The routing hook additionally refused `grep`, `sed`, `cat`, `tail` and `diff`; every refusal was
honoured and the command reissued through the routed form or with `# keryx:raw` and a reason.

No git state change, no network, no model call, no dependency change, no flow-state edit, no `git stash`,
no worktree touched. Synthetic and reserved hosts only (`attacker.invalid`, `ok.example.org`,
`cdn.example.org`). Masking offsets remain on the original bytes: no offset arithmetic changed.

## Concerns

1. **The cursor guard is a rule the fuzz forced, and it makes escape-aware constructs second-class.**
   They are flagged but never skip, so a document can now be scanned further than a renderer would read
   it — costing extra findings, never fewer. The alternative (letting them skip) released a real image
   in a fuzz-found document. A reviewer should rule on whether "flag but never skip" is the right
   permanent shape or whether the skip should be restored once a renderer differential covers it.
2. **Three new over-approximations, one shape.** `![a[b[c]d]\]e](URL)` is flagged and `marked` renders
   no image. Zero benign instances in 23 513 files, remedy is the allowlist, direction is toward
   flagging — but it is a real false positive that end 3 buys, and end 3 exists only for the nested
   spelling.
3. **`x09EscapeInAltOnly` is pinned by probe, not by unit test** — its text is byte-identical to
   `b01FullRefEscapedAlt`, which the regression does pin. T82#F-002's durability gap is otherwise
   unchanged from T83's disclosure.
4. **The two guard tests pass before the change as well as after**, deliberately: the ordering test and
   the escape-aware cost test are non-regression guards, not pins. The two *pinning* tests
   (`T84#F-001` cost, `T84#F-003` bypass) both failed on the pre-change tree, which is the requirement.
5. **My first boundary probe reported a false acceptance failure.** Single cold calls read
   `escapedCloseRunWithDef` at 1 120.1 ms; best-of-three, the methodology every prior round used and T83
   recorded explicitly, reads 590.9–607.4 ms. I changed my own probe rather than the claim, and the
   correction is written into it.
6. **Megabyte-scale timings are noisy on this machine** (T81 measured up to 5×). Every table is
   best-of-three and both sides of every comparison were measured the same way.

## Routing audit

- `graph_used`: **no** — *not-relevant*. Every file was named in the dispatch; there was no
  blast-radius question for gdgraph.
- `wiki_used`: **no** — *not-relevant*. The normative sources are the flow's own artifacts plus
  CommonMark.
- `ctx_used`: **yes** — `keryx ctx rg` and `keryx ctx read` for every code and document search, with the
  dropped-row incidents disclosed above and the raw logs read directly.
- `raw_rg_used`: **no** raw `rg`/`grep` ran as a code search; `grep`/`sed`/`cat`/`tail`/`diff` were each
  refused by the routing hook and reissued with `# keryx:raw` and a stated reason, per the dispatch's own
  disclosure that this project's routed tooling withholds evidence.
