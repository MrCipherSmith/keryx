# T52 — spec: fix the extractor and the resolution assumption together

Written before any code change. Baselines measured first (see "Baseline").

Closes T42#F-001 (blocker), T42#F-002 (major), T42#F-003 (minor), the `<base href>`
half of T42#F-006 (structural), and the false sentence in T42#F-005.

## Why this round is scoped as "extractor + resolution assumption + base element"

Four rounds have now moved the hole one layer up. T24/T24R closed URL *spellings*;
T40 replaced spelling recognition with real URL *resolution* and retired that whole
class; T42 then attacked the layer above and found the destinations never reach the
classifier at all, plus one assumption inside the classifier that is only true for
one renderer document scheme.

So this task does not fix "the fourteen cases". It fixes the two mechanisms that
produce them, and it fixes the one document-level element (`<base>`) that can
falsify the classifier's remaining load-bearing assumption ("relative ⇒ same
origin ⇒ no channel"). Anything that is a *policy* decision about which other
elements auto-fetch (iframe, video, script, CSS `url()`, the SVG `href` spelling,
`meta refresh`) is explicitly **out of scope** — the reviewer ruled it a separate
task, and widening the net there has a real false-rejection cost.

## Baseline (measured, before any edit)

| Probe | Result | Raw log |
|---|---|---|
| `T42-exfil-attack.ts` (reviewer's 42-case matrix, 5-renderer-base WHATWG oracle) | `cases=42 bypasses=14 falsePositives=0` (8 unconditional, 6 conditional) | `.metaproject/data/gdctx/raw/T52-before-T42-exfil-attack.log` |
| `T24-recheck2-exfil.ts` (earlier 48-case matrix) | `cases=48 bypasses=0 falsePositives=0` | `.metaproject/data/gdctx/raw/T52-before-T24R2-48matrix.log` |
| `T42-boundary.ts` ROW 1 | 6 of 9 shapes `mcp isError=false state=none reasons=[] leaksHost=true \| persist leaksHost=true identical=true \| seam leaksHost=true` | `.metaproject/data/gdctx/raw/T52-before-T42-boundary-row1.log` |
| `T42-charrefs.ts` | `namesTested=48 casesTested=240 namedSpellingBypasses=[] numericSpellingBypasses=[] absentButUrlSyntax=[]` | `.metaproject/data/gdctx/raw/T52-before-T42-charrefs.log` |

## Defect 1 (blocker) — parse attributes the way a renderer does

### What is wrong

```
HTML_IMG        /<im(?:g|age)\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
HTML_IMG_SRCSET /<im(?:g|age)\b[^>]*?\bsrcset\s*=\s*(…)/gi
```

Two independent assumptions, both contradicted by the HTML tokenizer
(HTML Standard §13.2.5):

1. **`[^>]*?` assumes `>` ends a tag.** In *attribute-value-(double|single)-quoted*
   state `>` is an ordinary character. `<img alt="a>b" src="https://att/p">` is ONE
   element with a real `src`; the character class cannot cross that `>`, the match
   fails, and the global scan finds no other `<img`, so the element is never
   extracted at all.
2. **`\bsrc` assumes an attribute-name position.** `\b` matches inside an attribute
   *value* too, so `<img alt="src=/safe" src="https://att/p">` captures the decoy
   `/safe"`, which correctly resolves relative — and leaves `lastIndex` past the
   real destination.

Both apply to `srcset` and to the `<image>` alias, and to a tag spread over lines.
Widening the character class cannot fix either: the fix is to stop using a
character class for a job the tokenizer does with a state machine.

### The fix

Replace both regexes with a small hand-written start-tag scanner that reproduces
exactly the tokenizer states between the tag name and the terminating `>`. The
constraint permits hand-rolled *attribute* scanning (only the URL parser must be
the platform's), provided it is justified against the tokenizer's rules — that
justification is the enumeration below.

```
HTML_IMAGE_TAG /<im(?:age|g)(?=[\t\n\f\r />]|$)/gi     // tag-name state ends here
HTML_BASE_TAG  /<base(?=[\t\n\f\r />]|$)/gi            // defect 4
```

then `readStartTagAttributes(content, indexAfterName)` walks:

- **before-attribute-name** — skip HTML whitespace (tab, LF, FF, CR, space) and
  `/`; `>` or EOF ends the tag.
- **attribute-name** — the first character is taken unconditionally (so a leading
  `=` is part of the name, as the spec's *unexpected-equals-sign-before-attribute-name*
  rule says); subsequent characters end the name at whitespace, `/`, `>` or `=`.
  Names are lowercased.
- **after-attribute-name** — skip whitespace; no `=` ⇒ a boolean attribute, no value.
- **before-attribute-value** — skip whitespace after `=`.
- **attribute-value-double-quoted / -single-quoted** — everything up to the
  matching quote, `>` and newlines included; EOF ⇒ value runs to end of input.
- **attribute-value-unquoted** — up to whitespace or `>`.

`src`/`srcset` are read **only from the attribute-name position**, so a `src=`
inside a value is data. The scan then resumes **after the tag's own `>`**, so a
`<img …>` written inside another tag's quoted attribute value is data too (a new
false positive the naive fix would have introduced).

### Attribute-form enumeration, and its method

**Method:** derived from the HTML Standard's tokenizer state machine (§13.2.5),
not from a list of examples. Every state reachable between `tag name` and the
terminating `>` was enumerated, and each transition that can carry or hide a
`src`/`srcset` is one form below. Each row is a regression vector.

| # | Form | Tokenizer state | Handled |
|---|---|---|---|
| 1 | `src="U"` | attribute-value-double-quoted | yes |
| 2 | `src='U'` | attribute-value-single-quoted | yes |
| 3 | `src=U` | attribute-value-unquoted | yes |
| 4 | `src = "U"` (whitespace around `=`) | after-attribute-name / before-attribute-value | yes |
| 5 | `hidden` (valueless attribute) | after-attribute-name, no `=` | yes |
| 6 | `<img/src="U"/>` (solidus between attributes) | before-attribute-name ignores `/` | yes |
| 7 | `SRC=`, `SrcSet=`, `<IMAGE>` | ASCII-case-insensitive names and tag names | yes |
| 8 | earlier value containing `>` | quoted value states — `>` is data | yes (defect 1.1) |
| 9 | earlier value containing `src=`/`srcset=` | value is not a name position | yes (defect 1.2) |
| 10 | tag spread over several lines | whitespace includes LF | yes |
| 11 | duplicate `src` in one tag | tree builder keeps the first | **both classified** (deny-by-default) |
| 12 | unterminated quoted value / EOF inside the tag | EOF-in-tag | value runs to EOF; collected attributes still classified |
| 13 | `=` as the first character of a name | unexpected-equals-sign-before-attribute-name | yes |
| 14 | `<img …>` written inside another element's quoted value | it is text, not an element | **not** a finding (scan resumes past the outer tag) |

Rows 11 and 12 are the two places this scanner is deliberately *more* eager than a
conformant tree builder, and both err toward flagging: a duplicate `src` is dropped
by a real parser but costs nothing to classify, and an unterminated tag is not
emitted by a real parser but our input is a *fragment* — the renderer may hold the
terminator we do not. Row 12 also matches the previous behaviour exactly (the old
regex never required a `>` either), so it is not a widening.

## Defect 2 (major) — decide the scheme-relative-looking destination independently of any base scheme

### What is wrong

`SYNTHETIC_BASES` varies the base **host** and holds the base **scheme** fixed at
`https`. WHATWG resolution branches on *both*: in the *scheme* state, a special
scheme equal to the base's goes to *special relative or authority* (relative,
inheriting the base host), and one that differs goes to *special authority
slashes* → *special authority ignore slashes*, which makes the next token the
**host**. So with two `https:` bases, `https:attacker.invalid/p` is judged relative
— true only for a renderer whose own document is `https:`. Measured against five
renderer bases:

```
https:attacker.invalid/p  →  https-page: keryx-…-base-a/-b (relative)
                             file-doc / vscode-webview / electron-app: attacker.invalid
```

The code's own asymmetry proves the variable is scheme: `http:attacker.invalid/p`
**is** flagged (scheme differs from the bases) while `https:` is not.

### The decision, and why it is the correct one

**Treat a destination that carries a special scheme and reaches an http(s) host
under *any* base scheme as carrying its own authority — i.e. flag it.**

Justification, in the only two directions that matter:

- *Correctness of the deny.* The bytes `https:attacker.invalid/p` fetch
  `attacker.invalid` in every renderer whose document scheme is not `https:`, and
  Electron/`file:`/`vscode-webview:`/custom-`app:` documents are exactly the
  contexts MCP clients render tool output in. The detector cannot know the
  renderer's document scheme, and `policies.md` makes the floor deny-by-default on
  a real cross-origin fetch. Deny is the only direction in which this may err.
- *Cost of the deny.* The class this adds is exactly "special scheme, colon, no
  slashes, then a host" — a URL nobody writes deliberately to mean a relative path.
  Measured: the only destinations whose verdict changes are the six `a.scheme*`
  spellings; every relative, dot-segment, fragment-only, query-only,
  percent-encoded, `data:`, `blob:`, `ftp:`, `ws:` and backslash-in-path control
  keeps its current verdict (table below).

