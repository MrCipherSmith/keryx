# T46 — spec: the render-triggered surfaces the auto-fetch floor does not cover

This is the policy half of the split T42 required (`T42-review.md`, judgement call 2). The repair
half is T52, independently rechecked by T53 and closed by T63. Nothing here re-opens those.

**This document is written before any code, and its dispositions are PROVISIONAL.** Every one of
them is a hypothesis that section 4's measurement confirms or refutes; the confirmed set lands in
`T46-implementation.md`. A disposition that the measurement contradicts changes, and the change is
recorded rather than quietly dropped.

---

## 1. Enumeration — the method, before the list

The previous enumeration (T40 §"surfaces with no matcher", extended by T42#F-006 and restated in
`T52-implementation.md`) is **not inherited**. It is re-derived here and then compared, because a
list that is passed from round to round accumulates whatever the first round happened to think of.

The method has three sources and one filter.

**Source 1 — HTML.** Walk the HTML Standard's element index section by section (§4.2 document
metadata, §4.3 sections, §4.4 grouping, §4.5 text-level, §4.7 edits, §4.8 embedded content, §4.9
tabular, §4.10 forms, §4.11 interactive, §4.12 scripting, §16 obsolete-but-conforming and
obsolete-but-still-honoured), and for each element ask the single question that defines this floor:
**does inserting this element into a document start a fetch, with no user interaction?** An element
whose fetch needs a click (`<a href>`, `<a ping>`, `<form action>`, `<button formaction>`,
`<area href>`) is out of scope by definition and is recorded as such rather than omitted, so the
next round does not rediscover it as a gap.

**Source 2 — CSS.** Enumerate the places the CSS `<url>` type is consumed and fetched during
layout or paint: the properties (`background`/`background-image`, `list-style-image`,
`border-image-source`, `mask-image`, `content`, `cursor`, `shape-outside`, `clip-path`, `filter`,
`offset-path`, `-webkit-box-reflect`), the at-rules (`@import`, `@font-face src`), and the value
functions that carry a URL without the `url()` spelling (`image-set()`, `src()`, and `@import`'s
bare-string form). Two contexts carry them: a `style=` attribute (declarations only) and a
`<style>` block (declarations plus at-rules).

**Source 3 — SVG.** Enumerate SVG elements that reference an external resource through `href` or
the legacy `xlink:href`: `<image>`, `<use>`, `<feImage>`, `<script>`, the paint-server and filter
`href` inheritance forms, and `<foreignObject>` as a nested-HTML surface.

**The filter — the renderer model.** This floor's threat model, stated in `exfil.ts`'s header and
relied on by every extraction decision in it, is *a markdown client with raw-HTML passthrough that
auto-renders tool output*. A surface counts only if that renderer would fetch it. Two consequences
recorded up front, because they change the count:

- `<template>` contents are inert in every conformant parser, so markup inside a template is not a
  surface. It is the one HTML container that is a genuine negative rather than a deferral.
- SVG `<use>` with an external reference is restricted to same-origin by all three engines. It is a
  reference, not a cross-origin fetch, and listing it as a fetch surface over-counts the gap.

**Unit of counting.** A surface is one **extraction site** — one element/attribute pair the
extractor would have to read — not one "way to fetch". The previous enumeration counted
`<link rel=preload>` and `<link rel=stylesheet>` as two surfaces (they are one attribute, `link
href`, with different `rel` values) and counted the `style=` attribute and the `<style>` block as
two (they are one CSS grammar in two contexts). Both inflate the denominator of the "2 of 21"
ratio. This document counts sites, states the ratio on that basis, and says where it differs from
the earlier count.

---

## 2. The enumeration

Fetch class: **SUB** = a subresource request on render; **NAV** = the client navigates;
**DOC** = fetches nothing itself but changes how other destinations resolve; **NONE** = no
zero-click fetch.

### 2.1 Already covered by the floor

