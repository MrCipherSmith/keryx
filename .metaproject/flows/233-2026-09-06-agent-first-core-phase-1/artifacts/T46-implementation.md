STATUS: DONE

# T46 — the render-triggered surfaces: enumeration, measurement, decision, implementation

The policy half of the split T42 required (`T42-review.md`, judgement call 2). The repair half is
T52, independently rechecked by T53 and closed by T63; nothing here re-opens any of it, and every
matrix those rounds established is re-run below and is **byte-identical before and after**.

Files changed: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`, and the
limitation wording in `docs/requirements/keryx-agent-first-core/policies.md`. Nothing else.
`src/commands/security.ts` (another worker's) was neither read for change nor touched.

| File | SHA-256 at end | Lines |
|---|---|---|
| `src/security/detect/exfil.ts` | `efe360a36fad99fd6d8f0e44490cd7424f2054bfbfb6ebc7ccd5f05d77250294` | 1002 |
| `src/security/detect/exfil.test.ts` | `6ec7871cb8f145ef8fa83823590b96bf47f99e4f9f05213b220fcb3518a6a25b` | 1028 |
| `docs/requirements/keryx-agent-first-core/policies.md` | `61ddb7f61c62588c6f0f805cfcf4014561b98a117c671ed3cfd578bc8c80cfb4` | 53 |
| `…/artifacts/T46-surfaces.ts` (new probe) | `ecd617d1cb06d1d34a7ea7b3cf2488d5a4c5366eebb05821b87a946c8173d41c` | — |
| `…/artifacts/T46-corpus.ts` (new probe) | `3638614069c5ea6a016a5a83aade1e322b6cb138c0c9bd6e7d4f2a6a52d0c1d2` | — |

---

## 1. The enumeration, and how it was enumerated

The previous list was **not inherited**. It was re-derived from three sources and one filter; the
full method is `T46-spec.md` §1, and the short version is:

- **HTML** — the element index walked section by section (§4.2 metadata, §4.3 sections, §4.4
  grouping, §4.5 text-level, §4.7 edits, §4.8 embedded content, §4.9 tabular, §4.10 forms, §4.11
  interactive, §4.12 scripting, §16 obsolete), asking of each element the one question that defines
  this floor: *does inserting it into a document start a fetch with no user interaction?* Elements
  whose fetch needs a click or a submit are recorded as out of scope rather than omitted.
- **CSS** — the places the `<url>` type is consumed and fetched during layout or paint: the ten
  url()-taking properties, the two at-rules, and the value spellings that carry a URL *without*
  `url()` (`@import "…"`, `image-set()`).
- **SVG** — the elements that reference an external resource through `href` / `xlink:href`.
- **The filter** — this floor's own threat model, a markdown client with raw-HTML passthrough that
  auto-renders tool output. A surface counts only if that renderer would fetch it.

**Unit of counting.** A surface is one *extraction site* — one element/attribute pair the extractor
must read. The earlier count of "21" split one site in two twice (`<link rel=preload>` and
`<link rel=stylesheet>` are one `link href` site; the `style=` attribute and the `<style>` block are
one CSS grammar in two contexts) and, on the other side, missed seven sites entirely.

### What the previous enumeration got wrong

**Missed (7 sites plus 2 CSS spellings):** `<source src>` (the previous list had only
`source srcset`); `<iframe srcdoc>`; `<link imagesrcset>`; the `background` attribute on anything
other than `<td>` — `<body>` in particular, whose attributes the "in body" insertion mode *merges
onto the open body element*, so it works from a fragment; `<frame src>`; SVG `<feImage href>`; SVG
`<script href>`. Inside its own "CSS `url()`" bucket it missed the two spellings a `url()`-only
matcher cannot see: `@import "…"` and `image-set()`.

**Over-counted (2):** `<link rel=preload>` / `<link rel=stylesheet>` as two surfaces; the `style=`
attribute and the `<style>` block as two surfaces.

**Wrongly weighted (1):** SVG `<use href>` was listed as a fetch surface. External `<use>` is
same-origin restricted in every engine, so it is not a cross-origin fetch channel at all.

**Correctly removed since:** `<base href>`, which T52 covered.

**Correctly excluded by both:** the removed elements (`applet`, `bgsound`, `html manifest`,
`menuitem icon`, `layer`, MathML `mglyph src`) — none ships in any engine.

On the site basis the ratio at the start of this task was **5 covered of 32 enumerated sites**.

---

## 2. What actually happened today — measured, not reasoned

`T46-surfaces.ts` (new, in this directory) drives 44 rows: one per enumerated site with a hostile
`https://attacker.invalid/p?ctx=CTX` destination, a relative-destination benign twin for each, and
the deliberate negatives (a text input's `src`, a non-refresh `meta`, click-gated elements, a
`<template>`). For every row it asks three independent questions:

1. **Would a real parser attribute this destination to this element?** Bun's `HTMLRewriter`
   (lol-html), a spec-derived tokenizer with no relationship to this codebase — the same oracle
   discipline T53 introduced. The CSS rows are labelled `css-spec`, because the claim there rests on
   the CSS specification and not on an HTML tokenizer.
2. **What does the detector do?** `detectExfil(content, [])` with an empty allowlist: flagged /
   partial (flagged but the host survives the mask) / released.
3. **Does it reach the boundaries unmasked?** `dispatchCallTool`, `prepareOutputForPersistence`,
   `validateOutputForTransport` and `redactToolOutput`, all under
   `mergeMcpConfig({ redactToolOutput: false })` — so what is measured is the **mandatory** floor.

**Result before this task** (`.metaproject/data/gdctx/raw/T46-before-surfaces.log`):

> `rows: 44, fetchingRows: 36, releasedFetchingCount: 33, benignControlsFlagged: []`

**33 of 36 fetching rows were released**, and released means the whole way: every one returned from
`dispatchCallTool` with `isError:false` and `redaction.state:"none"` — the metadata affirmatively
stating nothing was redacted — and reached `prepareOutputForPersistence`, the transport validator
and the seam **byte-identical**, with `attacker.invalid` present in the released text. Not one was
partially flagged; the gap was total per surface, not a truncation.

The three exceptions were the covered baseline (`<img src>`, `<img srcset>`, `<base href>`), all
`redacted` with the host gone at all four boundaries.

One row is flagged that a conformant parser would never fetch: `X04.templateImg`, an `<img src>`
written inside `<template>`, whose contents are inert. That is the pre-existing non-element-context
over-approximation T53#F-001 recorded for comments and RAWTEXT, in a container T53 did not test. It
errs toward flagging, it is unchanged by this task, and it is recorded in §6.

### The false-positive side

`T46-corpus.ts` (new) sweeps the checkout with its **own** start-tag walker — independent of the
detector, because the question is incidence, not security — and counts, per site, the files carrying
that construct with an external destination:

> `filesScanned: 22198, filesUnreadable: 0` — and exactly **one** site has any benign file:
> `C3.imgSrc`, in 3 files (`README.md` and its two worktree copies).

Every other site, covered or not, has **zero** benign instances in this repository. That is the
dispatch's point measured rather than assumed: this corpus cannot decide the question, because
Keryx is a CLI toolkit with no web assets — it contains no benign external `<script src>`, no
`<link rel=stylesheet>`, no `.css` with an `@import`. So Part B writes the shapes a Keryx tool
output realistically carries and this repository lacks, and asks which sites each one would trip:

| Synthetic benign carrier | Sites it would trip |
|---|---|
| `quotedHtmlPage` — `ctx read` of an `index.html` | `C3.imgSrc`, **`U13.scriptSrc`**, **`U14.linkHref`** |
| `quotedCssFile` — `ctx read` of a `site.css` | **`U19`/`U20`/`U21`** (measured by the CSS path; see the probe's method note) |
| `readmeWithVideo` — a README embedding a demo | `U03.videoPoster`, `U04.videoSrc` |
| `docsPageWithIframe` — docs embedding a player | `U11.iframeSrc` |
| `picturePolyfill` — a responsive-image snippet | `C3.imgSrc`, `U07.sourceSrcset` |
| `audioSample`, `objectPdfEmbed`, `trackCaptions` | `U05`, `U10`, `U06`+`U08` |
| `svgInlineImage`, `imageSubmitButton`, `legacyTableBackground`, `metaRefreshRedirectPage` | `U23`, `U01`, `U16`, `U02` |
| `relativeOnlyPage`, `svgSpriteUse`, `readmeBadges` | **none** |

This is the measurement the decision turns on, and it separates the surfaces cleanly. `<script src>`
and `<link href>` and CSS are tripped by **`quotedHtmlPage` and `quotedCssFile`** — a *file*, with
no particular content. Everything else is tripped only by a document that deliberately embeds
something.

---

## 3. Weighing the two costs

**The cost of leaving a surface open** is identical across every SUB row and is not theoretical: the
measurement above shows the payload reaching the client with `state:"none"`. It is *larger* for the
one NAV row — `<meta http-equiv=refresh>` takes the whole client to the attacker rather than issuing
one subresource request.

**The cost of covering** has two independent scales, and only one of them differs between surfaces.

- *Blast radius of one mask* — T53#F-001's principle. Every SUB surface here is `<img>`-equivalent:
  one resource stops loading. `<base href>` was the exception, which is why T52 pulled it forward.
  `<meta refresh>` has a *negative* blast radius: masking it removes a navigation nobody asked for.
- *Benign incidence in the text this floor protects* — measured above, and this is where they
  genuinely differ.

**The distinction that decides it.** Keryx tool and resource outputs are file excerpts, search
results, wiki pages and reports — so the realistic benign carrier of any of these constructs is
**source and documentation quoted back to the reader**. Against that:

> `<script src>`, `<link href>` and CSS destinations are the **document's own infrastructure**:
> present in every real HTML or CSS file regardless of what the file is about. The media, embedded
> content, image-fetching-attribute and navigation surfaces are **content**: present only when the
> document deliberately embeds something.

That is a categorical difference in incidence, not a marginal one, and it maps onto the criterion
T42 itself used ("several uncovered ones … are load-bearing in benign documents"). It also respects
the already-accepted baseline: this floor **already** masks `<img src="https://…">` inside a quoted
HTML file and inside this repository's own `README.md` (8 findings, T53's measurement, reproduced
here). A content surface costs no new *kind* of harm relative to that baseline. An infrastructure
surface does — it would mask URLs inside source a tool was asked to show, on every such file.

