import type { DetectorMatch } from "../types";
import { hostAllowed } from "./egress";

// Modern markdown auto-render exfiltration (E2 — EchoLeak / CVE-2025-32711).
//
// A zero-click data-exfil vector: an attacker gets the agent to emit a markdown
// image (or reference link) whose URL encodes stolen context; the rendering
// client auto-fetches it, leaking to the attacker's host. This detector flags
// the URL span in:
//   - inline image      `![alt](URL)` and `![alt](<URL>)`, including a
//                        description carrying balanced brackets (`![a[b]c](URL)`)
//   - inline link        `[text](URL)` and `[text](<URL>)`
//   - reference image    all three CommonMark spellings — full `![alt][ref]`,
//                        collapsed `![alt][]` and shortcut `![alt]` — against
//                        `[ref]: URL` or `[ref]: <URL>`. A renderer fetches all
//                        three; covering only the full form released the most
//                        ordinary of them, the README `![logo]` (T66#F-002).
//                        The label is matched the way CommonMark matches one —
//                        after case folding AND after collapsing internal
//                        whitespace — on both sides, and there is no bound on
//                        its length: the only criterion is whether the document
//                        defines that label (T72#F-002, T72#F-005). When one
//                        label is defined more than once EVERY definition is
//                        flagged, because which one a renderer fetches is a
//                        precedence rule and this floor does not bet on one
//                        (T78#F-002)
//   - image inside a
//     LINK               `[![alt](URL)](href)` in every image spelling — the
//                        README badge idiom `[![build](badge)](ci)`. A link's
//                        TEXT may contain an image and the image renders with
//                        no click, so only the link's DESTINATION is skipped,
//                        never its description. An image's own description is
//                        alt text and IS skipped, because a construct written
//                        there is not fetched (T72#F-001)
//   - reference LINK     `[text][ref]` / `[text][]` / `[text]`: read, but
//                        released. A link is click-gated, so it is not a
//                        zero-click fetch and the `!` marker is what separates
//                        the two
//   - HTML image         `<img src="URL">` and every `<img srcset="URL 1x, …">`
//                        candidate, plus the `<image>` spelling of the same
//                        element and, because SVG spells the same element's
//                        destination differently, `<image href|xlink:href>` and
//                        `<feImage href|xlink:href>`
//   - other image fetches `<input type=image src>` (gated on the type, because
//                        `src` on any other input fetches NOTHING), `<video
//                        poster>`, and the obsolete-but-honoured `background`
//                        attribute on `<body>`/`<table>`/`<td>`/`<th>`/`<tr>`/
//                        `<tbody>`/`<thead>`/`<tfoot>`
//   - media              `<video src>`, `<audio src>`, `<source src|srcset>`,
//                        `<track src>`
//   - embedded documents `<iframe src>`, `<embed src>`, `<object data>`
//   - navigation         `<meta http-equiv=refresh content="0;url=URL">`, the one
//                        surface here that is not a subresource request: it takes
//                        the whole client to the destination
//   - HTML base          `<base href="URL">`, which fetches nothing itself and is
//                        here for exactly that reason: it re-points every RELATIVE
//                        URL in the document, so it falsifies the "relative ⇒ same
//                        origin ⇒ no channel" half of the rule below (T42#F-006).
//                        A false positive here is a WHOLE-DOCUMENT effect, not a
//                        one-image one (T53#F-001), which is disclosed in the
//                        finding's own remediation (`BASE_REMEDIATION`) and is
//                        why the allowlist — not context detection — is the
//                        intended remedy for a benign CDN base; see the branch
//                        comment at `tag === "base"` (T53#F-001, T62#F-001)
//
// WHAT THIS FLOOR DOES NOT COVER, so a reader does not have to infer it from the
// list above (T42#F-006, decided in T46). Four render-triggered surfaces are
// enumerated, measured to reach an MCP client unmasked, and deliberately LEFT
// OPEN; the allowlist is not the remedy for them, a decision above this file is:
//   - `<script src>` and SVG `<script href>`, and `<link href>` / `<link
//     imagesrcset>` in every `rel`. These are a document's own INFRASTRUCTURE:
//     every quoted HTML file carries them, so covering them under the empty
//     default allowlist would mask URLs inside source a tool was asked to show.
//     Prerequisite: a non-empty default allowlist posture.
//   - CSS destinations — `url()` in a `style=` attribute or a `<style>` block,
//     `@import` (including its bare-string form, which carries a URL with no
//     `url()` spelling), `@font-face src`, and `image-set()`. Same prerequisite,
//     plus a second extractor: none of these is an HTML attribute, so the walker
//     below cannot reach them.
//   - `<iframe srcdoc>`, a nested INLINE document that is every other surface
//     again one level down. Prerequisite: recursion whose offsets map back
//     through the nested document's character-reference decoding.
// Three more are enumerated and deliberately NEVER covered, because they are not
// zero-click fetches at all: `<frame src>` (a `<frame>` start tag is ignored in
// the "in body" insertion mode, and a markdown-render client never produces a
// frameset document), external SVG `<use href>` (same-origin restricted in every
// engine), and the click- or submit-gated `<a href>`, `<a ping>`, `<area href>`,
// `<form action>` and `<button|input formaction>`.
//
// HOW the covered list is matched, in both directions, so a reader can predict a
// finding without running it (T66#F-003):
//   - Element and attribute names are matched ASCII case-insensitively, because
//     HTML tag names are. Coverage is therefore WIDER than the element list
//     reads: capitalised component markup with the same names in a quoted `.tsx`
//     or MDX file — `<Video src>`, `<Iframe src>`, `<Embed src>` — is covered
//     too, and is masked. That is a real, measured false-positive class; the
//     allowlist is its remedy, as it is for `<img src>` in a README.
//   - The two gates that read an attribute VALUE rather than a name
//     (`<input type=image>`, `<meta http-equiv=refresh>`) compare the value
//     AFTER character-reference decoding, so they are spelling-independent the
//     way the destinations are (`type="&#105;mage"` is an image submit button).
//     So does the one place that reads an attribute value as a GRAMMAR rather
//     than as a name-like token — the `srcset` candidate list — because a
//     renderer decodes the value before it splits it, and an entity-encoded
//     comma is a candidate boundary there and not in the raw bytes (T72#F-004).
//   - Matching is otherwise blind to nesting and context, so the construct
//     quoted inside an HTML comment, a fenced code block or a `<template>` is a
//     finding too. There are exactly THREE departures from that, and two of them
//     make coverage NARROWER, not wider:
//       (1) markup written inside another element's quoted attribute value is
//           deliberately not a finding, because for any conformant parser it is
//           an attribute value and no renderer fetches it (T53#F-004, the
//           `HTML_START_TAG.lastIndex` decision);
//       (2) an UNTERMINATED quoted attribute value consumes to the end of the
//           fragment, so anything after it is unexamined — which is what a
//           conformant tokenizer does with it as well (T53#F-003);
//       (3) `<base href>` is not an exception to the blindness at all — it is
//           flagged wherever it appears — but it is the one row where the cost
//           of that blindness is a WHOLE-DOCUMENT effect, disclosed to the
//           caller in `BASE_REMEDIATION` rather than suppressed here.
//
// WHICH ORACLE SETTLES WHICH QUESTION, recorded because three rounds on this
// file relied on one that cannot (T72#F-008). Bun's `HTMLRewriter` (lol-html)
// returns the RAW attribute source, not the tokenizer's decoded value:
// `getAttribute("type")` on `type="&#105;mage"` returns `&#105;mage`. It is a
// faithful oracle for ATTRIBUTION (which element owns which attribute) and for
// TAG BOUNDARIES, which is what T53 and T66 used it for — and it cannot
// adjudicate a DECODING question at all. Every earlier claim of the form
// "confirmed by an independent tokenizer" about decoding is therefore weaker
// than it reads. The decoding premise below rests on the SPEC TEXT
// (§13.2.5.35-.39), not on any oracle in this checkout; settling it by
// measurement would need a full parser (`parse5`, or Response→DOM), and the
// markdown oracle (`marked`) settles rendering questions but is a renderer for
// one flavour, so where it and this floor disagree in the direction of MORE
// flagging — nesting past its own depth limit — the floor keeps flagging and
// says so rather than claiming renderer confirmation it does not have.
//
// A destination is classified after HTML character references are decoded, because
// the renderer that performs the auto-fetch decodes them too: `https&#58;//host/…`
// is the same request as `https://host/…` (T24 F-004). It is then RESOLVED with
// the platform URL parser rather than matched against a set of authority
// spellings, because a pattern only ever knows the spellings it was shown
// (T24R2#F-001) — see `exfilHost`. Offsets stay on the RAW span, so
// `applyRedaction` masks the bytes as they were written.
//
// Extraction is part of the same guarantee: a destination that is truncated
// before it reaches the classifier is not protected by the classifier, and
// neither is one that is never MATCHED. The pointy-bracket destination forms
// above are extracted whole, whitespace included; HTML attributes are walked with
// the tokenizer's own states rather than with a negated character class, because
// `>` is ordinary data inside a quoted attribute value and an attribute VALUE is
// not an attribute NAME position (T42#F-001) — see `readStartTag`.
//
// Deny-by-default against `egress.allowlist`: an auto-fetched image URL whose
// host is NOT on the allowlist is flagged. An EMPTY allowlist flags every
// external auto-fetch image. An inline link is flagged here only when its URL
// carries an explicit credential locator; ordinary links remain the
// responsibility of detectEgress when an actual network operation is present.
//
// The URL span carries `mask:"url"` so `applyRedaction` strips the auto-render
// trigger, neutralizing the leak (AC2.1, E-9). Category is `egress`.

const EXFIL_CONFIDENCE = 0.85;

// Named references limited to the characters that carry URL syntax — enough to
// rebuild a scheme/authority, without pulling in a full HTML entity table.
//
// The membership rule, so the next character does not need a new review: a named
// reference is REQUIRED here when the URL parser either treats its character as
// URL syntax or removes it. This table is not, and does not need to be, the
// complete set of HTML5 names for ASCII characters — it is missing 14 of them,
// three of which (`midast`, `UnderBar`, `DiacriticalGrave`) are alias spellings
// of characters already present under another name (T42#F-005). Completeness over
// the alias spellings is not what makes the decoder sound: a NAMED reference is
// only ever an alternative spelling, and the numeric form above (`&#NN;` /
// `&#xNN;`, unbounded and range-checked) already covers every character
// generically. So an absent name can only matter for a character that has an
// HTML5 name AND is URL syntax or URL-removed — a small, closed set, and every
// member of it is here. Names whose character delimits nothing in a URL
// (`comma`, `Hat`, `lcub`, `rcub`, `verbar`, …) are therefore optional, and the
// entries below that fall in that category are present only incidentally.
//
// `bsol` (reverse solidus) is one of them because the parser treats `\` as `/`
// for a special scheme, so `&bsol;&bsol;host` is a protocol-relative URL.
// `Tab` and `NewLine` are in the table for the same reason `&#9;` is decoded
// above: they are HTML5 named references whose decoded character the URL parser
// then REMOVES, so `ht&Tab;tps://host` is byte-for-byte the same request as
// `https://host` (T24R2#F-001). A table that omits them leaves the scheme looking
// broken to the classifier while the renderer fetches.
const NAMED_CHARACTER_REFERENCES: Record<string, string> = {
  amp: "&",
  apos: "'",
  ast: "*",
  bsol: "\\",
  colon: ":",
  commat: "@",
  dollar: "$",
  equals: "=",
  excl: "!",
  grave: "`",
  gt: ">",
  lbrack: "[",
  lowbar: "_",
  lpar: "(",
  lsqb: "[",
  lt: "<",
  newline: "\n",
  num: "#",
  percnt: "%",
  period: ".",
  plus: "+",
  quest: "?",
  quot: '"',
  rbrack: "]",
  rpar: ")",
  rsqb: "]",
  semi: ";",
  sol: "/",
  tab: "\t",
  tilde: "~",
};

