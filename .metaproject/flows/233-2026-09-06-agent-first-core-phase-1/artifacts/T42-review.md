STATUS: DONE_WITH_CONCERNS

# T42 — independent verification of the three repairs (T40 / T41 / T44)

Third independent round. This reviewer wrote none of the code, none of the tests and neither earlier
review. Every verdict below cites a probe written and executed here against the current working tree.
The earlier probes were re-run as controls, and they reproduce — but they are exactly the vectors the
earlier rounds named, so they are re-run to prove no regression, never to prove closure.

## Scope

- Branch: `codex/agent-first-core`
- Base / merge-base: `main` @ `0bc6418` (`feat(metaproject): shrink the routing gate…`)
- Stage 1: **FAIL** — row 1 (auto-fetch resolution) is not met. Rows 2, 3, the no-new-bypass row and
  the no-new-false-rejection row are met.
- Stage 2 (code quality): **not run**, as required when Stage 1 does not pass.
- Source changes by this review: **none** (read-only). Three probe scripts and these two artifacts
  are the only files written.

File SHA-256 at start and at end. **No reviewed file changed during the review.** One excluded,
concurrently-owned file drifted and is recorded rather than reviewed.

| File | SHA-256 start | SHA-256 end | Drift |
|---|---|---|---|
| `src/security/detect/exfil.ts` | `5c020a68…f865a6` | same | no |
| `src/security/output-validation.ts` | `0f6856a3…ce19dd` | same | no |
| `src/security/guard.ts` | `29502011…44894` | same | no |
| `src/security/service.ts` | `6c71ef1e…c755a0` | same | no |
| `src/mcp/redact-seam.ts` | `e59526ed…1470300` | same | no |
| `src/mcp/dispatch.ts` | `f1db21b0…f6b6f18` | same | no |
| `src/commands/health.ts` (excluded, concurrent) | `8ce5d287…570dcd` | same | no |
| `src/flow/review-gate.ts` (excluded, concurrent) | `ab83a43b…40be29a` | `9cee7f72…8ff365321` | **YES — another worker's file, not reviewed, not touched here** |

Full lists: `…/scratchpad/hashes-start.txt`, `…/scratchpad/hashes-end.txt` (session-local).

## Summary

- Blocker: 1
- Major: 1
- Minor: 1
- Info: 3

T41 and T44 hold under attack. The byte-faithful scanner is the first of the three approaches to
this problem that I could not turn back into a hiding channel: 14 duplicate-member shapes the earlier
rounds did not use — including escaped duplicate keys in both orders, a `__proto__` duplicate, an
empty-key duplicate, a duplicate at depth 6 inside arrays, and a `0`/`-0` pair — are all replaced by
the canonical form with nothing leaked, while 27 value-faithful spellings (out-of-double-range
integer, `-0`, `1E+2`, Go/Python `\uXXXX` escapes, lone surrogates, integer-like key order, 2000-deep
nesting) come back byte-exactly with `state:"none"`. My own sweep of the repository confirms the
mislabelled set is empty.

T40 is the third approach to the auto-fetch floor and, like the first two, it closes the vectors it
was shown. Resolution is genuinely stronger than recognition and it retires the whole authority-
spelling class — the reviewer's 48-case matrix is now 0 bypasses / 0 false positives, reproduced
here. But the repair was made **inside the classifier**, and the floor is only as wide as the
extractor that feeds it. Two classes remain, both measured to reach the MCP client with
`isError:false` and `redaction.state:"none"` and to reach durable sinks byte-identical:

1. **Extraction (blocker, unconditional).** `HTML_IMG`'s attribute scan is `[^>]*?` and its `\bsrc`
   anchor is unanchored. A `>` inside an earlier *quoted* attribute value — which an HTML tokenizer
   does not treat as a tag end — makes the whole element invisible to the detector; and a decoy
   `src=` inside an earlier attribute value captures the match and moves `lastIndex` past the real
   one. Eight vectors, no character references, no exotic URL spelling, plain `https://` throughout.
   T40's own extraction table answers "truncated a destination? **no**" for both `<img>` rows; that
   answer is right about truncation and wrong about extraction, and the `<image>` alias T40 added
   inherits the same hole.
2. **The two-base reasoning itself (major, conditional).** Both synthetic bases are `https:`. WHATWG
   URL resolution of a `scheme:`-with-no-slashes destination *depends on whether the base's scheme
   equals it*: with an `https:` base, `https:attacker.invalid/p` is relative (the two bases disagree
   → no finding); with a `file:`, `vscode-webview:` or custom `app:` base — i.e. inside the Electron
   and webview clients that render MCP output — the parser's *special authority slashes* state makes
   `attacker.invalid` the host and the renderer fetches it. The bases differ in host, which is what
   the design intends, but they are **identical in scheme**, and scheme is the second variable the
   resolution depends on. The asymmetry is visible in the code's own behaviour: `http:attacker.invalid/p`
   *is* flagged (its scheme differs from the bases) while `https:attacker.invalid/p` is not.

## Stage 1 — specification compliance

