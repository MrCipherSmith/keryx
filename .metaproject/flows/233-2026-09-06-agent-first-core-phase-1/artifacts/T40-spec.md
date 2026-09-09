# T40 — spec: resolve auto-fetch destinations with a real URL parser

Written before any code change. Baseline measured first (see "Baseline", below).

## Problem statement (from T24R2#F-001)

`src/security/detect/exfil.ts` decides "does this destination carry a remote host"
by **pattern-matching the authority**: `exfilHost` accepts exactly two spellings,
`^https?://` and `^//`, and captures `([^/?#]+)`. Two rounds of fixes each closed
the spellings they were shown and fell to the next one, because the grammar the
WHATWG URL parser accepts is much larger than those two literals.

A second, independent defect: three of the five bypass classes never reach the
classifier at all. `INLINE`, `REFERENCE_DEF` and the `srcset` candidate split
truncate the destination at the first whitespace, so the whitespace-stripping
added to `considerUrl` in the previous round is unreachable for them. Improving
the classifier alone cannot close those.

## Baseline (measured, before any edit)

| Probe | Result | Raw log |
|---|---|---|
| `T24-recheck2-exfil.ts` (48-case matrix, WHATWG oracle) | `cases=48 bypasses=17 falsePositives=0` | `.metaproject/data/gdctx/raw/2026-09-06T14-35-04-889Z_run.log` |
| `T24-recheck2-boundary.ts` | 8 MCP cases `isError=false state=none leakHost=true`; `persistence.{backslashImage,namedTabImage,imageTag}` `allowed=true bytesIdentical=true leakHost=true`; same 3 at the seam `identical=true leakHost=true` | `.metaproject/data/gdctx/raw/2026-09-06T14-38-15-652Z_run.log` |
| focused suites | `239 pass, 3 skip, 0 fail, 906 expect()` | `.metaproject/data/gdctx/raw/2026-09-06T14-38-30-264Z_run.log` |

## Approach

### 1. Classification: resolve, do not recognise

Replace the authority recogniser with the platform `URL` parser (no hand-rolled
parser). The renderer resolves a destination against the *document's* base URL;
the detector has no document, so it resolves against a **synthetic base**.

A single synthetic base has a flaw: its host is a string an attacker can spell,
which would turn "same as base ⇒ ignore" into a bypass. So the destination is
resolved against **two** synthetic bases that differ only in host:

```
https://keryx-detector-base-a.invalid/keryx/page
https://keryx-detector-base-b.invalid/keryx/page
```

- Both resolutions yield the **same** host ⇒ the destination carries its own
  authority. That host is the renderer's destination, whatever spelling was used.
- The resolutions **differ** ⇒ the destination inherited the base authority, i.e.
  it is relative. A renderer would fetch it from its own origin: no cross-origin
  channel, no finding.
- The resolution **fails**, or the resolved scheme is not `http:`/`https:`, or the
  hostname is empty ⇒ no host, no finding (`data:`, `mailto:`, `javascript:`,
  fragment-only, query-only).

**What the synthetic base implies** — stated explicitly, as the dispatch requires:

- *Relative destinations* (`/assets/logo.png`, `./a.png`, `../a.png`, `a.png`,
  `#frag`, `?q=1`, and a relative path that happens to contain a backslash such as
  `/assets/a\b/logo.png`) resolve to whichever base they were given. The two
  resolutions differ, so they are classified relative and are never findings. This
  is renderer-faithful: the fetch goes to the client's own origin.
- *Scheme-relative destinations* (`//host`, and every backslash and extra-slash
  spelling of the same thing) resolve to the SAME host under both bases, so the
  host is recovered. They inherit the base's **scheme** only, which is why the
  bases are `https` — the same choice a renderer makes on an https page. A `http`
  vs `https` difference does not change the host, and the host is the whole
  question here.
- *A destination that literally names a synthetic base host* is not excused: both
  resolutions agree on that host, so it is flagged as external like any other.
  This is exactly the property a single-base design would not have.
- *A relative path can never be mistaken for a remote host and vice versa*,
  because the discriminator is the disagreement between two independent bases, not
  a syntax test on the source string.

Masking is unchanged: `considerUrl` builds the canonical form for classification
only and keeps `start`/`end` on the raw span, so `applyRedaction` masks the bytes
as written.

### 2. Decoding: two missing HTML5 named references

`NAMED_CHARACTER_REFERENCES` gains `Tab` (U+0009) and `NewLine` (U+000A) — the two
HTML5 named references whose decoded character the URL parser then *removes*, so
`ht&Tab;tps://host` is byte-for-byte the same request as `https://host`. Lookup
already lowercases the name, so the entries are keyed `tab` / `newline`.

### 3. Extraction: stop truncating angle-bracket destinations

CommonMark's `<...>` destination may contain spaces and tabs; it ends at the
first unescaped `>` or newline. `INLINE` and `REFERENCE_DEF` currently apply
`[^)\s>]+` / `[^\s>]+` to it, which truncates at the first whitespace. Both gain
an explicit angle-bracket alternative that captures the whole destination
(`<([^<>\n]*)>`), tried before the bare-destination alternative.

The `srcset` candidate split is **not** changed: the HTML srcset grammar itself
terminates a URL at whitespace, so `candidate.trim().split(/\s+/)[0]` is
renderer-faithful there. The srcset bypass is a classification defect (backslash
authority), not an extraction defect.

### 4. The `image` tag alias

The HTML parser's "in body" insertion mode rewrites an `image` start tag to `img`
and reprocesses it, so `<image src=…>` fetches identically. `HTML_IMG` and
`HTML_IMG_SRCSET` change `<img\b` to `<im(?:g|age)\b`.