| # | Site | Class | Policy id |
|---|---|---|---|
| C1 | markdown inline image `![alt](URL)` / `![alt](<URL>)` | SUB | `egress.markdown-image-exfil` |
| C2 | markdown reference definition `[ref]: URL` | SUB | `egress.reference-link-exfil` |
| C3 | `<img src>` / `<image src>` | SUB | `egress.html-image-exfil` |
| C4 | `<img srcset>` / `<image srcset>` | SUB | `egress.html-image-exfil` |
| C5 | `<base href>` | DOC | `egress.html-base-href-exfil` |

(`[text](URL)` inline links are flagged only when the URL carries a credential locator; that is a
secrets rule, not an auto-fetch one, and is not counted as a surface here.)

### 2.2 Enumerated as uncovered — HTML

| # | Site | Class | Notes |
|---|---|---|---|
| U01 | `<input type=image src>` | SUB | An `<img>` twin: fetches on render, no click. The `type` guard is the whole difference from a text input. |
| U02 | `<meta http-equiv=refresh content="0;url=…">` | NAV | The only NAV surface. Blast radius is the whole client, not one resource. |
| U03 | `<video poster>` | SUB | Fetched immediately, before any play. An image by another name. |
| U04 | `<video src>` | SUB | Fetched under the default `preload=metadata`. |
| U05 | `<audio src>` | SUB | As U04. |
| U06 | `<source src>` | SUB | Inside `<video>`/`<audio>`. **Missing from the previous enumeration**, which listed only `source srcset`. |
| U07 | `<source srcset>` | SUB | Inside `<picture>`. |
| U08 | `<track src>` | SUB | Fetched when the track is enabled (`default`, or auto-enabled by language). |
| U09 | `<embed src>` | SUB | |
| U10 | `<object data>` | SUB | |
| U11 | `<iframe src>` | SUB | A whole nested document. |
| U12 | `<iframe srcdoc>` | SUB | A nested *inline* document whose own content is every other surface again. **Absent from the previous enumeration.** |
| U13 | `<script src>` | SUB | Fetched and executed. |
| U14 | `<link href>` (`rel` = stylesheet, preload, prefetch, modulepreload, icon, manifest, prerender) | SUB | One site, many `rel` values. The previous enumeration counted two of the `rel` values as two surfaces. |
| U15 | `<link imagesrcset>` (`rel=preload as=image`) | SUB | **Absent from the previous enumeration.** |
| U16 | `background` attribute on `<body>`, `<table>`, `<td>`, `<th>`, `<tr>`, `<tbody>`, `<thead>`, `<tfoot>` | SUB | Obsolete but honoured by every engine. The previous enumeration listed only `td background`. |
| U17 | `<frame src>` / `<frameset>` | SUB | Obsolete but honoured. **Absent from the previous enumeration.** |

### 2.3 Enumerated as uncovered — CSS

| # | Site | Class | Notes |
|---|---|---|---|
| U18 | CSS `url()` in a `style=` attribute | SUB | `background-image`, `list-style-image`, `border-image-source`, `mask-image`, `content`, `cursor`, `shape-outside`, `clip-path`, `filter`, `offset-path`. |
| U19 | CSS `url()` in a `<style>` block | SUB | The same properties plus at-rules. |
| U20 | `@import url(…)` and `@import "…"` | SUB | The bare-string form carries a URL with no `url()` spelling, so a `url()`-only matcher misses it. **Absent from the previous enumeration.** |
| U21 | `@font-face { src: url(…) }` | SUB | **Named only implicitly by the previous enumeration's "CSS url()".** |
| U22 | `image-set()` / `-webkit-image-set()` | SUB | A URL-carrying value function. **Absent from the previous enumeration.** |

### 2.4 Enumerated as uncovered — SVG