### The mechanism

Keep the two-base *disagreement* rule — it is what makes "relative" decidable
without a syntax test — but apply it to **two pairs** that differ in scheme, and
flag when **either** pair agrees:

```
pair 1 (special):  https://keryx-detector-base-a.invalid/keryx/page
                   https://keryx-detector-base-b.invalid/keryx/page
pair 2 (opaque):   keryx-detector://keryx-detector-base-a.invalid/keryx/page
                   keryx-detector://keryx-detector-base-b.invalid/keryx/page
```

Two base schemes are *sufficient*, not merely more: the scheme state branches on
the single predicate "base's scheme equals the destination's scheme". Pair 1
realises the equal branch for `https` (and the differing branch for everything
else); pair 2's scheme is non-special and private, so it realises the differing
branch for **every** special destination scheme, including `https`. A third base
scheme could only repeat one of those two branches.

Measured resolution table (`bun … urlprobe.ts`, WHATWG `URL`):

| destination | pair 1 | pair 2 | verdict |
|---|---|---|---|
| `https:attacker.invalid/p` | base-a / base-b (disagree) | attacker.invalid ×2 | **flag** (new) |
| `https:/attacker.invalid/p`, `HTTPS:…`, `HtTpS:…` | disagree | attacker.invalid ×2 | **flag** (new) |
| `http:attacker.invalid/p` | attacker.invalid ×2 | attacker.invalid ×2 | flag (unchanged) |
| `https://att/p`, `//att/p`, `\\att/p` | attacker.invalid ×2 | agree but scheme `keryx-detector:` ⇒ null | flag (unchanged) |
| `/assets/a.png`, `../a.png`, `a.png`, `#frag`, `?q=1`, `/assets/a\b/logo.png` | disagree | disagree, and non-http scheme | not a finding (unchanged) |
| `%2f%2fatt/p`, `https%3a//att/p`, `docs.example.org/pixel.png` | disagree | non-http scheme | not a finding (unchanged) |
| `data:`, `blob:`, `mailto:`, `ftp://`, `ws://`, `file:` | non-http scheme | non-http scheme | not a finding (unchanged) |
| `https://keryx-detector-base-a.invalid/p` (names a base host) | agree | agree | flag (unchanged) |

## Defect 3 (minor) — do not cut a bare destination at `>`

`INLINE` group 3 `[^)\s>]+` → `[^)\s]+`; `REFERENCE_DEF` group 3 `[^\s>]+` →
`[^\s]+`. The angle-bracket alternative is tried first and is unchanged, so `>`
no longer needs to be excluded to keep the two alternatives apart. A CommonMark
bare destination may legally contain `>`, so `![x](https://att/a>b)` will now mask
whole instead of leaving `>b`.

## Defect 4 (structural) — the `<base href>` element