// Decimal, hexadecimal, and named references. The trailing `;` is optional because
// renderers accept `&#58` too. The numeric runs are UNBOUNDED on purpose: an HTML
// tokenizer consumes every digit and then range-checks the code point, so a
// digit-count bound matched only the prefix of `&#00000058;`, decoded it to code
// point 0 and left the reference raw — while the renderer decoded `:` and fetched
// (T24 F-004). The bound belongs on the code point, below.
const CHARACTER_REFERENCE =
  /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;
const MAX_DECODE_PASSES = 3;
const MAX_CODE_POINT = 0x10ffff;

function decodeCharacterReferencesOnce(value: string): string {
  CHARACTER_REFERENCE.lastIndex = 0;
  return value.replace(CHARACTER_REFERENCE, (raw, decimal, hex, name) => {
    if (decimal !== undefined || hex !== undefined) {
      const code =
        decimal !== undefined
          ? Number.parseInt(decimal as string, 10)
          : Number.parseInt(hex as string, 16);
      if (!Number.isInteger(code) || code <= 0 || code > MAX_CODE_POINT) {
        return raw as string;
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return raw as string;
      }
    }
    return (
      NAMED_CHARACTER_REFERENCES[String(name ?? "").toLowerCase()] ??
      (raw as string)
    );
  });
}

// Bounded repetition so a double-encoded `&amp;#58;` also resolves; a fixed point
// or the pass limit stops it.
function decodeCharacterReferences(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES && decoded.includes("&"); pass += 1) {
    const next = decodeCharacterReferencesOnce(decoded);
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return decoded;
}

// The URL a renderer would actually request, from the URL as it was written.
// Beyond decoding character references, every URL parser (WHATWG URL, "URL
// parsing") REMOVES ASCII tab, LF and CR anywhere in the input and strips leading
// and trailing C0-or-space before resolving the scheme and host. Classifying the
// decoded string without those removals left `ht&#9;tps://host`, a literal tab or
// newline inside the scheme, and a leading space or `&#9;` before the URL looking
// scheme-less, so no host was found and nothing was flagged — while the render
// still fetched (T24 F-004). Offsets are NOT touched: `considerUrl` keeps
// `start`/`end` on the raw span so `applyRedaction` masks the bytes as written.
const URL_STRIPPED_CHARACTERS = /[\t\n\r]/g;
const C0_OR_SPACE = 0x20;

// "Strip leading and trailing C0 control or space", written with code units so
// the source itself carries no invisible control characters.
function stripC0OrSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= C0_OR_SPACE) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= C0_OR_SPACE) end -= 1;
  return value.slice(start, end);
}

function renderableUrl(url: string): string {
  return stripC0OrSpace(
    decodeCharacterReferences(url).replace(URL_STRIPPED_CHARACTERS, ""),
  );
}

// The host a renderer would actually request, RESOLVED rather than recognized.
//
// Recognizing the authority by pattern is what failed two reviews running
// (T24 F-004 → T24R#F-002 → T24R2#F-001): `^https?://` and `^//` are two
// spellings out of the many the WHATWG URL parser accepts, so each round closed
// the spellings it was shown and fell to the next one — `\\host`, `https:\\host`,
// `https:/\host`, `/\host`, `https:///host`, `///host`. The parser is the
// authority on what the authority is, so this asks the platform parser instead of
// re-deriving it.
//
// A renderer resolves a destination against its DOCUMENT's base URL. This
// detector has no document, so it resolves against a SYNTHETIC base — and
// against a PAIR of them, differing only in host. That second base is not
// redundancy, it is the discriminator:
//
//   - both resolutions agree on the host  ⇒ the destination carries its OWN
//     authority (absolute, protocol-relative, or any backslash/extra-slash
//     spelling of the same). That host is the destination.
//   - the resolutions disagree            ⇒ the destination inherited the base's
//     authority, i.e. it is RELATIVE. A renderer fetches it from its own origin,
//     so there is no cross-origin channel and no finding.
//
// A single base would have to compare the result against its own host, which an
// attacker can simply spell; with two bases, a destination that names one of them
// makes both resolutions agree and is flagged like any other external host.
//
// One pair is not enough, and the reason is the second variable the resolution
// depends on (T42#F-002). WHATWG resolution branches in the *scheme* state on the
// predicate "the base's scheme equals the destination's scheme": when it holds,
// a special-scheme destination goes to `special relative or authority` and is
// RELATIVE; when it fails, it goes to `special authority slashes` →
// `special authority ignore slashes`, which makes the next token the HOST. A pair
// that is fixed at `https:` therefore judges `https:attacker.invalid/p` relative —
// true only for a renderer whose own document is `https:`. In a `file:` document,
// a `vscode-webview:` webview or an Electron custom-scheme document — the contexts
// MCP clients actually render tool output in — the same bytes fetch
// `attacker.invalid`. The old code showed the asymmetry itself:
// `http:attacker.invalid/p` was flagged and `https:attacker.invalid/p` was not.
//
// So the destination is resolved against TWO pairs whose base SCHEMES differ, and
// a host is returned when EITHER pair agrees. Two pairs are sufficient for the
// scheme-equality predicate above: pair 1 realises the "equal" branch for `https`
// (and the "differs" branch for every other scheme), and pair 2's scheme is
// non-special and private to this detector, so it realises the "differs" branch
// for EVERY special destination scheme, `https` included.
//
// That predicate is not the only place the parser consults the base (T53#F-002).
// The FILE state is also reachable from the *no-scheme* state whenever the BASE's
// own scheme is `file:` — a different branch, reached by a different test than
// scheme-equality — and the no-scheme state has a separate OPAQUE-PATH branch,
// where a relative destination against a base with an opaque path is a parse
// FAILURE. Neither synthetic pair is a `file:` base and neither has an opaque
// path, so neither branch is realised by either pair, and scheme-equality
// sufficiency alone does not cover them.
//
// What actually closes that gap is `resolvedHost` below, not a third base pair:
// it discards anything whose resolved protocol is not `http:`/`https:`, and the
// FILE state can only ever produce a `file:` URL while the OPAQUE-PATH branch can
// only ever produce a parse failure — both are discarded before a host is ever
// read. The two-pair argument and the `resolvedHost` filter are therefore NOT
// independent facts; sufficiency rests on both together. Widening `resolvedHost`
// past http(s) — adding `ws:`/`wss:` for a WebSocket egress channel, or `file:`
// for a UNC/SMB fetch, are the obvious candidates — would resurrect exactly the
// branches this paragraph says are closed, and would require a third base
// realising the FILE branch to stay sufficient.
//
// Consequences of the synthetic bases, stated rather than implied:
//   - a relative path can never be read as a remote host, and a remote host can
//     never be read as a relative path, because the test is the disagreement
//     between two independent bases and not a syntax rule on the source string. A
//     relative destination inherits each base's own host under BOTH pairs, so it
//     disagrees within each pair and stays unflagged;
//   - a scheme-relative destination (`//host`, and its backslash and extra-slash
//     spellings) inherits the base's SCHEME. Under pair 1 that is `https`, so the
//     host is recovered there; under pair 2 it becomes the private scheme, which
//     is not http(s) and yields nothing — which is why the pairs are OR-ed and not
//     AND-ed;
//   - a destination that carries a special scheme and no slashes agrees under
//     pair 2 and is flagged. This is deny-by-default in the only direction the
//     floor may err: such a destination fetches the named host in every renderer
//     whose document scheme differs, and no benign document writes it meaning a
//     relative path;
//   - a non-fetching or non-network scheme (`data:`, `mailto:`, `javascript:`,
//     `blob:`, `ftp:`, `ws:`) and a fragment- or query-only destination yield no
//     http(s) host under either pair, and are not findings.
const SYNTHETIC_BASE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [
    "https://keryx-detector-base-a.invalid/keryx/page",
    "https://keryx-detector-base-b.invalid/keryx/page",
  ],
  [
    "keryx-detector://keryx-detector-base-a.invalid/keryx/page",
    "keryx-detector://keryx-detector-base-b.invalid/keryx/page",
  ],
];

// The http(s) host this destination resolves to against one base, or null when it
// resolves to no network host at all.
function resolvedHost(url: string, base: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(url, base);
  } catch {
    return null; // not a URL a renderer could resolve
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null; // data:, mailto:, javascript:, … — no auto-fetched host
  }
  return resolved.hostname.length > 0 ? resolved.hostname.toLowerCase() : null;
}

// The host both bases of one pair agree on, or null when they disagree (the
// destination inherited the base authority, i.e. it is relative) or when it
// resolves to no network host at all.
function agreedHost(url: string, pair: readonly [string, string]): string | null {
  const first = resolvedHost(url, pair[0]);
  if (first === null) {
    return null;
  }
  return first === resolvedHost(url, pair[1]) ? first : null;
}

function exfilHost(url: string): string | null {
  for (const pair of SYNTHETIC_BASE_PAIRS) {
    const host = agreedHost(url, pair);
    if (host !== null) {
      return host;
    }
  }
  return null;
}

type UrlHit = {
  // The RAW span that gets masked. `start` + this length is the finding's end,
  // so it must be the bytes as they were written.
  url: string;
  start: number;
  policyId: string;
  // The string to CLASSIFY, when it is not the masked span itself. Only the
  // `<meta http-equiv=refresh>` surface needs the two to differ: its destination
  // sits inside a directive (`0;url=…`) that is not itself a URL, and the whole
  // directive is what must be masked — a timeout with the destination removed is
  // not a meaningful thing to leave behind. Defaults to `url` (T46).
  classify?: string;
  // Per-callsite override; defaults to FETCH_REMEDIATION below (T53#F-001).
  remediation?: string;
};

const FETCH_REMEDIATION =
  "Strip or allowlist auto-fetched destinations in rendered output — markdown images, <img>/<image>/<input type=image>/<video poster>/background, media and embedded-content elements, and any <base href> that re-points them; they exfiltrate context on render.";

// The one surface here that is not a subresource request. Masking an <img src>
// breaks one image; masking a refresh removes a NAVIGATION of the whole client,
// which is a different thing for a caller to be told (T46).
const META_REFRESH_REMEDIATION =
  "Strip or allowlist this <meta http-equiv=refresh>. It is not a subresource fetch: on render it navigates the whole client to the destination, so the entire directive is masked rather than the URL alone.";

// A masked <base href> re-points EVERY relative URL in the document back to the
// reader's own origin — not one destination — so a false positive here changes
// the whole document's resolution, not just one image (T53#F-001).
const BASE_REMEDIATION =
  "Strip or allowlist this <base href>. Unlike an <img src>, masking it re-points EVERY relative URL in the document to the reader's own origin, so a false positive here changes the whole document's resolution, not just one destination.";

// Would a renderer fetch this destination from a host this floor has not been
// told to permit? Split out of `considerUrl` so a caller that must decide
// BEFORE it knows which span to mask can ask the same question — the `srcset`
// branch, whose candidate boundaries can be hidden by decoding (T72#F-004).
function isExfilDestination(url: string, allowlist: string[]): boolean {
  const host = exfilHost(renderableUrl(url));
  if (!host) {
    return false; // relative / data / non-host URL — not an exfil channel
  }
  return !(allowlist.length > 0 && hostAllowed(host, allowlist));
}