**The argument that decides the other direction, and why it does not decide everything.** A floor
that covers 5 sites of 32 stops nothing against a deliberate attacker: they write `<video poster>`
instead of `<img src>` and the cost to them is one word. That argument is decisive *wherever the
false-positive cost is at or below the accepted baseline* — which is why the content surfaces are
covered now rather than deferred again. It is **not** a licence to cover the infrastructure
surfaces, because there the remedy for the false positive (a non-empty allowlist) does not exist
yet, and covering them first would mean masking legitimate source to close a hole whose neighbours
are already closed.

---

## 4. The decision, per surface

Covered = flagged, masked on the raw span, deny-by-default against `egress.allowlist`.

| # | Site | Class | Decision | Reason |
|---|---|---|---|---|
| U01 | `<input type=image src>` | SUB | **cover now** | An `<img>` twin, gated on `type=image` because `src` on any other input fetches nothing. Benign carrier: a quoted legacy form. |
| U02 | `<meta http-equiv=refresh>` | NAV | **cover now** | The only navigation surface and the worst outcome enumerated. Masking it removes a navigation, so the mask has no cost of its own. |
| U03 | `<video poster>` | SUB | **cover now** | An auto-fetched image spelled differently; fetched before any play. |
| U04 | `<video src>` | SUB | **cover now** | Content, not infrastructure. Carrier: a README embedding a demo. |
| U05 | `<audio src>` | SUB | **cover now** | As U04. |
| U06 | `<source src>` | SUB | **cover now** | As U04. Missing from the previous enumeration. |
| U07 | `<source srcset>` | SUB | **cover now** | As U04; candidate list split like `<img srcset>`. |
| U08 | `<track src>` | SUB | **cover now** | As U04. |
| U09 | `<embed src>` | SUB | **cover now** | Content. |
| U10 | `<object data>` | SUB | **cover now** | Content. Carrier: docs embedding a PDF. |
| U11 | `<iframe src>` | SUB | **cover now** | Content — a page carries zero iframes unless it embeds something. The canonical EchoLeak-class vector after `<img>`. Carrier: a docs page embedding a player; cost recorded in §6. |
| U16 | `background` on `body`/`table`/`td`/`th`/`tr`/`tbody`/`thead`/`tfoot` | SUB | **cover now** | Obsolete but honoured; `<body background>` works from a fragment because "in body" merges a body token's attributes onto the open body. Zero benign instances measured. |
| U23 | SVG `<image href|xlink:href>` | SUB | **cover now** | Arguably a defect in the *existing* coverage: the floor already matches the `<image>` tag and claims to cover "the `<image>` spelling of the same element", but read only `src`. |
| U24 | SVG `<feImage href|xlink:href>` | SUB | **cover now** | A real image fetch with no benign carrier; absent from the previous enumeration. Engine support for an *external* `feImage` href is uneven — recorded in §6 as the one covered row whose fetch claim is not uniform across engines. |
| U13 | `<script src>` | SUB | **cover later — prerequisite: a non-empty default allowlist posture** | Infrastructure: in every quoted HTML file. Masking it corrupts source a tool was asked to show. |
| U25 | SVG `<script href>` | SUB | **cover later — same prerequisite, and together with U13** | Its own benign incidence is ~0, but covering it while `<script src>` is open buys nothing: the attacker writes the open spelling. Splitting one element's two destination attributes across two decisions would also read as an oversight. |
| U14 | `<link href>` (every `rel`) | SUB | **cover later — same prerequisite** | Infrastructure. |
| U15 | `<link imagesrcset>` | SUB | **cover later — same prerequisite, with U14** | Same element, same carrier. |
| U18–U22 | CSS `url()` in `style=` / `<style>`, `@import` (incl. bare-string), `@font-face src`, `image-set()` | SUB | **cover later — same prerequisite, PLUS a CSS value extractor** | Infrastructure, and not reachable by the attribute walker at all: none of these is an HTML attribute, and `@import "…"` and `image-set()` mean a `url()`-only matcher is insufficient. A second grammar is a task, not a patch. |
| U12 | `<iframe srcdoc>` | SUB | **cover later — prerequisite: nested-document recursion with offset mapping** | A nested inline document is every other surface again, one level down, and its destinations sit behind character-reference decoding while the mask offsets must stay on the raw bytes. |
| U17 | `<frame src>` / `<frameset>` | SUB (nominal) | **never cover** | A `<frame>` start tag is *ignored* in the "in body" insertion mode, and a markdown-render client never produces a frameset document. There is no path from a fragment to a fetch. |
| U26 | SVG `<use href>` external | — | **never cover** | Same-origin restricted in all three engines. Covering it would produce false positives and close nothing. |
| U27 | SVG `<foreignObject>` | — | **not a site** | A container; its contents are the other rows. |
| §2.5 | `<a href>`, `<a ping>`, `<area href>`, `<form action>`, `<button|input formaction>` | — | **never cover** | Click- or submit-gated, so not zero-click by definition. |
| §2.5 | `<template>` contents | — | **never cover as a site** | Inert in every conformant parser. (The detector *does* currently over-flag markup inside one — §6.) |
| §2.5 | `applet`, `bgsound`, `html manifest`, `menuitem icon`, `layer`, MathML `mglyph src` | — | **never cover** | Removed from every shipping engine. |