| # | Site | Class | Notes |
|---|---|---|---|
| U23 | SVG `<image href>` / `<image xlink:href>` | SUB | The floor already matches the `<image>` **tag** (the HTML `<img>` alias) but reads only `src`/`srcset`; SVG spells the destination `href`, so the tag is found and the destination is not read. |
| U24 | SVG `<feImage href>` | SUB | **Absent from the previous enumeration.** |
| U25 | SVG `<script href>` / `xlink:href` | SUB | SVG's script element spells `src` as `href`. **Absent from the previous enumeration.** |
| U26 | SVG `<use href>` external | NONE-in-practice | Spec-external, but same-origin-restricted in all engines. The previous enumeration listed it as a fetch surface; that **over-counts**. |
| U27 | SVG `<foreignObject>` | SUB (nested) | Contains HTML, i.e. every other surface again. |

### 2.5 Enumerated and deliberately out of scope (recorded so they are not rediscovered)

`<a href>`, `<a ping>`, `<area href>`, `<form action>`, `<button formaction>`,
`<input formaction>` — every one needs a click or a submit, so none is zero-click.
`<template>` contents — inert by parse, a genuine negative.
`<applet>`, `<bgsound src>`, `<html manifest>`, `<menuitem icon>`, `<layer src>`, MathML
`<mglyph src>` — removed from every shipping engine; the previous enumeration did not include them
and should not.

### 2.6 What the previous enumeration got wrong

- **Missed** (7): `<source src>`, `<iframe srcdoc>`, `<link imagesrcset>`, `background` on elements
  other than `<td>`, `<frame src>`, SVG `<feImage href>`, SVG `<script href>`; and, inside its own
  "CSS `url()`" bucket, the two spellings that are not `url()` — `@import "…"` and `image-set()`.
- **Over-counted** (2): `<link rel=preload>` / `<link rel=stylesheet>` as two surfaces rather than
  one `link href` site; the `style=` attribute and the `<style>` block as two surfaces rather than
  one CSS grammar in two contexts.
- **Wrongly weighted** (1): SVG `<use href>` as a cross-origin fetch surface; it is same-origin
  restricted in every engine.
- **Correctly removed since**: `<base href>`, which T52 covered.

On the site basis above the ratio is **5 covered of 32 enumerated sites**, of which 27 are
uncovered. The earlier "2 of 21" counted HTML attribute sites only and split two sites in two.

---

## 3. Measurement plan (section 2 of the dispatch)

Nothing above is a claim about the current code. Two probes establish that, and both measure rather
than reason.

**`T46-surfaces.ts`** — one row per enumerated site, each a minimal fragment carrying
`https://attacker.invalid/p?ctx=CTX`, plus a benign control per site carrying a relative
destination. For each row:

1. **Renderer oracle.** Bun's `HTMLRewriter` (lol-html), an independent spec-derived tokenizer with
   no relationship to this codebase, is asked whether a real parser attributes the URL-bearing
   attribute to the element. This answers "would a renderer see this destination" without my
   reading of the standard being the only witness. For the CSS rows the oracle reports the text
   content of the `<style>` block or the `style` attribute; the fetch claim there rests on the CSS
   specification and is stated as such.
2. **Detector.** `detectExfil(content, [])` — flagged / partially flagged / released, with the
   policy ids and the post-`applyRedaction` text.
3. **Boundaries.** `dispatchCallTool` (MCP), `prepareOutputForPersistence` (persistence
   materializer), `validateOutputForTransport` and `redactToolOutput`, all under
   `mergeMcpConfig({ redactToolOutput: false })` so what is measured is the mandatory floor.

**`T46-corpus.ts`** — the false-positive side. For each enumerated site, count the files in this
checkout that carry the construct with an **external** destination, i.e. the benign instances an
empty allowlist would newly flag. The dispatch is right that this repository is a poor guide, so
this is paired with a synthetic benign corpus of the shapes a Keryx tool output realistically
carries and this repository happens to lack.

---

## 4. The cost framework (section 3 of the dispatch)

Three questions per surface, in this order.