// Push a redactable finding for a URL that is external and not allowlisted.
function considerUrl(
  hit: UrlHit,
  allowlist: string[],
  out: DetectorMatch[],
): void {
  if (!isExfilDestination(hit.classify ?? hit.url, allowlist)) {
    return;
  }
  out.push({
    category: "egress",
    policyId: hit.policyId,
    severity: "critical",
    confidence: EXFIL_CONFIDENCE,
    start: hit.start,
    end: hit.start + hit.url.length,
    value: hit.url,
    mask: "url",
    remediation: hit.remediation ?? FETCH_REMEDIATION,
  });
}

// Extraction must not truncate a destination before it is classified: a vector
// the classifier never sees is not closed by improving the classifier
// (T24R2#F-001). A CommonMark pointy-bracket destination `<…>` may contain
// spaces and tabs and ends at the first unescaped `>` or newline, so both inline
// and reference-definition destinations get an explicit angle-bracket
// alternative, tried FIRST, that captures the whole destination — whitespace and
// all. The bare alternative excludes only what the CommonMark link-destination
// grammar excludes: whitespace (and, inline, the closing parenthesis). `>` is
// legal in a bare destination, so excluding it cut `![x](https://host/a>b)` short
// and left the tail outside the mask (T42#F-003); the angle alternative is tried
// first, so nothing needs `>` to keep the two apart.
//
// The DESCRIPTION — the bracket run a markdown image or link opens with — is not
// matched by a regex, and that is the fix for T66#F-002 rather than an
// elaboration of it. CommonMark permits balanced brackets inside a description
// (`![a[b]c](URL)`), and a `\[[^\]]*\]` pattern cannot cross the inner `]`, so
// the construct matched nothing and the destination was released. The obvious
// repair — "allow one level of nesting" — is the mistake this file has already
// made twice in another form: a decoder bounded by digit count and an extractor
// bounded by a negated character class were each defeated by writing one more of
// whatever was bounded. A renderer counts depth, unbounded, so this counts depth,
// unbounded.
//
// Each opening `[` gets up to TWO candidate description ends, most-faithful
// first:
//   1. the BALANCED end — the `]` that returns the depth to 0, at any depth;
//   2. the FIRST `]` at any depth — precisely the span the old `[^\]]*` produced.
// Both are kept because the second is what makes this a strict SUPERSET of the
// previous extraction: `![a[](URL)` has no balanced close, and the old span is
// the one that matches there. Every shape the old pattern matched is therefore
// still reachable, and no over-approximation it recorded can silently disappear.
//
// Backslash escapes are not honoured by either of those two ends, and that is
// deliberate in exactly one direction: REPLACING them with escape-aware ones
// would REMOVE current matches (`![a\](URL)` is flagged today and renders no
// image), and this floor may not move in that direction.
//
// It does not follow that the escape rule may be ignored, and for a long time it
// was — which was T84#F-003. A description carrying a backslash-escaped `]` that
// the plain stack takes for the pair's close (`![a\]](URL)`) had BOTH of its
// candidate ends computed at the same wrong position, just past the escaped
// bracket, and the CommonMark-correct end was never offered at all. The
// construct was then not mis-labelled but invisible: `readInlineDestination`
// found `]` where it needed `(`, the full-reference branch's `[` check failed at
// the same wrong offset, and seven spellings reached all four public boundaries
// with `redaction.state:"none"` while `marked` fetched.
//
// So two more ends are APPENDED, most-faithful-first order preserved:
//   3. the balanced end over a stack that ignores ESCAPED brackets;
//   4. the first UNESCAPED `]` at any depth.
// Appending rather than substituting is the whole of the no-release argument:
// `readBracketConstructs` walks the ends in order, the inline pass takes the
// FIRST inline construct and the reference pass breaks at the FIRST resolving
// one, so every construct found before this is still found, still first, and
// still at the same offset. A new end can only produce a construct where there
// was none.
//
// Both are kept for the same reason 1 and 2 both are — they catch different
// shapes. End 4 closes `![a\]](URL)` and the full-reference spellings; end 3
// closes the nested `![a[b]\]c](URL)`, where the first unescaped `]` is an inner
// one and only a depth walk reaches the real end.
//
// They cost nothing on a document with no backslash in it: the escape-aware
// structures are then the escape-blind ones BY REFERENCE, ends 3 and 4
// deduplicate away, and `escapeAware` is false.
//
// Both ends are computed for the WHOLE input in ONE left-to-right pass, not per
// opening bracket, and that is a correctness property rather than a tidiness one:
// a per-open depth walk is quadratic on a run of `[`, and 200 000 of them —
// 200 KB an attacker can paste into any tool output — took 208 SECONDS inside the
// mandatory floor (`T71-perf.log`, first run). The `[^\]]*` this replaces was
// already quadratic on the same input (41 s across its two patterns, measured),
// so this is a pre-existing shape rather than one the repair introduced, but the
// repair is not allowed to make it worse. The stack pairing below is O(n), and
// the same run now costs single-digit milliseconds.
interface ContentIndex {
  // open index → index just past the `]` that closes it at depth 0
  balanced: Map<number, number>;
  // every `]` position, ascending, for the first-close fallback
  closes: number[];
  // whether the document contains a backslash at all. When it does not, the two
  // escape-aware members below ARE the two escape-blind ones, by reference, and
  // `descriptionEnds` skips them entirely.
  escapeAware: boolean;
  // the same pairing as `balanced`, over a stack that ignores a `[` or `]`
  // preceded by an ODD run of `\` — the brackets CommonMark reads as literals
  // (T84#F-003). Appended as a candidate end, never substituted for one.
  escapeAwareBalanced: Map<number, number>;
  // every UNESCAPED `]` position, ascending, for the fourth candidate end
  unescapedCloses: number[];
  // every `)` position, ascending. An inline destination's match ALWAYS ends at
  // the first `)` at or after the description, so the absence of one is proof
  // the destination grammar cannot match — see `readInlineDestination`.
  closeParens: number[];
  // running count of non-whitespace characters, so "could the bytes in [a, b)
  // normalise to a label at most N characters long" is an O(1) question. Built
  // only when the document actually defines a reference label; see LabelBudget.
  nonWhitespace: Uint32Array | null;
  // every `[` position, ascending, so "how many opening brackets does [a, b)
  // carry" is an O(log n) question. Built under the same condition; `closes`
  // above answers the same question for `]` and is always built.
  openBrackets: number[] | null;
}

// The whitespace `normaliseLabel` collapses. ASCII is decided by code unit so
// the common path allocates nothing; anything above ASCII falls through to the
// engine's own `\s`, which is the class the collapse below uses.
const UNICODE_WHITESPACE = /\s/;
function isCollapsibleSpace(code: number, character: string): boolean {
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
  return code > 0x7f && UNICODE_WHITESPACE.test(character);
}

function indexContent(content: string, withLabelCounts: boolean): ContentIndex {
  const balanced = new Map<number, number>();
  const closes: number[] = [];
  const closeParens: number[] = [];
  const open: number[] = [];
  const nonWhitespace = withLabelCounts
    ? new Uint32Array(content.length + 1)
    : null;
  const openBrackets: number[] | null = withLabelCounts ? [] : null;
  // One native scan decides whether the escape-aware pairing has to exist at
  // all. A document with no `\` in it cannot have an escaped bracket, so the two
  // pairings would be identical and the second one would be pure overhead — in
  // time, in memory, and in the reader's attention.
  const escapeAware = content.includes("\\");
  const escapeAwareBalanced = escapeAware ? new Map<number, number>() : balanced;
  const unescapedCloses: number[] = escapeAware ? [] : closes;
  const escapeAwareOpen: number[] = [];
  let backslashRun = 0;
  let counted = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] as string;
    if (nonWhitespace) {
      if (!isCollapsibleSpace(content.charCodeAt(index), character)) counted += 1;
      nonWhitespace[index + 1] = counted;
    }
    // Read the run BEFORE this character, then extend or clear it. An ODD run
    // means this character is escaped; `\\` is one literal backslash and leaves
    // the next character unescaped.
    const escaped = escapeAware && backslashRun % 2 === 1;
    if (escapeAware) backslashRun = character === "\\" ? backslashRun + 1 : 0;
    if (character === "[") {
      open.push(index);
      if (openBrackets) openBrackets.push(index);
      if (escapeAware && !escaped) escapeAwareOpen.push(index);
      continue;
    }
    if (character === ")") {
      closeParens.push(index);
      continue;
    }
    if (character !== "]") continue;
    closes.push(index);
    const start = open.pop();
    if (start !== undefined) balanced.set(start, index + 1);
    if (escapeAware && !escaped) {
      unescapedCloses.push(index);
      const escapeAwareStart = escapeAwareOpen.pop();
      if (escapeAwareStart !== undefined) {
        escapeAwareBalanced.set(escapeAwareStart, index + 1);
      }
    }
  }
  return {
    balanced,
    closes,
    escapeAware,
    escapeAwareBalanced,
    unescapedCloses,
    closeParens,
    nonWhitespace,
    openBrackets,
  };
}

