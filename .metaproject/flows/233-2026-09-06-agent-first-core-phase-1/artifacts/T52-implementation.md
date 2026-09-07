STATUS: DONE

# T52 — the extractor and the resolution assumption, fixed together

Closes T42#F-001 (blocker), T42#F-002 (major), T42#F-003 (minor), the `<base href>`
half of T42#F-006 (structural), and the false sentence in T42#F-005.

Files changed: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`
— nothing else. `guard.ts`, `output-validation.ts`, `service.ts`, `config.ts`,
`src/mcp/*` and every existing artifact were read and driven, never modified. The
three new artifacts (`T52-spec.md`, `T52-base.ts`, `T52-corpus.ts`) are additive.

## Why the previous three shapes each moved the hole one layer up

Round 1 bounded a digit run. Round 2 decoded and stripped whitespace. Round 3
(T40) stopped recognising authority spellings and started **resolving** with the
platform URL parser — which genuinely retired that whole class and still holds
(48-case matrix, 0 bypasses, re-measured below). Each round fixed the layer it was
shown and left the layer feeding it.

T42 attacked the layer above and found the two mechanisms this task repairs: the
destinations never reached the classifier at all, and one assumption *inside* the
classifier was true only for one renderer document scheme. Neither is a case; both
are mechanisms, and both are fixed here at the mechanism.

## Defect 1 (blocker) — extraction: parse attributes, do not scan them

### What was wrong

`HTML_IMG` / `HTML_IMG_SRCSET` scanned the tag with `[^>]*?` and anchored on an
unanchored `\bsrc`. Two assumptions, both contradicted by the HTML tokenizer:

1. **`>` does not end a tag inside a quoted attribute value.** In
   *attribute-value-(double|single)-quoted* state it is ordinary data, so
   `<img alt="a>b" src="https://attacker.invalid/p">` is one element with a real
   `src`. The class cannot cross that `>`, the match fails, and the global scan
   finds no other `<img`/`<image` — the element was **never extracted at all**.
2. **An attribute VALUE is not an attribute NAME position.** `\bsrc` matched inside
   a value, so `<img alt="src=/safe" src="…">` captured the decoy `/safe"`
   (correctly relative, correctly not a finding) and left `lastIndex` past the real
   destination.

### What replaced it

A single left-to-right scan over start tags:

```
HTML_START_TAG /<(im(?:age|g)|base)(?=[\t\n\f\r />]|$)/gi
readStartTag(content, indexAfterTagName) -> { attributes, end }
```

`readStartTag` reproduces the tokenizer's states between the tag name and the
terminating `>` (before-attribute-name → attribute-name → after-attribute-name →
before-attribute-value → attribute-value-double-quoted / -single-quoted /
-unquoted → after-attribute-value). `src` / `srcset` / `href` are read **only from
the name position**, and the scan resumes **past the tag's own `>`** — so a quoted
`>` is data, a `src=` inside a value is data, and an element written inside another
element's quoted value is data.

Hand-rolling is confined to attribute scanning, as the constraint allows; URL
parsing remains the platform's. It is justified below against the tokenizer's own
rules, and it is linear (no backtracking): the 16,684-file corpus sweep runs in a
few seconds.

### The attribute-form enumeration, and how it was enumerated

**Method — derived, not brainstormed.** I read the HTML Standard's tokenizer state
machine (§13.2.5) and enumerated every state reachable between `tag name` and the
terminating `>`, then asked of each transition: *can it carry a destination, and
can it hide one?* Each answer is a row, and each row is a regression vector in
`exfil.test.ts`. This is the enumeration method, and it is why the list is closed
rather than open: a form not in the table is a state the tokenizer does not have.

| # | Form | Tokenizer state | Treatment |
|---|---|---|---|
| 1 | `src="U"` | attribute-value-double-quoted | read |
| 2 | `src='U'` | attribute-value-single-quoted | read |
| 3 | `src=U` | attribute-value-unquoted (ends at whitespace or `>`) | read |
| 4 | `src = "U"` | after-attribute-name / before-attribute-value skip whitespace | read |
| 5 | `hidden` (no value) | after-attribute-name without `=` | skipped, no value |
| 6 | `<img/src="U"/>` | before-attribute-name ignores `/` | read |
| 7 | `SRC=`, `SrcSet=`, `<IMAGE>` | ASCII case-insensitive | read (names lowercased) |
| 8 | earlier value containing `>` | `>` is data in a quoted-value state | **fixed** (was invisible) |
| 9 | earlier value containing `src=` | a value is not a name position | **fixed** (was a decoy) |
| 10 | tag spread over lines | LF is HTML whitespace | read |
| 11 | duplicate `src` in one tag | tree builder keeps the first | **both classified** |
| 12 | EOF inside the tag | tree builder emits no element | attributes still classified |
| 13 | `=` as the first character of a name | unexpected-equals-sign-before-attribute-name | consumed as the name |
| 14 | `<img …>` inside another element's quoted value | it is text, not an element | **not** a finding |

Rows 11 and 12 are the two places this scanner is deliberately more eager than a
conformant tree builder; both err toward flagging, and row 12 matches the previous
behaviour exactly (the old regex never required a `>` either), so neither is a
widening of the net. Row 14 is the opposite direction and was a **pre-existing
false positive**: `<img alt="<img src=https://attacker.invalid/p>" src="/a.png">`
was flagged before this change and is not flagged now (measured:
`markupInsideValue before=1 after=0`).

Two boundaries chosen deliberately and worth naming:

- The tag-name terminator set is the tokenizer's (`\t \n \f \r space / >`), not
  `\s`. `\s` also matches U+00A0 and U+2028, which a real tokenizer keeps *inside*
  the tag name — `<img src=…>` is an unknown element that fetches nothing, so
  matching it would be a false positive. `<imgur>` and `<based>` are likewise not
  these elements.
- `srcset` candidates are still split at whitespace. That truncation is
  renderer-faithful: the srcset grammar itself terminates a URL there.

## Defect 2 (major) — the resolution assumption: two base *pairs*, not one

### What was wrong

`SYNTHETIC_BASES` varied the base **host** and held the base **scheme** fixed at
`https`. WHATWG resolution branches on both. In the *scheme* state, a special
scheme equal to the base's goes to `special relative or authority` (RELATIVE,
inheriting the base host); one that differs goes to `special authority slashes` →
`special authority ignore slashes`, which makes the next token the **HOST**. So
`https:attacker.invalid/p` was judged relative — true only for a renderer whose own
document is `https:`. The code showed the asymmetry itself:
`http:attacker.invalid/p` **was** flagged, `https:attacker.invalid/p` was not.

### The decision, and its justification

**A destination that carries a special scheme and reaches an http(s) host under any
base scheme carries its own authority, and is flagged** — independent of any single
base scheme, as the task requires.

- *Why deny is correct.* Those bytes fetch `attacker.invalid` in every renderer
  whose document scheme is not `https:`, and `file:`, `vscode-webview:` and
  Electron custom-scheme documents are exactly where MCP clients render tool
  output. The detector cannot know the renderer's document scheme; `policies.md`
  makes the floor deny-by-default on a real cross-origin fetch, and this is the
  only direction in which it may err.
- *Why the cost is nil.* The class added is exactly "special scheme, colon, no
  slashes, then a host" — not a shape any benign document writes to mean a relative
  path. Measured: the only verdicts that change are the six `a.scheme*` spellings.

### The mechanism

The two-base *disagreement* rule is kept — it is what makes "relative" decidable
without a syntax test — but it is applied to **two pairs whose base schemes
differ**, and a host is returned when **either** pair agrees:

```
pair 1 (special): https://keryx-detector-base-a.invalid/keryx/page
                  https://keryx-detector-base-b.invalid/keryx/page
pair 2 (opaque):  keryx-detector://keryx-detector-base-a.invalid/keryx/page
                  keryx-detector://keryx-detector-base-b.invalid/keryx/page
```

**Two pairs are sufficient, not merely more.** The scheme state branches on one
predicate: "the base's scheme equals the destination's scheme". Pair 1 realises the
*equal* branch for `https` and the *differs* branch for every other scheme; pair 2's
scheme is non-special and private to this detector, so it realises the *differs*
branch for **every** special destination scheme, `https` included. A third base
scheme could only repeat one of those two branches. The pairs are OR-ed, not
AND-ed, because a protocol-relative destination inherits pair 2's non-special
scheme and yields no http(s) host there.

Measured resolution table (platform WHATWG `URL`, both pairs):

| destination | pair 1 | pair 2 | verdict |
|---|---|---|---|
| `https:attacker.invalid/p` (+ `https:/`, `HTTPS:`, `HtTpS:`) | disagree (relative) | attacker.invalid ×2 | **flag (new)** |
| `http:attacker.invalid/p` | attacker.invalid ×2 | attacker.invalid ×2 | flag (unchanged) |
| `https://att/p`, `//att/p`, `\\att/p` | attacker.invalid ×2 | agree, scheme not http(s) ⇒ null | flag (unchanged) |
| `/assets/a.png`, `../a.png`, `a.png`, `#frag`, `?q=1`, `/assets/a\b/logo.png` | disagree | disagree, non-http scheme | not a finding |
| `%2f%2fatt/p`, `https%3a//att/p`, `docs.example.org/pixel.png` | disagree | non-http scheme | not a finding |
| `data:`, `blob:`, `mailto:`, `ftp://`, `ws://`, `file:` | non-http scheme | non-http scheme | not a finding |
| `https://keryx-detector-base-a.invalid/p` (names a base host) | agree | agree | flag (unchanged) |

## Defect 3 (minor) — the bare destination is no longer cut at `>`

`INLINE` group 3 `[^)\s>]+` → `[^)\s]+`; `REFERENCE_DEF` group 3 `[^\s>]+` →
`\S+`. A CommonMark bare destination may legally contain `>`; the angle-bracket
alternative is tried first, so `>` was never needed to keep the two alternatives
apart. `![x](https://attacker.invalid/a>b)` now masks whole
(`![x]([REDACTED:url])`) instead of leaving `>b` beside the mask, and the
`start`/`end` span is the destination's own.

## Defect 4 (structural) — `<base href>`: handled, and shown to be handled

`<base>` fetches nothing, and that is exactly why it mattered: it re-points **every
relative URL in the document**, which falsifies the load-bearing half of the
two-base rule ("the resolutions disagree ⇒ relative ⇒ the renderer fetches from its
own origin ⇒ no channel").

**Treatment.** A `<base href>` whose destination carries its own authority — same
`exfilHost` funnel, same allowlist check, same `mask:"url"` on the raw span — is an
egress finding, `egress.html-base-href-exfil`.

**Why that is sufficient, and how it was shown rather than argued.** The floor's
guarantee is about the text that gets rendered. Masking the href puts the document
base back inside the reader's own origin (`<base href="[REDACTED:url]">`), so every
relative destination around it resolves same-origin again and the rule's conclusion
is true once more; and a caller that never applies redaction still holds an
`egress` finding, so the document is not "clean" on either path.

`T52-base.ts` measures precisely that, with a renderer model independent of the
detector: it locates the document base itself (quote-state walk), applies it the
way an HTML document does, and adjudicates every destination with the platform
`URL` against five renderer document bases. Ten `<base>` vectors — absolute,
protocol-relative, scheme-with-no-slashes, backslash authority, entity-written
colon, base written *after* the image it re-points, uppercase/single-quoted, a base
whose href hides behind a quoted `>`, plus the markdown and `srcset` destination
surfaces — all reach `attacker.invalid` before redaction and **none** reaches it
after. Four controls (relative base, base without href, base written inside an
attribute value, allowlisted base) produce zero false positives.

**What was deliberately not done, and why.** The detector does not re-resolve
relative destinations against the attacker's base. That would make
attacker-controlled bytes the resolution base for spans whose offsets must stay on
the original bytes, and it would flag destinations whose written form is harmless —
a larger behaviour change for no additional guarantee, since the re-point is
already removed.

**`meta refresh` — enumerated, not implemented.** It is a *navigation* surface, not
a subresource fetch, and unlike `<base>` it falsifies no rule this detector relies
on. It belongs with the other render-triggered surfaces in the deferred policy
task, which the reviewer scoped out of this one. It is recorded here so the next
round does not rediscover it as an omission. The full deferred list (from
T40 §"surfaces with no matcher", extended by T42#F-006) is: `<iframe src>`,
`<video src|poster>`, `<audio src>`, `<source src|srcset>`, `<input type=image src>`,
`<object data>`, `<embed src>`, `<track src>`, `<link rel=preload|stylesheet href>`,
`<script src>`, `<body|td background>`, SVG `<image href|xlink:href>` and
`<use href>` (SVG spells it `href`, so even the `<image>` alias does not reach it),
CSS `url()` in a `style` attribute or `<style>` block, and `<meta http-equiv=refresh>`.

## Defect 5 (info) — the false sentence

"Over the ASCII punctuation that HTML5 names, that is exactly this set" is false:
14 ASCII-denoting HTML5 names are absent, three of them (`midast`, `UnderBar`,
`DiacriticalGrave`) alias spellings of characters the table already carries. The
table stays; the sentence now states the true and stronger reason — a *named*
reference is only ever an alternative spelling, and the numeric form (`&#NN;` /
`&#xNN;`, unbounded and range-checked) already covers every character generically,
so an absent name can only matter for a character that has an HTML5 name **and** is
URL syntax or URL-removed. Measured: of the 14 absent names, none denotes such a
character (`T42-charrefs.ts`, `absentButUrlSyntax: []`).

## Verification — exact counts and raw logs

Every probe ran **directly with `bun`**, not through `ctx run`: the reviewer
disclosed that `ctx run`'s compaction elides the per-case statuses that are the
evidence, and it does. Recorded in the routing audit. No network, no model call, no
git or flow-state change, no dependency change, no `bun test` without file
arguments. Synthetic hosts only (`attacker.invalid`, `*.invalid`, `example.org`);
nothing was contacted.

Raw logs are under `.metaproject/data/gdctx/raw/`.

### 1. The reviewer's 42-case matrix (`T42-exfil-attack.ts`, unmodified)

| | Before | After |
|---|---|---|
| cases | 42 | 42 |
| bypasses | **14** | **0** |
| — unconditional | 8 | 0 |
| — conditional on renderer scheme | 6 | 0 |
| false positives (15 benign controls) | 0 | **0** |

Raw: before `T52-before-T42-exfil-attack.log`, after `T52-after-T42-exfil-attack.log`.

The 14 closed: `b.gtInEarlierAttribute`, `.Single`, `.Image`, `.Srcset`,
`b.decoySrcInAttribute`, `b.decoySrcsetInAttribute`, `b.decoySrcThenGt`,
`b.newlineInTag` (defect 1); `a.schemeNoSlashes`, `.OneSlash`, `.Upper`, `.Mixed`,
`.Entity`, `.Markdown` (defect 2).

### 2. The earlier 48-case matrix (`T24-recheck2-exfil.ts`, unmodified)

| | Before | After |
|---|---|---|
| cases | 48 | 48 |
| bypasses | 0 | **0** |
| false positives | 0 | **0** |

Raw: before `T52-before-T24R2-48matrix.log`, after `T52-after-T24R2-48matrix.log`.

### 3. The real boundaries (`T42-boundary.ts`, unmodified; advisory redaction OFF)

`mergeMcpConfig({ redactToolOutput: false })`, so what is measured is the mandatory
floor.

| Shape | Before | After |
|---|---|---|
| `gtInEarlierAttribute` | `mcp isError=false state=none reasons=[] leaksHost=true \| persist leaksHost=true identical=true \| seam leaksHost=true` | `state=redacted reasons=["egress.html-image-exfil"] leaksHost=false \| persist leaksHost=false identical=false \| seam leaksHost=false` |
| `decoySrcInAttribute` | same, leaking | same, closed |
| `decoySrcThenGt` | same, leaking | same, closed |
| `gtInEarlierAttributeSrcset` | same, leaking | same, closed |
| `imageAliasGt` | same, leaking | same, closed |
| `schemeNoSlashes` | same, leaking | same, closed |
| `ctlBackslash`, `ctlImageTag` (controls) | already closed | unchanged |
| `ctlPublicLink` (control) | `state=none`, byte-identical | unchanged |

Raw: before `T52-before-T42-boundary-row1.log`, after `T52-after-T42-boundary-row1.log`.

**Rows 2 and 3 of the same probe (T41's byte-faithful scanner and T44's persistence
signal) are byte-identical before and after** — `serialized`, `handBuilt`,
`endToEnd` and `signalMatrix` all compare equal — so this change touched nothing
there.

`T24-recheck2-boundary.ts` (the earlier boundary probe) re-run as a no-regression
control: **28 MCP cases, 0 `leakHost` at the transport, 0 at
`prepareOutputForPersistence`, 0 at `redactToolOutput`**; `cleanPretty` /
`cleanCompact` still `bytesIdentical=true`; every refusal keeps its own token.
Raw `T52-after-T24R2-boundary.log`.

### 4. New regressions — one per defect, failing before and passing after

`bun test src/security/detect/exfil.test.ts`:

| | Before (new tests, old detector) | After |
|---|---|---|
| tests | 27 | 27 |
| pass | 20 | **27** |
| fail | **7** | **0** |
| expect() | 186 | 313 |

RED raw `T52-red-exfil-test.log` — the exact seven that failed:

```
(fail) attribute scanning follows the tokenizer, so a quoted > or a decoy src= cannot hide a destination
(fail) a scheme-with-no-slashes destination is judged independently of the base scheme
(fail) a bare CommonMark destination containing > is masked whole
(fail) a base element carrying its own authority is a document-level egress finding
(fail) tokenizer-faithful attribute scanning adds no false positives
(fail) the persistence materializer never writes an auto-fetch host for the extraction classes
(fail) the transport validator reports every extraction class as redacted with the host gone
```

Five class regressions plus both boundary regressions. Note the fifth: the
false-positive control failed *before* the fix, because the old scan flagged
`<img alt="<img src=…>" src="/a.png">` — markup written inside a quoted value.
That is a pre-existing false positive this change removes, and it is reported as a
closure rather than counted among the bypasses.

GREEN raw `T52-green-exfil-test.log`.

### 5. Required focused suites

`bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts
src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts src/mcp`

**259 pass, 3 skip, 0 fail, 1244 expect(), 262 tests across 21 files.**
Raw `T52-after-focused-suites.log`. (T40 recorded 252 pass / 3 skip / 255 tests on
the same set; the +7 are this task's regressions, and 0 fail means nothing in the
other four targets regressed.)

Wider sweep: `bun test src/security src/session` → **323 pass, 0 fail, 1557
expect()**. Raw `T52-after-wider-suite.log`.

### 6. Character references (`T42-charrefs.ts`, unmodified)

Unchanged before and after: `namesTested 48, casesTested 240,
namedSpellingBypasses [], numericSpellingBypasses [], absentButUrlSyntax []`.
Raw `T52-before-T42-charrefs.log`, `T52-after-T42-charrefs.log`.

### 7. The base-element determination (`T52-base.ts`, new)

Same probe, both detectors (the "before" detector is the pre-T52 revision
reconstructed by reverse-applying only the four *behavioural* edits, each anchor
required to match exactly once, and cross-checked against ten known verdicts).

| | Before | After |
|---|---|---|
| cases | 14 | 14 |
| attacker host reachable **before** redaction | 10 | 10 |
| attacker host reachable **after** redaction | **10** | **0** |
| documents not neutralized | 10 | **0** |
| false positives (4 controls) | 0 | **0** |

Raw: `T52-before-base.log`, `T52-after-base.log`.

### 8. False-positive sweep over the repository's own content (`T52-corpus.ts`, new)

Every text file in the checkout (17 extensions, `node_modules`/`.git`/build output
excluded), empty allowlist, both detectors.

| | Before | After |
|---|---|---|
| files scanned | 16684 | 16684 |
| files unreadable / skipped | 0 / 0 | 0 / 0 |
| total findings | 192 | 248 |
| files with findings | 40 | 41 |

Raw `T52-before-corpus.log`, `T52-after-corpus.log`.

The delta is **+66 / −10, and every one of the 66 is inside a file that carries
attack vectors on purpose**: the flow's own probes
(`T42-exfil-attack.ts` +14, `T42-boundary.ts` +6, `T24-recheck2-boundary.ts` +1,
`T52-base.ts` +10), the review artifacts quoting them (`T42-review.md` +5,
`T42-result.json` +1, `T52-spec.md` +3, one gdctx log +1), the extended test file
(`src/security/detect/exfil.test.ts` +24) and the detector's own doc comment (+1).
**Zero new findings in benign repository content** — no docs page, no fixture, no
source file outside the security detector. All 18 `egress.html-base-href-exfil`
hits are in `T52-base.ts`, `exfil.test.ts` and `T42-exfil-attack.ts`; the
repository contains no benign `<base href>`. The 10 removed are the same
destinations re-attributed after defect 3 (`…/a` → `…/a>b`, the whole-span mask).

### 9. Types and lint

- `bun run typecheck` (`tsc --noEmit`) — exit 0, no output. Raw
  `T52-after-typecheck.log`.
- `bunx eslint src/security/detect/exfil.ts src/security/detect/exfil.test.ts` —
  exit 0, no output. Raw `T52-after-eslint.log`.
- `bunx eslint` on the two new probe artifacts — exit 0 (both are outside the lint
  scope; reported so the omission is not silent). Raw `T52-after-eslint-probes.log`.

## Concerns for the orchestrator

1. **The deferred surface task is still open and is now the whole residual.** The
   floor covers `<img|image src>`, `<img|image srcset>`, the markdown image and
   reference forms, and now `<base href>`. The ~19 render-triggered surfaces listed
   above remain unclosed by policy decision, and `<meta http-equiv=refresh>` should
   be in that task's scope. Nothing in this task changes that ruling; it only
   removes `<base>` from the list, because `<base>` was not one more fetching
   element but a falsifier of the classifier's own rule.
2. **Two deliberate over-approximations, both toward flagging.** A duplicate
   `src`/`srcset` in one tag is classified even though a tree builder keeps only the
   first, and a tag left unterminated at end of input is still classified even
   though a tree builder emits no element. Both are stated in the code, both err in
   the safe direction, and the second matches the previous behaviour exactly.
3. **`<base href>` is a new finding class under an empty allowlist.** A benign
   document carrying `<base href="https://cdn.example.org/">` becomes an egress
   finding — consistent with how the floor already treats an
   `<img src="https://cdn.example.org/logo.png">`, and measured to hit nothing in
   this repository, but it is a behaviour change a reviewer should agree with
   rather than inherit.
4. **The "before" side of the two new probes uses a reconstructed detector.** The
   pre-T52 revision is not a git object (T40's changes are uncommitted), so it was
   rebuilt by reverse-applying the four behavioural edits with each anchor required
   to match exactly once, then cross-checked against ten known verdicts
   (including the pre-existing false positive). The reviewer's own two matrices
   needed no reconstruction — their before-runs are real runs against the tree as
   it stood.
5. **Do not review your own fix.** This report is evidence, not adjudication. The
   tokenizer states are taken from the HTML Standard §13.2.5, the resolution
   branches from the WHATWG URL *scheme* state, and every host verdict comes from
   Bun's WHATWG `URL`, not from a live renderer.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the file set exactly,
  and the graph answers from the last `keryx gdgraph build` while the tree carries a
  large uncommitted multi-worker change set, so a graph answer could not be quoted
  as current. The cross-file enumerations (policy-id call sites, remediation string)
  came from `ctx rg` over the working tree.
- `wiki_used: no (not-relevant)` — the governing texts are `T42-review.md`,
  `docs/requirements/keryx-agent-first-core/policies.md`, the flow's
  `acceptance-criteria.md` and `T40-spec.md` / `T40-implementation.md`; all read
  directly.
- `ctx_used: partial, disclosed` — every code search went through
  `bun src/cli.ts ctx rg`. Probe and test **execution** ran `bun` directly, as the
  reviewer disclosed and for the same reason: `ctx run`'s compaction elides the
  per-case statuses that are the acceptance evidence. Test, typecheck and lint
  output was small enough to read whole.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find` over project code. Bounded
  `Read` calls with `offset`/`limit` and small `bun -e` readers over scratchpad JSON
  were used instead; two attempted `cat`/`tail` invocations were correctly refused
  by the routing hook and replaced.