| # | Row | Verdict | Evidence |
|---|---|---|---|
| 1 | **Auto-fetch resolution (T40)** — the two-base rule closes the class, not the seventeen cases; nothing is truncated before classification | **NOT MET** | Reviewer's 48-case matrix re-run unmodified: `cases=48 bypasses=0 falsePositives=0` — every one of the 17 is genuinely closed and the 4 benign controls stay unflagged. Beyond it, `T42-exfil-attack.ts` (42 cases, each adjudicated by a WHATWG `URL` oracle against **five** renderer document bases, not one) reports **14 bypasses, 0 false positives**: 8 unconditional (`b.gtInEarlierAttribute`, `.Single`, `.Image`, `.Srcset`, `b.decoySrcInAttribute`, `b.decoySrcsetInAttribute`, `b.decoySrcThenGt`, `b.newlineInTag`) and 6 conditional on a non-`https` renderer base (`a.schemeNoSlashes`, `.OneSlash`, `.Upper`, `.Mixed`, `.Entity`, `.Markdown`). Reproduced at the real boundaries by `T42-boundary.ts`: six of them return `isError:false`, `state:"none"`, `reasons:[]` from `dispatchCallTool` with the attacker host present, and `allowed:true` **byte-identical** through `prepareOutputForPersistence` and `redactToolOutput` — with `redactToolOutput:false`, i.e. the mandatory floor. Findings T42#F-001, T42#F-002. Positive half: the authority-spelling class *is* closed as a class — backslash runs, unbounded slash runs, userinfo, ports, IPv6, hex IPv4, IDN homoglyphs, trailing-dot hosts and uppercase/mixed-case schemes are all resolved correctly, and percent-encoded delimiters, `data:`, `blob:`, `ftp:`, `ws:`, dot segments, backslash-in-relative-path, anchor-only and query-only destinations are correctly *not* findings. |
| 1a | **Extraction sub-row** — no destination truncated before classification | **PARTIAL** | The markdown pointy-bracket fix is real and complete: `![x](<ht<TAB>tps://…>)` and the reference-definition form now reach `considerUrl` whole. The `srcset` whitespace split is renderer-faithful as claimed (the srcset grammar terminates a URL at whitespace). One residual truncation, benign: a CommonMark **bare** destination may legally contain `>`, and `INLINE`'s `[^)\s>]+` cuts there — `![x](https://attacker.invalid/a>b)` masks as `![x]([REDACTED:url]>b)`, so the host is still removed and this is mask completeness, not a bypass (T42#F-003). The real extraction defect is not truncation but non-match: see T42#F-001. |
| 2 | **Byte-faithful canonicalization (T41)** — no hiding channel regained; out-of-range integer and `-0` survive byte-exactly; nothing-removed no longer claims a redaction | **MET** | `T42-boundary.ts` ROW 2, 42 shapes. **Hiding channel, attacked with shapes the earlier rounds did not use:** `dupSameValue`, `dupObjectSurvivor`, `dupArraySurvivor`, `dupEscapedKeyFirst`, `dupEscapedKeySecond`, `dupProtoKey`, `dupEmptyKey`, `dupDepth6InArray` (duplicate at depth 6 through five array wrappers), `dupNegativeZeroPair` (`{"a":0,"a":-0}` — `Number("0") === -0` is *true* in JS, so the value comparison alone would have accepted the first member; the key-consumption rule rejects it anyway), `dupNumberSpelling`, `dupLastMember`, `dupWithNewlines` — every one `ok:true`, `state:"redacted"`, `reasons:["serialized-content-normalized"]`, `bytesPreserved:false`, `leaksSecret:false`, `leaksCred:false`. Structurally unsafe duplicates still fail closed: `dupKeyIsSecretName` → `sensitive-property-name`, `dupSurvivorNumericCredential` → `sensitive-numeric-field`. The argument holds under inspection too: `matchesObject` deletes the key from `unmatched` on match and refuses a key not in it, so a duplicate fails **before its value is read**, and since `JSON.parse` has already succeeded the only way valid JSON can carry more than its parse is a duplicate member. **Value preservation:** `bigInteger` `{"n":12345678901234567890}` and `negativeZero` `{"delta":-0,"other":[-0]}` are now `bytesPreserved:true`, `state:"none"`. **No false redaction:** `unicodeEscape`, `goStyleEscape` (`\u003c \u0026`), `solidusEscape`, `exponent`, `trailingZero`, `plusExponent`, `integerLikeKeyOrder`, `surrogatePair`, `loneSurrogate`, `emptyKeyClean`, `protoKeyClean` all `state:"none"`, byte-exact. |
| 3 | **Persistence signal (T44)** — a caller can distinguish bytes preserved / content masked / duplicate dropped | **MET, with a documentation defect** | `T42-boundary.ts` ROW 3. On the materializer taken alone the three outcomes are fully distinct: `none/[]/bp=true`, `redacted/["secrets.aws-access-key"]/bp=false`, `redacted/["serialized-content-normalized"]/bp=false`; and the refused branch carries its own outcome (`{state:"format-unsafe", reasons:["sensitive-numeric-field"]}`) for a numeric value under a credential key. The disclosed architectural limit is **real and reproduced**: driving the genuine `guardOutput()` → `prepareOutputForPersistence()` path, masked content and a dropped duplicate both read `none/[]/bp=false` and are indistinguishable from each other; only `bytesPreserved` separates them from a preserved payload. Ruling below (T42#F-004): **acceptable, because it is not the caller's only signal** — the same `guardOutput` result carries `decision.findings` (`[{category:"secret", policyId:"secrets.aws-access-key"}]`, measured), so "was something masked and why" is answerable end to end. What is not acceptable is the `guard.ts` doc comment, which states the return distinguishes all three; on the path every production caller uses, it does not. |
| 4 | **No new bypass** introduced by the three repairs | **MET** | Every class the earlier rounds closed is still closed at every seam. `T24-recheck2-exfil.ts` 0/48. `T24-recheck2-boundary.ts`: all 8 previously-open transport cases now `state:"redacted"` / `egress.html-image-exfil` (`p.markdown-angle-tab`: `egress.markdown-image-exfil`) with `leakHost=false`, and `backslashImage` / `namedTabImage` / `imageTag` all `identical=false, leakHost=false` through the materializer and the seam. `T24-recheck2-validator.ts`: every ROW1 property-name verdict, every ROW3 `$ref` verdict, and all five T19 contract controls (own `undefined` → `non-json-value`, cycle → `cyclic-value`, non-finite → `non-json-value`, numeric-under-credential-key → `sensitive-numeric-field`, secret property name → `sensitive-property-name`) reproduce. Constant failure text `Output withheld: format-unsafe` on every refusal; an attacker-named `$ref` leaks nothing. The 14 bypasses in row 1 are **pre-existing shapes T40 never claimed**, not regressions T40 introduced — I checked that none of them depends on a T40 change. |
| 5 | **No new false rejection** | **MET** | 0 rejections in every probe and in the whole repository. My own re-measured sweep (`T24-recheck2-repojson.ts`, unmodified, over this checkout): **`filesScanned 2058, unparseable 0, bytePreserved 2007, rejected 0, normalizedOnly 0, redactedForContent 51`** — the T41 claim of 22 → 0 mislabelled files is confirmed independently, and the byte-preserved count rose without any new rejection. Deliberate false-rejection attacks on the new scanner all pass: 2000-deep nesting, 200-deep nesting, leading/trailing whitespace, pretty-print at indent 2 and tab, top-level scalar, top-level out-of-range number, `{}`, `[]`, non-JSON prose, `1E+2`, lone surrogate, surrogate pair, empty key, `__proto__` key. At the transport: `p.public-link` `state:"none"` byte-identical, `p.public-link-plus-email` accepted as `redacted`/`pii.email` rather than refused, `p.numeric-key` / `p.safe-scalars` / `p.ref-defs-sibling` / `p.ref-annotations` all `state:"none"`. Exfil side: 15 benign controls, **0 false positives** — including a backslash inside a relative path, a relative multi-candidate `srcset`, `callbacks[0](payload)`, and prose that mentions `src`. |

### Dispatch acceptance criteria

- **AC2 (AFC-02)** — **met**. `p.secret-key`, `p.deep-secret-key`, `p.email-key` → `isError:true`,
  `state:"format-unsafe"`, `sensitive-property-name`, constant text, secret absent from
  `JSON.stringify(result)`; `p.throws-secret` (a thrown error carrying the credential) →
  `isError:true`, `state:"redacted"`, secret absent; safe JSON passes its schema
  (`p.safe-scalars`, `p.ref-defs-sibling`, `p.ref-annotations` → `state:"none"`); a numeric required
  field carrying a secret returns `format-unsafe`/`sensitive-numeric-field`, never an invalid string
  (`p.password-numeric` at the transport, `numericUnderCredentialKey` at the materializer, both
  measured here).
- **AC5 (AFC-15)** — **not met**. No field-name or spelling bypass survives (row 1's positive half,
  row 4); a URL secret is masked (`secrets.url-credentials` fires across the corpus sweep;
  `p.password-key` → `secrets.sensitive-field`); a public Markdown link is byte-identical and not an
  egress finding, alone and beside a redacted sibling. It fails on the auto-fetch half: 8
  unconditional and 6 conditional renderer-equivalent URLs still reach the client unflagged
  (T42#F-001, T42#F-002).
- **Third criterion (all three repairs hold at the detector AND at the public boundaries)** —
  **not met** for repair 1; **met** for repairs 2 and 3.

## Findings

### [T42#F-001] A `>` or a decoy `src=` in an earlier attribute value makes an `<img>` invisible to the detector

- **Severity:** blocker
- **File:** `src/security/detect/exfil.ts:280`
- **Symbol:** `HTML_IMG` / `HTML_IMG_SRCSET`
- **Problem:** Both patterns scan the tag with `[^>]*?` before an unanchored `\bsrc` / `\bsrcset`.
  Neither assumption survives contact with the HTML tokenizer:
  1. **`>` inside a quoted attribute value does not end a tag.** In the
     *attribute-value-(double|single)-quoted* state `>` is an ordinary character, so
     `<img alt="a>b" src="https://attacker.invalid/p">` is one element with a real `src`. The
     regex's `[^>]*?` cannot cross that `>`, the match fails at that position, and the global scan
     finds no other `<img`/`<image` — so the element is **never extracted at all**. Improving the
     classifier cannot reach it, exactly as with the markdown truncation T40 fixed.
  2. **`\bsrc` matches inside an attribute value.** `<img alt="src=/safe" src="https://attacker.invalid/p">`
     matches the *decoy*: the alternation's `([^\s>]+)` captures `/safe"`, which resolves relative
     and is correctly not a finding — and `lastIndex` is then past the real `src`, so the real
     destination is never classified either. The decoy needs no special spelling; `<img
     data-note="see src=/a.png for details" src="…">` is ordinary prose an attacker-controlled tool
     would emit.
  Both shapes apply identically to `srcset` and to the `<image>` alias T40 added, and to a tag
  spread over several lines.
- **Impact:** The mandatory no-auto-fetch floor is bypassed by plain `https://` URLs with no
  character references and no exotic authority spelling — i.e. by the simplest possible form of the
  attack the floor exists to stop. Measured at the real seams with advisory redaction **off**: the
  payload reaches the MCP client inside operation JSON with `isError:false` and
  `redaction.state:"none"` (the metadata affirmatively states nothing was redacted), and reaches
  durable sinks **byte-identical** through `prepareOutputForPersistence` and `redactToolOutput`.
  Rendering it is a zero-click request to the attacker host carrying whatever context the attacker
  encoded in the query string.
- **Reproduction:**
  `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T42-exfil-attack.ts <out>`
  → `unconditional` lists 8 ids. `bun …/T42-boundary.ts <out>` → `gtInEarlierAttribute`,
  `decoySrcInAttribute`, `decoySrcThenGt`, `gtInEarlierAttributeSrcset`, `imageAliasGt` all
  `mcp isError=false state=none reasons=[] leaksHost=true | persist leaksHost=true identical=true |
  seam leaksHost=true`, against controls `ctlBackslash` and `ctlImageTag` which are correctly
  `state=redacted reasons=["egress.html-image-exfil"] leaksHost=false`.
- **Suggested fix:** Stop scanning the tag with a character class and scan it the way the tokenizer
  does. Match the element open tag (`<im(?:g|age)\b`) and then walk its attributes with a small
  attribute-list pattern that consumes `name(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?` repeatedly until an
  unquoted `>`, collecting `src`/`srcset` from the *attribute name* position only — so a quoted `>`
  is consumed as data and a `src=` inside a value is never an anchor. Add one regression per shape
  in `src/security/detect/exfil.test.ts` (quoted `>` before src, single-quoted, `<image>` alias,
  `srcset`, decoy `src=`, multi-line tag) and one at the transport in
  `src/mcp/structural-redaction.test.ts`, keeping every existing benign control.
- **Class scope:**
  - sites: `src/security/detect/exfil.ts:280` (`HTML_IMG`), `:286` (`HTML_IMG_SRCSET`),
    `:354-364` (the `<img src>` loop), `:367-388` (the `srcset` loop). The markdown surfaces
    (`INLINE:270`, `REFERENCE_DEF:275`) do **not** carry this shape — they were checked and are
    delimiter-correct after T40.
  - enumeration_method: complete read of `src/security/detect/exfil.ts`, then every extraction
    constant crossed against the two tokenizer facts the regex ignores (a quoted `>` does not end a
    tag; an attribute *value* is not an attribute *name* position), producing a 10-shape matrix
    (`>` in an earlier value × double/single quote × `<img>`/`<image>` × `src`/`srcset`, decoy
    `src=`/`srcset=` in an earlier value, decoy embedded in prose, multi-line tag), each paired with
    a benign control and adjudicated by a WHATWG `URL` oracle rather than by inspection, then
    re-driven through `dispatchCallTool`, `prepareOutputForPersistence` and `redactToolOutput`.

### [T42#F-002] Both synthetic bases are `https:`, so a scheme-with-no-slashes destination is judged relative — but is absolute in every non-`https` renderer document

- **Severity:** major
- **File:** `src/security/detect/exfil.ts:201`
- **Symbol:** `SYNTHETIC_BASES` / `exfilHost`
- **Problem:** The two-base discriminator varies the base's **host** and holds its **scheme**
  fixed, but WHATWG URL resolution of a destination that carries a scheme and no slashes depends on
  *both*. In the *scheme* state, a special-scheme URL whose scheme equals the base's goes to
  *special relative or authority* (relative, inheriting the base host); one whose scheme differs
  goes to *special authority slashes* → *special authority ignore slashes*, which makes the next
  token the **host**. With two `https:` bases, `https:attacker.invalid/p` therefore resolves to
  each base's own host, the resolutions disagree, and the rule concludes "relative, same-origin, no
  channel". That conclusion is only true for a renderer whose document is itself `https:`. In a
  `file:` document, a `vscode-webview:` webview or an Electron custom-scheme document — the
  contexts MCP clients actually render markdown and HTML in — the base scheme differs and the same
  bytes resolve to `attacker.invalid`. The code's own behaviour exhibits the asymmetry:
  `http:attacker.invalid/p` **is** flagged (its scheme differs from the bases) while
  `https:attacker.invalid/p` is not, which is a scheme-dependent verdict on an
  otherwise-identical vector.
- **Impact:** A zero-click fetch to the attacker host under a realistic and common client class,
  from a payload the floor releases with `isError:false`, `redaction.state:"none"` and byte-identical
  persistence. Lower reach than F-001 because it needs the renderer's document scheme not to be
  `https:`, but the same floor and the same severity of outcome when it fires. Six spellings,
  including the markdown image surface and a `&colon;` entity form.
- **Reproduction:** `bun …/T42-exfil-attack.ts <out>` → `conditionalOnRendererScheme` lists
  `a.schemeNoSlashes`, `a.schemeOneSlash`, `a.schemeNoSlashesUpper`, `a.schemeNoSlashesMixed`,
  `a.schemeNoSlashesEntity`, `a.schemeNoSlashesMarkdown`; each row's `rendererHosts` shows
  `https-page: "client.example.org"` beside `file-doc / vscode-webview / electron-app-scheme:
  "attacker.invalid"`, with `flagged:false` and `hostStillPresentAfterRedaction:true`. At the
  boundary, `bun …/T42-boundary.ts <out>` → `schemeNoSlashes: mcp isError=false state=none
  reasons=[] leaksHost=true | persist leaksHost=true identical=true | seam leaksHost=true`.
- **Suggested fix:** Vary the base's **scheme** as well as its host. Resolve against a second pair
  of bases whose scheme is not `http(s)` (a non-special scheme such as
  `keryx-detector://base-a.invalid/keryx/page`) and flag when **either** pair agrees. Verified
  reasoning: a genuinely relative destination inherits the base host under both pairs, so it still
  disagrees within each pair and stays unflagged (no new false positive on `/assets/a.png`, `../a`,
  `#frag`, `?q=1`); a `scheme:`-no-slashes destination agrees within the non-special pair and is
  flagged. This is deny-by-default in the only direction the floor may err. Add one regression per
  spelling in `exfil.test.ts` and re-run the 15 benign controls.
- **Class scope:**
  - sites: `src/security/detect/exfil.ts:201` (`SYNTHETIC_BASES`), `:208` (`resolvedHost`),
    `:221` (`exfilHost`), `:232` (`considerUrl`, the single funnel every surface routes through).
  - enumeration_method: complete read of `exfilHost`/`resolvedHost` against the WHATWG URL *scheme*
    and *relative* state machine to identify every base property the resolution depends on (host —
    varied; scheme — not varied; path — irrelevant to hostname), then a 5-renderer-base × 21-URL-form
    oracle (`T42-exfil-attack.ts` section A) covering scheme-with-no-slashes in five spellings,
    userinfo, port, IPv6, hex IPv4, IDN homoglyph, trailing-dot host, backslash+userinfo,
    percent-encoded delimiters, and the non-network schemes `ftp:`/`ws:`/`blob:`/`data:`, each with a
    stated expected verdict.

### [T42#F-003] A bare CommonMark destination is still cut at `>`, leaving an unmasked tail

- **Severity:** minor
- **File:** `src/security/detect/exfil.ts:270`
- **Symbol:** `INLINE` / `REFERENCE_DEF`
- **Problem:** T40 added the angle-bracket alternative but left the bare alternative as
  `[^)\s>]+`. A CommonMark **bare** link destination may legally contain `>` (only `<`, ASCII
  control characters, and unbalanced parentheses are excluded), so
  `![x](https://attacker.invalid/a>b)` is extracted as `https://attacker.invalid/a`.
- **Impact:** None on host disclosure — the host precedes the cut, the finding fires, and the
  output masks to `![x]([REDACTED:url]>b)` with the host gone. The residue is a fragment of the
  attacker's path left in the output and a `start`/`end` span narrower than the destination, which
  matters only if a future change makes the tail meaningful. Recorded so the next round does not
  rediscover it as a bypass.
- **Reproduction:** `bun …/T42-exfil-attack.ts <out>` → row `b.mdBareGtTruncation`:
  `flagged:true, hostStillPresentAfterRedaction:false, redacted:"![x]([REDACTED:url]>b)"`.
- **Suggested fix:** Drop `>` from the bare alternative's negated class (`[^)\s]+`) now that the
  angle form is tried first, and assert the full-span mask in a regression.
- **Class scope:**
  - sites: `src/security/detect/exfil.ts:270` (`INLINE`, group 3), `:275` (`REFERENCE_DEF`, group 3).
  - enumeration_method: both bare alternatives read against the CommonMark link-destination
    grammar; the only character legal in a destination and excluded by the class is `>`.

### [T42#F-004] `prepareOutputForPersistence`'s doc comment claims a three-way signal the real path does not provide

- **Severity:** minor
- **File:** `src/security/guard.ts:53`
- **Symbol:** `prepareOutputForPersistence` (doc comment)
- **Problem:** The comment states the return "carries the deterministic floor's own `redaction`
  outcome … so a caller can tell apart the three shapes an 'allowed' result can take: the original
  bytes came back untouched, content was masked …, or the bytes were replaced by the safe canonical
  form". That holds for a hand-built `GuardResult` with `redacted` unset. It does not hold on the
  path every one of the ten production callers uses: `guardOutput` runs the same floor first and
  sets `guard.redacted` to already-clean text, so the materializer's second pass finds nothing and
  reports `state:"none", reasons:[]` for masked content **and** for a dropped duplicate alike. The
  implementer disclosed this in `T44-implementation.md` §4 and in a test comment; the API's own
  documentation, which is what a caller reads, still makes the stronger claim.
- **Impact:** No disclosure, no rejection, no data change. A caller that branches on
  `redaction.state` to answer "was anything removed" is told "none" when a credential was in fact
  masked — the mirror of the defect T24R2#F-003 recorded and T41 fixed, in the under-reporting
  direction. Bounded, because `bytesPreserved` is truthful on every path (it compares against
  `original`, not `guard.redacted`) and the caller also holds `guard.decision.findings`, which
  carries `[{category:"secret", policyId:"secrets.aws-access-key"}]` for the masked case — measured.
  So the information is available; the doc points at the wrong field.
- **Reproduction:** `bun …/T42-boundary.ts <out>` → `signalMatrix.handBuilt` =
  `{bytesPreserved:"none/[]/bp=true", contentMasked:"redacted/[\"secrets.aws-access-key\"]/bp=false",
  duplicateDropped:"redacted/[\"serialized-content-normalized\"]/bp=false"}` versus
  `signalMatrix.endToEnd` = `{bytesPreserved:"none/[]/bp=true", contentMasked:"none/[]/bp=false",
  duplicateDropped:"none/[]/bp=false", exfilHostMasked:"none/[]/bp=false"}`.
- **Suggested fix:** Amend the comment to state the two-pass architecture explicitly: on the
  `guardOutput` path `redaction` describes the **second** pass (usually `none`, because the first
  pass already cleaned the text), `bytesPreserved` is the reliable "did anything change" signal, and
  "what changed and why" comes from `guard.decision.findings`. Optionally thread the guard's own
  first-pass outcome through so `redaction` means the same thing on both paths — a behaviour change,
  and not required for this phase.
- **Class scope:**
  - sites: `src/security/guard.ts:53-74` (the comment), `:93` (the `guard.redacted ?? original`
    second pass). Callers that read only `.allowed`/`.content`/`.reason` are unaffected: the ten
    production sites enumerated in `T44-implementation.md` §1 were re-confirmed by
    `bun src/cli.ts ctx rg "prepareOutputForPersistence" src` against the current tree.
  - enumeration_method: `ctx rg` for every call site, then both paths driven end to end
    (`T42-boundary.ts` ROW 3) with the three outcomes and the refused branch.

### [T42#F-005] The named-reference table's stated membership rule is security-sound but its exactness claim is false

- **Severity:** info
- **File:** `src/security/detect/exfil.ts:57`
- **Symbol:** `NAMED_CHARACTER_REFERENCES`
- **Problem:** The comment says "over the ASCII punctuation that HTML5 names, that is exactly this
  set". It is not: 14 ASCII-denoting HTML5 names are absent, and three of them — `midast` (`*`),
  `UnderBar` (`_`), `DiacriticalGrave` (`` ` ``) — are alias spellings of characters the table
  **already carries** under `ast`, `lowbar` and `grave`, so the set is neither "exactly the ASCII
  punctuation names" nor closed under aliasing. (The other eleven are `comma`, `Hat`, `lcub`,
  `lbrace`, `verbar`, `vert`, `VerticalLine`, `rcub`, `rbrace`, `nbsp`, `NonBreakingSpace`, which the
  comment's exclusion clause partly covers.)
- **Impact:** None on security, measured rather than argued. See the ruling below.
- **Reproduction:** `bun …/T42-charrefs.ts` → `{namesTested:48, casesTested:240,
  namedSpellingBypasses:[], numericSpellingBypasses:[], absentButUrlSyntax:[]}`.
- **Suggested fix:** Replace "that is exactly this set" with the sound half of the rule ("every
  ASCII-denoting HTML5 name whose character the URL parser treats as syntax or removes; other
  characters are present only incidentally and other names for them are not required"), so a future
  reader deriving membership from the comment derives the correct set.
- **Class scope:**
  - sites: `src/security/detect/exfil.ts:42-56` (the comment), `:57-88` (the table).
  - enumeration_method: the HTML standard's named-character-reference table filtered to entries
    denoting an ASCII character (48 names, all alias spellings included), each placed in five
    authority-rebuilding positions (inside the scheme, as the scheme colon, as the authority slashes,
    leading, protocol-relative) and adjudicated by a WHATWG `URL` oracle — 240 cases — then repeated
    with the numeric spelling of the same character as the control.

### [T42#F-006] Two render-triggered surfaces are missing from T40's own enumeration of the residual gap

- **Severity:** info
- **File:** `src/security/detect/exfil.ts:290`
- **Symbol:** `detectExfil`
- **Problem:** `T40-implementation.md` enumerates the uncovered auto-fetch surfaces carefully and
  honestly, but its list omits `<base href>` and `<meta http-equiv="refresh" content="0;url=…">`.
  `<base>` is materially different from the rest: it does not fetch anything itself, it silently
  re-points **every relative URL in the document**, so it converts the detector's "relative ⇒ no
  channel" conclusion — the load-bearing half of the two-base rule — into a false one for any
  renderer that honours a raw `<base>`.
- **Impact:** Both are unclosed like the other 17 surfaces, so this changes no verdict; it changes
  the **scope** the follow-up must cover, and `<base>` should be ranked first there because it
  invalidates a rule rather than adding one more element.
- **Reproduction:** measured directly against `detectExfil` with an empty allowlist —
  19 surfaces tested (`iframe`, `video poster`, `video src`, `audio src`, `source srcset`,
  `input type=image`, `object data`, `embed src`, `track src`, `link rel=preload`,
  `link rel=stylesheet`, `script src`, `td background`, SVG `image href`, SVG `use href`,
  CSS `url()` in a style attribute, `<style>` block, `<base href>`, `meta refresh`), **`matches=0`
  for all 19**. Note that the SVG surfaces would not be caught even by T40's `<image>` alias,
  because SVG spells the destination `href`, not `src`.
- **Suggested fix:** Add `<base href>` and `<meta http-equiv=refresh>` to the follow-up's surface
  list, and note in the policy decision that `<base>` must be handled as a document-level
  invalidation of relative-destination safety, not as one more fetching element.

## Judgement calls

### 1. The named-character-reference membership rule — **ACCEPT the rule, CORRECT the claim**

The argument was tested, not taken on trust. Every HTML5 named character reference that denotes an
ASCII character — 48 names including every alias spelling — was placed in five positions that could
rebuild an authority (inside the scheme, as the scheme colon, as the two authority slashes, leading,
protocol-relative), and each of the 240 cases was adjudicated by a WHATWG `URL` oracle against the
detector's actual verdict. **0 bypasses in the named spelling and 0 in the numeric control**, and
of the 14 absent names, **none denotes a character the URL parser treats as syntax or removes**.

The rule is sound for a reason stronger than the current table's contents: a named reference is only
ever an *alternative* spelling, and the numeric form (`&#NN;`, unbounded, range-checked) already
covers every character generically. So the named table can only ever matter for a character that (a)
has a *named* HTML5 spelling and (b) is URL syntax or URL-removed — a closed, small and now
exhaustively enumerated set. Importing all 2231 entries would add weight and no coverage.

What must change is the sentence, not the set: "over the ASCII punctuation that HTML5 names, that is
exactly this set" is false (T42#F-005), and a future maintainer deriving membership from it would
derive the wrong set. Fix the comment; keep the table.

### 2. The uncovered auto-fetch surfaces — **ACCEPT for this phase, with the documented limitation tightened, and only if the follow-up is created now**

Measured position first: the floor covers **2 of 21** render-triggered surfaces I could test
(`<img|image src>` and `<img|image srcset>`, plus the markdown image and reference forms), and 19 of
19 others return `matches=0`. That is a minority, and the implementer said so plainly rather than
letting the closure count imply completeness — the disclosure is exactly right and is what makes
acceptance possible at all.

I accept it for this phase, on three grounds and one condition.

- **It is a policy decision, not a bug.** Closing `<iframe>`, `<video poster>`, `<link href>`,
  `<script src>` and CSS `url()` under an empty allowlist would make a documentation page carrying an
  embedded video an egress finding. Choosing between deny-by-default on every fetching element and a
  media-only floor is a product decision with a real false-rejection cost, and `policies.md` is
  explicit that refusing a payload with a safe representation is the defect, not the caution. Making
  that call inside a repair task, in a file two other workers are adjacent to, would be worse
  engineering than deferring it.
- **The classes differ in kind.** The 21 surfaces share a *shape* but not a *rule*: the covered ones
  are unconditionally auto-fetching with no legitimate cross-origin use in agent output; several
  uncovered ones (stylesheet, script, iframe) are load-bearing in benign documents. One shared
  surface table with a stated policy is the right implementation, and it is a task, not a patch.
- **The residual is bounded by disclosure.** It is written down, enumerated, and now extended by two
  surfaces the original enumeration missed (T42#F-006).

**Condition:** this acceptance is separable from row 1's failure and does not survive alone. The
blocker (T42#F-001) and the major (T42#F-002) are *not* in this category — they are the covered
surfaces failing on the simplest possible input, and no policy decision is needed to fix them. If the
follow-up is scoped only as "add the missing surfaces" and F-001/F-002 are folded into it, the same
mistake repeats for a fourth round: the covered surface would still leak while the uncovered list
grows shorter. Scope them as two tasks — one repair (F-001, F-002, F-003), one policy-then-implement
(F-006 plus the 19 surfaces, `<base href>` ranked first).

## Confirmed clean areas

Each was executed, not inspected.

- **The authority-spelling class is genuinely closed as a class**, not case by case: backslash
  authority in six spellings, unbounded slash runs, userinfo, explicit port, IPv6 literal and
  loopback, hex IPv4, IDN homoglyph, trailing-dot host, uppercase and mixed-case schemes — all
  resolved and flagged; percent-encoded delimiters, percent-encoded scheme colon, `data:`, `blob:`,
  `ftp:`, `ws:`, dot segments, backslash inside a relative path, anchor-only and query-only
  destinations, an empty angle destination, and `callbacks[0](payload)` — all correctly not findings.
- **Character-reference decoding.** 240 named-reference cases and 240 numeric controls, 0 bypasses.
- **The byte-faithful scanner cannot be turned into a hiding channel.** 14 duplicate shapes across
  key spelling, nesting depth, container type, member position, whitespace and the `0`/`-0` trap; all
  replaced by the canonical form, no secret or credential in any output.
- **Value integrity.** Out-of-double-range integer, `-0` in both scalar and array position, `1e3`,
  `1.0`, `1E+2`, `\uXXXX` escapes, `\/`, surrogate pairs and a lone surrogate all byte-exact with
  `state:"none"`; independent `sameParse` oracle agrees for every accepted shape.
- **Repository corpus, re-measured here rather than trusted:** 2058 files, 0 unparseable, 0
  rejected, 0 mislabelled, 2007 byte-preserved, 51 redacted for real content.
- **T19 contract points** all reproduce: constant failure text on every refusal, fixed value-free
  reason tokens only, own `undefined` → `non-json-value`, cycle → `cyclic-value`, non-finite →
  `non-json-value`, numeric under a credential key → `sensitive-numeric-field` at validator,
  transport and materializer, public links not egress findings, pretty-printed payloads preserved
  with no redaction state.
- **The floor applies with advisory redaction disabled** — every transport case ran under
  `mergeMcpConfig({ redactToolOutput: false })`.
- **The typecheck fallout T44 disclosed is resolved.** `src/security/detect/exfil.test.ts:339` now
  carries the widened `toEqual`; `bun run typecheck` exits 0 with no output.
- **Focused suites green.** `bun test src/security/detect/exfil.test.ts
  src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts
  src/security/persistence-sinks.test.ts src/security/guard.test.ts` → **103 pass, 0 fail, 679
  expect()**.
- **Concurrent-area discipline.** `src/commands/health.ts` byte-identical; `src/flow/review-gate.ts`
  changed under its owner and was neither read for review nor touched.

## Evidence

| Artifact | SHA-256 |
|---|---|
| `T42-exfil-attack.ts` | `382d22a0674bab0b9a80a345c7afe5fbe34d79099ad4e5213020d19923f7d935` |
| `T42-boundary.ts` | `0b9bc18c0f72ad25e4150001b5739ed8a6a066522cc4a7e2ea3eb6f9d04f368d` |
| `T42-charrefs.ts` | `a12d600a0801020be70e326566610d603b79eefe3cffe76abc6454ed90c058b1` |
| out: `…/scratchpad/T42-exfil-attack.json` | `d6207c8d623fb694d2055f2b9177c53a6eb5e548e58d81bd46f0df73194ab220` |
| out: `…/scratchpad/T42-boundary.json` | `dc2700189738dcdf3ecbb6c459377d9d8302055baf078f4f1ff0fdd5ae5637b1` |
| out: `…/scratchpad/T42-repojson.json` (my own corpus sweep) | `d83dcf0d61c6cd606f9815535654a629b36cd4113e544d2eba39d6c3dcf5fd5d` |
| out: `…/scratchpad/T24R2-exfil-rerun.json` (48-case matrix re-run) | `69caf814d72c9ad11c863c56cd6223b15280c21e3bc4715a0a5c5bb47986c4df` |
| out: `…/scratchpad/T42-ctl-boundary.json` (reviewer boundary control) | `9c138e5ec56334bb596c6bc7052cb7c8dc91cc5542941d8f16cbedb3a5566ffe` |
| out: `…/scratchpad/T42-ctl-validator.json` (reviewer validator control) | `d7c5dcae0840c844b60346baa75633cbc99e318bfd011b571e2a02bec8ee05cc` |

Probe JSON outputs live under the session scratchpad
(`/private/tmp/claude-502/-Users-Goodea-goodea-keryx/2c1aca69-07c3-46d7-89d4-79e0152123a5/scratchpad/`)
because the dispatch permits writing only `T42-review.md`, `T42-result.json` and `T42-*.ts` under the
artifacts directory. Every probe is deterministic and re-runnable from the committed `.ts` files.

No model call, no network, no dependency change, no git or flow-state change, no `bun test` without
file arguments, and no mutation of any production or test file. All credentials in probes are
synthetic (`AKIA`+`IOSFODNN7EXAMPLE`, `tr0ub4dor-correct-horse`) and every host is reserved
(`attacker.invalid`, `*.invalid`, `example.org`, `client.example.org`); nothing was contacted.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the file set exactly, and the graph
  answers from the last `keryx gdgraph build` while the tree carries a large uncommitted multi-worker
  change set, so a graph answer could not be quoted as current. The one cross-file enumeration needed
  (callers of `prepareOutputForPersistence`) came from `ctx rg` over the working tree.
- `wiki_used: no (not-relevant)` — the governing texts are
  `docs/requirements/keryx-agent-first-core/policies.md`, the flow's `acceptance-criteria.md`,
  `T24-recheck2.md` and the three implementation reports; all were read directly.
- `ctx_used: partial, disclosed` — every code search went through `bun src/cli.ts ctx rg`. Probe
  and test **execution** ran `bun` directly rather than through `ctx run`: the dispatch states that
  `ctx run`'s compaction drops the per-case statuses that are this review's evidence, and it does —
  the 42-row and 240-case matrices are exactly the kind of per-case output it elides. Test and
  typecheck output was small enough to read whole. No `# keryx:raw` escape was needed and no raw
  gdctx log was read.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find` over project code. Bounded `Read` calls with
  `offset`/`limit` and small `bun -e` readers over scratchpad JSON were used instead; one attempted
  `cat` of a schema file was correctly refused by the routing hook and replaced with a `bun -e` read.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T42#F-001",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 280,
    "symbol": "HTML_IMG",
    "problem": "HTML_IMG and HTML_IMG_SRCSET scan the tag with [^>]*? before an unanchored \\bsrc. An HTML tokenizer does not end a tag at a `>` inside a quoted attribute value, so <img alt=\"a>b\" src=\"https://attacker.invalid/p\"> is never matched at all; and \\bsrc matches inside an attribute VALUE, so a decoy such as <img alt=\"src=/safe\" src=\"...\"> captures the decoy and moves lastIndex past the real destination. Both shapes apply to srcset and to the <image> alias, and to a tag spread over lines. The destination never reaches considerUrl, so no classifier improvement can close them.",
    "impact": "The mandatory no-auto-fetch floor is bypassed by plain https:// URLs with no character references and no exotic authority spelling. Measured with advisory redaction off: the payload reaches the MCP client inside operation JSON with isError:false and redaction.state:\"none\", and reaches durable sinks byte-identical through prepareOutputForPersistence and redactToolOutput, so rendering it is a zero-click request to the attacker host carrying attacker-encoded context.",
    "suggested_fix": "Scan the tag the way the tokenizer does: match the open tag <im(?:g|age)\\b, then walk attributes as name(\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+))? repeatedly until an unquoted >, taking src/srcset from the attribute NAME position only. Add one regression per shape in src/security/detect/exfil.test.ts and one at the transport in src/mcp/structural-redaction.test.ts, keeping every benign control.",
    "evidence": "T42-exfil-attack.ts (42 cases, WHATWG URL oracle over five renderer document bases) reports 8 unconditional bypasses and 0 false positives; T42-boundary.ts reproduces five of them at dispatchCallTool as isError=false, state=none, reasons=[], attacker host present, and as allowed:true byte-identical through prepareOutputForPersistence and redactToolOutput, against ctlBackslash/ctlImageTag controls that are correctly state=redacted with the host gone.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:html-img-attribute-scan-extraction",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:280",
        "src/security/detect/exfil.ts:286",
        "src/security/detect/exfil.ts:354",
        "src/security/detect/exfil.ts:367"
      ],
      "enumeration_method": "Complete read of src/security/detect/exfil.ts, then every extraction constant crossed against the two tokenizer facts the regex ignores (a quoted > does not end a tag; an attribute value is not an attribute name position), producing a 10-shape matrix (> in an earlier value x double/single quote x <img>/<image> x src/srcset, decoy src=/srcset= in an earlier value, decoy embedded in prose, multi-line tag), each paired with a benign control and adjudicated by a WHATWG URL oracle rather than by inspection, then re-driven through dispatchCallTool, prepareOutputForPersistence and redactToolOutput. The markdown surfaces INLINE and REFERENCE_DEF were checked for the same shape and do not carry it."
    }
  },
  {
    "id": "F-002",
    "global_id": "T42#F-002",
    "reviewer": "review-security-code",
    "severity": "major",
    "file": "src/security/detect/exfil.ts",
    "line": 201,
    "symbol": "SYNTHETIC_BASES",
    "problem": "The two-base discriminator varies the base HOST and holds the base SCHEME fixed at https, but WHATWG resolution of a scheme-with-no-slashes destination depends on both: a special-scheme URL whose scheme equals the base's is relative, one whose scheme differs takes the special-authority-slashes path and makes the next token the host. So https:attacker.invalid/p makes the two https bases disagree and is judged relative, while a renderer whose document is file:, vscode-webview: or a custom app: scheme resolves the same bytes to attacker.invalid. The code exhibits the asymmetry itself: http:attacker.invalid/p IS flagged, https:attacker.invalid/p is not.",
    "impact": "A zero-click fetch to the attacker host under a common MCP client class (Electron and webview documents), from a payload the floor releases with isError:false, redaction.state:\"none\" and byte-identical persistence. Six spellings including the markdown image surface and an entity-written colon. Narrower reach than F-001 because it needs a non-https renderer document, but the same floor and the same outcome when it fires.",
    "suggested_fix": "Vary the base scheme as well as the host: resolve against a second pair of bases with a non-special scheme (e.g. keryx-detector://base-a.invalid/keryx/page) and flag when either pair agrees. A genuinely relative destination inherits the base host in both pairs and still disagrees within each, so no new false positive is introduced on /assets/a.png, ../a, #frag or ?q=1 - verified against the 15 benign controls.",
    "evidence": "T42-exfil-attack.ts reports conditionalOnRendererScheme = [a.schemeNoSlashes, a.schemeOneSlash, a.schemeNoSlashesUpper, a.schemeNoSlashesMixed, a.schemeNoSlashesEntity, a.schemeNoSlashesMarkdown]; each row's rendererHosts shows client.example.org under the https base beside attacker.invalid under the file:, vscode-webview: and app: bases, with flagged:false. T42-boundary.ts reproduces schemeNoSlashes at dispatchCallTool as isError=false state=none leaksHost=true and byte-identical through the materializer and the seam.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:two-base-rule-fixed-scheme",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:201",
        "src/security/detect/exfil.ts:208",
        "src/security/detect/exfil.ts:221",
        "src/security/detect/exfil.ts:232"
      ],
      "enumeration_method": "Complete read of exfilHost/resolvedHost against the WHATWG URL scheme and relative state machine to identify every base property the resolution depends on (host - varied; scheme - not varied; path - irrelevant to hostname), then a 5-renderer-base x 21-URL-form oracle covering scheme-with-no-slashes in five spellings, userinfo, port, IPv6, hex IPv4, IDN homoglyph, trailing-dot host, backslash plus userinfo, percent-encoded delimiters, and the non-network schemes ftp/ws/blob/data, each with a stated expected verdict."
    }
  },
  {
    "id": "F-003",
    "global_id": "T42#F-003",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/security/detect/exfil.ts",
    "line": 270,
    "symbol": "INLINE",
    "problem": "T40 added the angle-bracket alternative but left the bare alternative as [^)\\s>]+. A CommonMark bare link destination may legally contain >, so ![x](https://attacker.invalid/a>b) is extracted as https://attacker.invalid/a and the span ends before the destination does.",
    "impact": "None on host disclosure - the host precedes the cut, the finding fires, and the output masks to ![x]([REDACTED:url]>b) with the host gone. The residue is a fragment of the attacker's path left in the output and a narrower start/end span. Recorded so the next round does not rediscover it as a bypass.",
    "suggested_fix": "Drop > from the bare alternative's negated class now that the angle form is tried first, and assert the full-span mask in a regression.",
    "evidence": "T42-exfil-attack.ts row b.mdBareGtTruncation: flagged:true, hostStillPresentAfterRedaction:false, redacted:\"![x]([REDACTED:url]>b)\".",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:bare-destination-gt-truncation",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-004",
    "global_id": "T42#F-004",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/security/guard.ts",
    "line": 53,
    "symbol": "prepareOutputForPersistence",
    "problem": "The doc comment states the return distinguishes the three shapes an allowed result can take (bytes untouched, content masked, bytes replaced by the canonical form). That holds only for a hand-built GuardResult with redacted unset. On the path all ten production callers use, guardOutput runs the same floor first and sets guard.redacted to already-clean text, so the materializer's second pass reports state:\"none\", reasons:[] for masked content and for a dropped duplicate alike.",
    "impact": "No disclosure, no rejection, no data change. A caller branching on redaction.state to answer 'was anything removed' is told none when a credential was masked - the mirror of T24R2#F-003 in the under-reporting direction. Bounded, because bytesPreserved is truthful on every path and the same guard result carries decision.findings (measured: [{category:\"secret\", policyId:\"secrets.aws-access-key\"}]), so the information exists; the documentation points at the wrong field.",
    "suggested_fix": "Amend the comment to state the two-pass architecture: on the guardOutput path redaction describes the second pass (usually none, because the first already cleaned the text), bytesPreserved is the reliable did-anything-change signal, and what changed and why comes from guard.decision.findings. Threading the guard's first-pass outcome through so redaction means the same thing on both paths is a behaviour change and is not required for this phase.",
    "evidence": "T42-boundary.ts signalMatrix.handBuilt = {bytesPreserved:\"none/[]/bp=true\", contentMasked:\"redacted/[secrets.aws-access-key]/bp=false\", duplicateDropped:\"redacted/[serialized-content-normalized]/bp=false\"} versus signalMatrix.endToEnd = {bytesPreserved:\"none/[]/bp=true\", contentMasked:\"none/[]/bp=false\", duplicateDropped:\"none/[]/bp=false\", exfilHostMasked:\"none/[]/bp=false\"}.",
    "confidence": "high",
    "dedupe_key": "afc02:persistence:redaction-state-two-pass-doc-claim",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true
  },
  {
    "id": "F-005",
    "global_id": "T42#F-005",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/security/detect/exfil.ts",
    "line": 57,
    "symbol": "NAMED_CHARACTER_REFERENCES",
    "problem": "The stated membership rule ends 'over the ASCII punctuation that HTML5 names, that is exactly this set'. It is not: 14 ASCII-denoting HTML5 names are absent, three of which (midast for *, UnderBar for _, DiacriticalGrave for backtick) are alias spellings of characters the table already carries, so the set is neither exactly the ASCII punctuation names nor closed under aliasing.",
    "impact": "None on security, measured rather than argued: 240 named-reference cases and 240 numeric controls across five authority-rebuilding positions produce zero bypasses, and none of the 14 absent names denotes a character the URL parser treats as syntax or removes. The risk is only that a future maintainer deriving membership from the sentence derives the wrong set.",
    "suggested_fix": "Replace 'that is exactly this set' with the sound half of the rule: every ASCII-denoting HTML5 name whose character the URL parser treats as syntax or removes; other characters are present incidentally and other names for them are not required.",
    "evidence": "T42-charrefs.ts: {namesTested:48, casesTested:240, namedSpellingBypasses:[], numericSpellingBypasses:[], absentFromDetectorTable:[midast, comma, Hat, UnderBar, DiacriticalGrave, lcub, lbrace, verbar, vert, VerticalLine, rcub, rbrace, nbsp, NonBreakingSpace], absentButUrlSyntax:[]}.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:named-reference-membership-claim",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": false
  },
  {
    "id": "F-006",
    "global_id": "T42#F-006",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/security/detect/exfil.ts",
    "line": 290,
    "symbol": "detectExfil",
    "problem": "T40's enumeration of the residual auto-fetch gap is careful but omits <base href> and <meta http-equiv=refresh>. <base> is materially different from the other uncovered surfaces: it fetches nothing itself and silently re-points every relative URL in the document, which converts the detector's 'relative implies same-origin, no channel' conclusion - the load-bearing half of the two-base rule - into a false one for any renderer that honours a raw <base>.",
    "impact": "Changes no verdict (both are unclosed like the other 17), but changes the scope the follow-up must cover, and <base> should be ranked first there because it invalidates a rule rather than adding one more fetching element.",
    "suggested_fix": "Add <base href> and <meta http-equiv=refresh> to the follow-up's surface list and record that <base> must be treated as a document-level invalidation of relative-destination safety, not as one more fetching element.",
    "evidence": "Measured directly against detectExfil with an empty allowlist across 19 surfaces (iframe, video poster, video src, audio src, source srcset, input type=image, object data, embed src, track src, link rel=preload, link rel=stylesheet, script src, td background, SVG image href, SVG use href, CSS url() in a style attribute, style block, base href, meta refresh): matches=0 for all 19. The SVG surfaces would not be caught even by T40's <image> alias, because SVG spells the destination href rather than src.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:uncovered-render-surfaces-scope",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true
  }
]
```