// The index of the first value at or after `from`, by binary search over an
// ascending list.
function lowerBound(values: number[], from: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((values[middle] as number) < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

// The first value at or after `from`, by binary search over an ascending list.
function firstAtOrAfter(values: number[], from: number): number {
  const low = lowerBound(values, from);
  return low < values.length ? (values[low] as number) : -1;
}

// How many of an ascending list's values fall in [start, end).
function countInRange(values: number[], start: number, end: number): number {
  return lowerBound(values, end) - lowerBound(values, start);
}

// The candidate description ends for one opening bracket, and how many of them
// are the ESCAPE-BLIND ones. `blind` is not bookkeeping: a construct found only
// through an escape-aware end may add a finding but may never move the scan
// cursor, and `blind` is what the passes below read to tell the two apart. See
// `BracketConstruct.escapeAware` for why.
interface DescriptionEnds {
  ends: number[];
  blind: number;
}

function descriptionEnds(index: ContentIndex, open: number): DescriptionEnds {
  const balancedClose = index.balanced.get(open) ?? -1;
  const first = firstAtOrAfter(index.closes, open);
  const firstClose = first === -1 ? -1 : first + 1;
  const ends: number[] = [];
  if (balancedClose !== -1) ends.push(balancedClose);
  if (firstClose !== -1 && firstClose !== balancedClose) ends.push(firstClose);
  const blind = ends.length;
  // Ends 3 and 4 (T84#F-003), APPENDED after the two above so neither of them
  // can lose a race it wins today. `includes` runs over at most three numbers.
  if (!index.escapeAware) return { ends, blind };
  const escapeAwareClose = index.escapeAwareBalanced.get(open) ?? -1;
  if (escapeAwareClose !== -1 && !ends.includes(escapeAwareClose)) {
    ends.push(escapeAwareClose);
  }
  const firstUnescaped = firstAtOrAfter(index.unescapedCloses, open);
  const firstUnescapedClose = firstUnescaped === -1 ? -1 : firstUnescaped + 1;
  if (firstUnescapedClose !== -1 && !ends.includes(firstUnescapedClose)) {
    ends.push(firstUnescapedClose);
  }
  return { ends, blind };
}

// The opening of any markdown bracket construct. The `!` prefix distinguishes an
// auto-fetching image from a user-initiated link.
const BRACKET_OPEN = /(!?)\[/g;

// The inline destination, `(URL …)`, anchored (sticky) at the character just
// after the description so it can only match where a renderer would look for it.
// Groups: 1 = angle-bracket destination, 2 = bare destination.
const INLINE_DESTINATION = /\(\s*(?:<([^<>\n]*)>|([^)\s]+))[^)]*\)/y;
// A reference definition's destination, `: URL`, anchored (sticky) just past the
// `]:`. Groups: 1 = angle-bracket destination, 2 = bare destination. This is the
// tail of the pattern `readReferenceDefinitions` replaced, unchanged, so the
// destination and its offset are read exactly as they were.
const REFERENCE_DESTINATION = /\s*(?:<([^<>\n]*)>|(\S+))/y;

// CommonMark matches a link label after Unicode case folding AND after
// collapsing every run of internal whitespace — a newline included — to a
// single space, on BOTH sides of the match. `trim().toLowerCase()` alone left
// `![a][b  c]` unresolved against `[b c]: URL`, which a renderer resolves and
// fetches (T72#F-005). Applied identically at the definition site and the use
// site; a normalisation applied to one side only is a bypass, not a repair.
const LABEL_WHITESPACE_RUN = /\s+/g;
function normaliseLabel(label: string): string {
  return label.trim().replace(LABEL_WHITESPACE_RUN, " ").toLowerCase();
}

// THE REFERENCE-DEFINITION TABLE, AND WHY IT IS NO LONGER A REGEX (T82#F-001).
//
// It used to be `/^[ \t]*\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|(\S+))/gm`. Two facts
// about that pattern, which are the same fact seen from two sides:
//
//   - `[^\]]+` cannot cross a `]`, so the `]` the pattern matched was ALWAYS the
//     first one after the opening bracket, and a line matched only when that
//     first `]` was immediately followed by `:`. That is the whole of its
//     semantics, and it is reproduced below exactly.
//   - therefore a definition whose label carries a BACKSLASH-ESCAPED `]` matched
//     nothing at all. `[foo\]]: URL` has another `]` where the `:` has to be, so
//     the table stayed empty, the reference pass never ran, and the document
//     produced ZERO findings — while CommonMark («a link label ends with the
//     first right bracket that is not backslash-escaped») and `marked` both
//     resolve `![foo\]]` and emit the `<img>`. Five spellings reached all four
//     public boundaries with `redaction.state:"none"`. Pre-existing, and missed
//     by ten rounds precisely because it is the fact the cost proof leans on.
//
// The repair is at the DEFINITION site only; the use side already produces the
// right bytes. For every reachable spelling — shortcut `![foo\]]`, short, full
// `![alt][foo\]]`, collapsed `![foo\]][]` and multi-escape `![a\]b\]c]` — the
// candidate label span `readBracketConstructs` builds runs from `[`+1 to the
// FIRST `]`, i.e. `foo\`. So a definition is registered under exactly that: the
// label read escape-aware (to recognise the line at all) and then TRUNCATED AT
// ITS FIRST `]`.
//
// WHAT THAT DOES TO THE COST PROOF, which is the reason the truncation is the
// design rather than a detail. T81's step (i) was "no key can contain `]`,
// because the capture is `[^\]]+`". After this change the reason is stronger and
// no longer a property of any pattern:
//
//     a key is the label's bytes UP TO ITS FIRST `]`, so no key contains `]`
//     — by construction.
//
// Steps (ii) and (iii) are untouched: `normaliseLabel` still neither adds nor
// removes a `]`, `readLabel` still rejects every span carrying one as a
// NECESSARY condition, and candidate spans are therefore still pairwise
// disjoint with total length at most `content.length`.
//
// WHY IT IS A SCAN AND NOT A SECOND PATTERN. `[^\]]+` crosses newlines, so on a
// document that opens a bracket on every line and never closes one, every
// line-start `[` scanned to end-of-content and backtracked — quadratic, 5 899 ms
// on 352 000 bytes, measured on the pre-repair tree. Every adversarial shape the
// prior rounds built carried a `]`, so none of them reached it. Adding a second,
// escape-aware pattern beside the first would have doubled that. The scan below
// does one left-to-right pass and one binary search per line-start `[`, with no
// backtracking anywhere.
const LINE_TERMINATORS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);

interface ReferenceDefinitions {
  // label → every definition of it, in document order (T78#F-002: the floor does
  // not bet on a renderer's precedence rule, so none of them is discarded)
  refs: Map<string, Array<{ url: string; start: number }>>;
  maxLength: number;
  maxOpenBrackets: number;
}

type DefinitionDestination = { url: string; start: number; end: number } | null;

// The destination at `afterColon`, and the index just past it, or null when the
// grammar cannot match — which is the only way the replaced pattern could fail
// once it had found `]:`.
//
// MEMOISED BY `afterColon`, for the same reason `readInlineDestination` is
// memoised by `descriptionEnd`, and because not memoising it was a second,
// independent quadratic in this file (T84#F-001). Two facts compose:
//
//   - MANY line-start `[` can share ONE `]:` offset, so they all ask at the same
//     index — a document with one `]:` and a bracket on every line gives every
//     one of those lines the same question;
//   - when the read FAILS the cursor is not advanced (only a successful read
//     advances `resumeAt`, below), so nothing suppresses the next line start.
//
// And a failing read is not cheap. With a whitespace run to end of input after
// the colon, `\s*` consumes the whole run and then gives back one character at a
// time, retrying an alternation that cannot match at end of input — Theta(run)
// per call. Once per line start over O(n) line starts is O(n²): 7 018 ms in the
// detector at 200 001 bytes, and 6 784-6 952 ms at EVERY public boundary at
// 196 610 bytes, with no attacker host in the payload at all. Ten rounds of
// adversarial shapes missed it because every one of them contained a `]` that
// either resolved or failed fast; this needs a `]:` that is FOUND and then fails
// to parse what follows.
//
// The cache is sound because the regex is STICKY: `exec` can only match at
// `lastIndex`, so the result is a pure function of `afterColon` and of a
// `content` that is fixed for the cache's lifetime. It therefore changes no
// answer at all — the repair is entirely a cost repair.
//
// WHAT IT DOES TO THE COST PROOF. The label-side chain is untouched: no key, no
// candidate span and no slice changes. The destination side gains an argument it
// never had. With the cache the reader runs at most once per DISTINCT offset,
// and the whitespace runs at distinct offsets are pairwise DISJOINT — for
// `o₁ < o₂`, `content[o₂ - 1]` is the `:` that produced `o₂`, a non-whitespace
// character at an index ≥ `o₁`, so the run at `o₁` ends at or before `o₂ - 1`.
// Total destination work is therefore at most `content.length`: linear, with no
// budget and no bound on any length, which is the same shape of argument the
// label side already carries.
function readDefinitionDestination(
  content: string,
  afterColon: number,
  cache: Map<number, DefinitionDestination>,
): DefinitionDestination {
  const cached = cache.get(afterColon);
  if (cached !== undefined) return cached;
  REFERENCE_DESTINATION.lastIndex = afterColon;
  const match = REFERENCE_DESTINATION.exec(content);
  const url = match ? (match[1] ?? match[2] ?? "") : "";
  const destination: DefinitionDestination =
    match && url
      ? {
          url,
          start: afterColon + match[0].lastIndexOf(url),
          end: REFERENCE_DESTINATION.lastIndex,
        }
      : null;
  cache.set(afterColon, destination);
  return destination;
}

function readReferenceDefinitions(content: string): ReferenceDefinitions {
  const refs = new Map<string, Array<{ url: string; start: number }>>();
  let maxLength = 0;
  let maxOpenBrackets = 0;
  // One destination reading per `]:` offset, shared by BOTH readings below
  // (T84#F-001). See `readDefinitionDestination` for why it is sound and for
  // what it does to the cost proof.
  const destinations = new Map<number, DefinitionDestination>();

  // One pass: every `]`, every `]` a renderer reads as a label terminator (not
  // preceded by an ODD run of `\`), and every unescaped `[`. Ascending, so each
  // question below is a binary search rather than a scan.
  const closes: number[] = [];
  const unescapedCloses: number[] = [];
  const unescapedOpens: number[] = [];
  let backslashRun = 0;
  for (let at = 0; at < content.length; at += 1) {
    const code = content.charCodeAt(at);
    if (code === 0x5c) {
      backslashRun += 1;
      continue;
    }
    if (code === 0x5d) {
      closes.push(at);
      if (backslashRun % 2 === 0) unescapedCloses.push(at);
    } else if (code === 0x5b && backslashRun % 2 === 0) {
      unescapedOpens.push(at);
    }
    backslashRun = 0;
  }

  const register = (raw: string, url: string, start: number): void => {
    // The key is the label UP TO ITS FIRST `]`, which is both what the use side
    // hands to `readLabel` and what keeps step (i) of the cost proof true.
    const firstClose = raw.indexOf("]");
    const ref = normaliseLabel(firstClose === -1 ? raw : raw.slice(0, firstClose));
    if (!ref || !url) return;
    const defined = refs.get(ref);
    if (defined) defined.push({ url, start });
    else refs.set(ref, [{ url, start }]);
    if (ref.length > maxLength) maxLength = ref.length;
    let openBrackets = 0;
    for (let at = 0; at < ref.length; at += 1) {
      if (ref.charCodeAt(at) === 0x5b) openBrackets += 1;
    }
    if (openBrackets > maxOpenBrackets) maxOpenBrackets = openBrackets;
  };

  // `resumeAt` is the replaced pattern's own `lastIndex`, and it is advanced by
  // the FIRST reading only. The escape-aware reading is purely additive: it
  // never moves the cursor, so it cannot skip a line the pattern would have
  // matched. Moving the cursor for it is not a smaller change, it is a RELEASE —
  // `[a\]b\n[c]: URL` would have its `[c]` definition swallowed.
  let resumeAt = 0;
  let lineStart = 0;
  for (;;) {
    if (lineStart >= resumeAt && closes.length > 0) {
      let at = lineStart;
      while (at < content.length) {
        const code = content.charCodeAt(at);
        if (code !== 0x20 && code !== 0x09) break;
        at += 1;
      }
      if (content.charCodeAt(at) === 0x5b) {
        const open = at;
        const first = firstAtOrAfter(closes, open + 1);
        if (first > open + 1) {
          // READING 1 — the replaced pattern, character for character: the first
          // `]` terminates the label and must be followed by `:`.
          if (content.charCodeAt(first + 1) === 0x3a) {
            const destination = readDefinitionDestination(
              content,
              first + 2,
              destinations,
            );
            if (destination) {
              register(
                content.slice(open + 1, first),
                destination.url,
                destination.start,
              );
              resumeAt = destination.end;
            }
          }
          // READING 2 — CommonMark's, reached only when the first `]` is
          // BACKSLASH-ESCAPED, which is exactly the case reading 1 cannot see.
          // The label then ends at the first UNESCAPED `]`, and it may not carry
          // an unescaped `[` — a label that does is not a label for CommonMark,
          // and `marked` renders no image for one (`![a\]b[c]` fetches nothing).
          //
          // That last condition is not only faithfulness. It is what bounds this
          // reading's cost: two line-start `[` cannot survive it with the same
          // terminator (the second would sit inside the first's label), so the
          // slices this reading takes are pairwise DISJOINT and their total
          // length is at most `content.length` — the same shape of argument as
          // the candidate spans in `readLabel`, and for the same reason.
          if (
            unescapedCloses.length > 0 &&
            firstAtOrAfter(unescapedCloses, open + 1) !== first
          ) {
            const close = firstAtOrAfter(unescapedCloses, open + 1);
            if (
              close !== -1 &&
              content.charCodeAt(close + 1) === 0x3a &&
              countInRange(unescapedOpens, open + 1, close) === 0
            ) {
              const destination = readDefinitionDestination(
                content,
                close + 2,
                destinations,
              );
              if (destination) {
                register(
                  content.slice(open + 1, first),
                  destination.url,
                  destination.start,
                );
              }
            }
          }
        }
      }
    }
    let at = lineStart;
    while (at < content.length && !LINE_TERMINATORS.has(content.charCodeAt(at))) {
      at += 1;
    }
    if (at >= content.length) break;
    lineStart = at + 1;
  }

  return { refs, maxLength, maxOpenBrackets };
}

