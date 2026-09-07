STATUS: DONE_WITH_CONCERNS

# T40 — resolve auto-fetch destinations with a real parser instead of matching the authority

Closes T24R2#F-001. Third approach, not a third patch: host recognition is
replaced by host **resolution** through the platform URL parser, and extraction is
fixed alongside classification so no destination is truncated before it is
classified.

Files changed: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`
— nothing else. `output-validation.ts`, `service.ts`, `guard.ts`, `config.ts`,
`src/mcp/*` and every review artifact were read and driven, never modified.

## What changed, and why the previous shape could not work

`exfilHost` used to answer "does this destination carry a remote host" with two
literal patterns, `^https?://` and `^//`. That is a *recognizer* for two spellings
out of the many the WHATWG URL parser accepts, which is why round one (digit-count
bound on character references) and round two (decoding plus whitespace stripping)
each closed the spellings they were shown and fell to the next.

`exfilHost` now **resolves**. The renderer resolves a destination against its
document's base URL; this detector has no document, so it resolves against a
synthetic base — and against **two** of them, differing only in host:

```
https://keryx-detector-base-a.invalid/keryx/page
https://keryx-detector-base-b.invalid/keryx/page
```

- both resolutions agree on the host ⇒ the destination carries its **own**
  authority; that host is the destination;
- the resolutions disagree ⇒ the destination inherited the base's authority, i.e.
  it is **relative**; a renderer fetches it same-origin, so there is no channel;
- resolution fails, the resolved scheme is not `http:`/`https:`, or the hostname is
  empty ⇒ no host, no finding.

The second base is the discriminator, not redundancy. With one base the rule has
to be "ignore the result when it equals my own host", and an attacker can simply
spell that host. With two, a destination that names one of them makes both
resolutions **agree**, so it is flagged like any other external host.

### What a synthetic base implies (stated, as the dispatch requires)

- **Relative destinations** — `/assets/logo.png`, `./a.png`, `../a.png`, `a.png`,
  `#frag`, `?q=1`, and a relative path containing a backslash such as
  `/assets/a\b/logo.png` — resolve to whichever base they were given, so the two
  resolutions differ and they are never findings. Renderer-faithful: the fetch
  goes to the client's own origin.
- **Scheme-relative destinations** — `//host` and every backslash / extra-slash
  spelling of it — resolve to the same host under both bases, so the host is
  recovered. They inherit the base's **scheme** only, which is why both bases are
  `https`: the same choice a renderer makes on an https page. Scheme does not
  change the host, and the host is the whole question.
- **A relative path can never be mistaken for a remote host, and a remote host can
  never be mistaken for a relative path**, because the discriminator is the
  disagreement between two independent bases rather than a syntax rule applied to
  the source string. Measured both ways: `b.relativeBackslashPath`,
  `b.relativeDotSegments`, `b.windowsPathImage`, `b.anchorOnly`, `b.queryOnly`
  stay at 0 matches, while `new.backslashProtocolRelative`,
  `new.threeSlashRelative` and `new.slashBackslashRelative` are flagged.
- **Non-network schemes** (`data:`, `mailto:`, `javascript:`, `blob:`) resolve to a
  protocol that is not http(s) and yield no host, so they are not findings.

Masking is untouched: `considerUrl` builds the canonical form for classification
only and keeps `start`/`end` on the raw span, so `applyRedaction` masks the bytes
as written. Every regression asserts the host is absent from the redacted output,
which is the property that would break first if offsets had moved.

## Per bypass class

### Class 1 — backslash authority spellings (6 of the 17)

`new.backslashProtocolRelative`, `new.backslashSchemeBoth`,
`new.backslashSchemeMixed`, `new.slashBackslashRelative`, `new.backslashEntity`,
`new.srcsetBackslash`.

The parser's *relative slash* and *special authority ignore slashes* states treat
`\` exactly as `/` for a special scheme, so `\\host`, `https:\\host`,
`https:/\host` and `/\host` are all protocol-relative. Resolution closes all six
without naming any of them.

**Additionally found and closed here, outside the reviewer's matrix:** `&bsol;` is
the HTML5 named reference for the reverse solidus and was **not** in
`NAMED_CHARACTER_REFERENCES`. Once backslashes became authority-significant,
`<img src="&bsol;&bsol;attacker.invalid/p">` was a live bypass of this same class —
my own sweep reported `x.namedBsol bypass=true` before the table gained `bsol`
(raw `…/2026-09-06T14-47-15-863Z_run.log`), and `bypasses=0` after
(`…/2026-09-06T14-47-43-610Z_run.log`). The table now carries a stated membership
rule instead of a list, so the next character does not need a new review: a named
reference belongs there when the URL parser treats its character as URL syntax or
removes it; over the ASCII punctuation HTML5 names, that is exactly the current
set, and `comma`, `Hat`, `lcub`, `rcub`, `verbar` are excluded because their
characters delimit nothing in a URL.

Regression: `backslash spellings of the authority are resolved, not
pattern-matched` (8 vectors, incl. `&#92;`, `&#x5c;` and `&bsol;`).

### Class 2 — extra slash runs after the scheme (3 of the 17)

`new.tripleSlash`, `new.fourSlash`, `new.threeSlashRelative`. The parser skips an
unbounded run of `/` and `\` after the scheme; the old `([^/?#]+)` capture required
the byte after `//` to be a non-slash. Resolution has no such requirement. My own
sweep adds `x.sixSlash` and `x.backslashFiveSlashes` (mixed run) — both closed.

Regression: `extra slash runs after the scheme do not hide the host`.

### Class 3 — the HTML5 named references for tab and newline (4 of the 17)

`new.namedTabInScheme`, `new.namedNewlineInScheme`, `new.namedTabAfterScheme`,
`new.leadingNamedTab`. `&Tab;` and `&NewLine;` decode to U+0009 / U+000A, which the
URL parser then **removes** — exactly like the `&#9;` form the previous round
closed. `tab` and `newline` added to `NAMED_CHARACTER_REFERENCES` (the lookup
already lowercases, so `&Tab;`/`&TAB;` both resolve).

Regression: `the HTML5 named references for tab and newline are decoded like a
renderer decodes them`.

### Class 4 — the `image` tag alias (2 of the 17)

`new.imageTag`, `new.imageTagEntity`. The HTML parser's "in body" insertion mode
changes an `image` start tag's name to `img` and reprocesses the token, so
`<image src>` fetches identically. `HTML_IMG` and `HTML_IMG_SRCSET` changed from
`<img\b` to `<im(?:g|age)\b` — one element with two spellings, not two matchers.

Regression: `the image start tag is the img alias the HTML parser makes it`
(incl. `<image srcset>` and the uppercase `<IMAGE SRC>` form).

### Class 5 — truncated angle-bracket destinations (2 of the 17)

`new.markdownAngleTab`, `new.markdownAngleLeadingSpace`. **These never reached the
classifier**, so improving the classifier could not have closed them: a CommonMark
pointy-bracket destination may contain spaces and tabs, and `INLINE`'s `[^)\s>]+`
and `REFERENCE_DEF`'s `[^\s>]+` truncated it at the first whitespace before
`considerUrl` ever ran. Both patterns gained an explicit angle-bracket
alternative, tried first, that captures the destination whole:

```
INLINE        /(!?)\[[^\]]*\]\(\s*(?:<([^<>\n]*)>|([^)\s>]+))[^)]*\)/g
REFERENCE_DEF /^[ \t]*\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|([^\s>]+))/gm
```

The bare form keeps its original shape, so a destination without pointy brackets is
extracted exactly as before.

The `srcset` candidate split (`candidate.trim().split(/\s+/)[0]`) is deliberately
**not** changed: the HTML srcset grammar itself terminates a URL at whitespace, so
that truncation is renderer-faithful. Measured, not assumed —
`b.srcsetLiteralTab` (`<img srcset="ht<TAB>tps://attacker.invalid/p 1x">`) is 0
matches here, and a real renderer takes `ht` as the candidate URL and rejects
`tps://…` as a descriptor, so it does not fetch either. The srcset bypass in class
1 was a classification defect, not an extraction defect.

Regression: `angle-bracket destinations reach the classifier without being
truncated` (inline and reference-definition forms, tab and leading-space).

## Auto-fetch surface enumeration, and how it was enumerated

**Method — three independent passes, so the answer does not rest on one:**

1. **Complete read** of `src/security/detect/exfil.ts`: every extraction constant
   and every `considerUrl` call site.
2. **`bun src/cli.ts ctx rg "img\b|srcset|iframe|<image|poster|<embed|<object" src --glob '!*.test.ts'`**
   — establishes that `exfil.ts` is the ONLY module in `src/` carrying an HTML
   auto-fetch matcher (all other hits are `WeakMap`/`WeakSet` noise), so the
   surface list is complete for the repository and not just for this file.
   Raw: `.metaproject/data/gdctx/raw/2026-09-06T14-38-39-617Z_rg.log`.
3. **`bun src/cli.ts ctx rg "detectExfil|redactSensitiveText" src`** — enumerates
   every consumer, so "which seams inherit this fix" is measured rather than
   assumed: `src/security/output-validation.ts:149` (the structural walk reached by
   the MCP transport, the persistence materializer and the MCP compatibility
   seam), `src/security/detect/index.ts:49` (`runDetectors`),
   `src/security/redact.ts:132` (`redactSensitiveText`, reached from
   `src/session/slate.ts`, `src/session/store.ts`,
   `src/session/slate-terminal-state.ts`,
   `src/harness/tool/builtin/web-search-tool.ts`,
   `src/harness/tool/builtin/slate-tool.ts`, `src/mcp/tools.ts`).

**Every extraction pattern in `exfil.ts` (complete):**

| # | Constant | Surface | Truncated a destination? | Action taken |
|---|---|---|---|---|
| 1 | `INLINE` | `![alt](URL)`, `[text](URL)` | yes, over a `<…>` destination | angle-bracket alternative added |
| 2 | `REFERENCE_USE` | `![alt][ref]` | n/a — resolves through `REFERENCE_DEF` | none needed |
| 3 | `REFERENCE_DEF` | `[ref]: URL` | yes, over a `<…>` destination | angle-bracket alternative added |
| 4 | `HTML_IMG` | `<img src>` | no | `<image>` alias added |
| 5 | `HTML_IMG_SRCSET` + candidate split | `<img srcset>` | no — srcset terminates a URL at whitespace by spec | `<image>` alias added |

**HTML auto-fetch surfaces with NO matcher here at all** (from the HTML standard's
fetching elements, cross-checked against pass 2, which found zero matchers for any
of them):

`<input type="image" src>`, `<source src|srcset>` in `<picture>`/`<video>`/
`<audio>`, `<video src|poster>`, `<audio src>`, `<iframe src>`, `<embed src>`,
`<object data>`, `<track src>`, `<link rel=stylesheet|preload|prefetch href>`,
`<script src>`, `<body|td background>`, SVG `<image href|xlink:href>` and
`<use href>`, and CSS `url(...)` in a `style` attribute or `<style>` block.

**None of these is closed by T40** — see Concerns. The dispatch names five bypass
classes and the `image` alias, and adding the list above changes detector
behaviour for benign documents (a documentation page carrying an embedded video
iframe would become an egress finding under an empty allowlist), which is a policy
scoping decision rather than a bug fix, in a file two other workers are adjacent
to. It is recorded here as a named residual gap, not omitted.

## Verification — exact counts and raw logs

All commands ran through `bun src/cli.ts ctx run`. No network, no model call, no
git state change, no `bun test` without file arguments, no dependency change.
Synthetic hosts only (`attacker.invalid`, `*.invalid`, `example.org`); nothing was
contacted.

### 1. The reviewer's 48-case matrix (`T24-recheck2-exfil.ts`, unmodified)

| | Before | After | Raw log |
|---|---|---|---|
| cases | 48 | 48 | before `.metaproject/data/gdctx/raw/2026-09-06T14-35-04-889Z_run.log` |
| bypasses | **17** | **0** | after `.metaproject/data/gdctx/raw/2026-09-06T14-47-51-215Z_run.log` |
| false positives | 0 | **0** | |

Per-case adjudication of the same two JSON outputs
(raw `.metaproject/data/gdctx/raw/2026-09-06T14-42-53-298Z_run.log`):

- **20 / 20 previously fixed vectors still closed** — every `fix.*` case
  `flagged=true`, `hostStillPresentAfterRedaction=false`.
- **4 / 4 benign controls unflagged** — `ctl.publicMarkdownLink`, `ctl.bareUrl`,
  `ctl.relativeImage`, `ctl.dataUriImage` all `flagged=false`, before and after.
  The fifth `ctl.` row (`ctl.allowlistedHost`) is marked `control:false` by the
  reviewer and is expected flagged; it is, before and after.
- **17 / 17 bypasses closed** — every one goes `bypassBefore=true` →
  `bypassAfter=false` with `hostPresent=false`.

### 2. Required focused suites

`bun src/cli.ts ctx run -- bun test src/security/detect/exfil.test.ts src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts src/mcp`

| | Before | After |
|---|---|---|
| pass | 239 | **252** |
| skip | 3 | 3 |
| fail | **0** | **0** |
| expect() | 906 | 1085 |

Raw: before `.metaproject/data/gdctx/raw/2026-09-06T14-38-30-264Z_run.log`,
after `.metaproject/data/gdctx/raw/2026-09-06T14-47-51-077Z_run.log`.

The +13 is +8 from this task and +5 from the concurrent worker who edited
`src/security/output-validation.{ts,test.ts}` at 18:41–18:42 local, between the
two runs (file mtimes). Not this task's change; noted so the delta is not read as
mine.

Wider sweep, same shape: `bun test src/security src/session` → **309 pass, 0 fail,
1271 expect()** (raw `.metaproject/data/gdctx/raw/2026-09-06T14-48-11-585Z_run.log`).

### 3. New regressions — one per bypass class, failing before, passing after

`bun test src/security/detect/exfil.test.ts`:

| | Before the fix | After |
|---|---|---|
| tests | 20 | 20 |
| pass | 13 | **20** |
| fail | **7** | **0** |

RED raw: `.metaproject/data/gdctx/raw/2026-09-06T14-41-07-763Z_run.log` — the exact
seven that failed:

```
(fail) backslash spellings of the authority are resolved, not pattern-matched
(fail) extra slash runs after the scheme do not hide the host
(fail) the HTML5 named references for tab and newline are decoded like a renderer decodes them
(fail) the image start tag is the img alias the HTML parser makes it
(fail) angle-bracket destinations reach the classifier without being truncated
(fail) the persistence materializer never writes an auto-fetch host for any class
(fail) the transport validator reports every class as redacted with the host gone
```

Five class regressions plus both boundary regressions. The eighth new test
(`resolution against a synthetic base leaves benign destinations unflagged`)
passed before and after **by design** — it is a control, not a pin, and it is
reported as such rather than counted among the closures (the bookkeeping mistake
T24R2#F-004 recorded).

GREEN raw: `.metaproject/data/gdctx/raw/2026-09-06T14-47-51-077Z_run.log`.

### 4. Verified at the MCP dispatch and the persistence materializer

The reviewer's own `T24-recheck2-boundary.ts`, unmodified, with
`mergeMcpConfig({ redactToolOutput: false })` — advisory redaction OFF, so this is
the mandatory floor.

Before `.metaproject/data/gdctx/raw/2026-09-06T14-38-15-652Z_run.log`,
after `.metaproject/data/gdctx/raw/2026-09-06T14-47-57-889Z_run.log`.

| Seam | Before | After |
|---|---|---|
| `dispatchCallTool` (MCP) | 8 cases `isError=false, state=none, reasons=[], leakHost=true` | all 8 `isError=false, state=redacted, reasons=egress.html-image-exfil` (`p.markdown-angle-tab`: `egress.markdown-image-exfil`), `leakHost=false` |
| `prepareOutputForPersistence` | `backslashImage`, `namedTabImage`, `imageTag`: `allowed=true, bytesIdenticalToInput=true, leakHost=true` | all three `allowed=true, bytesIdentical=false, leakHost=false` |
| `redactToolOutput` (seam) | same three `identical=true, leakHost=true` | all three `identical=false, leakHost=false` |

The eight MCP cases: `p.backslash-protocol-relative`, `p.backslash-scheme`,
`p.triple-slash`, `p.named-tab-image`, `p.named-newline-image`, `p.image-tag`,
`p.srcset-backslash`, `p.markdown-angle-tab`.

Controls at the boundary held exactly: `p.public-link` stays `state:"none"` with no
finding; `p.public-link-plus-email` stays `redacted`/`pii.email`;
`p.safe-scalars`, `p.numeric-key`, `p.ref-defs-sibling`, `p.ref-annotations` stay
`state:"none"`; `cleanPretty` and `cleanCompact` stay `bytesIdentical=true` /
`identical=true`; every row-1/2/3 refusal keeps its own token and the constant
text. Nothing in rows 1, 2, 3 or 5 moved.

Two of the eight new regressions in `exfil.test.ts` drive the same two functions
directly (`prepareOutputForPersistence` from `src/security/guard.ts`, and
`validateOutputForTransport` — the exact function `src/mcp/redact-seam.ts` calls),
one vector per class, so the boundary property is pinned by the committed suite and
not only by a probe.

### 5. My own adversarial + benign sweep (beyond the reviewer's 48)

12 adversarial cases and 14 benign controls, each adjudicated by the same WHATWG
`URL` oracle. Final: **adversarial=12 bypasses=0 benign=14 falsePositives=0**
(plus a legitimate allowlisted multi-candidate `srcset` at 0 matches).
Raw `.metaproject/data/gdctx/raw/2026-09-06T14-47-43-610Z_run.log`; the earlier run
that caught `&bsol;` is `.metaproject/data/gdctx/raw/2026-09-06T14-47-15-863Z_run.log`.

Adversarial: mixed slash/backslash runs, six slashes, `&#x5c;` and `&bsol;`
backslash references, uppercase scheme, trailing-dot host, explicit port,
backslash + userinfo, `<image srcset>` + backslash, angle destination with a title,
angle reference definition with a tab, `&NewLine;` between scheme and `//`.

Benign controls added on top of the reviewer's four (his are the floor):
an ordinary public Markdown link whose **path contains a backslash**; a relative
image whose path contains a backslash; a relative image with `../..` segments; a
**legitimate multi-candidate srcset** (three relative candidates) and a second one
entirely on an allowlisted host; a relative angle-bracket destination; `<image
src="/assets/logo.png">`; a Windows path in an image destination; anchor-only and
query-only destinations; a `data:` and a `blob:` URI; the `callbacks[0](payload)`
code-index shape; an empty angle destination `![x](<>)`; and a `srcset` whose first
candidate is truncated by a literal tab. All 0 matches.

### 6. Types and lint

- `bun run typecheck` (`tsc --noEmit`) — exit 0, no output.
  Raw `.metaproject/data/gdctx/raw/2026-09-06T14-48-09-368Z_run.log`.
- `bunx eslint src/security/detect/exfil.ts src/security/detect/exfil.test.ts` —
  exit 0, no output.
  Raw `.metaproject/data/gdctx/raw/2026-09-06T14-48-10-377Z_run.log`.

## Concerns for the orchestrator

1. **Residual auto-fetch surfaces.** The surfaces enumerated above with no matcher
   at all (`<iframe src>`, `<object data>`, `<embed src>`, `<input type=image src>`,
   `<source src|srcset>`, `<video poster>`, `<link href>`, `<script src>`, SVG
   `<image href>`, CSS `url()`, …) remain open. They are a *different* finding
   class from the five T40 closes and were never claimed closed, but they are the
   same shape of hole, and closing them is a policy decision about false positives
   on benign documents, not a bug fix. Recommend a scoped follow-up that decides
   the policy first (deny-by-default on every fetching element vs. media-only) and
   then implements one shared surface table.
2. **`&bsol;` was found by this task's own sweep, not by the matrix.** The named
   reference table is now governed by a stated membership rule rather than a list,
   and the rule is complete over ASCII punctuation HTML5 names — but a reviewer
   should check that reasoning rather than take it on trust. The full HTML5 named
   reference table (2231 entries) was deliberately not imported for weight.
3. **Concurrent drift is in the measurements.** `src/security/output-validation.ts`
   and its test changed under another worker between my before- and after-runs.
   The 48-case matrix, the boundary probe and my own sweep were all re-run after
   that change, so the after-figures are against the current tree; the +5 test
   delta in the focused suite is theirs, not mine.
4. **Do not review your own fix** — this report is evidence, not adjudication. The
   `<image>`→`img` rewrite and the CommonMark pointy-bracket grammar are taken from
   the respective standards; host resolution is measured with Bun's WHATWG `URL`,
   not with a live renderer.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the file set exactly,
  and the graph answers from the last `gdgraph build` while the tree carries a
  large uncommitted multi-worker change set, so a graph answer could not be quoted
  as current. The cross-file enumerations (auto-fetch matchers, detector consumers)
  came from `ctx rg` over the current tree.
- `wiki_used: no (not-relevant)` — the governing texts are the reviewer's report,
  `docs/requirements/keryx-agent-first-core/policies.md` and the flow's
  `acceptance-criteria.md`; all read directly.
- `ctx_used: yes` — every command, search, test run and probe went through
  `bun src/cli.ts ctx run` / `ctx rg`. Raw logs were read only with bounded
  `sed -n` carrying the `# keryx:raw` escape and a stated reason, because gdctx
  compaction drops the per-case statuses that are the acceptance evidence.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find` over project code.