**(a) What does leaving it open cost?** A rendered tool output starts a request to an
attacker-chosen host with no click, carrying whatever the attacker encoded in the query string.
That cost is the same for every SUB surface, larger for the NAV surface (U02 takes the whole client
to the attacker, not one subresource), and different in kind for a DOC surface (which is why
`<base>` was pulled forward into T52 rather than left here).

**(b) What does covering it cost?** A benign document containing that construct becomes a finding
under an empty allowlist and its URL is masked. Two things scale that cost, and they are
independent:

- **Blast radius of one mask.** T53#F-001 established the principle: masking an `<img src>` breaks
  one image; masking a `<base href>` re-points the whole document. Every SUB surface here has
  `<img>`-equivalent blast radius. U02 (meta refresh) has none at all — masking it removes a
  navigation nobody wanted.
- **Benign incidence in the text this floor actually protects.** This is where the surfaces
  genuinely differ, and it is measured in `T46-corpus.ts` rather than asserted.

**(c) Does a Keryx tool output realistically carry it?** This is the question the dispatch puts at
the centre, and it is the one that separates the classes. Keryx tool and resource outputs are: file
excerpts (`ctx read`), search results (`ctx rg`), wiki pages, memory entries, health/test reports,
and flow artifacts. So the realistic benign carrier of any of these constructs is **source code
and documentation quoted back to the reader** — an HTML file, a CSS file, a JSX component, a README.
That is exactly why the already-accepted baseline matters: this floor **already** masks
`<img src="https://…">` inside a quoted HTML file and inside this repository's own README (T53
measured 8 such findings in `README.md`). A surface whose benign incidence is at or below that
baseline costs no new *kind* of harm; a surface whose incidence is materially above it is a
different decision, not a bigger version of the same one.

**The rule this task will not break.** Do not widen the net until benign text trips it. Where (b)
and (c) say a surface is load-bearing in ordinary quoted source, the answer is not "cover it
anyway"; it is "name the prerequisite that would make covering it safe" — which for every such
surface is the same prerequisite, a non-empty default allowlist or an
allow-known-CDN-hosts posture, and that is a product decision this task must not make alone.

---

## 5. Provisional dispositions (to be confirmed or refuted by section 3's measurement)

| # | Site | Provisional | Reason |
|---|---|---|---|
| U01 | `<input type=image src>` | **cover now** | An `<img src>` twin with a `type` guard; the attribute walker already reads `src`. Benign incidence expected ~0: nobody writes an image submit button into agent text or into quoted docs. |
| U02 | `<meta http-equiv=refresh>` | **cover now** | The only NAV surface and the worst outcome on the list. Mask blast radius nil. Needs a small `content` grammar (`<time>[;|, ]url=<url>`), which is bounded and testable. |
| U23 | SVG `<image href>` / `xlink:href` | **cover now** | Arguably a defect in the *existing* coverage rather than a new surface: the floor already matches the `<image>` tag and claims to cover "the `<image>` spelling of the same element", but reads only `src`. |
| U03 | `<video poster>` | **cover now** | An auto-fetched image spelled differently; fetched before any interaction. |
| U04–U10, U17 | `<video src>`, `<audio src>`, `<source src|srcset>`, `<track src>`, `<embed src>`, `<object data>`, `<frame src>` | **cover now, pending incidence** | All are the attribute walker plus a name; all have `<img>`-equivalent blast radius. To be confirmed against measured benign incidence — a README embedding a video is the shape that could refute this. |
| U16 | `background` attribute | **cover now, pending incidence** | Obsolete-but-honoured; benign incidence expected ~0 in modern source. |
| U11 | `<iframe src>` | **decide on evidence** | Load-bearing in benign documentation (embeds). Expected to fall on the "cover later" side. |
| U13 | `<script src>` | **cover later, named prerequisite** | Every quoted HTML file carries one. Masking it corrupts code the reader asked to see. |
| U14, U15 | `<link href>`, `<link imagesrcset>` | **cover later, named prerequisite** | As U13. |
| U18–U22 | CSS `url()`, `@import`, `@font-face src`, `image-set()` | **cover later, named prerequisite** | Also needs a second extractor (a CSS value grammar), not the attribute walker — a different task, not a bigger patch. |
| U12 | `<iframe srcdoc>` | **cover later, named prerequisite** | Needs recursion into a nested document, which no part of this extractor does. |
| U26 | SVG `<use href>` | **never cover** | Same-origin restricted in every engine; it is not a cross-origin fetch surface. Covering it would be pure false positives. |
| U27 | SVG `<foreignObject>` | **not a site** | A container; its contents are the other rows. |
| U24, U25 | SVG `<feImage href>`, `<script href>` | **decide on evidence** | Real fetches, benign incidence expected ~0, but `<script href>` shares `<script src>`'s carrier. |
| §2.5 | click-gated and removed elements | **never cover** | Not zero-click, or not shipped. |