// WHY THERE IS NO `MAX_REFERENCE_LABEL` HERE ANY MORE (T72#F-002).
//
// T71 refused to read a bracket run longer than 999 characters as a label, on
// the ground that CommonMark caps a label at 999 and so "a longer bracket run
// cannot be a label in any conformant renderer". Measured against the renderer
// this floor is defended against — the markdown client that performs the fetch
// — that is false: `marked` resolves a 1000- and a 1200-character label and
// emits the `<img>`. The pattern the scanner replaced had NO bound and flagged
// it, so the constant did not narrow an over-approximation, it opened a hole,
// with the cliff exactly at the constant. It was the seventh instance of this
// file's one recurring failure: a bound chosen by the implementer, defeated by
// writing one more of whatever was bounded.
//
// What replaces it is not a larger constant but a fact about the input. A
// bracket run can only be a label if its normalised form EQUALS a key that this
// document's own `[ref]: URL` lines produced. Normalising can collapse
// whitespace but can never remove a non-whitespace character, so
//
//     normalise(span).length >= nonWhitespaceCount(span)
//
// and a span whose non-whitespace count already exceeds the longest key in the
// table cannot match any of them. That is a NECESSARY condition, checked in
// O(1) against the prefix counts built with the bracket index, so it never
// releases a label a renderer would resolve — a 1200-character label with a
// 1200-character definition is a finding — while a bracket run with no
// definition to match is dismissed without being sliced. When the document
// defines no labels at all the reference pass does not run.
//
// WHY THAT WAS NOT ENOUGH EITHER, and what the cost is bounded by now
// (T78#F-001).
//
// `maxKeyLength` is read out of the payload, and the payload is the attacker's:
// ONE long `[ref]: URL` line raises it arbitrarily, every opening bracket then
// passes the O(1) test, and the O(span) slice behind it made the pass quadratic
// again — 400 029 bytes cost 20.8 SECONDS in the mandatory floor, against 43 ms
// for the same bytes without the definition line. That was the third bound on
// this path (a constant, then a maximum derived from the input), so what
// replaces it is not a fourth bound on a LENGTH but a bound on TOTAL WORK, and
// the property to check is no longer "is this number big enough" but "can any
// document change the asymptotic cost". It cannot, for three reasons that
// compose:
//
//   1. Only an IMAGE open can cost a label slice. The inline pass never reads a
//      reference construct and the reference pass discards them for every
//      non-`!` open, so `readBracketConstructs` no longer BUILDS one unless its
//      caller wants it (`wantReference`). A run of `[` — the shape both prior
//      rounds measured — now allocates nothing at all.
//   2. Two necessary conditions the document cannot inflate. A key is a label's
//      bytes UP TO ITS FIRST `]` (`readReferenceDefinitions`), so NO key can
//      ever contain `]`, whatever an attacker writes — by construction of the
//      truncation, which is why widening the definition reading to see escaped
//      closers (T82#F-001) did not weaken this; `normaliseLabel` neither adds
//      nor removes one; therefore a span carrying a `]` cannot equal any key.
//      That is a fact about the table, not a measurement. It also has a structural
//      consequence that is what actually makes the pass linear: after it, a
//      candidate span carries no `]`, and the `[`-count condition below (the
//      most `[` any key carries, normally zero) leaves it carrying no `[`
//      either — so the `[` that opens it is the LAST `[` before the `]` that
//      closes it, no two candidate spans can share an endpoint, and the spans
//      are pairwise DISJOINT. Their total length is at most `content.length`.
//   3. A total-work budget for the one filter a document CAN raise. Defining a
//      label that itself contains `[` raises the `[` threshold, so the label
//      path may spend at most `LABEL_WORK_FACTOR * content.length` characters
//      of slicing per document. When that is exhausted the path stops slicing
//      and every reference definition in the document is FLAGGED — the failure
//      direction is a finding, which is the direction this floor may move in,
//      never a release.
//
// So the only quantity an attacker can inflate is the input's own length, and
// the cost is linear in it. `LABEL_WORK_FACTOR` is deliberately NOT a bound on
// any label, span or document length: it is a multiplier on the input, and an
// honest document spends far less than one multiple of itself (at most four
// candidate spans per `![` open, and by (2) those spans are disjoint).
//
// WHY «FOUR» AND NOT «TWO», AND WHY THE BOUND DID NOT MOVE WITH IT (T84#F-003).
// `descriptionEnds` gained two ESCAPE-AWARE candidate ends, appended after the
// two escape-blind ones. Three facts keep this paragraph true:
//
//   - the SHORTCUT and COLLAPSED forms gain nothing to slice. Their label span
//     is [open+1, descriptionEnd-1), and a new end is used only when it DIFFERS
//     from the first-`]` end — otherwise it is deduplicated — so it is strictly
//     greater, and the span therefore contains that first `]`. `readLabel`'s
//     `]` rejection reads the ESCAPE-BLIND `closes` (deliberately: it is the
//     necessary condition of (2), not a faithfulness choice) and fires in
//     O(log n) BEFORE any slice. That path's total slicing is unchanged;
//   - the FULL form's spans stay pairwise disjoint. Its span is [d+1, c) where
//     `content[d] === "["` and `c` is the first `]` at or after d+1, read from
//     the same escape-blind `closes` — so a surviving span is a function of `c`
//     alone, and for c₁ < c₂ the second span cannot contain the `]` at c₁, so
//     c₁ ≤ d₂ and the two are disjoint. Total length ≤ `content.length`,
//     however many candidate ends fed them;
//   - what is left is O(log n) of binary searching per candidate end, and there
//     are at most twice as many. A constant, not an exponent.
const LABEL_WORK_FACTOR = 8;

interface LabelBudget {
  // the longest key the document's own reference definitions produced
  maxLength: number;
  // the most `[` any key carries — normally 0, and the only threshold here a
  // document can raise, which is why (3) above exists
  maxOpenBrackets: number;
  // prefix non-whitespace counts, or null when maxLength is 0
  nonWhitespace: Uint32Array | null;
  // characters of label normalisation still permitted for this document
  work: number;
  // set when `work` ran out; the caller flags every definition rather than
  // releasing what it did not examine
  exhausted: boolean;
}

// The label the span [start, end) would resolve to, or null when it provably
// cannot resolve to any key in this document's table. Every rejection below is
// a NECESSARY condition — a span it rejects could not have matched a key — so
// this narrows cost without narrowing coverage.
function readLabel(
  content: string,
  index: ContentIndex,
  budget: LabelBudget,
  start: number,
  end: number,
): string | null {
  const counts = budget.nonWhitespace;
  if (!counts || end <= start) return null;
  // Normalising can collapse whitespace but never removes a non-whitespace
  // character, so `normalise(span).length >= nonWhitespaceCount(span)`; and a
  // key is non-empty, so an all-whitespace span normalises to "" and matches
  // nothing (T72#F-002).
  const nonWhitespace = (counts[end] ?? 0) - (counts[start] ?? 0);
  if (nonWhitespace === 0 || nonWhitespace > budget.maxLength) return null;
  // No key can contain `]` — a key is a label truncated at its first one — and
  // no key can contain more `[` than the most any key carries (T78#F-001).
  if (countInRange(index.closes, start, end) > 0) return null;
  const opens = index.openBrackets;
  if (opens && countInRange(opens, start, end) > budget.maxOpenBrackets) {
    return null;
  }
  const width = end - start;
  if (width > budget.work) {
    budget.exhausted = true;
    return null;
  }
  budget.work -= width;
  return normaliseLabel(content.slice(start, end));
}

function spanHasNonWhitespace(
  budget: LabelBudget,
  start: number,
  end: number,
): boolean {
  const counts = budget.nonWhitespace;
  if (!counts) return false;
  return (counts[end] ?? 0) - (counts[start] ?? 0) > 0;
}

// One markdown bracket construct, resolved the way CommonMark resolves it.
// `descriptionEnd` is the index just past the description's `]`, i.e. where the
// destination begins — the caller skips THAT span and not the description, see
// the inline pass.
//
// `escapeAware` marks a construct that exists ONLY because of an escape-aware
// candidate end. It may be flagged like any other, but it may NOT move the scan
// cursor — see the inline pass for the release it otherwise causes.
type BracketConstruct =
  | {
      kind: "inline";
      url: string;
      start: number;
      descriptionEnd: number;
      end: number;
      escapeAware: boolean;
    }
  | { kind: "reference"; label: string; end: number; escapeAware: boolean };

type InlineDestination = { url: string; start: number; end: number } | null;

// The inline destination at one description end, memoised.
//
// Two properties of the grammar make this both cheap and safe. It is STICKY at
// `descriptionEnd`, so its result depends on nothing but that index — which is
// what makes memoising sound, and it matters because MANY opening brackets can
// share one description end (`"[".repeat(n) + "](URL)"` gives every one of them
// the same `]`), and re-running the regex per bracket is quadratic.
//
// And every alternative it can match ends at the FIRST `)` at or after the
// description, because neither `[^)\s]+` nor `[^)]*` may cross one. So when no
// `)` follows, the grammar cannot match — and running it anyway is what cost
// 285 seconds on a 12.5 KB payload (T72#F-003): `[^)\s]+[^)]*\)` backtracks
// over every split of the run it just consumed, quadratic in the run length and
// cubic once a leading run of `[` offers it a start position at every bracket.
// The `)` positions are indexed in the same single pass as the brackets, so
// asking is O(log n) and the answer is exact rather than a bound.
function readInlineDestination(
  content: string,
  index: ContentIndex,
  descriptionEnd: number,
  cache: Map<number, InlineDestination>,
): InlineDestination {
  const cached = cache.get(descriptionEnd);
  if (cached !== undefined) return cached;
  let destination: InlineDestination = null;
  // `(` immediately after the description ⇒ inline. CommonMark allows no
  // whitespace between the two, and neither does this.
  if (
    content[descriptionEnd] === "(" &&
    firstAtOrAfter(index.closeParens, descriptionEnd) !== -1
  ) {
    INLINE_DESTINATION.lastIndex = descriptionEnd;
    const match = INLINE_DESTINATION.exec(content);
    const url = match ? (match[1] ?? match[2] ?? "") : "";
    if (match && url) {
      destination = {
        url,
        start: descriptionEnd + match[0].indexOf(url),
        end: INLINE_DESTINATION.lastIndex,
      };
    }
  }
  cache.set(descriptionEnd, destination);
  return destination;
}

