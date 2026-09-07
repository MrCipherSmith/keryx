# T67 — spec: revert the `<base href>` inert-span suppression (T62#F-001), keep T63's disclosure work

Written before any code change. Detector hash at start:
`efe360a36fad99fd6d8f0e44490cd7424f2054bfbfb6ebc7ccd5f05d77250294` (`src/security/detect/exfil.ts`).

## 1. What is being reverted, and why the isolation T63 offered is not taken

T63 added a rule to `detectExfil`: a `<base href>` is not a finding when the tag
sits inside a span that *this file's two regexes* show is closed — an HTML
comment (`/<!--[\s\S]*?-->/`) or a CommonMark fenced code block (`FENCE_LINE`
pairing). T53 had ruled *document, do not change*; T62 measured the change and
ruled *revert in full*.

The measurement, reproduced here before touching anything (raw:
`.metaproject/data/gdctx/raw/T67-before-T62-exfil.log`,
`T67-before-T62-boundary.log`):

- `T62-exfil.ts`: `{"cases":13,"bypasses":6}` — `x01`, `x02`, `x03`, `x05`,
  `x06`, `x07` all yield `baseFindings: 0` with the attacker host present in the
  redacted output.
- `T62-boundary.ts`: `{"hostileLeakingAtAnyBoundary":4,"ids":["abruptEmptyComment","abruptDashComment","commentEndBang","fencePairSwallowsLiveBase"]}`,
  each with `mcpState "none"`, `mcpReasons []`, `persistState "none"`,
  `transportState "none"` and `leaksHost {mcp:true,persist:true,transport:true,seam:true}`.

The comment half accounts for `x01`/`x02`/`x03` (three of the four
boundary-confirmed leaks) and `x06`; the fence half accounts for `x07` (the
fourth) and `x05`. Reverting either half alone leaves the other half's leaks
standing, so neither half is independently sound and both go.

## 2. The reason to record in the module

Not "suppression is undesirable". The recorded reason is narrower and is the one
that generalizes: the rule approximated two grammars — the HTML tokenizer's
comment states and CommonMark's fenced-code/HTML-block rules — with two regexes,
**in the one direction where being wrong releases attacker-controlled bytes**.
`<!-->`, `<!--->` and `--!>` each end a comment before the regex's `-->` does, and
fence spans and comment spans computed independently of one another pair
delimiters no renderer pairs. Five bytes defeat it.

The condition under which the decision could be revisited is stated too: an
implementation that decided the span with the same conformant tokenizer the
reviewers used as an oracle (lol-html via `HTMLRewriter`) plus a real CommonMark
pass, failing toward flagging on every ambiguity — not only on an unterminated
delimiter — and whose acceptance evidence includes hostile payloads placed inside
every span kind it recognizes.

## 3. Exact changes

`src/security/detect/exfil.ts` (owned):

1. Delete `HTML_COMMENT_SPAN`, `FENCE_LINE`, `fencedCodeBlockSpans`,
   `nonRenderedSpans`, `isInNonRenderedSpan` and the block comment that argues
   for them; replace with the recorded reason from §2.
2. Delete `nonRenderedBaseSpansCache` / `getNonRenderedBaseSpans` inside
   `detectExfil`.
3. `tag === "base"` branch: the guard becomes `attribute.name === "href"` again.
4. Header comment (`:34-39`): keep the whole-document-blast-radius sentence
   (T53#F-001); drop the clause claiming `<base>` is excluded from non-rendered
   spans.
5. `<base>` branch comment: keep the asymmetry paragraph; replace the sentence
   describing the suppression with the recorded reason.
6. The T53#F-004 comment at `HTML_START_TAG.lastIndex` says the attribute-value
   decision is "one of the two places … (with the `<base>` inert-span check
   below)" — after the revert it is the only one, so the cross-reference is
   corrected. This is part of the revert, not a new claim.

Kept verbatim (T63's valuable half, not in question): `BASE_REMEDIATION` and its
separation from `FETCH_REMEDIATION`, `UrlHit.remediation`, the whole-document
disclosure, the corrected `SYNTHETIC_BASE_PAIRS` sufficiency argument
(T53#F-002), the corrected `readStartTag` EOF paragraph (T53#F-003), and the
T53#F-004 decision itself.

`src/security/detect/exfil.test.ts` (owned):

- Three tests asserted the suppression itself (`a base element inside a closed
  HTML comment / backtick fence / tilde fence is not a finding`). They are
  **inverted into regressions that the suppression is gone**, not deleted: the
  same three payloads must now be findings and must be masked.
- Kept unchanged: the unterminated-comment/fence test, the `<img>`-still-flagged
  test, the base-outside-a-fence test, the remediation-disclosure test, the
  T53#F-002 and T53#F-003 pins.
- Added: one regression per reviewer shape — `x01` abrupt-empty-comment, `x02`
  abrupt-dash-comment, `x03` comment-end-bang, `x05` comment delimiters quoted in
  fences, `x06` comment delimiters in code spans, `x07` fence markers quoted
  inside a comment — each asserting a `egress.html-base-href-exfil` finding and
  no attacker host after redaction.

## 4. Acceptance and verification plan

| Check | Before (measured) | Required after |
|---|---|---|
| `T62-exfil.ts` | 13 cases, **6 bypasses** | 13 cases, **0 bypasses** |
| `T62-boundary.ts` | **4** leaking | **0** leaking; the two benign controls may now be masked (that is the reverted false positive returning, and is the accepted cost) |
| `T53-extract.ts` | 88 cases, 0 bypasses, 14 over-approximations | identical |
| `T53-resolve.ts` | 41×15=615, 0 bypasses, 0 FP | identical |
| `T53-base.ts` | `hostileNotNeutralized 0`, `benignFlaggedIds [g05,g06]` | `0`, `[g05,g06,g07,g08]` (T53's original set) |
| `T53-boundary.ts` | 0 leaking, `[ctlCdnBaseDoc]` | 0 leaking, T53's original benign set |
| `T42-exfil-attack.ts` | 42 cases, 0/0 | identical |
| `T24-recheck2-exfil.ts` | 48 cases, 0/0 | identical |
| `T42-charrefs.ts` | 240 cases, `absentButUrlSyntax: []` | identical |
| `T42-boundary.ts` | ROW 1 six shapes closed, `ctlPublicLink` `none` | identical |
| `T24-recheck2-boundary.ts` | 12 canonicalization + 28 persistence rows | identical |
| `T46-surfaces.ts` | surface matrix, `flaggedNonFetching [X04.templateImg]` | identical |
| `T52-base.ts` | `reachableAfterRedaction []` | identical |
| `T53-corpus.ts` part B | **6** of 30 flagged | **7** of 30, `codeFenceBaseExample` back — the pre-suppression number |
| Suites | 87 pass / 0 fail | pass, with the new regressions |
| `bun run typecheck`, `bunx eslint` on both owned files | exit 0 | exit 0 |

AC5 (AFC-15) is re-checked directly in the suite run: no field-name or spelling
bypass, a URL secret masked, a public Markdown link not a network send.

## 5. Order of work (TDD)

1. Write the inverted + six-shape regressions (RED) and run them against the
   unreverted detector — they must fail.
2. Revert the three code sites; re-run — GREEN.
3. Re-run every matrix above, plus the suites, typecheck and eslint.
</content>
</invoke>
