# T77 — spec: the parser-adoption question, decided by measurement, then the repair

Written before any production edit. `src/security/detect/exfil.ts` was
`ef029fe36b4f81f224b4b2de4d5ad21ae724ba06de47c67039a4912091efed8a` at the moment this file was
written — the same hash T71 delivered and T72 reviewed, so nothing moved between the review and this
repair. Full start hashes: `.T77-hashes-start.txt` in this directory.

---

## Part 0 — I agree with the orchestrator's judgement, and for a reason it did not state

The orchestrator's judgement is that patching this detector a ninth time is the wrong move, and that
the hand-rolled CommonMark/HTML tokenization is the thing generating the rounds. I have now read the
module line by line, and I agree with the diagnosis. Eight rounds is not eight unrelated bugs: it is
one bug — *a hand-written approximation of a grammar, each round closing the shapes it was shown* —
and the list is monotonous. A decoder bounded by digit count fell to zero padding (T24 F-004). An
extractor bounded by a negated character class fell to a quoted `>` (T42#F-001). A resolver with two
same-scheme bases fell to a scheme-relative destination (T42#F-002). A depth bound was correctly
avoided in T71 and a *length* bound written three lines away, which T72 defeated at exactly the
boundary (T72#F-002). That is a pattern, and "patch it again" does not address a pattern.

Where I disagree is with the implicit next step. The remedy the dispatch asks me to evaluate — hand
the markdown half to `marked` — I measured, and it is not viable. **It is not viable on all four
axes at once**, and one of the four is not a judgement call at all. The detail is Part 1.

So the honest conclusion is narrower than either "adopt the parser" or "patch it again", and I want
it on the record in this form, because the next round will read it:

> The right answer for this module is a real parser. `marked` is not that parser — it is a *renderer*
> for one flavour, it has no offsets, and it is 3 800× slower than the code it would replace on the
> shape an attacker actually sends. Adopting it would have replaced a denial-of-service surface with
> a strictly worse one and released twelve coverage rows. The blockers therefore have to be fixed by
> hand this round, and what I have tried to do differently is to fix them **by removing invented
> bounds and replacing them with facts derived from the input itself**, so that the next round has
> one fewer bound to defeat.

---

## Part 1 — viability, measured

Probe: `T77-viability.ts` (mine, new). Raw: `.metaproject/data/gdctx/raw/T77-viability.log`.
Oracle/subject: `marked@17.0.1`, the same build every prior round used as its markdown oracle.

### Axis 0 — availability. **FAILS, and it is dispositive on its own.**

| Row | Verdict | Measured |
|---|---|---|
| `declaredInPackageJson` | **FAIL** | `package.json` `dependencies` is `{}`. `marked` appears in `dependencies`, `optionalDependencies` and `devDependencies` **zero times**. |
| `reachedOnlyThroughOptionalDependency` | **FAIL** | `bun.lock:68` — `"@opentui/core@0.4.5" … "dependencies": { … "marked": "17.0.1" … }`. `@opentui/core` is listed by this package under **`optionalDependencies`**. |
| `shippedArtifactCarriesIt` | **FAIL** | `files` ships `dist` only, and `scripts.build` passes `--external @opentui/core`, so the published bundle resolves `marked` through that optional tree at runtime or not at all. |

An `import { Lexer } from "marked"` inside `src/security/detect/exfil.ts` therefore throws at **module
load** on any install where the optional dependency was skipped — a platform it does not build on, an
install run with optional dependencies disabled, a lockfile-less consumer. The floor is mandatory:
a module-load failure there is not a degraded floor, it is **no floor**, and it takes
`detectExfil`'s importers (`src/security/detect/index.ts` → `redactToolOutput`,
`prepareOutputForPersistence`, `validateOutputForTransport`, `dispatchCallTool`) with it. Making that
safe requires adding `marked` to `dependencies`, which this dispatch does not authorize.

I am recording this as a measured axis rather than replying `STATUS: BLOCKED`, because BLOCKED here
would leave three blockers open in a mandatory security control. The dispatch's own instruction is
explicit that the blockers close either way; the dependency clause governs the branch where adoption
is chosen, and I am not choosing it. **The package is `marked`, and the reason is stated above.**

### Axis 1 — mapping a token back to a byte span. **FAILS.**

| Row | Verdict | Measured |
|---|---|---|
| `tokenCarriesAnOffset` | **FAIL** | image token keys are exactly `["type","raw","href","title","text","tokens"]`. No `start`, `end`, `position` or `offset`. |
| `rawConcatenationReproducesSource` | **FAIL** | concatenating top-level `raw` reproduces an LF document but **not** a CRLF one: `marked` preprocesses `\r\n` before lexing, so every reconstructed offset in a CRLF payload is wrong by the number of preceding CRs. |
| `hrefEqualsRawBytesAcrossSpellings` | **FAIL** | see the table below. |

`href` is not the source span, and the divergences are exactly the spellings this floor exists to
catch:

| Spelling | source bytes | `marked` `href` | equal |
|---|---|---|---|
| `![a](https&#58;//attacker.invalid/p)` | `https&#58;//attacker.invalid/p` | same | yes |
| `![a](ht<TAB>ps://attacker.invalid/p)` | `ht<TAB>ps://attacker.invalid/p` | **`""` (empty)** | **no** |
| `![a](<https://attacker.invalid/a b>)` | `<https://attacker.invalid/a b>` | `https://attacker.invalid/a b` | no |
| `![a](https:\\attacker.invalid/p)` | `https:\\attacker.invalid/p` | **`https:\attacker.invalid/p`** | **no** |
| `![a](https://attacker.invalid/p?q="x")` | same | same | yes |

The two bolded rows are not cosmetic. The tab-in-scheme row is **the T24 F-004 vector**: the URL
parser removes ASCII tab, so `ht<TAB>ps://host` is byte-for-byte the same request as `https://host`,
and `renderableUrl` exists in this module for that reason. `marked` hands back an empty `href` for
it. A token-stream implementation that classified `token.href` would therefore *release* a vector
this floor closed three rounds ago. The backslash row loses one of the two reverse solidi that make
the destination protocol-relative — the T24R2#F-001 class.

So adopting the token stream means: take `token.raw`, search inside it for the destination, and map
that offset back — which is the hand-rolled scanning the adoption was supposed to remove, now with an
extra ambiguity (which occurrence of the destination text inside `raw`?) and an offset base that is
wrong on CRLF input.

### Axis 2 — performance inside a mandatory floor. **FAILS, and by three orders of magnitude.**

`Lexer.lex` alone, against the current `detectExfil` on the same bytes:

| Shape | bytes | `marked` lex | shipped detector | ratio |
|---|---|---|---|---|
| `"[".repeat(200000)` | 200 000 | **394 696 ms** | 77.5 ms | **5 093× slower** |
| `"![".repeat(200000)` | 400 000 | **813 057 ms** | 213.4 ms | **3 810× slower** |
| `"[".repeat(50000)+"]".repeat(50000)` | 100 000 | **34 238 ms** | 114 ms | **300× slower** |
| `"[".repeat(20000)+"a"+"]".repeat(20000)` | 40 001 | **6 132 ms** | — | — |
| `![a](` + 100 000 non-`)` | 100 005 | 53.7 ms | 10 622.2 ms | 198× faster |
| `"[".repeat(6250)+"![a]("+"A".repeat(6250)` | 12 505 | 547.4 ms | 285 580.5 ms | 522× faster |
| realistic 40 KB tool output | 40 062 | 23.2 ms | 1 805.1 ms | 78× faster |

`marked` is faster on precisely the two shapes T72#F-003 names and catastrophically slower on the
four the current code handles in milliseconds. **Thirteen and a half minutes on 400 KB an attacker
pastes into any tool output** is a worse denial-of-service surface than the eight and a half minutes
T72 measured, not a fix for it. A floor that adopts this parser trades one availability failure for a
larger one, and the larger one is reachable with a *simpler* payload (a bracket run needs no
structure at all).

None of the four slow shapes threw, so there is no fail-toward-flagging path either: the parser does
not report "unsure", it just does not return.

### Axis 3 — correctness against the shapes eight rounds accumulated. **FAILS.**

A renderer resolves one flavour's rules. A floor must **over**-approximate. 12 of 14 measured
coverage rows are flagged by the detector and NOT resolved to an attacker image by `marked`, so
adopting the token stream as the source of truth would release every one of them:

`depth2`, `depth3`, `depth6` (nesting past `marked`'s own limit — T71 flagged these deliberately,
T72 accepted the direction), `unbalancedOpen`, `escapedClose`, `htmlImgInFence`, `baseInFence`,
`metaRefresh`, `inputTypeImageCharref`, `srcsetCandidate`, `videoPoster`, `componentMarkup`.

The last six are not even markdown: they are the HTML half, which `marked` passes through as raw text
and does not tokenize into attributes at all. So "walk the token stream" replaces the markdown half
only, leaving the HTML half hand-rolled — the module keeps both mechanisms, plus a dependency, plus
a 3 800× slower path.

### Verdict

**Not viable. All four axes fail.** The blockers are fixed by hand below. What I have changed about
*how* they are fixed is the subject of Part 2.

---

## Part 2 — the repair, and the discipline it applies

The through-line of the eight rounds is **a bound invented by the implementer and then defeated**.
So every bound this task adds is derived from the input, not chosen:

### Blocker 1 (T72#F-001) — an image inside a link is released

Root cause, read at `exfil.ts:994-1000` and `:1030-1038`: for `[![alt](URL)](href)` the outer
bracket has two readings; `.find` takes the outer one, `isImage` comes from the outer bracket's
missing `!`, so it is classified as a click-gated link — and `BRACKET_OPEN.lastIndex = inline.end`
then advances past the whole construct, so the interior is never scanned by either pass.

The fix is CommonMark's own rule rather than a patch to `.find`: **an image's description is alt
text, and nothing inside it is fetched; a link's description is content, and an image inside it
renders.** So the scan skips the interior of an **image** construct (unchanged behaviour, and
`marked` confirms it: `![a[b](U)](OK)` renders only `OK`) and does **not** skip the description of a
**link** construct. It still skips the link's *destination* span, which is what keeps the scan
linear.

### Blocker 2 (T72#F-002) — `MAX_REFERENCE_LABEL` releases what the old pattern flagged

`MAX_REFERENCE_LABEL = 999` is removed. It is replaced by a criterion that cannot be defeated by
writing one more character, because it is not a constant: **a bracket run can only be a label if its
normalised form equals a key that is actually in this document's reference-definition table.** So the
gate becomes `nonWhitespaceCount(span) <= maxKeyLength`, where `maxKeyLength` is the longest key the
document's own `[ref]: URL` lines produced. That is a *necessary* condition (normalising can only
collapse whitespace, never remove non-whitespace), so it never releases a resolvable label — a
1000-character label with a 1000-character definition is flagged — and it is O(1) per bracket via a
prefix count computed in the same pass that indexes the brackets. When the document has no
definitions at all the reference pass is skipped outright.

### Blocker 3 (T72#F-003) — `INLINE_DESTINATION` backtracks catastrophically

`\(\s*(?:<([^<>\n]*)>|([^)\s]+))[^)]*\)` can only match if a `)` exists after the description, and
its match always ends at the **first** such `)`. So the same pass that indexes brackets also indexes
`)` positions, and the regex is only run when a binary search finds one. When it cannot match, the
cost is O(log n) instead of O(m²).

That alone is not enough once blocker 1 stops skipping link descriptions, because many opens can
share one description end (`"[".repeat(n) + "](" + URL + ")"`). So the destination result is
**memoised by description end**, and each distinct end is examined once.

### Majors

- **T72#F-004** — `srcset` candidates are split on raw bytes. When the decoded value contains more
  commas than the raw value, the candidate boundaries are hidden from the split; every decoded
  candidate is classified and, if any is a finding, the **whole raw attribute value** is masked. The
  span stays on raw bytes. Under the default empty allowlist nothing changes.
- **T72#F-005** — reference labels are normalised with CommonMark's rule
  (`trim → collapse internal whitespace → lowercase`) identically at the definition side and the use
  side.
- **T72#F-006** — the completeness sentence in `policies.md`'s auto-fetch subsection, and the module
  header block, are corrected to match what the code does after the four fixes above. `Version:`
  `0.1.3 → 0.1.4`.

### The oracle question (T72#F-008), recorded because three rounds relied on it

Bun's `HTMLRewriter` (lol-html) returns the **raw** attribute source, not the tokenizer's decoded
value. It is a faithful oracle for attribution and tag boundaries and **cannot adjudicate a decoding
question at all**. Every earlier "confirmed by an independent tokenizer" claim about decoding is
therefore weaker than it reads. This is written into the module header so the next round inherits it,
and Part 3 of `T77-implementation.md` states which of my own conclusions rest on which oracle and
where no oracle in this checkout can settle the question.

## Not done, deliberately

- No dependency change, no lockfile change.
- The inert-context suppression is **not** re-added; a `<base>` element stays a finding wherever it
  appears, and the module's own record of why is left intact.
- No reviewer probe and no existing review artifact is modified; no existing test is weakened.
- The depth-2..6 over-approximation stays as T71 shipped it and T72 accepted it.