**After this task the ratio is 23 covered of 32 enumerated sites**, and the nine that remain are
four deferred with a named prerequisite plus five that are not zero-click fetches at all. Measured:
`releasedFetchingCount` fell **33 → 15**, and the 15 are exactly the deferred set
(`U12`, `U13`, `U14`×3 rel spellings, `U15`, `U17`, `U18`–`U22`, `U25`).

### Where the decision departed from the spec's provisional dispositions

`T46-spec.md` §5 wrote its dispositions before the measurement and said any that the evidence
contradicted would be recorded rather than quietly dropped. Four changed.

| # | Provisional | Final | Why it changed |
|---|---|---|---|
| U17 `<frame src>` | cover now, pending incidence | **never cover** | Not an incidence question at all. Working through the insertion modes for the implementation showed a `<frame>` start tag is *ignored* in "in body", and a markdown-render client never produces a frameset document — so there is no path from a fragment to a fetch. A principled exclusion is better than a gratuitous inclusion that costs nothing. |
| U11 `<iframe src>` | decide on evidence; "expected to fall on the cover-later side" | **cover now** | The evidence went the other way. The expectation came from T42's sketch, which grouped iframe with stylesheet and script as "load-bearing in benign documents". Part B separates them: `quotedHtmlPage` — a file, any file — trips script and link, while an iframe needs `docsPageWithIframe`, a page that deliberately embeds a player. Content, not infrastructure. |
| U24 `<feImage href>` | decide on evidence | **cover now** | Zero benign carrier and a real image fetch. Recorded in §6.3 as the one covered row whose fetch is not uniform across engines. |
| U25 SVG `<script href>` | decide on evidence | **cover later, with U13** | Its own incidence is ~0, so the incidence test would have said cover. It is deferred anyway because covering one of an element's two destination attributes while the other is open buys nothing against an attacker and reads as an oversight to the next reader. |

The rest stand as written, including the two the spec was least sure of: U03–U10 and U16 were
"cover now, pending incidence", and the incidence measurement (zero benign files here; only
deliberate-embed synthetic carriers) confirmed them.

---

## 5. What was implemented, and how

Everything covered goes through the extractor that already exists. No new parser was written where
the existing one would do, and the URL parsing stays the platform's.

- **`HTML_START_TAG`** gains the element names, keeping the tokenizer's own tag-name terminator
  lookahead, so `<inputs>`, `<videos>` and `<objection>` are not these elements. Alternation order
  is irrelevant for the `t…` names because the lookahead rejects a short match followed by more name
  characters and the engine then tries the longer alternative.