// Every construct the bytes at `open` (`content[open] === "["`) could be, in the
// order a renderer would prefer them: the balanced-description reading first,
// the old first-`]` reading second. `end` is the index just past the construct.
//
// `wantReference` is the `!` gate, moved in FRONT of the work it gates
// (T78#F-001). The inline pass reads only `kind === "inline"` and the reference
// pass reads a reference construct only for an image open, so building one for
// any other caller was work whose result was thrown away — and it was the work
// that made a run of `[` quadratic.
function readBracketConstructs(
  content: string,
  index: ContentIndex,
  open: number,
  destinations: Map<number, InlineDestination>,
  budget: LabelBudget,
  wantReference: boolean,
): BracketConstruct[] {
  const constructs: BracketConstruct[] = [];
  const { ends, blind } = descriptionEnds(index, open);
  for (let at = 0; at < ends.length; at += 1) {
    const descriptionEnd = ends[at] as number;
    const escapeAware = at >= blind;
    const inline = readInlineDestination(content, index, descriptionEnd, destinations);
    if (inline) {
      constructs.push({
        kind: "inline",
        url: inline.url,
        start: inline.start,
        descriptionEnd,
        end: inline.end,
        escapeAware,
      });
      continue;
    }
    // No definition in this document, or no caller that would read one, so no
    // bracket run needs to be read as a label.
    if (!wantReference || budget.maxLength === 0) continue;

    // `[` immediately after ⇒ a FULL reference when the label is non-empty and
    // the COLLAPSED form when it is empty; nothing after ⇒ the SHORTCUT form.
    // Collapsed and shortcut both take the label from the DESCRIPTION, which is
    // CommonMark's own rule and the half T46's enumeration inherited rather than
    // re-derived (T66#F-002). The label's own `]` comes from the same close
    // index the description used, so the old sticky `\[([^\]]*)\]` is gone: it
    // read the same bytes and allocated them before anything had decided
    // whether they could possibly match.
    let labelStart = open + 1;
    let labelEnd = descriptionEnd - 1;
    let end = descriptionEnd;
    if (content[descriptionEnd] === "[") {
      const close = firstAtOrAfter(index.closes, descriptionEnd + 1);
      if (close !== -1) {
        end = close + 1;
        if (spanHasNonWhitespace(budget, descriptionEnd + 1, close)) {
          labelStart = descriptionEnd + 1;
          labelEnd = close;
        }
      }
    }
    const label = readLabel(content, index, budget, labelStart, labelEnd);
    if (label === null) continue;
    constructs.push({ kind: "reference", label, end, escapeAware });
  }
  return constructs;
}

// HTML start tags this detector reads. `<image>` is not a different element but
// the same one spelled differently: the HTML parser's "in body" insertion mode
// changes an `image` start tag's name to `img` and reprocesses the token, so
// `<image src>` fetches identically (T24R2#F-001). `<base>` fetches nothing and is
// read for the opposite reason — it re-points every relative URL in the document.
// The rest are the render-triggered surfaces T46 decided to cover; the ones it
// decided to leave open (`script`, `link`, CSS, `iframe srcdoc`) are deliberately
// ABSENT here, and the header comment says why.
//
// The lookahead is the tokenizer's own tag-name terminator set (whitespace, `/`,
// `>`), so `<imgur>`, `<based>`, `<inputs>` and `<videos>` are not these
// elements. Alternation order does not matter for the `t…` names: the lookahead
// rejects a short match that is followed by more name characters, and the engine
// then tries the longer alternative.
const HTML_START_TAG =
  /<(im(?:age|g)|feimage|base|input|meta|video|audio|source|track|embed|object|iframe|body|table|tbody|thead|tfoot|td|th|tr)(?=[\t\n\f\r />]|$)/gi;

// Which attribute of which element carries a destination a renderer fetches, and
// under which policy id. `srcset` values are candidate lists and are split; every
// other value is one destination.
//
// The ids group by WHAT is fetched, which is what a caller triaging a finding
// needs: an image (the existing id, extended to the elements that fetch one
// without being `<img>`), a media resource, or a whole embedded document.
// `<base href>` and `<meta http-equiv=refresh>` have their own branches below,
// because each is gated on something other than the attribute name.
//
// Two elements here are namespace-ambiguous and are read EAGERLY, the same
// direction every other extraction decision in this file errs in: `href` on
// `<image>` and on `<feImage>` fetches in the SVG namespace and is inert in the
// HTML one, and this scanner sees a fragment with no namespace context. So is
// `background` on a `<td>` written outside a table, which a tree builder drops.
// Both cost a masked destination in markup no renderer would have fetched; both
// were measured to have zero benign instances in this checkout (T46).
type DestinationKind = "url" | "srcset";
const IMAGE_POLICY = "egress.html-image-exfil";
const MEDIA_POLICY = "egress.html-media-exfil";
const EMBEDDED_POLICY = "egress.html-embedded-document-exfil";

const IMAGE_URL = { policyId: IMAGE_POLICY, kind: "url" as DestinationKind };
const IMAGE_SRCSET = { policyId: IMAGE_POLICY, kind: "srcset" as DestinationKind };
const MEDIA_URL = { policyId: MEDIA_POLICY, kind: "url" as DestinationKind };
const MEDIA_SRCSET = { policyId: MEDIA_POLICY, kind: "srcset" as DestinationKind };
const EMBEDDED_URL = { policyId: EMBEDDED_POLICY, kind: "url" as DestinationKind };
const BACKGROUND_ONLY = { background: IMAGE_URL };

const FETCHING_ATTRIBUTES: Record<
  string,
  Record<string, { policyId: string; kind: DestinationKind }>
> = {
  img: { src: IMAGE_URL, srcset: IMAGE_SRCSET },
  // SVG spells this element's destination `href`; HTML spells it `src`. Both.
  image: {
    src: IMAGE_URL,
    srcset: IMAGE_SRCSET,
    href: IMAGE_URL,
    "xlink:href": IMAGE_URL,
  },
  feimage: { href: IMAGE_URL, "xlink:href": IMAGE_URL },
  input: { src: IMAGE_URL }, // gated on type=image below
  video: { poster: IMAGE_URL, src: MEDIA_URL },
  audio: { src: MEDIA_URL },
  source: { src: MEDIA_URL, srcset: MEDIA_SRCSET },
  track: { src: MEDIA_URL },
  embed: { src: EMBEDDED_URL },
  object: { data: EMBEDDED_URL },
  iframe: { src: EMBEDDED_URL },
  body: BACKGROUND_ONLY,
  table: BACKGROUND_ONLY,
  tbody: BACKGROUND_ONLY,
  thead: BACKGROUND_ONLY,
  tfoot: BACKGROUND_ONLY,
  td: BACKGROUND_ONLY,
  th: BACKGROUND_ONLY,
  tr: BACKGROUND_ONLY,
};

// `src` on an input fetches ONLY when the type is `image`; on a text or hidden
// input no renderer requests it, so flagging it would be a pure false positive.
// A DUPLICATE `type` is resolved eagerly — any spelling of `image` enables the
// branch — which is the same direction as the duplicate-`src` over-approximation
// `readStartTag` already documents.
//
// The comparison runs on the DECODED value, for the same reason `renderableUrl`
// and `metaRefreshDestination` decode: the tokenizer consumes character
// references in the attribute-value states (§13.2.5.35-.39), so
// `type="&#105;mage"` IS an image submit button and `http-equiv="&#114;efresh"`
// IS a refresh in every engine. Comparing the raw bytes released both surfaces
// for one cheap spelling — seven of them measured reaching an MCP client with
// `redaction.state:"none"` (T66#F-001). This is the ONLY helper in the module
// that decides on an attribute VALUE; every other branch keys off the attribute
// NAME, which a tokenizer does not entity-decode, so fixing it here closes the
// class rather than its two current members.
//
// Decoded for CLASSIFICATION only. The caller still masks `attribute.value` at
// `attribute.valueStart`, so the offsets stay on the bytes as they were written.
// The match stays EXACT after `trim().toLowerCase()`: `refresh&#59;` decodes to
// `refresh;`, which no renderer refreshes on, and a prefix or substring test
// here would invent a surface instead of describing one.
function hasAttributeValue(
  attributes: ReadonlyArray<HtmlAttribute>,
  name: string,
  expected: string,
): boolean {
  return attributes.some(
    (attribute) =>
      attribute.name === name &&
      decodeCharacterReferences(attribute.value).trim().toLowerCase() === expected,
  );
}

// The HTML "shared declarative refresh steps" content grammar, permissively:
//   <time> [ (";" | ",") ] [ "url" [ "=" ] ] <url>
// with the URL optionally wrapped in matching single or double quotes. Every
// engine also accepts the destination with the `url` keyword omitted, so the
// keyword group is optional. Permissive is the correct direction here: a
// spelling this grammar does not recognise is a destination the floor releases.
//
// Character references are decoded FIRST, because a renderer decodes the
// attribute value before running this grammar on it — `content="0&#59;url=…"` is
// the same directive as `content="0;url=…"`.
const META_REFRESH_CONTENT =
  /^\s*[0-9.]*\s*(?:[;,]\s*)?(?:url\b\s*=?\s*)?([\s\S]*)$/i;

function metaRefreshDestination(rawContent: string): string | null {
  const match = META_REFRESH_CONTENT.exec(decodeCharacterReferences(rawContent));
  if (!match) {
    return null;
  }
  let destination = (match[1] ?? "").trim();
  const quote = destination[0];
  if (destination.length >= 2 && (quote === '"' || quote === "'")) {
    const close = destination.indexOf(quote, 1);
    destination = close === -1 ? destination.slice(1) : destination.slice(1, close);
  }
  return destination.length > 0 ? destination : null;
}

// HTML whitespace, per the tokenizer: tab, LF, FF, CR, space. Deliberately NOT
// `\s`, which also matches U+00A0 and U+2028 — characters a real tokenizer keeps
// inside the tag name, making the element unknown and non-fetching.
function isHtmlSpace(character: string): boolean {
  return (
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r" ||
    character === " "
  );
}

interface HtmlAttribute {
  name: string;
  value: string;
  valueStart: number;
}

// Walk one start tag's attribute list the way the HTML tokenizer does
// (HTML Standard §13.2.5: before-attribute-name → attribute-name →
// after-attribute-name → before-attribute-value → attribute-value-(double-quoted|
// single-quoted|unquoted) → after-attribute-value), starting just after the tag
// name. Returns the attributes and the index just PAST the tag.
//
// This is hand-rolled on purpose and only for ATTRIBUTES — the URL parsing stays
// the platform's. A character class cannot do this job, and that is what failed:
// `[^>]*?` assumed `>` ends a tag, but in a quoted-value state `>` is ordinary
// data, so `<img alt="a>b" src=…>` matched nothing and the element was never
// extracted at all; and an unanchored `\bsrc` matched inside an attribute VALUE,
// so `<img alt="src=/safe" src=…>` captured the decoy and skipped the real
// destination (T42#F-001). Reading names only from the name position, and
// resuming the scan past the tag's own `>`, fixes both — and the second half also
// keeps `<img alt="<img src=…>" src="/a.png">`, which is text and not an element,
// from becoming a false positive.
//
// Two places this is deliberately more eager than a conformant tree builder, both
// erring toward flagging: a duplicate attribute (a tree builder keeps the first;
// classifying both costs nothing) and a TAG left unterminated at end of input (a
// tree builder emits no element for it; our input is a FRAGMENT, so the renderer
// may hold the terminator we do not — and the previous regex did not require a `>`
// either).
//
// That "renderer may hold the terminator we do not" premise does not apply
// symmetrically to the OTHER eof case this same loop implements (T53#F-003): an
// unterminated QUOTED VALUE (`close === -1` below) consumes to end of input,
// advances the scan past the end, and any later `<img src=…>` in the fragment is
// never examined — the opposite of eager. That is not a hole: a conformant
// tokenizer emits no element there either (an unclosed quote consumes the rest of
// ITS document too, terminator or not), so this half is CONSERVATIVE rather than
// lax, and is measured faithful against an independent tokenizer, not merely
// assumed — `<img alt="x <img src=…>` reads the inner `<img` as text inside the
// unterminated value, and a real parser fetches nothing from it either.
function readStartTag(
  content: string,
  from: number,
): { attributes: HtmlAttribute[]; end: number } {
  const attributes: HtmlAttribute[] = [];
  let index = from;

  while (index < content.length) {
    // before attribute name: whitespace and `/` are ignored here
    while (
      index < content.length &&
      (isHtmlSpace(content[index] as string) || content[index] === "/")
    ) {
      index += 1;
    }
    if (index >= content.length) break;
    if (content[index] === ">") {
      index += 1;
      break;
    }

    // attribute name: the FIRST character is taken unconditionally, so a leading
    // `=` becomes part of the name — the spec's
    // unexpected-equals-sign-before-attribute-name rule, and the thing that keeps
    // this loop making progress.
    let nameEnd = index + 1;
    while (nameEnd < content.length) {
      const character = content[nameEnd] as string;
      if (
        isHtmlSpace(character) ||
        character === "/" ||
        character === ">" ||
        character === "="
      ) {
        break;
      }
      nameEnd += 1;
    }
    const name = content.slice(index, nameEnd).toLowerCase();
    index = nameEnd;

    // after attribute name: an `=`, possibly spaced, introduces a value
    let cursor = index;
    while (cursor < content.length && isHtmlSpace(content[cursor] as string)) {
      cursor += 1;
    }
    if (cursor >= content.length || content[cursor] !== "=") {
      attributes.push({ name, value: "", valueStart: index });
      continue;
    }
    cursor += 1;
    while (cursor < content.length && isHtmlSpace(content[cursor] as string)) {
      cursor += 1;
    }

    const quote = content[cursor];
    if (quote === '"' || quote === "'") {
      const valueStart = cursor + 1;
      const close = content.indexOf(quote, valueStart);
      const valueEnd = close === -1 ? content.length : close;
      attributes.push({
        name,
        value: content.slice(valueStart, valueEnd),
        valueStart,
      });
      index = close === -1 ? content.length : close + 1;
      continue;
    }

    const valueStart = cursor;
    let valueEnd = valueStart;
    while (
      valueEnd < content.length &&
      !isHtmlSpace(content[valueEnd] as string) &&
      content[valueEnd] !== ">"
    ) {
      valueEnd += 1;
    }
    attributes.push({
      name,
      value: content.slice(valueStart, valueEnd),
      valueStart,
    });
    index = valueEnd;
  }

  return { attributes, end: index };
}

