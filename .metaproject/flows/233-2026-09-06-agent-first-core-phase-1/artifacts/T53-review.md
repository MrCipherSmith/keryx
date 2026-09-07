STATUS: DONE_WITH_CONCERNS

# T53 — independent verification of the fourth auto-fetch repair (T52)

Fourth independent round on this floor. This reviewer wrote none of the code, none of the tests
and none of the three earlier reviews. Every verdict below cites a probe written and executed here
against the working tree. The earlier probes were re-run unmodified as controls; they prove no
regression, never closure.

The method deliberately differs from every previous round on this floor. The three earlier rounds
each adjudicated extraction **by inspection against the specification**, and each time the next
round found a tokenizer rule the previous reader had not held in mind. This round does not read the
tokenizer; it **runs one**. Bun ships `HTMLRewriter` (Cloudflare lol-html), a separate,
spec-derived HTML tokenizer with no relationship to this codebase, so for every extraction case the
question "would a real parser attribute this `src` to this element?" is answered by a second
implementation rather than by me. That is what makes row 1's result a measurement instead of an
opinion.

## Scope

- Branch: `codex/agent-first-core`
- Base / merge-base: `main` @ `0bc6418` (`feat(metaproject): shrink the routing gate…`)
- Stage 1: **PASS** — all five rows met.
- Stage 2 (code quality): run, because Stage 1 passed. One nit, no finding (below).
- Source changes by this review: **none** (read-only). Five probe scripts and these two artifacts
  are the only files written.

File SHA-256 at start and at end. **No reviewed file changed during the review.** Four excluded or
concurrently-owned files drifted and are recorded rather than reviewed; every conclusion that
touches them was re-measured after the drift and is unchanged.

| File | SHA-256 start | SHA-256 end | Drift |
|---|---|---|---|
| `src/security/detect/exfil.ts` | `6750d80c…ccf9dd` | same | no |
| `src/security/detect/exfil.test.ts` | `0d296cff…21bc1` | same | no |
| `src/security/detect/index.ts` | `a509312d…79c0d` | same | no |
| `src/security/redact.ts` | `b8e9d9a5…44b86` | same | no |
| `src/mcp/dispatch.ts` | `f1db21b0…f6b6f18` | same | no |
| `src/mcp/structural-redaction.test.ts` | `53faabb2…ca6aca` | same | no |
| `src/security/persistence-sinks.test.ts` | `f00899ef…16ad1` | same | no |
| `src/security/output-validation.ts` | `0f6856a3…ce19dd` | same | no |
| `src/mcp/redact-seam.ts` | `e59526ed…1470300` | same | no |
| `src/security/service.ts` | `e08be640…1b6632` | same | no |
| `src/security/self-protect.ts` (excluded, concurrent) | `afad4f94…92c0e1` | same | no |
| `src/security/guard.ts` (**drifted, not reviewed**) | `32a98b9f…931201` | `2b25a417…c6516e` | **YES** |
| `src/security/config.ts` (**drifted, not reviewed**) | `267285d5…8c5640` | `cde9fd7f…6b1c10` | **YES** |
| `src/commands/security.ts` (excluded, concurrent) | `e37b1f8a…d7067b` | `73d557be…0e7fca` | **YES** |
| `src/health/service.ts` (excluded, concurrent) | `23075627…8a7c81` | `37ae5422…2aa4f8d0` | **YES** |

`guard.ts` and `config.ts` are **not** in the dispatch's declared concurrent set, yet both changed
mid-review under another worker. They were neither read for review nor touched here. Because
`guard.ts` carries `prepareOutputForPersistence` and `validateOutputForTransport` — two of the four
boundaries this review measures — `T53-boundary.ts`, `T42-boundary.ts` and the five focused suites
were **re-run after the drift**: every row is byte-identical to the pre-drift run
(`hostileLeakingAtAnyBoundary: 0`, 116 pass / 0 fail). The orchestrator should still know that two
undeclared files moved during an independent review.

Full lists: `…/scratchpad/T53-hashes-start.txt`, `…/scratchpad/T53-hashes-end.txt` (session-local).

## Summary

- Blocker: 0
- Major: 0
- Minor: 1
- Info: 3

**The fourth approach is the first one I could not turn back into a hiding channel, and the first
whose extraction I could check against something other than my own reading of the standard.** 88
extraction cases derived from the tokenizer state machine — including seven states T52's table does
not enumerate (NULL replacement, end-tag-with-attributes, comment and RAWTEXT/RCDATA contexts,
non-ASCII whitespace inside the tag name, character references in a *name* rather than a value, the
ambiguous-ampersand rule, and the full unquoted-value terminator set) — produce **0 bypasses**
against an independent parser. 41 destination forms × 15 renderer document bases (615 resolutions,
covering base scheme, host, specialness, port, userinfo, path depth, query, fragment, UNC and an
opaque-path base) produce **0 bypasses and 0 false positives**. 19 hostile classes of my own
derivation are closed at `dispatchCallTool`, `prepareOutputForPersistence`,
`validateOutputForTransport` and `redactToolOutput` with advisory redaction **off**.

The two mechanisms T42 named are genuinely repaired at the mechanism, not at the cases:

1. **Extraction.** Replacing `[^>]*?` + `\bsrc` with a state-machine walk did not merely close the
   eight shapes T42 showed. Every state I could reach that the implementer's fourteen rows omit is
   handled the way lol-html handles it — a NUL in the tag name makes the element unknown and is
   correctly *not* flagged, a character reference in an attribute name is correctly *not* decoded, a
   quote inside an attribute name is correctly appended to the name and the real `src` behind it is
   still read, and an unquoted value correctly ends at exactly the five HTML whitespace characters
   and `>` while `/ " ' = ` <` stay data. The scanner is also linear: 960 KB of text and 200 K
   consecutive solidi finish in single-digit milliseconds with no backtracking.

2. **Resolution.** The two-pair rule holds under every base property I could vary, and the
   disagreement rule produces no false positive on any relative form. The *conclusion* is correct.
   The *argument written in the comment* is narrower than the truth — the parser has base-dependent
   branches the pairs do not realise (the `file` state; the opaque-path failure in the no-scheme
   state) — and it is only the `http(s)` filter in `resolvedHost` that makes those branches
   unreachable. That is T53#F-002, info, because the code is right and the reason given for it would
   license a wrong conclusion if the filter ever widened.

3. **The base element.** Upheld with evidence, not inherited. 15 hostile `<base>` vectors reach the
   attacker host before redaction under an independent renderer model and **none** reaches it after;
   the "masking puts the document base back inside the reader's origin" argument is measured true
   for relative `src`, relative `srcset` and relative markdown destinations, for a base written
   *after* the image it re-points, and for the HTML rule that the first `<base>` with an `href`
   wins. The one thing the disclosure understates is the **blast radius of a false positive**: a
   masked `<base>` re-points every relative URL in the document, so mis-flagging one is a
   whole-document effect, not a one-image effect. That is T53#F-001, minor.

## Stage 1 — specification compliance

| # | Row | Verdict | Evidence |
|---|---|---|---|
| 1 | **Extraction reads attributes the way a tokenizer does** | **MET** | `T53-extract.ts`: **88 cases, 0 bypasses**, each adjudicated by Bun's `HTMLRewriter` (lol-html) rather than by inspection, then resolved with the platform `URL` against five renderer bases. Cases derived from the state machine, not from T52's table, and deliberately including states T52 does not enumerate. Required probes all present and all OK: **NULL** in the tag name / attribute name / value / before-attribute-name (`n01`–`n05` — the first three correctly *not* flagged, because U+FFFD makes the element or attribute a different one; `n04` leading-C0 correctly flagged); **unquoted value terminators** at space, tab, LF, FF, CR and `>` and *not* at `/`, `"`, backtick, `=`, `<` (`u01`–`u12`); **solidus in odd positions** — between attributes, before the first attribute, inside a name, after a name, in runs, as a self-close before a second tag (`v01`–`v06`, all matching lol-html including the two where `src` becomes a valueless attribute and correctly does not fetch); **quote inside an attribute name** in four placements (`q01`–`q04`) plus both quote-nesting directions (`q05`, `q06`); **duplicate attributes in both orders** (`s11` flagged and fetched, `s11b` flagged and *not* fetched — the disclosed over-approximation); **character references in a name** (`c01`–`c03`, correctly not decoded, correctly not flagged) against the value control (`c04`, `c05`, decoded and flagged); **case folding** on the tag name and the attribute name (`s07`, `s07b`, `b07`). The `>`-in-a-quoted-value and decoy-`src=` classes T42 found reproduce as closed (`s08`, `s09`, `r01`, `r03`, `y03`). Non-ASCII whitespace inside the tag name (`w01`–`w03`) and the `imgur`/`based` prefixes (`w04`, `w05`) are correctly *not* this element, matching lol-html. Linearity: `manyOpenTags` 100 KB → 9.6 ms, `manySlashes` 200 KB → 1.8 ms, `bigBenign` 960 KB → 1.8 ms. |
| 2 | **Two base pairs are sufficient, not merely more** | **MET** (conclusion), **argument incomplete** (T53#F-002) | `T53-resolve.ts`: **41 destinations × 15 renderer document bases = 615 resolutions, 0 bypasses, 0 false positives.** The renderer set was built by enumerating every base property the WHATWG basic URL parser branches on and asking which of them neither synthetic pair varies: scheme (varied), host (varied), specialness (varied), **is-file (not varied)**, **opaque path (not varied)**, **port, userinfo, path depth, query, fragment (none varied)**. Each unvaried property got its own renderer base — `file:///…`, `file://share.example.org/…` (UNC), `https://…:8443/…`, `https://u:p@…/a/b/c/d`, `https://client.example.org` (no path), `https://…/chat?t=1#x`, `ws://…`, `ftp://…`, `app:opaque-document`, `chrome-extension://…`, `tauri://localhost/…`. No destination's classification turned out to depend on any of them: the scheme-with-no-slashes class is flagged in every spelling (`https:`, `https:/`, `HTTPS:`, `HtTpS:`, space-padded, `http:`, `http:/`), the special non-http schemes (`ws:`, `wss:`, `ftp:`, `file:`, `file://`) correctly yield no finding, the detector's own private scheme spelled by the attacker yields none, and all 13 relative forms — including `%2f%2f…`, `https%3a//…`, `docs.example.org/pixel.png`, `a:b/c.png`, `/attacker.invalid/p` and `.//attacker.invalid/p` — stay unflagged under every base. The sufficiency *claim* survives the test; the sufficiency *argument* in the comment does not cover the `file` state or the opaque-path branch, which is why this row carries an info finding rather than nothing. |
| 3 | **The `<base href>` finding class** | **MET; behaviour change upheld, with one undisclosed consequence** | `T53-base.ts`: 23 cases with a renderer model independent of the detector (document base located with lol-html under the real "first `<base>` with an `href` wins" rule, every destination resolved with `URL` against five renderer bases). **15 hostile vectors: 15 reach the attacker host before redaction, 0 after** — absolute, protocol-relative, scheme-no-slashes, backslash authority, entity colon, unquoted, uppercase/single-quoted, `>`-hidden href, base written *after* the image, base re-pointing a markdown image, base re-pointing a relative `srcset`, two-base documents in both orders, a first `<base>` with no href, and a duplicate `href` with the hostile one first. So **no, a relative destination in a document whose base was masked cannot reach a remote host**: `<base href="[REDACTED:url]">` resolves inside the reader's own origin and every relative destination follows it back. **Yes, a benign document that legitimately carries a base element now trips the floor** — `<base href="https://cdn.example.org/docs/v2/">` is masked (`T53-base` g06, `T53-boundary` `ctlCdnBaseDoc`), and so is a `<base href>` merely *quoted* inside a markdown code fence or an HTML comment (`T53-corpus` part B). Allowlist semantics are exactly those of `<img src>`, verified including the `https://cdn.example.org@attacker.invalid/` userinfo trick (flagged) and a subdomain of an allowlisted apex (not flagged). |
| 4 | **No new false positive** | **MET for this repository; the corpus cannot establish the stronger claim** | `T53-corpus.ts`, re-measured rather than trusted, on a **wider** scope than the implementer's (21769 files vs 16684 — I do not exclude `.claude/worktrees` or `.metaproject/data/gdctx/artifacts`): 389 findings across 56 files, 0 unreadable, 5.9 s. **All 55 `egress.html-base-href-exfil` findings — the only class this change adds — are in 8 files, every one of which exists to carry vectors** (`exfil.test.ts`, the T42/T52/T53 probes, `T52-implementation.md`, one gdctx RED log). Zero in documentation, fixtures, or any source file outside the security detector. The 15 finding-bearing files my classifier calls benign are 8 gdctx *logs of these very probes*, 6 copies inside `.claude/worktrees` older checkouts, and the repository `README.md` — whose 8 findings are pre-existing `<img src="https://…">` badges and screenshots that the old regex matched identically, not a regression. Part B adds 30 benign shapes of my own that the repository does not contain: 23 clean; 6 flagged by classes that predate this change (shields.io badge, remote reference definition, a remote `<img>` inside a code fence, an HTML comment, a `<script>` string) and **1 flagged by the class this change adds** (`codeFenceBaseExample`). So the implementer's "zero new findings in benign repository content" reproduces and is true; the stronger reading is not established, because the corpus contains no benign `<base href>` at all — as the implementer themselves noted. That gap is T53#F-001. |
| 5 | **The previous rounds stay closed** | **MET** | Re-run unmodified against the current tree: `T42-exfil-attack.ts` (42 cases) → `bypasses: [], falsePositives: [], unconditional: [], conditionalOnRendererScheme: []`. `T24-recheck2-exfil.ts` (48 cases) → `cases=48 bypasses=0 falsePositives=0`. `T42-charrefs.ts` → `namesTested 48, casesTested 240, namedSpellingBypasses [], numericSpellingBypasses [], absentButUrlSyntax []`. `T42-boundary.ts` ROW 1 → all six formerly-leaking shapes `state=redacted reasons=["egress.html-image-exfil"] leaksHost=false | persist leaksHost=false identical=false | seam leaksHost=false`, controls unchanged, `ctlPublicLink` still `state=none` byte-identical. **Canonicalization boundary rows unchanged** (`T24-recheck2-boundary.ts`): all 12 serialized shapes `leakS=false leakEsc=false leakCred=false leakHost=false`, `cleanPretty`/`cleanCompact` still `identical=true`, duplicates still normalized. **Persistence boundary rows unchanged**: all 28 MCP cases keep their exact state and reason token — `p.secret-key`/`p.deep-secret-key`/`p.email-key` `format-unsafe`/`sensitive-property-name`, `p.password-numeric` `sensitive-numeric-field`, `p.throws-secret` `redacted`/`secrets.aws-access-key`, `p.public-link` `state=none`, `p.ref-defs-sibling`/`p.ref-annotations` `state=none`. `T52-base.ts` re-run against the current detector: `notNeutralized: [], falsePositives: []`. Focused suites `bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts src/security/guard.test.ts` → **116 pass, 0 fail, 933 expect()**. `bun run typecheck` exit 0, `bunx eslint` on both changed files exit 0. |

### Dispatch acceptance criteria

- **AC5 (AFC-15)** — **met**. No field-name or spelling bypass survives (row 5's three matrices, plus
  row 1's 88 cases and row 2's 615 resolutions, all with 0 bypasses). A URL secret is masked
  (`p.password-key` → `secrets.sensitive-field`; `egress.markdown-link-sensitive-value` fires across
  the corpus). A public Markdown link is not treated as a network send: `ctlPublicLink` is
  `state:"none"` and byte-identical at all four boundaries, alone and beside a redacted sibling.
  The auto-fetch half — the half T42 failed on — is now met at the detector **and** at the MCP
  dispatch **and** at the persistence materializer.
- **Every bypass class the four rounds found is closed, verified at all three layers, with no new
  bypass** — **met**. `T53-boundary.ts`: 19 hostile classes of my own derivation (9 `<base>` shapes,
  10 tokenizer states T52's table omits), **0 leaking at any of the four boundaries**, advisory
  redaction off. Plus the two earlier boundary matrices re-run clean.
- **No benign content newly flagged** — **met for measured content, with a caveat**: 0 new findings
  in 21769 repository files; 1 of 30 synthetic benign shapes newly flagged (T53#F-001).
- **The resolution sufficiency argument and the base-element behaviour change each upheld or
  refuted** — both **upheld with evidence**; the sufficiency *argument* is corrected (T53#F-002) and
  the base-element *consequence* is extended (T53#F-001). Neither is refuted.

## Findings

### [T53#F-001] The `<base>` class masks a benign documentation base, and a mis-flagged base re-points the whole document

- **Severity:** minor
- **File:** `src/security/detect/exfil.ts:571`
- **Symbol:** `detectExfil` (the `tag === "base"` branch)
- **Problem:** Two halves, one class.
  1. Under an empty allowlist, a document that legitimately carries `<base href="https://cdn.example.org/docs/v2/">` is an egress finding and its href is masked. The implementer disclosed this (concern 3) and argued it is consistent with `<img src="https://cdn.example.org/logo.png">`. It is consistent in *policy* but not in *effect*: masking an `<img src>` breaks one image, while masking a `<base href>` re-points **every relative URL in the document** to the reader's own origin, so a single false positive silently changes the resolution of every link and image around it. That asymmetry is not stated anywhere in the code, the spec or the implementation report.
  2. The new class inherits the extractor's pre-existing non-element-context over-approximation. `<base href>` written inside a markdown code fence, an HTML comment, a `<script>` string or a `<pre>` block is flagged even though no renderer parses it as an element — verified against lol-html (`T53-extract` `x02`–`x07`). For `<img>` that over-approximation predates this change; for `<base>` it is new, and it is exactly the shape documentation *about* `<base>` takes.
  The corpus does not contradict this, it is silent on it: this repository contains **no** benign `<base href>` at all, so "zero new findings in benign repository content" is a true measurement of a corpus that cannot exercise the class.
- **Impact:** No disclosure and no bypass — the direction is toward flagging. The cost is a
  documentation or tool-output payload whose HTML is quietly rewritten: the base href becomes
  `[REDACTED:url]` and every relative destination in that document now resolves against the reader's
  origin instead of the intended one. `policies.md` permits returning the safe part with
  `redaction.state=redacted`, so this is within policy; it is the *blast radius* that is
  undocumented, and a caller reading `reasons: ["egress.html-base-href-exfil"]` is not told that the
  rest of the document's resolution changed with it.
- **Reproduction:**
  `bun …/T53-base.ts <out>` → `benignFlaggedIds: ["g05.twoBasesRelativeFirst","g06.cdnBaseDoc","g07.cdnBaseInFence","g08.cdnBaseInComment"]`, and g06's redacted output is
  `<base href="[REDACTED:url]">\n<img src="logo.png">\n<a href="guide.html">Guide</a>` — the image
  and the anchor now resolve somewhere else.
  `bun …/T53-corpus.ts <out>` → part B `flaggedIds` includes `codeFenceBaseExample`.
  `bun …/T53-boundary.ts <out>` → `benignNotByteIdenticalIds: ["ctlCdnBaseDoc"]` at
  `dispatchCallTool`, `prepareOutputForPersistence`, `validateOutputForTransport` and
  `redactToolOutput`.
- **Suggested fix:** Keep the finding — the class is correct and the deny direction is right. Two
  cheap corrections: (a) state the whole-document effect in the `<base>` branch's comment and in the
  `remediation` string, so a caller that sees this policy id knows the document's relative
  resolution changed, not just one destination; (b) record in the deferred-surface task that the
  non-element-context over-approximation (comment, RAWTEXT, RCDATA, fenced code) now covers a
  document-level element, and that a benign `<base href>` is the shape most likely to surface it —
  the allowlist is the intended remedy and should be named as such.
- **Class scope:**
  - sites: `src/security/detect/exfil.ts:571-583` (the `<base href>` branch), `:322` (the shared
    `remediation` string), `:356` (`HTML_START_TAG`, which is what makes comment/RAWTEXT/RCDATA
    contexts indistinguishable from element contexts), `:586-597` and `:604-621` (the `src`/`srcset`
    branches, which carry half (2) of this shape already and are unchanged by it).
  - enumeration_method: complete read of `detectExfil`'s HTML loop, then every non-element context
    the HTML tokenizer has for `<` (comment, bogus comment, RAWTEXT via `<style>`, script-data via
    `<script>`, RCDATA via `<textarea>`/`<title>`, end tag, attribute value) driven through the
    detector and through lol-html as an oracle (`T53-extract.ts` `x01`–`x07`, `s14`, `b10`), then a
    30-shape synthetic benign corpus written to contain the documentation forms this repository
    happens to lack (`T53-corpus.ts` part B), then the whole 21769-file checkout swept and the new
    policy id attributed per file (`T53-corpus.ts` part A).

### [T53#F-002] The sufficiency argument names one base-dependent branch; the URL parser has three

- **Severity:** info
- **File:** `src/security/detect/exfil.ts:224`
- **Symbol:** `SYNTHETIC_BASE_PAIRS` (the comment), `exfilHost`
- **Problem:** The comment states that the scheme state "branches on one predicate: the base's
  scheme equals the destination's scheme", and concludes "a third base scheme could only repeat one
  of those two branches". The premise is incomplete. The WHATWG basic URL parser branches on the
  base in at least three places, not one: (i) the scheme-equality predicate the comment names; (ii)
  the **file state**, entered whenever the destination's scheme is `file` *or* — from the *no scheme
  state* — whenever the **base's** scheme is `file`, which is a different branch reached by a
  different test; (iii) the **opaque-path** branch of the no-scheme state, where a relative
  destination against a base with an opaque path is a parse **failure**. Neither pair is a `file:`
  base and neither has an opaque path, so neither branch is realised by either pair, and the stated
  reason for sufficiency does not cover them. What actually makes the conclusion sound is a
  different fact the comment does not invoke: `resolvedHost` discards anything whose protocol is not
  `http:`/`https:`, so the file state can only ever yield a `file:` URL (discarded) and the
  opaque-path branch can only ever yield a failure (discarded). The conclusion is right; the reason
  written down is not the reason it is right.
- **Impact:** None today — measured, not argued: 41 destinations × 15 renderer bases, including
  `file:///…`, a `file://` UNC base, an `app:opaque-document` base, ported, userinfo-bearing,
  path-deep, query- and fragment-bearing bases and the two other special schemes, produce 0 bypasses
  and 0 false positives. The risk is the ordinary one for a load-bearing comment: a future change
  that widens `resolvedHost` past http(s) — adding `ws:`/`wss:` for a WebSocket egress channel is
  the obvious candidate, and `file:` for a UNC/SMB fetch is the less obvious one — would remove the
  fact that is doing the work while leaving the sentence that appears to justify it, and a
  maintainer deriving base sufficiency from the comment would derive it wrongly. This is the same
  failure mode as T42#F-005: a sound rule with an unsound stated reason.
- **Reproduction:** `bun …/T53-resolve.ts <out>` →
  `{destinations: 41, rendererBases: 15, bypasses: 0, falsePositives: 0}`. The base set and the
  reason each base is in it are enumerated in the probe's header comment; `d.fileNoSlash`,
  `d.fileAuthority`, `d.wsNoSlash`, `d.wssNoSlash` and `d.ftpNoSlash` are the rows that reach the
  branches the pairs do not realise, and each returns "no remote host under any renderer base"
  precisely because of the http(s) filter.
- **Suggested fix:** Replace "a third base scheme could only repeat one of those two branches" with
  the two-part reason that is actually true: the pairs realise both sides of the scheme-equality
  predicate, **and** the parser's other base-dependent branches (the `file` state; an opaque base
  path) cannot produce an `http(s)` host, which is the only thing `resolvedHost` returns. Add the
  consequence a maintainer needs: widening `resolvedHost` beyond `http:`/`https:` invalidates this
  argument and requires a third base realising the `file` branch.
- **Class scope:**
  - sites: `src/security/detect/exfil.ts:210-229` (the sufficiency argument), `:250-259`
    (`SYNTHETIC_BASE_PAIRS`), `:263-274` (`resolvedHost`, which holds the fact the argument omits).
  - enumeration_method: the WHATWG basic URL parser read state by state for every step that
    consults `base`, producing the list of base properties the classification could depend on
    (scheme, is-special, is-file, opaque path, host, port, userinfo, path, query, fragment); each
    property then given a renderer document base that varies it, and 41 destination forms driven
    against all 15 through the platform `URL` and through the real detector.

### [T53#F-003] The EOF-in-tag justification is stated as one-directional; the same rule also hides

- **Severity:** info
- **File:** `src/security/detect/exfil.ts:394`
- **Symbol:** `readStartTag` (the doc comment), `T52-implementation.md` concern 2
- **Problem:** Row 12 is justified as an over-approximation that "errs toward flagging": a tag left
  unterminated at end of input still has its collected attributes classified, because "our input is
  a FRAGMENT, so the renderer may hold the terminator we do not". The same code path also runs in
  the *opposite* direction and that half is not stated: an unterminated **quoted value** consumes to
  end of input (`close === -1 → valueEnd = content.length`), the scan index is set past the end, and
  any later `<img src=…>` in the fragment is never examined. So the one rule both flags what a
  parser would drop and hides what a parser would drop — and the premise offered for the eager half
  ("the renderer may hold the terminator we do not") argues, if taken at face value, for the
  opposite treatment of the hiding half.
- **Impact:** None measured, and the behaviour is correct — a real tokenizer also emits nothing
  there, so the detector is faithful rather than lax. `T53-extract.ts` `y01`
  (`<img alt="x <img src="https://attacker.invalid/p">`) and `y02` (the single-quoted twin) both
  report `renderer=false detector=false`: lol-html reads the inner text as the outer element's
  attribute value and bogus attributes, exactly as this scanner does, and issues no request. The
  finding is about the completeness of a security argument that a later round will read as the
  specification of this behaviour, not about the behaviour.
- **Suggested fix:** State both halves in the `readStartTag` comment: an unterminated tag has its
  attributes classified (eager), and an unterminated quoted value swallows the remainder of the
  fragment so nothing after it is classified (conservative) — and record the measurement that makes
  the second acceptable, namely that a conformant tokenizer emits no element there either, so the
  fragment premise does not apply symmetrically.
- **Reproduction:** `bun …/T53-extract.ts <out>` → rows `y01.unterminatedSwallows`,
  `y02.unterminatedThenTag` (`renderer=false detector=false`), against `s12.eofInTagQuoted` and
  `s12b.eofInTagUnquoted` (`renderer=false detector=true`, verdict `OVER`).

### [T53#F-004] The extractor now releases attacker text unmasked when it judges it inert, which trades a false positive for a renderer-conformance assumption

- **Severity:** info
- **File:** `src/security/detect/exfil.ts:561`
- **Symbol:** `detectExfil` (`HTML_START_TAG.lastIndex = Math.max(end, nameEnd)`)
- **Problem:** Resuming the scan past the tag's own `>` is what makes
  `<img alt="<img src=https://attacker.invalid/p>" src="/a.png">` a non-finding, and the
  implementation report reports it as a **removed** pre-existing false positive. It is that; it is
  also a narrowing of the net whose safety now rests on the *reader* implementing the
  attribute-value states. Measured at the boundary, that payload leaves `dispatchCallTool` with
  `isError:false`, `redaction.state:"none"`, byte-identical through the materializer and the seam,
  with the string `attacker.invalid` present in the released text (`T53-boundary.ts`
  `ctlMarkupInValue`, `leaksHost=true` at all four). Against a conformant tokenizer that is inert
  and correct; against a client that renders tool output through a non-conformant HTML-ish pass
  (a regex-based markdown-to-HTML step, a sanitizer that strips attributes and re-emits their
  contents), it is not obviously inert.
- **Impact:** None demonstrated — I could not construct a renderer that fetches it, and lol-html
  does not. Recorded because it is the one place where this round's design decides *not* to mask
  attacker-controlled bytes on the strength of a parser model, where every previous round of this
  floor decided the opposite, and because the previous reviewer's standing framing for this floor is
  deny-by-default. The trade is defensible and I do not ask for it to be reversed; it should be a
  recorded decision rather than an incidental consequence of the `lastIndex` line.
- **Suggested fix:** Record it in the `<base>`/`<img>` loop comment as a decision with its premise
  named — "markup inside a quoted attribute value is text for any conformant HTML parser, so it is
  released unmasked; this is the one point where the floor trusts the reader's parser" — and add the
  case to the deferred-surface task's scope so that a future policy round on non-conformant
  renderers has it in the list.
- **Reproduction:** `bun …/T53-boundary.ts <out>` → `ctlMarkupInValue` `mcp isError=false
  state=none reasons=[] leaksHost=true | persist leaksHost=true identical=true | transport
  leaksHost=true | seam leaksHost=true`. `bun …/T53-extract.ts <out>` → `s14.markupInsideValue`,
  `b10.baseInsideValue`: `renderer=false detector=false hostAfter=true`.

## Judgement calls

### 1. The `<base href>` behaviour change — **UPHELD, with the consequence extended**

The implementer asked for agreement rather than inheritance, and the agreement is earned. I tested
the argument three ways and it holds each time.

*Is `<base>` a real channel?* Yes, and it is the only element on the deferred list that falsifies a
rule the classifier depends on rather than adding a destination. Measured: 15 hostile `<base>`
vectors, each reaching `attacker.invalid` under a renderer model that has no relationship to the
detector — it locates the document base with lol-html under the real "first `<base>` with an `href`
wins" rule and resolves with the platform `URL`. That includes the two shapes that make it a
*document-level* problem rather than an element-level one: a base written **after** the image it
re-points (`h06`), and a base re-pointing a **markdown** image and a relative **srcset** (`h10`,
`h11`) — surfaces that carry no authority of their own and could not otherwise be reached.

*Is masking sufficient?* Yes, and the reason the implementer gives is the right one and is measured
rather than asserted. `<base href="[REDACTED:url]">` is a relative base, so the document base
returns to the reader's own origin and every relative destination follows it back. 15 of 15 hostile
documents reach the attacker before redaction and 0 after. The alternative the implementer rejected
— re-resolving relative destinations against the attacker's base — would indeed put
attacker-controlled bytes in the resolution path for spans whose offsets must stay on the original
bytes, and would buy nothing once the re-point is gone. Rejecting it was right.

*Is the cost acceptable?* Yes, but the disclosure understates it in one respect and I am recording
that rather than waving it through (T53#F-001): masking a `<base>` is a **whole-document** effect.
Every relative link and image around it now resolves somewhere else. For `<img src>` a false
positive costs one image; for `<base href>` it costs the document's entire relative resolution. That
does not change the verdict — the deny direction is still correct and the allowlist is still the
remedy — but it is a different order of consequence and it belongs in the comment and the
remediation string. The related half is that the repository contains no benign `<base href>`
whatsoever, so the corpus sweep, whose number I reproduce, is silent on the class rather than
exonerating it; the benign shape that does trip it (a `<base href>` quoted in a documentation code
fence) I had to write myself.

**Ruling: keep the class, keep the empty-allowlist default, document the blast radius.**

### 2. The two deliberate over-approximations — **BOTH ACCEPTED**

*A duplicate source attribute.* Accepted. Verified rather than assumed: lol-html applies the tree
builder's first-wins rule, so `<img src="/a.png" src="https://attacker.invalid/p">` is genuinely not
fetched and the detector genuinely over-flags it (`T53-extract` `s11b`, verdict `OVER`), while the
hostile ordering `<img src="https://attacker.invalid/p" src="/a.png">` **is** fetched and **is**
flagged (`s11`). The same holds for `<base>` in both orders (`b05`, `b06`) and for the
empty-unquoted-value shape that turns into the same class (`u12`). The cost is a masked image in
malformed HTML nobody writes deliberately; the alternative — implementing first-wins — would mean
the detector deliberately ignoring an attacker-supplied destination on the strength of the reader
applying a de-duplication rule, which is the wrong direction for a floor. Accept, no change.

*A tag unterminated at end of input.* Accepted, with T53#F-003 against the *justification* rather
than the behaviour. The behaviour is right: our input is a fragment, and classifying the attributes
we did collect costs nothing (`s12`, `s12b` — `renderer=false detector=true`). It also matches the
previous regex, so it is not a widening, as claimed. What is not right is the characterisation of
row 12 as purely eager: the same EOF handling makes an unterminated **quoted value** swallow the
rest of the fragment, so anything after it is never classified. I measured that half too, and it is
faithful — a conformant tokenizer emits nothing there either (`y01`, `y02`, both
`renderer=false detector=false`) — so it is not a hole. But the premise offered for the eager half,
"the renderer may hold the terminator we do not", applies word for word to the closing quote, and a
reader who takes the justification at face value would expect the opposite treatment. Accept the
behaviour; fix the sentence.

### 3. The reconstructed pre-repair detector — **A REAL WEAKNESS THAT WEAKENS NOTHING LOAD-BEARING**

The implementer disclosed it plainly (concern 4), which is what makes it assessable. The
reconstruction is not in the repository and T40's changes are uncommitted, so I **cannot verify it**
and I do not claim to have. Here is exactly what rests on it.

**Rests on the reconstruction:** the *before* column of `T52-base.ts` (10 of 14 cases reachable
before redaction) and the *before* counts of `T52-corpus.ts` (192 findings / 40 files, and therefore
the "+66 / −10" delta and its attribution).

**Does not rest on it:** everything the acceptance criteria actually turn on. The *after* columns of
both probes are real runs against the tree, and I reproduced them (`T52-base.ts` re-run here:
`notNeutralized: [], falsePositives: []`). The before-runs of the two matrices that carry the
blocker and the major — `T42-exfil-attack.ts` (14 bypasses) and `T42-boundary.ts` (six leaking
shapes) — were real runs against the real pre-repair tree, recorded independently in `T42-review.md`
by a reviewer who had no stake in T52. And the claim the reconstruction was built to support for
`<base>` — that it was previously a gap — was already measured against the real tree by T42#F-006
(`matches=0` across 19 surfaces including `<base href>`), so the reconstruction is redundant there.

**Does it weaken the conclusions?** No, for a reason worth stating because it should be the method
next time: **the before-side was never needed.** The only new class is identifiable by its policy id
(`egress.html-base-href-exfil`), so "which findings are new and where do they live" is answerable
from a single run of the *current* detector by attribution, with no reconstruction and no prior
revision. That is what I did — 55 base-href findings, 8 files, every one vector-carrying — and it
agrees with the implementer's conclusion while resting on nothing that cannot be re-derived from
disk. The reconstruction is therefore an unnecessary risk that happened not to cost anything.

**Ruling: accept the evidence. Record for the next round that a new finding class should be measured
by policy-id attribution over the current tree, not by reconstructing a prior detector** — it is
strictly stronger, strictly cheaper, and does not require trusting an anchor-matching edit script
that no reviewer can see.

## Confirmed clean areas

Each was executed, not inspected.

- **Extraction is faithful to an independent parser across 88 cases**, including every state I could
  reach that T52's table omits. The detector and lol-html agree on all 88 in the security direction;
  the 14 disagreements are all the detector flagging where lol-html does not.
- **Resolution is stable under every base property the two pairs do not vary** — file, UNC-file,
  opaque-path, ported, userinfo-bearing, path-deep, query- and fragment-bearing, `ws:`, `ftp:`,
  `chrome-extension:` and `tauri:` renderer bases: 615 resolutions, 0 bypasses, 0 false positives.
- **All 13 relative destination forms stay unflagged under all 15 bases**, including the three that
  look like authorities (`docs.example.org/pixel.png`, `/attacker.invalid/p`,
  `.//attacker.invalid/p`) and the two percent-encoded ones.
- **Allowlist semantics for `<base>` are exactly those of `<img src>`**: apex and subdomain allowed,
  a userinfo-prefixed allowlisted host (`https://cdn.example.org@attacker.invalid/`) correctly
  flagged, empty / whitespace-only / entity-only hrefs correctly not findings.
- **Mask spans are correct on the raw bytes** for quoted, unquoted, entity-bearing and multi-candidate
  `srcset` values: `<img srcset="A 1x, B 2x, /c.png 3x">` masks A and B and leaves `/c.png`.
- **The scanner is linear and has no backtracking**: 20 K open tags, 20 K quoted `>` runs, 20 K
  attributes, 200 K consecutive solidi, 20 K nested pseudo-tags inside one value, a 400 KB
  unterminated value and 960 KB of benign prose all complete in ≤ 9.6 ms.
- **The new policy id needs no registration** — `egress.html-base-href-exfil` flows through the same
  free-form `policyId` path as `egress.html-image-exfil`, which has no catalogue entry either
  (`ctx rg` over `src`, `docs`, `fixtures`: the existing id appears only in the detector and its
  tests), so no reporting or gate surface is left without a mapping.
- **All three earlier repairs still hold at the boundaries**: 12 canonicalization shapes with no
  leak and `cleanPretty`/`cleanCompact` byte-identical; 28 MCP cases each keeping its exact state
  and constant reason token; the persistence signal matrix unchanged.
- **The floor applies with advisory redaction disabled** — every transport case in `T53-boundary.ts`
  and `T42-boundary.ts` ran under `mergeMcpConfig({ redactToolOutput: false })`.
- **Green tree**: 116 pass / 0 fail / 933 expect() on the five focused suites; `tsc --noEmit` exit 0;
  `eslint` on both changed files exit 0.
- **Stage 2 (code quality)**, run because Stage 1 passed. `readStartTag` is a single linear pass with
  one loop and no allocation per character; every state transition carries the spec rule it
  implements; the two eager deviations are named at the point they occur. `exfilHost` /
  `agreedHost` / `resolvedHost` decompose cleanly and each has one job. No dead code, no unused
  export, no duplicated logic between the `src`, `srcset` and `href` branches beyond the shared
  `considerUrl` funnel, which is the right shape. One nit, not raised as a finding: the comment
  block at `:509-511` sits at column 0 inside `detectExfil` while the surrounding body is indented
  two, and `SENSITIVE_URL_VALUE` at `:487` follows `readStartTag`'s closing brace with no blank
  line. Both are cosmetic, eslint passes, and neither is worth a round trip in a file two other
  workers are adjacent to.

## Evidence

| Artifact | SHA-256 |
|---|---|
| `T53-extract.ts` | `7542a4f2fa7550e3e66a90f4d727751584d1ac070e14e5a440e26af8c083a4ae` |
| `T53-resolve.ts` | `f87386757ca8f94346a8eed3e64c5459be22e5c411f9ad349a38f049eace6858` |
| `T53-base.ts` | `a82e7732352094f32f0b224835c857949fb6ebbf63fabbfa5159a1e5ee6092b7` |
| `T53-boundary.ts` | `314d7047d97888d58227ca369eba137af148eeffea95c4ae0cac438c836e3249` |
| `T53-corpus.ts` | `a03a991bc5ca4a6c13e4d0ce8b0c17176c0508d196dabe9382ab51e27a47231e` |
| out: `…/scratchpad/T53-extract.json` | `586197934f2e4c370834d2a6c7fc38439ac960a154178a23b3f4fc183b21cd23` |
| out: `…/scratchpad/T53-resolve.json` | `7f4f69b4540544225457f061ed9597c536f902ecc490afb1ae6ce014ff5ceb3d` |
| out: `…/scratchpad/T53-base.json` | `1179b92f40df24890cca19c7f5eb4f301bc621ed0944f393670264ba9f8c7e3d` |
| out: `…/scratchpad/T53-boundary.json` | `e6376d6eeec06f8c36c685732823bfc363ccfec4fd48d5a635c912a1e3b8b05a` |
| out: `…/scratchpad/T53-corpus.json` | `cc971a452a110f45f5604b27470beec9fde9136a43dbf5c8169a3a3da019182a` |
| out: `…/scratchpad/T53-rerun-T42-exfil.json` (42-case matrix) | `0533defdfdaa6f66039c9b4857f8a91707aced4ab778771ecaefe9ca57288f42` |
| out: `…/scratchpad/T53-rerun-T24-recheck2-exfil.json` (48-case matrix) | `69caf814d72c9ad11c863c56cd6223b15280c21e3bc4715a0a5c5bb47986c4df` |
| out: `…/scratchpad/T53-rerun-T42-charrefs.log` (240-case matrix) | `698d88993076fd92aad9b4a4e1f8235a0eac2b7490baa0d34d8d1c65cac1b452` |
| out: `…/scratchpad/T53-rerun-T42-boundary.json` | `ca27f50deabd34ddc772abf0a710b011e7cb38c354a1dc510cfd1ca2abe4fe9e` |
| out: `…/scratchpad/T53-rerun-T24R2-boundary.json` | `9c138e5ec56334bb596c6bc7052cb7c8dc91cc5542941d8f16cbedb3a5566ffe` |
| out: `…/scratchpad/T53-rerun-T52-base.json` | `19ba9dd0e8cf40389376e513806e138a7b78e868ea87f5cb3be02e2bca02f103` |
| `…/scratchpad/T53-hashes-start.txt` | `ed954aee4eaae5fa2be151c3bf912f2b657951797a7139400095a2985eb7e2a3` |
| `…/scratchpad/T53-hashes-end.txt` | `2e034249f6e818fbd06350b6dfb7ad80e15b0e654c1a65cba43e1ab62f7c6a3c` |

Probe JSON outputs live under the session scratchpad
(`/private/tmp/claude-502/-Users-Goodea-goodea-keryx/2c1aca69-07c3-46d7-89d4-79e0152123a5/scratchpad/`)
because the dispatch permits writing only `T53-review.md`, `T53-result.json` and `T53-*.ts` under the
artifacts directory. Every probe is deterministic and re-runnable from the committed `.ts` files.

No model call, no network, no dependency change, no git or flow-state change, no `bun test` without
file arguments, and no mutation of any production or test file. Every host in every probe is
reserved or synthetic (`attacker.invalid`, `*.invalid`, `example.org`, `cdn.example.org`,
`client.example.org`, `img.shields.io` only as literal text in a benign fixture); nothing was
contacted, and no probe performs I/O beyond reading the checkout and writing its own JSON to the
scratchpad.

**Oracle limitation, disclosed.** lol-html returns attribute values **raw**, without decoding
character references, so my extraction oracle under-reports on `c04.refInValue`,
`c05.refInValueNumeric` and `c06.ambiguousAmpersand`: it says "no fetch" where a browser decodes
`&colon;` and does fetch. Those three are recorded as `OVER` in the raw output and are **not**
over-approximations — the detector is right and the oracle is blind. The same limitation makes
`T53-base.ts`'s `h05.entityColon` show `before=false`; the detector flags it and the redacted
document is clean either way. No bypass verdict anywhere depends on the oracle's decoding, because
a bypass requires the oracle to say "fetch" while the detector says "clean", and an oracle that
under-decodes can only produce the opposite error.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the file set exactly, and the graph
  answers from the last `keryx gdgraph build` while the tree carries a large uncommitted
  multi-worker change set, so a graph answer could not be quoted as current. The one cross-file
  enumeration needed (where exfil policy ids are registered) came from `ctx rg` over the working
  tree.
- `wiki_used: no (not-relevant)` — the governing texts are
  `docs/requirements/keryx-agent-first-core/policies.md`, the flow's `acceptance-criteria.md`,
  `T42-review.md`, `T52-spec.md`, `T52-implementation.md` and `T40-implementation.md`; all were read
  directly, as the dispatch required.
- `ctx_used: partial, disclosed` — every code search went through `bun src/cli.ts ctx rg`, and the
  one diff through `bun src/cli.ts ctx diff --stat`. Probe and test **execution** ran `bun`
  directly, as the dispatch instructed and for the reason it gave: `ctx run`'s compaction elides the
  per-case statuses that are this review's evidence, and the 88-row, 41×15 and 240-case matrices are
  exactly that kind of output. Test, typecheck and lint output was small enough to read whole. Two
  attempted `tail` invocations were correctly refused by the routing hook and replaced with bounded
  `bun -e` readers over the scratchpad.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find`/`sed` over project code. Bounded `Read` calls
  with `offset`/`limit` and small `bun -e` readers were used instead.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T53#F-001",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/security/detect/exfil.ts",
    "line": 571,
    "symbol": "detectExfil",
    "problem": "The new <base href> class is correct but its cost is understated in two ways. (1) Masking an <img src> breaks one image; masking a <base href> re-points EVERY relative URL in the document to the reader's own origin, so one false positive silently changes the resolution of every link and image around it. That asymmetry appears nowhere in the code, the spec or the implementation report. (2) The class inherits the extractor's pre-existing non-element-context over-approximation, so a <base href> written inside a markdown code fence, an HTML comment, a <script> string or a <pre> block is flagged although no conformant renderer parses it as an element - which is exactly the shape documentation ABOUT <base> takes. The corpus sweep does not contradict this, it is silent on it: the repository contains no benign <base href> at all, so 'zero new findings in benign repository content' measures a corpus that cannot exercise the class.",
    "impact": "No disclosure and no bypass; the direction is toward flagging and policies.md permits returning the safe part with redaction.state=redacted. The cost is a documentation or tool-output payload whose HTML is quietly rewritten - the base href becomes [REDACTED:url] and every relative destination around it now resolves against the reader's origin instead of the intended one - and a caller reading reasons:[\"egress.html-base-href-exfil\"] is not told that the document's relative resolution changed with it.",
    "suggested_fix": "Keep the class, the empty-allowlist default and the deny direction. (a) State the whole-document effect in the <base> branch's comment and in the shared remediation string, so a caller that sees this policy id knows the document's relative resolution changed and not just one destination. (b) Record in the deferred-surface task that the non-element-context over-approximation (comment, RAWTEXT, RCDATA, fenced code) now covers a document-level element, that a benign <base href> is the shape most likely to surface it, and that the allowlist is the intended remedy.",
    "evidence": "T53-base.ts: benignFlaggedIds = [g05.twoBasesRelativeFirst, g06.cdnBaseDoc, g07.cdnBaseInFence, g08.cdnBaseInComment]; g06's redacted output is '<base href=\"[REDACTED:url]\">\\n<img src=\"logo.png\">\\n<a href=\"guide.html\">Guide</a>', so the image and the anchor now resolve elsewhere. T53-corpus.ts part B: codeFenceBaseExample flagged among 30 synthetic benign shapes. T53-boundary.ts: benignNotByteIdenticalIds = [ctlCdnBaseDoc] at dispatchCallTool, prepareOutputForPersistence, validateOutputForTransport and redactToolOutput. T53-extract.ts x02-x07 establish the non-element-context half against lol-html. T53-corpus.ts part A: 21769 files, all 55 egress.html-base-href-exfil findings in 8 vector-carrying files, 0 in benign repository content.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:base-href-class-blast-radius-and-non-element-contexts",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:571",
        "src/security/detect/exfil.ts:322",
        "src/security/detect/exfil.ts:356",
        "src/security/detect/exfil.ts:586",
        "src/security/detect/exfil.ts:604"
      ],
      "enumeration_method": "Complete read of detectExfil's HTML loop, then every non-element context the HTML tokenizer has for '<' (comment, bogus comment, RAWTEXT via <style>, script-data via <script>, RCDATA via <textarea> and <title>, end tag with attributes, attribute value) driven through the detector AND through Bun's HTMLRewriter (lol-html) as an independent oracle - T53-extract.ts x01-x07, s14, b10. Then a 30-shape synthetic benign corpus written to contain the documentation forms this repository happens to lack (T53-corpus.ts part B), then the whole 21769-file checkout swept with the new policy id attributed per file (T53-corpus.ts part A)."
    }
  },
  {
    "id": "F-002",
    "global_id": "T53#F-002",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/security/detect/exfil.ts",
    "line": 224,
    "symbol": "SYNTHETIC_BASE_PAIRS",
    "problem": "The sufficiency argument states that the scheme state branches on one predicate ('the base's scheme equals the destination's scheme') and concludes that 'a third base scheme could only repeat one of those two branches'. The premise is incomplete: the WHATWG basic URL parser branches on the base in at least three places - the scheme-equality predicate, the FILE state (entered from the no-scheme state whenever the BASE's scheme is file, a different test), and the OPAQUE-PATH branch of the no-scheme state, where a relative destination against an opaque-path base is a parse failure. Neither pair is a file: base and neither has an opaque path, so neither branch is realised by either pair. What actually makes the conclusion sound is a fact the comment does not invoke: resolvedHost discards anything whose protocol is not http:/https:, so the file state can only yield a file: URL and the opaque-path branch can only yield a failure. The conclusion is right; the stated reason is not the reason it is right.",
    "impact": "None today, measured rather than argued: 41 destinations x 15 renderer document bases - including file:///, a file:// UNC base, an app:opaque-document base, ported, userinfo-bearing, path-deep, query- and fragment-bearing bases and the other special schemes - give 0 bypasses and 0 false positives. The risk is that a future change widening resolvedHost past http(s) (ws:/wss: for a WebSocket egress channel is the obvious candidate; file: for a UNC/SMB fetch the less obvious one) removes the fact doing the work while leaving the sentence that appears to justify it, so a maintainer deriving base sufficiency from the comment derives it wrongly. Same failure mode as T42#F-005: a sound rule with an unsound stated reason.",
    "suggested_fix": "Replace 'a third base scheme could only repeat one of those two branches' with the two-part reason that is true: the pairs realise both sides of the scheme-equality predicate, AND the parser's other base-dependent branches (the file state; an opaque base path) cannot produce an http(s) host, which is the only thing resolvedHost returns. Add the consequence a maintainer needs: widening resolvedHost beyond http:/https: invalidates this argument and requires a third base realising the file branch.",
    "evidence": "T53-resolve.ts: {destinations: 41, rendererBases: 15, bypasses: 0, falsePositives: 0}. The rows that reach the unrealised branches - d.fileNoSlash, d.fileAuthority, d.wsNoSlash, d.wssNoSlash, d.ftpNoSlash - each return 'no remote host under any renderer base' precisely because of the http(s) filter in resolvedHost, not because of the base pairs.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:two-pair-sufficiency-argument-incomplete",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:210",
        "src/security/detect/exfil.ts:250",
        "src/security/detect/exfil.ts:263"
      ],
      "enumeration_method": "The WHATWG basic URL parser read state by state for every step that consults `base`, producing the list of base properties the classification could depend on (scheme, is-special, is-file, opaque path, host, port, userinfo, path, query, fragment). Each property was then given a renderer document base that varies it, and 41 destination forms were driven against all 15 bases through the platform URL and through the real detector (T53-resolve.ts)."
    }
  },
  {
    "id": "F-003",
    "global_id": "T53#F-003",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/security/detect/exfil.ts",
    "line": 394,
    "symbol": "readStartTag",
    "problem": "Row 12 (EOF inside the tag) is justified as an over-approximation that errs toward flagging, because 'our input is a FRAGMENT, so the renderer may hold the terminator we do not'. The same code path also runs in the opposite direction and that half is not stated: an unterminated QUOTED value consumes to end of input (close === -1 -> valueEnd = content.length), the scan index is set past the end, and any later <img src=...> in the fragment is never examined. So one rule both flags what a parser would drop and hides what a parser would drop, and the premise offered for the eager half applies word for word to the closing quote, where it would argue for the opposite treatment.",
    "impact": "None measured, and the behaviour is correct rather than lax: a conformant tokenizer emits nothing there either, so the detector is faithful. The finding is about the completeness of a security argument that a later round will read as the specification of this behaviour.",
    "suggested_fix": "State both halves in the readStartTag comment: an unterminated tag has its collected attributes classified (eager), and an unterminated quoted value swallows the remainder of the fragment so nothing after it is classified (conservative). Record the measurement that makes the second acceptable - a conformant tokenizer emits no element there either, so the fragment premise does not apply symmetrically.",
    "evidence": "T53-extract.ts rows y01.unterminatedSwallows and y02.unterminatedThenTag: renderer=false detector=false, adjudicated by lol-html; against s12.eofInTagQuoted and s12b.eofInTagUnquoted: renderer=false detector=true, verdict OVER.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:eof-in-tag-justification-one-directional",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-004",
    "global_id": "T53#F-004",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/security/detect/exfil.ts",
    "line": 561,
    "symbol": "detectExfil",
    "problem": "Resuming the scan past the tag's own '>' is what makes <img alt=\"<img src=https://attacker.invalid/p>\" src=\"/a.png\"> a non-finding, reported as a removed pre-existing false positive. It is that; it is also a narrowing of the net whose safety now rests on the READER implementing the attribute-value states. Measured at the boundary, that payload leaves dispatchCallTool with isError:false, redaction.state:\"none\", byte-identical through the materializer and the seam, with 'attacker.invalid' present in the released text. Against a conformant tokenizer it is inert and correct; against a client that renders tool output through a non-conformant HTML-ish pass it is not obviously inert.",
    "impact": "None demonstrated - no renderer I could construct fetches it, and lol-html does not. Recorded because it is the one place where this round's design decides NOT to mask attacker-controlled bytes on the strength of a parser model, where every previous round of this floor decided the opposite and the standing framing is deny-by-default. The trade is defensible; it should be a recorded decision rather than an incidental consequence of the lastIndex line.",
    "suggested_fix": "Record it in the HTML loop's comment as a decision with its premise named - markup inside a quoted attribute value is text for any conformant HTML parser, so it is released unmasked; this is the one point where the floor trusts the reader's parser - and add the case to the deferred-surface task's scope so a future policy round on non-conformant renderers has it in the list.",
    "evidence": "T53-boundary.ts: ctlMarkupInValue = mcp isError=false state=none reasons=[] leaksHost=true | persist leaksHost=true identical=true | transport leaksHost=true | seam leaksHost=true. T53-extract.ts: s14.markupInsideValue and b10.baseInsideValue = renderer=false detector=false hostAfter=true.",
    "confidence": "medium",
    "dedupe_key": "afc15:exfil:markup-in-value-released-on-parser-conformance",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true
  }
]
```