- **`FETCHING_ATTRIBUTES`** — one table, element → attribute → `{policyId, kind}`, read **only from
  the attribute name position**, which is the property that made the extractor faithful in the first
  place (T42#F-001). `srcset` values keep the renderer-faithful whitespace split.
- **Two gates on a different attribute than the destination.** `<input>` requires `type=image` and
  `<meta>` requires `http-equiv=refresh`, so both need the whole attribute list before the branch can
  decide — a shape the loop did not have. Both gates resolve a duplicate eagerly (any spelling of the
  gating value enables the branch), which is the same direction as the duplicate-`src`
  over-approximation `readStartTag` already documents.
- **`UrlHit.classify`** — the one surface where the string to classify and the span to mask differ.
  `<meta http-equiv=refresh content="0;url=…">`'s destination sits inside a directive that is not
  itself a URL, so the refresh grammar extracts the URL (after character-reference decoding, because
  a renderer decodes the attribute value before running the grammar — `content="0&#59;url=…"` is the
  same directive) and the **whole directive** is the mask span. Leaving `content="0;url="` behind
  would be a directive with no meaning, and masking the whole value keeps the offsets exactly where
  the existing sites keep theirs.
- **Policy ids.** Three new, grouped by *what is fetched*, which is what a caller triaging a finding
  needs: `egress.html-media-exfil`, `egress.html-embedded-document-exfil`,
  `egress.html-meta-refresh-exfil`. The existing `egress.html-image-exfil` is extended to the
  elements that fetch an image without being `<img>` (`input type=image`, `video poster`,
  `background`, SVG `image`/`feImage` `href`). As T53 confirmed, these ids flow through the same
  free-form `policyId` path and none has a catalogue entry, so no reporting surface is left without a
  mapping.
- **Remediation.** `IMAGE_REMEDIATION` is renamed `FETCH_REMEDIATION` and its text now names the
  elements it actually covers. `BASE_REMEDIATION` is unchanged (T63). `META_REFRESH_REMEDIATION` is
  new and says the thing that is different about it: it is a navigation of the whole client, which is
  why the whole directive is masked.

Two extraction decisions inherited rather than re-made, and stated so a later round does not read
them as oversights: markup inside a quoted attribute value stays data (the `lastIndex` decision,
T53#F-004) — so `<img alt="<iframe src=…>" src="/a.png">` is still not a finding, and it now covers
the new elements by construction because the decision lives in the scan resume and not in any
branch. And the `<base>` inert-span check (T63) is **not** extended to the new elements: a false
positive there costs one resource, not a whole document, so the cheaper over-approximation stands.

---

## 6. Costs this decision accepts, stated rather than implied

1. **`<iframe src>` is the covered row with the most plausible benign carrier.** A documentation page
   embedding a player is a real shape (`docsPageWithIframe`). It is covered because a page carries no
   iframe unless it deliberately embeds one, so the incidence is content-dependent rather than
   file-dependent, and because leaving the canonical alternative to `<img>` open would make the rest
   of the coverage decorative. The remedy is the allowlist, exactly as for `<img src>`.
2. **Two namespace-ambiguous rows are read eagerly.** `href` on `<image>` and `<feImage>` fetches in
   the SVG namespace and is inert in the HTML one, and this scanner sees a fragment with no namespace
   context; likewise `background` on a `<td>` written outside a table, which a tree builder drops.
   Both cost a masked destination in markup no renderer would have fetched. Both were measured at
   zero benign instances in this checkout.
3. **`<feImage href>` is the one covered row whose fetch is not uniform across engines.** External
   `feImage` references are supported unevenly. Covering it costs nothing measurable and leaving it
   open would be a channel wherever it *is* supported; the uncertainty is recorded rather than
   resolved.
4. **Capitalised JSX components share these element names.** `<Video src="https://…">`,
   `<Source …>`, `<Table background=…>` in a quoted `.tsx` file match case-insensitively and become
   findings. This is not new in kind — `<Image src="https://…">`, the Next.js component, has been
   matched by the existing `<image>` alias since T24R2 — but it is newly *wider*. Measured at zero
   instances here; recorded because a React-heavy repository is where it would surface, and the
   allowlist is the remedy.
5. **`<img>` inside `<template>` is still flagged** although template contents are inert
   (`X04.templateImg`). This is the pre-existing non-element-context over-approximation T53#F-001
   recorded for comments and RAWTEXT, in a container T53 did not test. Unchanged by this task, and it
   errs toward flagging. Closing it uniformly across every element and every non-element context
   remains the shape T63 declined to widen and this task did not either.
6. **The corpus still cannot exonerate the new classes.** As with `<base>`, the repository contains
   no benign instance of any newly covered construct, so "zero new findings in benign repository
   content" is a true measurement of a corpus that cannot exercise the classes. The synthetic Part B
   corpus is what carries that weight, and it is 15 shapes written for this purpose.

---

## 7. The limitation, after this task

The dispatch requires that a reader of the module *and* of the requirements package can tell exactly
what the floor covers and what it does not, without reading the implementation. Before this task
neither could.

**The module** (`src/security/detect/exfil.ts`, header comment). The covered list is extended to the
new sites, and a new block — *"WHAT THIS FLOOR DOES NOT COVER, so a reader does not have to infer it
from the list above"* — names the four deferred surfaces with the prerequisite for each, and the
three never-covered ones with the reason each is not a zero-click fetch.

**The requirements package** (`docs/requirements/keryx-agent-first-core/policies.md`, version bumped
`0.1.1 → 0.1.2`). This is the file the ownership constraint allows "if and only if the decision makes
the current wording inaccurate", and it did — by silence. The package described the redaction norm
and said nothing at all about the auto-fetch floor's surface coverage; the limitation existed only in
flow artifacts, which are not the requirements package, so a reader was free to conclude the floor
was total. A new `### Auto-fetch floor: покрытая и непокрытая область` subsection now states, in the
document's own language and register: what the floor is and that it applies regardless of advisory
redaction; the complete covered list, marked *«перечень полный, не пример»*; the deliberately
uncovered list with its shared reason and its prerequisites, and that those surfaces return with
`redaction.state=none`; the never-covered list with the reason each is not zero-click; and the
nesting-blind/context-blind property of the extraction, with the `<base href>` exception.

**No frozen text was touched.** `acceptance-criteria.md` and `flow.json` are unchanged.

**One precise note on the norm's wording, offered rather than applied.** The sentence that governs
this area — *"URL проверяется на чувствительные query/path значения; наличие публичной
Markdown-ссылки не равняется сетевой отправке"* — is about a URL's *content* (a credential in a
query or path). The auto-fetch floor is about a URL's *position* (a destination a renderer requests
on its own), which is a different rule with a different trigger. The new subsection states the second
rule beside the first rather than editing the first, because rewriting the credential-locator
sentence to also mean auto-fetch would blur two norms that a reader needs to keep apart. If the
package's owner wants one sentence for both, the change belongs in the norm, deliberately, not as a
side effect of this task.