`<base href>` fetches nothing, and that is precisely why it is dangerous here: it
re-points **every relative URL in the document**, which falsifies the load-bearing
half of the two-base rule ("the resolutions disagree ⇒ relative ⇒ the renderer
fetches from its own origin ⇒ no channel").

**Treatment:** a `<base href>` whose destination carries its own authority (same
`exfilHost` funnel, same allowlist check) is itself an egress finding,
`egress.html-base-href-exfil`, masked `url` on its raw span.

**Why that is sufficient, stated precisely rather than assumed.** The floor's
guarantee is about the text that gets rendered. Masking the base href removes the
re-point from that text: `<base href="[REDACTED:url]">` sets the document base to a
same-origin path, so every relative destination in the redacted document resolves
same-origin again and the two-base rule's conclusion is true once more. And a
caller that never applies redaction still sees an `egress` finding on the document,
so the content is not "clean" on either path. This is verified, not argued, by
`T52-base.ts`: for each vector, every destination in the **redacted** output is
resolved against all five renderer bases and no attacker host appears.

**Why the detector does not instead re-resolve relative destinations against the
attacker's base:** it would make attacker-controlled bytes the resolution base for
spans whose offsets must stay on the original bytes, and it would flag relative
destinations whose *written* form is harmless — a larger behaviour change for no
additional guarantee, since the re-point is already removed.

**`meta refresh` is deliberately not handled here.** It is a navigation surface,
not a subresource fetch, and unlike `<base>` it does not falsify any rule this
detector relies on; it belongs to the deferred policy task with the other
render-triggered surfaces. It is recorded in the enumeration so the next round does
not rediscover it as an omission.

## Defect 5 (info, documentation) — the false membership sentence

"Over the ASCII punctuation that HTML5 names, that is exactly this set" is false:
`midast` (`*`), `UnderBar` (`_`) and `DiacriticalGrave` (`` ` ``) are alias
spellings of characters the table already carries, and 11 more ASCII-denoting names
are absent. The table stays; the sentence is replaced by the true and stronger
reason — the numeric form `&#NN;`/`&#xNN;` is unbounded and generic and already
covers every character, so a *named* entry can only ever matter for a character
that has an HTML5 name **and** is URL syntax or URL-removed. Measured: of the 14
absent names, none denotes such a character (`T42-charrefs.ts`,
`absentButUrlSyntax: []`).

## Regressions (RED before GREEN), in `src/security/detect/exfil.test.ts`

One test per defect, plus controls. Every existing test is kept unchanged.

1. `attribute scanning follows the tokenizer, so a quoted > or a decoy src= cannot
   hide a destination` — forms 1–13 above as vectors, `<img>`/`<image>`,
   `src`/`srcset`, both quote styles, multi-line, unquoted, `/`-separated.
2. `a scheme-with-no-slashes destination is judged independently of the base
   scheme` — `https:`, `https:/`, `HTTPS:`, `HtTpS:`, `https&colon;`, and the
   markdown surface.
3. `a bare CommonMark destination containing > is masked whole` — inline and
   reference-definition forms; asserts the `>`-tail is inside the mask.
4. `a base element carrying its own authority is a document-level egress finding` —
   absolute, protocol-relative, `<base>` + relative `<img>`; controls: relative
   `<base href="/docs/">`, allowlisted base.
5. Benign controls, extended: form 14 (`<img>` inside another value), a `<base>`
   with a relative href, `<img/src=…>` self-closing relative, an unquoted relative
   value, a duplicate relative `src`, prose containing `src=` and `>`.
6. Boundary regressions extended: the five new class vectors driven through
   `prepareOutputForPersistence` (`src/security/guard.ts`) and
   `validateOutputForTransport` (`src/security/output-validation.ts` — the exact
   function `src/mcp/redact-seam.ts` calls).

## Verification plan

Before and after, with counts and raw logs under `.metaproject/data/gdctx/raw/`:

- `T42-exfil-attack.ts` (42 cases) — must go 14 → 0 bypasses, 0 false positives.
- `T24-recheck2-exfil.ts` (48 cases) — must stay 0 / 0.
- `T42-boundary.ts` — the six leaking shapes must become `state=redacted`,
  `leaksHost=false`, `identical=false` at `dispatchCallTool`,
  `prepareOutputForPersistence` and `redactToolOutput`; controls unchanged.
- `T42-charrefs.ts` — must stay 0 named / 0 numeric bypasses.
- `T52-base.ts` (new) — the base-element determination, both directions.
- `T52-corpus.ts` (new) — a false-positive sweep over the repository's own text
  content, before and after; the count must not rise.
- `bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts
  src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts src/mcp`
- `bun run typecheck`, `bunx eslint` on both changed files.

Probes run **directly with `bun`**, not through `ctx run`: the reviewer disclosed
that `ctx run`'s compaction elides the per-case statuses that are the evidence, and
it does. Recorded in the routing audit.

## Ownership

Only `src/security/detect/exfil.ts` and `src/security/detect/exfil.test.ts` are
edited. `guard.ts`, `output-validation.ts`, `service.ts`, `config.ts`, `src/mcp/*`
and every existing artifact are read and driven, never modified. New artifacts
(`T52-*.md`, `T52-*.ts`, `T52-result.json`) are additive.