---

## 6. Implementation shape, if section 5 survives measurement

Anything covered is implemented the way T52 and T63 did it — in the extractor that already exists,
with no new parser where the existing one will do.

- `HTML_START_TAG` gains the element names, keeping the tokenizer's own tag-name terminator
  lookahead so `<inputs>` and `<videos>` are not these elements.
- The per-attribute loop gains a branch per element, reading the destination **only from the
  attribute name position**, exactly as `src`/`srcset`/`href` are read now. `<input>` additionally
  requires `type` to be `image`, ASCII case-insensitively, which means the branch must see the
  whole attribute list before deciding — a shape the current loop does not have and that this task
  introduces.
- `<meta http-equiv=refresh>` is the one row needing a value grammar: the `content` attribute's
  URL part, offset-correct on the raw bytes so `applyRedaction` masks the destination and not the
  timeout.
- Policy ids stay in the existing free-form `policyId` space (T53 confirmed
  `egress.html-image-exfil` has no catalogue entry either, so no reporting surface is left without
  a mapping). New ids are named for what they are, not for `img`.
- Everything covered inherits `IMAGE_REMEDIATION` unless its blast radius differs; U02 does, so it
  gets its own.

## 7. Regressions, written before the code

Per covered surface: one flag-and-mask regression over the tokenizer states that already have
coverage for `<img>` (quoted `>` in an earlier value, decoy attribute name in a value, unquoted
value, case folding, multi-line tag), one benign control with a relative destination, one
allowlist control, and one boundary row through `prepareOutputForPersistence` and
`validateOutputForTransport`. Plus, for every surface **not** covered, one test that pins the
decision itself — a released surface stays released, so a later round reads the gap as deliberate
rather than as an oversight, and a future widening has to change a test on purpose.

## 8. What must be true at the end (section 5 of the dispatch)

The recorded limitation must be accurate and complete in two places, and it is currently accurate
in neither:

- **The module.** `exfil.ts`'s header lists what it covers and says nothing about what it does not.
  A reader cannot tell the floor is partial.
- **The requirements package.** `docs/requirements/keryx-agent-first-core/policies.md` describes
  the redaction norm and does not mention the auto-fetch floor's surface coverage at all — the
  limitation exists only in flow artifacts, which are not the requirements package. Under the
  ownership constraint this file may be edited only if the decision makes the current wording
  inaccurate; a silence that lets a reader conclude the floor is total is exactly that, and the
  edit will be confined to stating the floor's scope and its named exclusions.

The frozen `acceptance-criteria.md` is not touched. If the norm's wording should change beyond the
limitation sentence, this task says so precisely instead of editing it.

## 9. Constraints this task works under

Ownership: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`, and the limitation
wording in `docs/requirements/keryx-agent-first-core/policies.md`. `src/commands/security.ts` is
another worker's and is not touched. No git or flow-state change, no network, no model call, no
dependency change, no `bun test` without file arguments, synthetic hosts only. Every prior matrix
is re-run before and after and must be unchanged.