---

## 8. Verification — exact counts, before and after, with raw log paths

Every probe ran **directly with `bun`**, not through `ctx run`, for the reason T52, T53 and T63 each
disclosed and which holds here: `ctx run`'s compaction elides the per-case rows that are the
evidence, and the 44-row, 88-row and 41×15 matrices are exactly that kind of output. The one
required focused-suite run went through `ctx run` as the dispatch specifies. Raw logs under
`.metaproject/data/gdctx/raw/`.

No network, no model call, no git or flow-state change, no dependency or lockfile change, no
`bun test` without file arguments. Every host is reserved or synthetic (`attacker.invalid`,
`cdn.example.org`, `docs.example.org`, `media.example.org`, `*.invalid`); nothing was contacted.

### 8.1 The prior matrices — all nine byte-identical before and after

Each was run against the tree before the first edit and again after the last one, and the logs were
compared programmatically (paths normalised).

| Matrix | Before | After | Raw (before / after) |
|---|---|---|---|
| `T42-exfil-attack.ts` (42 cases) | `bypasses: [], falsePositives: [], unconditional: [], conditionalOnRendererScheme: []` | **identical** | `T46-before-T42-exfil.log` / `T46-after-T42-exfil.log` |
| `T24-recheck2-exfil.ts` (48 cases) | `cases=48 bypasses=0 falsePositives=0` | **identical** | `T46-before-T24R2-exfil.log` / `T46-after-T24R2-exfil.log` |
| `T42-charrefs.ts` (240 cases) | `namesTested 48, casesTested 240, namedSpellingBypasses [], numericSpellingBypasses [], absentButUrlSyntax []` | **identical** | `T46-before-T42-charrefs.log` / `T46-after-T42-charrefs.log` |
| `T53-extract.ts` (88 cases) | `bypasses: 0, overApproximations: 14` (same 14 ids) | **identical** | `T46-before-T53-extract.log` / `T46-after-T53-extract.log` |
| `T53-resolve.ts` (41 × 15 = 615) | `bypasses: 0, falsePositives: 0` | **identical** | `T46-before-T53-resolve.log` / `T46-after-T53-resolve.log` |
| `T53-base.ts` (23 cases) | `hostileNotNeutralized: 0; benignFlaggedIds: [g05, g06]` | **identical** | `T46-before-T53-base.log` / `T46-after-T53-base.log` |
| `T53-boundary.ts` (26 shapes) | `hostileLeakingAtAnyBoundary: 0; benignNotByteIdenticalIds: [ctlCdnBaseDoc]` | **identical** | `T46-before-T53-boundary.log` / `T46-after-T53-boundary.log` |
| `T42-boundary.ts` (rows 1–3) | 6 formerly-leaking shapes closed; `signalMatrix` unchanged; `ctlPublicLink` `state=none` byte-identical | **identical** | `T46-before-T42-boundary.log` / `T46-after-T42-boundary.log` |
| `T24-recheck2-boundary.ts` (28 MCP cases) | 0 leaking at any boundary; every reason token unchanged | **identical** | `T46-before-T24R2-boundary.log` / `T46-after-T24R2-boundary.log` |