// WHY THERE IS NO "the tag is inside an inert span, so it is not a finding" rule
// here, and what it would take to add one (T62#F-001, reverted in T67).
//
// The pull is real and it is recorded rather than forgotten, because the next
// person to see `<base href>` flagged in a page that merely DOCUMENTS `<base>`
// will feel it: a false `<base>` positive is a whole-document effect (T53#F-001),
// and quoting the element inside a fenced code block or an HTML comment is
// exactly the shape benign documentation takes. T63 acted on that pull and
// suppressed the finding inside a span two regexes showed was closed — an HTML
// comment (`/<!--[\s\S]*?-->/`) and a CommonMark fenced code block (a
// left-to-right pairing of fence-marker lines).
//
// It was reverted because approximating a grammar with a regex is wrong in the
// one direction where being wrong RELEASES attacker-controlled bytes. Six
// payloads produced no finding at all, four of them measured leaking the attacker
// host at all four public boundaries with `redaction.state:"none"` and an empty
// `reasons` array — the caller was not even told anything had been considered:
//   - `<!-->` and `<!--->` end a comment in the comment-start / comment-start-dash
//     states (abrupt-closing-of-empty-comment) and `--!>` ends one in the
//     comment-end-bang state. All three end it BEFORE the attacker's `<base>`,
//     while a `-->`-only regex runs past the tag to a later terminator and calls
//     the live element inert. Five bytes, `<!-->`, is the whole attack.
//   - Fence spans and comment spans computed independently of one another pair
//     delimiters no renderer pairs: a fence marker quoted inside a comment, or
//     comment delimiters quoted inside fences or code spans, produce a "closed
//     span" over a base that both renderer models draw live.
// The bound the rule relied on — "only a span whose opening AND closing delimiter
// are both present counts" — does foreclose blanket suppression by an unterminated
// `<!--`, but presence of a matching pair of THIS code's delimiters is not
// evidence that a renderer draws a span between them, and every bypass above
// supplies such a pair.
//
// So the standing ruling is T53's: keep the class, keep the empty-allowlist
// default, and let the ALLOWLIST be the remedy for a benign CDN base; the cost of
// the remaining false positive is a masked URL in a rendered document, and the
// cost of the false negative it would buy back is a silent request to an
// attacker's host.
//
// This is NOT "context detection is undesirable". It could be revisited by an
// implementation that decides the span with the same conformant tokenizer the
// reviewers used as an oracle (lol-html, via `HTMLRewriter`) plus a real
// CommonMark pass — the discipline `readStartTag` already applies to attributes —
// failing toward FLAGGING on every ambiguity rather than only on an unterminated
// delimiter, and whose acceptance evidence includes hostile payloads placed inside
// every span kind it recognizes, not only benign ones removed from the finding
// list. The measurement that must go green is `T62-exfil.ts` (0 bypasses of 13)
// and `T62-boundary.ts` (0 leaking at four boundaries).

const SENSITIVE_URL_VALUE =
  /(?:[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)=|\/(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\/)[^&#/?\s]+/i;

// Does this inline LINK destination carry an explicit credential locator?
// Memoised by description end for the same reason the destination itself is:
// many opening brackets can share one description end, and re-running a regex
// over the same (possibly very long) destination once per bracket is quadratic.
function isSensitiveDestination(
  url: string,
  descriptionEnd: number,
  cache: Map<number, boolean>,
): boolean {
  const cached = cache.get(descriptionEnd);
  if (cached !== undefined) return cached;
  const sensitive = SENSITIVE_URL_VALUE.test(url);
  cache.set(descriptionEnd, sensitive);
  return sensitive;
}

// How many candidate boundaries a `srcset` value carries, counted without
// allocating the split.
function countCommas(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x2c) total += 1;
  }
  return total;
}