## Auto-fetch surface enumeration

**Method** (three independent passes, so the answer does not rest on one):

1. Complete read of `src/security/detect/exfil.ts` — every extraction constant and
   every call to `considerUrl`.
2. `bun src/cli.ts ctx rg "img\b|srcset|iframe|<image|poster|<embed|<object" src --glob '!*.test.ts'`
   — confirms `exfil.ts` is the ONLY module in `src/` carrying an HTML auto-fetch
   matcher (the other hits are `WeakMap`/`WeakSet` noise). Raw:
   `.metaproject/data/gdctx/raw/2026-09-06T14-38-39-617Z_rg.log`.
3. `bun src/cli.ts ctx rg "detectExfil|redactSensitiveText" src` — every consumer
   of the detector, so "which seams inherit this fix" is enumerated rather than
   assumed: `src/security/output-validation.ts:149` (the structural walk reached by
   the MCP transport, the persistence materializer and the MCP compatibility seam),
   `src/security/detect/index.ts:49` (`runDetectors`), `src/security/redact.ts:132`
   (`redactSensitiveText`, used by `src/session/slate.ts`,
   `src/harness/tool/builtin/web-search-tool.ts`,
   `src/harness/tool/builtin/slate-tool.ts`, `src/session/store.ts`,
   `src/session/slate-terminal-state.ts`, `src/mcp/tools.ts`).

**Extraction patterns in `exfil.ts` (complete list, all five are surfaces):**

| # | Constant | Surface | Truncation defect | Action |
|---|---|---|---|---|
| 1 | `INLINE` | `![alt](URL)`, `[text](URL)` | yes — `[^)\s>]+` over a `<…>` destination | angle-bracket alternative added |
| 2 | `REFERENCE_USE` | `![alt][ref]` | n/a (resolves through `REFERENCE_DEF`) | none |
| 3 | `REFERENCE_DEF` | `[ref]: URL` | yes — `[^\s>]+` over a `<…>` destination | angle-bracket alternative added |
| 4 | `HTML_IMG` | `<img src>` | no | `<image>` alias added |
| 5 | `HTML_IMG_SRCSET` + candidate split | `<img srcset>` | no (srcset terminates a URL at whitespace by spec) | `<image>` alias added |

**HTML auto-fetch surfaces that have NO matcher here at all** (enumerated from the
HTML standard's fetching elements, cross-checked with pass 2 above, which found
zero matchers for any of them). None is in scope for T40 — the dispatch names five
bypass classes and the `image` alias, and adding these changes detector behaviour
for benign documents (an embedded video iframe in a documentation page would
become an egress finding under an empty allowlist), which is a policy scoping
decision, not a bug fix:

`<input type="image" src>`, `<source src|srcset>` inside `<picture>`/`<video>`/
`<audio>`, `<video src|poster>`, `<audio src>`, `<iframe src>`, `<embed src>`,
`<object data>`, `<track src>`, `<link rel=stylesheet|preload|prefetch href>`,
`<script src>`, `<body|td background>`, SVG `<image href|xlink:href>` and
`<use href>`, and CSS `url(...)` in a `style` attribute or `<style>` block.

This is carried into the report as a named residual gap and a recommended
follow-up, not as a silent omission.

## Regressions (RED before GREEN), in `src/security/detect/exfil.test.ts`

One test per bypass class, plus benign controls:

1. `backslash authority spellings` — `\\host`, `https:\\host`, `https:/\host`,
   `/\host`, `&#92;&#92;host`, `srcset` with `\\host`.
2. `extra slash runs after the scheme` — `https:///host`, `https:////host`,
   `///host`.
3. `HTML5 named references for tab and newline` — `ht&Tab;tps://host`,
   `ht&NewLine;tps://host`, `https&Tab;://host`, `&Tab;https://host`.
4. `image tag alias` — `<image src="https://host/p">`, `<image src="https&#58;//host/p">`,
   and the `<image srcset>` form.
5. `angle-bracket destinations are not truncated before classification` —
   `![x](<ht<TAB>tps://host/p>)`, `![x](< https://host/p>)`, and the
   reference-definition form `[r]: <ht<TAB>tps://host/p>`.

Benign controls (the reviewer's four are the floor; these are added):

- an ordinary public Markdown link whose path contains a backslash;
- a relative image whose path contains a backslash (`/assets/a\b/logo.png`) — a
  relative path must never be read as an authority;
- a legitimate multi-candidate `srcset` (three relative candidates), and a
  multi-candidate `srcset` entirely on an allowlisted host;
- a relative angle-bracket destination `![logo](</assets/logo.png>)`;
- `<image src="/assets/logo.png">` — the new alias must not flag a relative
  destination;
- an anchor-only and a query-only destination.

Boundary verification (MCP dispatch + persistence materializer), which
`exfil.test.ts` alone cannot claim:

- two tests in `exfil.test.ts` driving `prepareOutputForPersistence`
  (`src/security/guard.ts`) and `validateOutputForTransport`
  (`src/security/output-validation.ts` — the exact function
  `src/mcp/redact-seam.ts` calls) over one vector from each class;
- plus a re-run of the reviewer's own `T24-recheck2-boundary.ts`, unmodified,
  which drives the real `dispatchCallTool` with `redactToolOutput:false`.

## Ownership

Only `src/security/detect/exfil.ts` and `src/security/detect/exfil.test.ts` are
edited. `output-validation.ts`, `service.ts`, `guard.ts` and `config.ts` are read
and driven, never modified (two other workers own them). No probe or review
artifact is modified.