`T52-base.ts` re-run after the change as an extra control: `notNeutralized: [], falsePositives: []`,
10 of 14 reachable before redaction and 0 after — unchanged (`T46-after-T52-base.log`).

### 8.2 The surface matrix — this task's own measurement

`T46-surfaces.ts`, 44 rows, four boundaries, advisory redaction OFF.

| | Before | After |
|---|---|---|
| rows | 44 | 44 |
| fetching rows | 36 | 36 |
| **fetching rows RELEASED** | **33** | **15** |
| released set | every enumerated site except `<img src>`, `<img srcset>`, `<base href>` | exactly the deferred set: `U12`, `U13`, `U14`×3, `U15`, `U17`, `U18`, `U18b`, `U19`, `U20`, `U20b`, `U21`, `U22`, `U25` |
| newly covered rows | — | **18**, each `flagged` with `mcp state=redacted`, `isError=false`, and `unmaskedAt[mcp=false persist=false transport=false seam=false]` |
| benign controls flagged | 0 | **0** |
| non-fetching rows flagged | 1 (`X04.templateImg`) | 1 (unchanged) |

Raw: `T46-before-surfaces.log` / `T46-after-surfaces.log`.

### 8.3 The false-positive sweeps

`T46-corpus.ts` (own walker, incidence): `filesScanned 22198, unreadable 0`; the only site with a
benign file is `C3.imgSrc` (3 files). Raw `T46-corpus.log`.