export function detectExfil(
  content: string,
  allowlist: string[] = [],
): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  let m: RegExpExecArray | null;

  // Build the reference-definition table (ref → { url, start }) FIRST, because
  // it is what decides whether any bracket run in this document can be a label
  // at all, and how long one has to be before it certainly cannot (LabelBudget).
  // Nothing is pushed to `matches` here, so match order is unaffected by the
  // table being built before the index rather than after it.
  //
  // EVERY definition of a label is kept, not the last one (T78#F-002). The
  // table used to be written with `Map.set`, so a document that defined the
  // same label twice had its SECOND definition masked while CommonMark — «if
  // there are several matching definitions, the first one takes precedence» —
  // and `marked` resolve and fetch the FIRST. Six spellings reached all four
  // public boundaries with the attacker's host still in the payload AND
  // `redaction.state:"redacted"`, which is worse than a plain release because
  // the caller is told it was handled.
  //
  // The repair keeps a LIST and flags every entry rather than swapping which
  // one wins. Picking first-wins would be correct for CommonMark and would be
  // another bet on one renderer's reading of the same bytes, which is this
  // file's one recurring defect; flagging all of them is correct under either
  // precedence rule and costs one extra masked URL in a document with an
  // accidental duplicate.
  //
  // A definition whose label carries a backslash-escaped `]` is read too, under
  // the key the USE side produces — the label's bytes up to its first `]`
  // (T82#F-001). See `readReferenceDefinitions` for what that does to the cost
  // proof: step (i) survives, for a stronger reason than the one it replaces.
  const {
    refs,
    maxLength: maxLabelLength,
    maxOpenBrackets: maxLabelOpenBrackets,
  } = readReferenceDefinitions(content);

  // Pair every bracket in the input once, up front, and index the `)` positions
  // and the non-whitespace prefix counts in the same pass; the markdown passes
  // read these instead of walking the input again per opening bracket.
  const index = indexContent(content, maxLabelLength > 0);
  const budget: LabelBudget = {
    maxLength: maxLabelLength,
    maxOpenBrackets: maxLabelOpenBrackets,
    nonWhitespace: index.nonWhitespace,
    work: LABEL_WORK_FACTOR * content.length,
    exhausted: false,
  };
  // One inline-destination reading per description end, shared by both passes.
  const destinations = new Map<number, InlineDestination>();

  // Inline images and links. Images are auto-fetched by renderers. An inline
  // link is a finding here only when it embeds a sensitive query/path value;
  // otherwise a public link by itself is not an exfil action.
  //
  // The inline pass and the reference pass below stay SEPARATE walks, in this
  // order, although both now read the same constructs: merging them would
  // reorder `matches` for a document carrying both, and match order is
  // observable through `applyRedaction` and through every prior matrix.
  //
  // WHAT THE SCAN MAY SKIP, and why the two cases differ (T72#F-001).
  //
  // T71 resumed the scan past the WHOLE construct whenever one was resolved.
  // For `[![alt](URL)](href)` — the README badge idiom, `[![build](badge)](ci)`,
  // which opens a large fraction of all READMEs — the outer bracket's balanced
  // reading is the link, `isImage` is read from the outer bracket's missing `!`,
  // and resuming past the link discarded the image nested inside it. `marked`
  // emits `<img src="…">` for five measured spellings of that shape and all five
  // reached an MCP client with `redaction.state:"none"`.
  //
  // CommonMark draws the line, and it is not symmetric:
  //   - an IMAGE's description is ALT TEXT. A construct written inside it
  //     contributes characters to the alt attribute and is not fetched —
  //     `![a[b](INNER)](OUTER)` renders one image, `OUTER` — so resuming past
  //     the whole construct is faithful, and is kept.
  //   - a LINK's description is CONTENT. An image written inside it renders and
  //     is fetched with no click, so the description must still be scanned.
  //     Only the link's DESTINATION span is skipped, which is what keeps the
  //     walk linear: the destination is the part a renderer reads as a URL, not
  //     as markdown, and skipping it is also what stops `[a](http://h/[x](y))`
  //     from being read as two constructs.
  let destinationStart = -1;
  let destinationEnd = -1;
  const sensitive = new Map<number, boolean>();
  const flaggedInlineStarts = new Set<number>();
  BRACKET_OPEN.lastIndex = 0;
  while ((m = BRACKET_OPEN.exec(content)) !== null) {
    const isImage = m[1] === "!";
    const open = m.index + m[0].length - 1;
    if (open >= destinationStart && open < destinationEnd) {
      BRACKET_OPEN.lastIndex = destinationEnd; // inside a destination, not markdown
      continue;
    }
    const inline = readBracketConstructs(
      content,
      index,
      open,
      destinations,
      budget,
      false, // this pass reads only inline constructs
    ).find((construct) => construct.kind === "inline");
    if (!inline || inline.kind !== "inline") {
      continue; // not an inline construct; the scan resumes just inside it
    }
    // A construct that exists only because of an ESCAPE-AWARE candidate end is
    // FLAGGED but never SKIPS, and that asymmetry is a measured requirement
    // rather than caution. Fuzzing found a document whose first line grew a
    // spurious LINK through a new end — its destination grammar then ran across
    // the newline and swallowed the whole of the next line, whose genuine
    // `![bc\](<URL>)` image stopped being scanned and stopped being a finding.
    // Skipping is an optimisation justified by a renderer resolving the outer
    // construct, and for a candidate this file added itself that is exactly the
    // thing not yet established. So the new ends may only ADD.
    if (inline.escapeAware) {
      // fall through to the classification below without moving the cursor
    } else if (isImage) {
      BRACKET_OPEN.lastIndex = inline.end; // alt text: nothing inside is fetched
    } else {
      destinationStart = inline.descriptionEnd;
      destinationEnd = inline.end;
    }
    // Not skipping a link's description means several opening brackets can
    // resolve to the SAME destination span (`"[".repeat(n) + "](URL)"` gives
    // every one of them the same `]`). One span is one finding, and dropping
    // out here is also what keeps the classification off the hot path.
    if (flaggedInlineStarts.has(inline.start)) continue;
    if (
      !isImage &&
      !isSensitiveDestination(inline.url, inline.descriptionEnd, sensitive)
    ) {
      continue;
    }
    flaggedInlineStarts.add(inline.start);
    considerUrl(
      {
        url: inline.url,
        start: inline.start,
        policyId: isImage
          ? "egress.markdown-image-exfil"
          : "egress.markdown-link-sensitive-value",
      },
      allowlist,
      matches,
    );
  }

  // Reference-style uses remain guarded as an indirect injection surface. They
  // resolve to their definition's URL span, so redacting the definition
  // neutralizes every use that points at it. All three CommonMark spellings
  // resolve here — full `![a][ref]`, collapsed `![a][]` and shortcut `![a]` —
  // because a renderer fetches all three (T66#F-002).
  //
  // The `!` gate is unchanged and load-bearing: a plain reference LINK is
  // click-gated, so `[a]`, `[a][]` and `[a][ref]` stay released, and so does a
  // reference DEFINITION line, which is itself a shortcut-shaped bracket run
  // carrying no `!`.
  //
  // A document that defines no labels cannot resolve a reference use, so this
  // walk does not run at all — which is also what keeps a bare bracket run from
  // being read as a label once per opening bracket.
  destinationStart = -1;
  destinationEnd = -1;
  BRACKET_OPEN.lastIndex = 0;
  const flaggedRefStarts = new Set<number>();
  while (refs.size > 0 && (m = BRACKET_OPEN.exec(content)) !== null) {
    const isImage = m[1] === "!";
    const open = m.index + m[0].length - 1;
    if (open >= destinationStart && open < destinationEnd) {
      BRACKET_OPEN.lastIndex = destinationEnd; // inside a destination, not markdown
      continue;
    }
    const constructs = readBracketConstructs(
      content,
      index,
      open,
      destinations,
      budget,
      isImage, // only an image open's reference construct is ever read below
    );
    const inline = constructs.find((construct) => construct.kind === "inline");
    if (inline && inline.kind === "inline") {
      // A renderer resolves this as an inline construct, so its description is
      // not a reference use: an inline destination wins over a definition of
      // the same label, and the definition is not additionally flagged. The
      // same image/link asymmetry as the inline pass applies to what may be
      // skipped — `[![badge]](href)` carries a shortcut reference IMAGE inside a
      // link's description, and skipping the description released it (T72#F-001).
      //
      // …and an ESCAPE-AWARE-only construct skips nothing at all, for the reason
      // the inline pass states. It also does not `continue`: suppressing the
      // reference reading on the strength of a candidate end this file added
      // itself would be the same release seen from the other pass.
      if (!inline.escapeAware) {
        if (isImage) BRACKET_OPEN.lastIndex = inline.end;
        else {
          destinationStart = inline.descriptionEnd;
          destinationEnd = inline.end;
        }
        continue;
      }
    }
    if (!isImage) continue;
    for (const construct of constructs) {
      if (construct.kind !== "reference") continue;
      const defs = refs.get(construct.label);
      if (!defs) continue;
      // Same rule once more: an escape-aware-only reference construct is
      // flagged, but the scan is not resumed past it.
      if (!construct.escapeAware) BRACKET_OPEN.lastIndex = construct.end;
      // Every definition of this label, not one of them: which one a renderer
      // fetches is a precedence rule, and the floor does not bet on one
      // (T78#F-002).
      for (const def of defs) {
        if (flaggedRefStarts.has(def.start)) continue;
        flaggedRefStarts.add(def.start);
        considerUrl(
          { url: def.url, start: def.start, policyId: "egress.reference-link-exfil" },
          allowlist,
          matches,
        );
      }
      break;
    }
  }

  // The label path's work budget ran out, which means some bracket run was left
  // unexamined. The only way a document reaches this is by defining a label
  // that itself carries `[`, which raises the one threshold above that a
  // payload can raise (T78#F-001). What is NOT examined must not be released,
  // so every definition in the table is flagged — the allowlist still decides
  // whether each is a finding, so this widens what is examined rather than what
  // is denied.
  if (budget.exhausted) {
    for (const defs of refs.values()) {
      for (const def of defs) {
        if (flaggedRefStarts.has(def.start)) continue;
        flaggedRefStarts.add(def.start);
        considerUrl(
          { url: def.url, start: def.start, policyId: "egress.reference-link-exfil" },
          allowlist,
          matches,
        );
      }
    }
  }

  // HTML start tags, walked once left to right. Each tag's attributes are read
  // with the tokenizer's states and the scan then resumes past that tag, so
  // markup written inside a quoted value stays data.
  HTML_START_TAG.lastIndex = 0;
  while ((m = HTML_START_TAG.exec(content)) !== null) {
    const tag = (m[1] ?? "").toLowerCase();
    const nameEnd = m.index + m[0].length;
    const { attributes, end } = readStartTag(content, nameEnd);
    HTML_START_TAG.lastIndex = Math.max(end, nameEnd);

    // Resuming past this tag's own `>` is a DECISION, not a side effect
    // (T53#F-004): it is what keeps markup written inside another element's
    // quoted attribute value from being read as a second element —
    // `<img alt="<img src=https://attacker.invalid/p>" src="/a.png">` releases
    // the inner `src=` unmasked, because for ANY conformant HTML parser that text
    // is an attribute VALUE, not a start tag, and no renderer fetches it. Since
    // the `<base>` inert-span check was reverted (T62#F-001), this is the ONLY
    // place in this floor that trusts the READER's parser rather than assuming the
    // worst of it; every other extraction decision in this file errs toward
    // flagging, and this one survives on evidence the reverted rule never had —
    // it was measured against 88 tokenizer cases with an independent oracle. The
    // trade is accepted, not incidental: a renderer that does not tokenize HTML
    // conformantly — a regex-based markdown-to-HTML pass, a sanitizer that strips
    // tags and re-emits their contents as text — is outside the threat model this
    // floor targets, the auto-render behaviour of a markdown client with raw-HTML
    // passthrough (this file's header comment, T24R2#F-001).

    // Two surfaces are gated on an attribute OTHER than the one carrying the
    // destination, so the whole attribute list has to be in hand before either
    // branch can decide (T46). Both gates are computed once per tag.
    const sites = FETCHING_ATTRIBUTES[tag];
    if (tag === "input" && !hasAttributeValue(attributes, "type", "image")) {
      continue; // `src` on a non-image input fetches nothing
    }
    const isMetaRefresh =
      tag === "meta" && hasAttributeValue(attributes, "http-equiv", "refresh");

    for (const attribute of attributes) {
      if (attribute.value.length === 0) continue;

      // <meta http-equiv=refresh> is the one NAVIGATION surface: on render the
      // client goes to the destination, so what leaks is not one subresource
      // request but the whole session's next page. The destination sits inside a
      // directive that is not itself a URL, so the directive is CLASSIFIED after
      // the refresh grammar extracts the URL from it and MASKED whole — leaving
      // `content="0;url="` behind would be a directive with no meaning.
      if (tag === "meta") {
        if (isMetaRefresh && attribute.name === "content") {
          const destination = metaRefreshDestination(attribute.value);
          if (destination) {
            considerUrl(
              {
                url: attribute.value,
                classify: destination,
                start: attribute.valueStart,
                policyId: "egress.html-meta-refresh-exfil",
                remediation: META_REFRESH_REMEDIATION,
              },
              allowlist,
              matches,
            );
          }
        }
        continue;
      }

      // <base href> is not auto-fetched. It re-points every RELATIVE destination
      // in the document, which is the assumption the two-base rule rests on, so a
      // base that carries its OWN authority is a document-level egress channel.
      // Masking it puts the document base back inside the reader's own origin, so
      // the relative destinations around it are same-origin again (T42#F-006).
      //
      // The cost of getting this WRONG is not symmetric with `<img src>`
      // (T53#F-001): a masked `<img src>` breaks one image; a masked
      // `<base href>` re-points EVERY relative URL in the document, so one false
      // positive here is a whole-document effect. That asymmetry is disclosed to
      // the caller in `BASE_REMEDIATION` rather than acted on here: this branch
      // fires wherever the tag appears, including inside what looks like an HTML
      // comment or a fenced code block, and the allowlist is the remedy for a
      // benign base. The suppression that once sat on this line was a measured
      // bypass and was reverted — see the block comment above `SENSITIVE_URL_VALUE`
      // for the reason and for what a future implementation would have to prove.
      if (tag === "base") {
        if (attribute.name === "href") {
          considerUrl(
            {
              url: attribute.value,
              start: attribute.valueStart,
              policyId: "egress.html-base-href-exfil",
              remediation: BASE_REMEDIATION,
            },
            allowlist,
            matches,
          );
        }
        continue;
      }

      // Every remaining surface is one element/attribute pair in the table above,
      // read only from the attribute NAME position — the property that made the
      // extractor faithful in the first place (T42#F-001).
      const site = sites?.[attribute.name];
      if (!site) continue;

      if (site.kind === "url") {
        considerUrl(
          {
            url: attribute.value,
            start: attribute.valueStart,
            policyId: site.policyId,
          },
          allowlist,
          matches,
        );
        continue;
      }

      // srcset: a comma-separated candidate list, each entry `URL [descriptor]`.
      // Every candidate is auto-fetchable, so each is classified on its own. The
      // candidate split stops at whitespace on purpose: the srcset grammar itself
      // terminates a URL there, so unlike the markdown destinations this
      // truncation is renderer-faithful.
      //
      // The SPLIT, though, is a value GRAMMAR run on an attribute value, and a
      // renderer decodes character references in an attribute value BEFORE it
      // runs "parse a srcset attribute" on it — the same premise the two
      // attribute gates rest on (§13.2.5.35-.39). So `a.png&#44;https://…` is
      // ONE candidate to a raw split and TWO to a renderer, and under a
      // NON-EMPTY allowlist carrying the first candidate's host — the documented
      // remedy for every false positive in this floor — the second candidate
      // reached the client unmasked (T72#F-004).
      //
      // When decoding reveals a boundary the raw bytes do not carry, the decoded
      // candidates' offsets cannot be mapped back to raw spans one by one, and
      // offsets must stay on the raw bytes. So the decoded candidates are
      // classified and the WHOLE raw attribute value is masked if any of them is
      // a finding: a coarser span in the raw bytes, never a released one. When
      // the counts agree — every ordinary srcset — nothing about the existing
      // per-candidate path changes.
      const decodedValue = decodeCharacterReferences(attribute.value);
      if (countCommas(decodedValue) > countCommas(attribute.value)) {
        const reachable = decodedValue
          .split(",")
          .some((candidate) => {
            const url = candidate.trim().split(/\s+/)[0] ?? "";
            return url.length > 0 && isExfilDestination(url, allowlist);
          });
        if (reachable) {
          matches.push({
            category: "egress",
            policyId: site.policyId,
            severity: "critical",
            confidence: EXFIL_CONFIDENCE,
            start: attribute.valueStart,
            end: attribute.valueStart + attribute.value.length,
            value: attribute.value,
            mask: "url",
            remediation: FETCH_REMEDIATION,
          });
        }
        continue;
      }

      let offset = 0;
      for (const candidate of attribute.value.split(",")) {
        const url = candidate.trim().split(/\s+/)[0] ?? "";
        if (url) {
          considerUrl(
            {
              url,
              start: attribute.valueStart + offset + candidate.indexOf(url),
              policyId: site.policyId,
            },
            allowlist,
            matches,
          );
        }
        offset += candidate.length + 1; // + the comma that split removed
      }
    }
  }

  return matches;
}
