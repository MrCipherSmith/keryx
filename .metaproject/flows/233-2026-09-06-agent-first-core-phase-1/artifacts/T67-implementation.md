STATUS: DONE

# T67 — reverting the `<base href>` inert-span suppression (T62#F-001), keeping T63's disclosure work

Files owned and changed: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts` — nothing else.

Detector `src/security/detect/exfil.ts` SHA-256 **at start** `efe360a36fad99fd6d8f0e44490cd7424f2054bfbfb6ebc7ccd5f05d77250294`,
**at end** `63edcc57c8604ab5e66534ca5c92d30ef0f77d942494d898dc2f07f479ab15cc`.
`src/security/detect/exfil.test.ts` at end `a8f2365b22c595b627feb8da243e203440ac11f35b5d3a16f4d9fa260aed7f11`.
Recorded because two other workers hold `src/security/self-protect.ts` / `guard.ts` / `commands/security.ts` / the docs and a third
is reading this same detector; the start hash is the file I measured the bypass on, the end hash is the file every "after" number below was measured on.

Spec written before any code change: `T67-spec.md` in this directory.

## What was measured before touching anything

The reviewer's own two probes, run directly (not through `ctx run` — its compaction drops the per-case rows that are the evidence,
which is the same disclosed reason T52/T53/T63 gave and which I re-observed here):

| Probe | Raw log | Result |
|---|---|---|
| `T62-exfil.ts` | `.metaproject/data/gdctx/raw/T67-before-T62-exfil.log` | `{"cases":13,"bypasses":6}` — `x01`, `x02`, `x03`, `x05`, `x06`, `x07` each `baseFindings: 0` with the attacker host still in the redacted output |
| `T62-boundary.ts` | `.metaproject/data/gdctx/raw/T67-before-T62-boundary.log` | `{"hostileLeakingAtAnyBoundary":4,"ids":["abruptEmptyComment","abruptDashComment","commentEndBang","fencePairSwallowsLiveBase"]}`, each `mcpState "none"`, `mcpReasons []`, `persistState "none"`, `transportState "none"`, `leaksHost {mcp:true,persist:true,transport:true,seam:true}` |

F-001 reproduces exactly as written, at the detector and at all four public boundaries, with advisory redaction OFF (the mandatory floor).

## What was reverted

Three code sites, both halves, no isolation taken — the comment half carried `x01`/`x02`/`x03` (three of the four
boundary-confirmed leaks) and `x06`; the fence half carried `x07` (the fourth) and `x05`, so reverting either alone leaves the
other's leaks standing:

1. `HTML_COMMENT_SPAN`, `FENCE_LINE`, `fencedCodeBlockSpans`, `nonRenderedSpans`, `isInNonRenderedSpan` — deleted.
2. `nonRenderedBaseSpansCache` / `getNonRenderedBaseSpans` inside `detectExfil` — deleted.
3. The guard on the `tag === "base"` branch — back to `if (attribute.name === "href")`. A base element is a finding wherever it appears.

## What was kept — T63's valuable half, unchanged

- `BASE_REMEDIATION` and its separation from `FETCH_REMEDIATION`; the optional `UrlHit.remediation` field and the `<base>` callsite that passes it.
- The whole-document blast-radius disclosure, in the header comment and in the branch comment.
- The corrected asymmetry paragraph on the `<base>` branch (a masked `<img src>` breaks one image; a masked `<base href>` re-points every relative URL).
- The rewritten `SYNTHETIC_BASE_PAIRS` sufficiency argument (T53#F-002) and the corrected `readStartTag` EOF paragraph (T53#F-003), plus **both of their pinning tests**, byte-identical.
- The T53#F-004 decision itself. Its comment said the attribute-value trade is "one of the two places … (with the `<base>` inert-span check below)"; with the check gone it is now the only one, so that cross-reference was corrected — part of the revert, not a new claim — and the sentence now also names the evidence that distinguishes it: 88 tokenizer cases against an independent oracle, which the reverted rule never had.

## The reason recorded in the module

A block comment now sits where `nonRenderedSpans` was (immediately above `SENSITIVE_URL_VALUE`), addressed to the next person
who notices `<base href>` flagged on a documentation example. It states, in this order:

- The pull is real and is not dismissed: a false `<base>` positive is a whole-document effect and quoting the element in a fence
  or a comment is exactly the shape benign documentation takes.
- **Why the rule was wrong is not "suppression is undesirable".** It is that approximating the HTML comment states and
  CommonMark's fenced-code/HTML-block rules with two regexes is wrong *in the one direction where being wrong releases
  attacker-controlled bytes*. The three terminators the `-->`-only regex does not know (`<!-->`, `<!--->` — abrupt-closing-of-empty-comment
  — and `--!>` in the comment-end-bang state) are named, and so is the independent computation of fence spans and comment spans
  that pairs delimiters no renderer pairs. Five bytes is the whole attack.
- Why the "both delimiters present" bound is not the property that makes suppression safe.
- T53's standing ruling as the live one: keep the class, keep the empty-allowlist default, the allowlist is the remedy for a benign
  CDN base — a false positive costs a masked URL in a rendered document, a false negative costs a silent request to an attacker's host.
- **The condition under which it could be revisited**: an implementation that decides the span with the same conformant tokenizer
  the reviewers used as an oracle (lol-html via `HTMLRewriter`) plus a real CommonMark pass, failing toward flagging on every
  ambiguity rather than only on an unterminated delimiter, with hostile payloads inside every span kind it recognizes in its
  acceptance evidence. The two measurements it would have to turn green are named: `T62-exfil.ts` (0 of 13) and `T62-boundary.ts` (0 leaking).

## Tests

Per the constraint, no test the reverted task added was deleted.

- The three tests that asserted the suppression itself (`a base element inside a closed HTML comment / backtick fence / tilde fence
  is not a finding`) were **inverted into regressions that the suppression is gone**: the same three payloads must now be
  `egress.html-base-href-exfil` findings and must be masked. Stated here because the constraint asks for it explicitly.
- Kept unchanged and still passing: the unterminated-comment/fence test, the `<img>`-inside-a-comment/fence test, the
  base-outside-a-fence test, the remediation-disclosure test, and the T53#F-002 / T53#F-003 pins.
- Added: one regression covering **all six** reviewer shapes — `x01.abruptEmptyComment`, `x02.abruptDashComment`,
  `x03.commentEndBang`, `x05.commentDelimitersQuotedInFences`, `x06.commentDelimitersInCodeSpans`,
  `x07.fenceMarkersQuotedInsideAComment` — each asserting a base-href finding and no attacker host after redaction. Not only the
  four that leaked at the boundaries.
- The section comment above them was rewritten to say what stands (the disclosure half) and what was reverted and why.

RED before the code change: `bun test src/security/detect/exfil.test.ts` → **42 pass, 4 fail** (the three inverted tests and the
six-shape regression), raw `.metaproject/data/gdctx/raw/T67-red-probe.log`.
GREEN after: **46 pass, 0 fail, 567 expect()**, raw `.metaproject/data/gdctx/raw/T67-green-detector-suite.log`.

## Verification — exact counts and raw log paths

All raw logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

### The finding itself

| Probe | Before (`T67-before-…log`) | After (`T67-after-…log`) |
|---|---|---|
| `T62-exfil.ts` (13 cases, lol-html + CommonMark oracles) | **6 bypasses** (`x01,x02,x03,x05,x06,x07`) | **0 bypasses**; all 13 cases `baseFindings: 1`, `attackerHostStillInRedactedOutput: false` |
| `T62-boundary.ts` (4 public boundaries) | **4 leaking**, all four states `none`, `reasons []` | **0 leaking**; every hostile shape `redacted` at MCP/persist/transport with `["egress.html-base-href-exfil"]`, `leaksHost` false at all four |

All six shapes are findings again, verified at the detector (`T62-exfil.ts`) and at all four public boundaries — the four the
reviewer drove through `T62-boundary.ts` plus `x05`/`x06`, whose base-href findings the detector run and the committed regression pin.

### Every prior measurement

Compared as whole log files, before vs after.

| Probe | Before | After | Raw logs |
|---|---|---|---|
| `T53-extract.ts` (88 cases) | 0 bypasses, 14 over-approximations | **byte-identical log** | `T67-before-T53-extract.log` / `T67-after-T53-extract.log` |
| `T53-resolve.ts` (41 × 15 = 615) | 0 bypasses, 0 FP | **byte-identical** | `…-T53-resolve.log` |
| `T42-exfil-attack.ts` (42 cases) | 0 bypasses, 0 FP | **byte-identical** | `…-T42-exfil-attack.log` |
| `T24-recheck2-exfil.ts` (48 cases) | 0/0 | **identical** (log differs only in the output filename it prints; the written JSON matrices are byte-identical) | `…-T24-recheck2-exfil.log` |
| `T42-charrefs.ts` (48 names × 5 shapes = 240) | 0 bypasses, `absentButUrlSyntax: []` | **byte-identical** | `…-T42-charrefs.log` |
| `T46-surfaces.ts` (surface matrix) | `flaggedNonFetching: ["X04.templateImg"]`, `benignControlsFlagged: []` | **byte-identical** | `…-T46-surfaces.log` |
| `T24-recheck2-boundary.ts` (12 canonicalization + 28 MCP persistence rows) | every state and reason token | **identical** (same filename-only log diff; JSON byte-identical) | `…-T24-recheck2-boundary.log` |
| `T42-boundary.ts` ROW 1 | six formerly-leaking shapes closed, `ctlPublicLink` `state=none` | **byte-identical** | `…-T42-boundary.log` |
| `T52-base.ts` (14 cases) | `reachableAfterRedaction: []` | **byte-identical** | `…-T52-base.log` |
| `T53-boundary.ts` (26 shapes × 4 boundaries) | `hostileLeakingAtAnyBoundary: 0`, `benignNotByteIdenticalIds: ["ctlCdnBaseDoc"]` | **byte-identical** | `…-T53-boundary.log` |
| `T53-base.ts` (23 cases) | `hostileNotNeutralized: 0`, `benignFlaggedIds: [g05,g06]` | `hostileNotNeutralized: **0**`, `benignFlaggedIds: **[g05,g06,g07,g08]**` — T53's original recorded set | `…-T53-base.log` |

The only two probes that moved are the two that measure the reverted behaviour, and both moved back to their pre-suppression values.

### The benign corpus count

`T53-corpus.ts` part B: **7 of 30** synthetic benign shapes flagged, with `codeFenceBaseExample` back in `flaggedIds` — the number
before the suppression (it was 6 under it). The other six are unchanged and all belong to classes that predate the `<base>` class:
`readmeBadge`, `readmeBadgeAllowlisted`, `codeFenceRemoteImgExample`, `htmlCommentImg`, `scriptStringImg`, `markdownRefDefRemote`.
Raw `T67-before-T53-corpus.log` / `T67-after-T53-corpus.log`.

Part A (whole-checkout sweep) grew for a reason that is not the revert and is stated rather than glossed: the sweep includes the
session's own new files. 22,350 → 22,381 files, 0 unreadable, `egress.html-base-href-exfil` 66 → 94. Per-file attribution of all 17
files now carrying a base-href finding: 16 are vector-carrying (the detector's own tests, the T42/T52/T53/T62 probes, T52/T53/T62
review and implementation reports, and gdctx raw logs of those runs). The seventeenth is
`.metaproject/data/gdctx/artifacts/2026-09-06T17-45-01-455Z_run.md`, a gdctx summary of a `bun test` run whose captured output is
this file's own new test source — vector-carrying in substance, classified `benign` only because the probe's allowlist enumerates
paths rather than content. **No genuinely benign repository file carries a base-href finding.**

### AC5 (AFC-15)

Re-checked directly after the revert, raw `T67-after-ac5.log`:
`{"label":"SUMMARY","spellingBypasses":0,"urlSecretMasked":true,"publicLinkState":"none"}` — six spellings (decoy field name,
named and numeric character references, uppercase tag/attribute, backslash authority, and the abrupt-comment base) all caught with
the host gone; `?api_key=…` masked whole as `egress.markdown-link-sensitive-value`; a public Markdown link is 0 findings at the
detector and `redaction.state:"none"` at `validateOutputForTransport`. The same three clauses are pinned by the committed suite
(`AC2.1/AC2.4`, `AC2.2`, `AC2.3`, the charrefs matrix and the transport tests) which passes below.

### Required suites, typecheck, lint

- `bun src/cli.ts ctx run -- bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts
  src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts` → **97 pass, 0 fail, 865 expect()**, exit 0,
  raw `.metaproject/data/gdctx/raw/2026-09-06T17-47-27-409Z_run.log`. (Was 87 pass before this task; +10 is the six-shape
  regression plus the three inverted ones counted with their new assertions.)
- `bun run typecheck` → exit 0, `T67-typecheck.log`.
- `bunx eslint src/security/detect/exfil.ts src/security/detect/exfil.test.ts` → exit 0, no output, `T67-eslint.log`.

## Concerns

- The two benign controls in `T62-boundary.ts` (`ctlCdnBaseInComment`, `ctlCdnBaseInFence`) are masked again, and
  `T53-base.ts`'s `g07`/`g08` are findings again. That is the reverted false positive returning, and it is the accepted cost:
  the allowlist is the remedy, and it is recorded as such in the module.
- No git state was changed and nothing outside the two owned files was touched.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch named the exact file set, and the graph answers from the last
  `keryx gdgraph build` while this checkout carries a large uncommitted multi-worker change set, so a graph answer could not be
  quoted as current.
- `wiki_used: no (not-relevant)` — the governing texts (`T62-review.md` F-001 and its judgement call, `T63-implementation.md`,
  `T53-review.md`#F-001, `policies.md`, the flow's `acceptance-criteria.md`) were read directly, as the dispatch required.
- `ctx_used: partial, disclosed` — every text search went through `bun src/cli.ts ctx rg`, and the required focused-suite run went
  through `bun src/cli.ts ctx run`. Probe execution ran `bun` directly, because `ctx run`'s compaction drops the per-case rows that
  are the evidence; I observed that again in this session (`ctx rg` over the detector reported `Matches: 17` and displayed 4).
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find`/`sed` over project code; one `cat` attempt was refused by the routing hook
  and replaced with a bounded read.
</content>