`T53-corpus.ts` (the reviewer's, unmodified, real detector) re-run after the change —
raw `T46-after-T53-corpus.log`:

| | T53 recorded | After T46 |
|---|---|---|
| files scanned | 21769 | 22233 (this task added artifacts) |
| total findings | 389 | 450 |
| files with findings | 56 | 62 |
| **benign files with findings** | **15** | **15** |
| the 15 | 8 gdctx logs of these probes, 6 worktree copies, `README.md` | **the same 15, with the same policy ids** |
| new policy ids in benign files | — | **none** — every benign finding is still `html-image` / `markdown-image` / `reference-link` / `markdown-link-sensitive-value` |
| Part B (30 synthetic benign shapes) | 6 flagged | **6 flagged, the same 6 ids** — `readmeBadge`, `readmeBadgeAllowlisted`, `codeFenceRemoteImgExample`, `htmlCommentImg`, `scriptStringImg`, `markdownRefDefRemote` |

All 25 findings under the three new policy ids (`html-media` 9, `html-embedded-document` 9,
`html-meta-refresh` 7) are inside this task's own probes, spec and test file. **Zero benign
repository content gained a finding of any class.**

### 8.4 New regressions — RED before, GREEN after

`bun test src/security/detect/exfil.test.ts`:

| | Before the fix (new tests, old detector) | After |
|---|---|---|
| tests | 45 | 45 |
| pass | 38 | **45** |
| fail | **7** | **0** |
| expect() | 388 | 552 |

Raw: RED `T46-red-exfil-test.log`, GREEN `T46-green-exfil-test.log`. The seven that failed:

```
(fail) T46: every newly covered render-triggered surface is flagged and masked
(fail) T46: the input src surface is gated on type=image, not on the attribute name
(fail) T46: the meta refresh surface parses the content grammar and masks the whole directive
(fail) T46: allowlist semantics for the new surfaces match the image surface exactly
(fail) T46: the meta refresh finding's remediation names the navigation consequence
(fail) T46: the persistence materializer never writes an auto-fetch host for the new surfaces
(fail) T46: the transport validator reports every new surface as redacted with the host gone
```

Two of the nine new tests pass **both** before and after, on purpose: *"the newly covered surfaces
add no false positive on relative destinations"* and *"the deliberately uncovered surfaces stay
released, with their reason recorded"*. The second is the one that pins the decision rather than the
code — a future widening has to change a test deliberately, and a future narrowing breaks the first.
No existing test was modified, weakened or removed.

### 8.5 Required suites, types, lint

`bun src/cli.ts ctx run -- bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts`

| | Before | After |
|---|---|---|
| pass | 87 | **96** |
| fail | 0 | **0** |
| expect() | 629 | **850** |

Raw before `T46-before-focused-suites.log`; after
`.metaproject/data/gdctx/raw/2026-09-06T17-24-01-888Z_run.log` (via `ctx run`, exit 0).

- `bun run typecheck` (`tsc --noEmit`) — exit 0, no diagnostics. Raw `T46-after-typecheck.log`.
- `bunx eslint src/security/detect/exfil.ts src/security/detect/exfil.test.ts` — exit 0, no output.
  Raw `T46-after-eslint.log`.
- `bunx eslint` on the two new probes — both outside the lint scope (`File ignored because of a
  matching ignore pattern`), 0 errors. Reported so the omission is not silent. Raw
  `T46-after-eslint-probes.log`.

### 8.6 Performance

The element set grew from 3 names to 20, so the scanner was re-measured on dense markup. Linear, no
backtracking: 820 KB / 20 000 table rows → 67.6 ms; 508 KB / 20 000 `<img>` → 144.0 ms (the
pre-existing shape, so the widened set is not the cost driver); 547 KB / 10 000
`<video><source><track>` → 151.2 ms; 479 KB / 10 000 `<meta refresh>` → 99.5 ms; 967 KB of benign
prose → 2.1 ms; 200 000 consecutive solidi → 1.8 ms.

### 8.7 Acceptance criteria

- **AC5 (AFC-15)** — **met**, and the auto-fetch half is materially wider than before. No field-name
  or spelling bypass survives (the three re-run matrices at 0 bypasses, plus the 88-case extraction
  and 615-resolution matrices unchanged). A URL secret is masked
  (`egress.markdown-link-sensitive-value` fires across the corpus; `p.password-key` →
  `secrets.sensitive-field` in the re-run boundary matrix). A public Markdown link is not treated as
  a network send: `ctlPublicLink` is `state:"none"` and byte-identical at all four boundaries, and
  the new transport regression additionally pins a fully-relative HTML page as `state:"none"`.
- **Every prior measurement holds** — the nine matrices in §8.1 are byte-identical, the
  character-reference matrix is unchanged, and the boundary rows for the neighbouring repairs
  (canonicalization and the persistence signal, `T42-boundary` rows 2 and 3) compare equal.
- **The recorded limitation is accurate and complete** — §7, in both the module and the requirements
  package, with each surface's disposition justified in §4.

---

## 9. Concerns for the orchestrator

None blocking. Three worth surfacing.

1. **This task made a policy call that widens the net, and a reviewer should agree with it rather
   than inherit it.** 18 rows moved from released to flagged. The reasoning is §3 and the evidence is
   §2 and §8.3, and the specific place to push back is `<iframe src>` (§6.1) — it is the covered row
   with the most plausible benign carrier, and it is isolated in the table as
   `iframe: { src: EMBEDDED_URL }`, one line to revert.
2. **The deferred set is now four surfaces with one shared prerequisite**, and that prerequisite is a
   product decision this task deliberately did not make: the floor's default allowlist is empty, so
   deny-by-default equals deny-everything for a document's own infrastructure. Until someone decides
   what a default allowlist should contain, `<script src>`, `<link href>` and CSS destinations stay
   open — and that is now written down in the module and in the requirements package rather than in a
   flow artifact.
3. **`policies.md` was edited under the "if and only if inaccurate" clause on the ground that silence
   was the inaccuracy.** If the orchestrator reads that clause more narrowly, the subsection is one
   contiguous block (`### Auto-fetch floor: покрытая и непокрытая область`) and the version bump is
   one line. The separate, precise note about the norm's own wording (§7, last paragraph) is offered
   and *not* applied.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the file set exactly, and the graph
  answers from the last `keryx gdgraph build` while this checkout carries a large uncommitted
  multi-worker change set, so a graph answer could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing texts are `T42-review.md`, `T53-review.md`,
  `T52-implementation.md`, `T63-implementation.md`,
  `docs/requirements/keryx-agent-first-core/policies.md` and the flow's `acceptance-criteria.md`; all
  were read directly, as the dispatch required.
- `ctx_used: partial, disclosed` — every text search went through `bun src/cli.ts ctx rg`, and the
  one required focused-suite run through `bun src/cli.ts ctx run`. Probe and regression **execution**
  ran `bun` directly, for the reason T52/T53/T63 each disclosed and which holds here: `ctx run`'s
  compaction elides the per-case rows that are this task's evidence.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find`/`sed`/`tail` over project code. One attempted
  `tail` was correctly refused by the routing hook and replaced with a bounded `bun -e` reader;
  bounded `Read` calls with `offset`/`limit` were used for file excerpts.
