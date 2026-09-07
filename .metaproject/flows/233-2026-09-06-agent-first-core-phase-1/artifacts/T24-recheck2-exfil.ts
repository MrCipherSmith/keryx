// T24 recheck 2 — adversarial matrix against the NEW character-reference decoder
// and URL classifier in src/security/detect/exfil.ts.
//
// Read-only. Synthetic only: reserved `attacker.invalid` / `example.org` domains,
// no credentials. Every case carries a WHATWG-URL oracle (`new URL(candidate,
// base)`) so "a renderer would fetch this" is measured, not asserted.
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const ATT = "attacker.invalid";
const BASE = "https://client.example.org/session/page";

// What host would a browser actually request for this attribute value, after HTML
// character-reference decoding? `decodeForRenderer` implements the HTML5 named
// references this test needs plus unbounded numeric runs — i.e. what a tokenizer does.
const RENDERER_NAMED: Record<string, string> = {
  Tab: String.fromCharCode(9),
  NewLine: String.fromCharCode(10),
  colon: ":",
  sol: "/",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
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

function rendererHost(attributeValue: string): string | null {
  try {
    return new URL(decodeForRenderer(attributeValue), BASE).hostname;
  } catch {
    return null;
  }
}

type Case = {
  id: string;
  // The whole content string handed to detectExfil.
  content: string;
  // The URL as written inside the attribute / destination, for the oracle.
  attributeValue: string;
  // true when the case is a benign control that MUST stay unflagged.
  control?: boolean;
  note: string;
};

const cases: Case[] = [
  // ---- controls that must never regress -------------------------------------
  {
    id: "ctl.publicMarkdownLink",
    content: "See [public documentation](https://docs.example.org/guide) for details.",
    attributeValue: "https://docs.example.org/guide",
    control: true,
    note: "ordinary public link — not an egress finding",
  },
  {
    id: "ctl.bareUrl",
    content: "Docs live at https://docs.example.org/guide today.",
    attributeValue: "https://docs.example.org/guide",
    control: true,
    note: "bare public URL",
  },
  {
    id: "ctl.relativeImage",
    content: '<img src="/assets/logo.png">',
    attributeValue: "/assets/logo.png",
    control: true,
    note: "same-origin relative image",
  },
  {
    id: "ctl.dataUriImage",
    content: '<img src="data:image/gif;base64,R0lGOD">',
    attributeValue: "data:image/gif;base64,R0lGOD",
    control: true,
    note: "data: URI, no host",
  },
  {
    id: "ctl.allowlistedHost",
    content: '<img src="https://docs.example.org/pixel.png">',
    attributeValue: "https://docs.example.org/pixel.png",
    control: false,
    note: "external host with empty allowlist — expected FLAGGED (deny-by-default)",
  },

  // ---- previously fixed vectors (must stay closed) ---------------------------
  { id: "fix.decimalEntity", content: `<img src="https&#58;//${ATT}/p?x=1">`, attributeValue: `https&#58;//${ATT}/p?x=1`, note: "decimal reference for ':'" },
  { id: "fix.hexEntityLower", content: `<img src="https&#x3a;//${ATT}/p">`, attributeValue: `https&#x3a;//${ATT}/p`, note: "hex reference" },
  { id: "fix.hexEntityUpperX", content: `<img src="https&#X3A;//${ATT}/p">`, attributeValue: `https&#X3A;//${ATT}/p`, note: "uppercase X + hex digits" },
  { id: "fix.namedColon", content: `<img src="https&colon;//${ATT}/p">`, attributeValue: `https&colon;//${ATT}/p`, note: "named reference &colon;" },
  { id: "fix.namedColonUpper", content: `<img src="https&COLON;//${ATT}/p">`, attributeValue: `https&COLON;//${ATT}/p`, note: "uppercase named reference" },
  { id: "fix.noSemicolon", content: `<img src="https&#58//${ATT}/p">`, attributeValue: `https&#58//${ATT}/p`, note: "semicolon omitted" },
  { id: "fix.zeroPaddedDecimal", content: `<img src="https&#00000058;//${ATT}/p">`, attributeValue: `https&#00000058;//${ATT}/p`, note: "zero-padded decimal (the T24R#F-002 vector)" },
  { id: "fix.zeroPaddedHex", content: `<img src="https&#x000003a;//${ATT}/p">`, attributeValue: `https&#x000003a;//${ATT}/p`, note: "zero-padded hex" },
  { id: "fix.tabEntityInScheme", content: `<img src="ht&#9;tps://${ATT}/p">`, attributeValue: `ht&#9;tps://${ATT}/p`, note: "tab reference inside the scheme" },
  { id: "fix.literalTabInScheme", content: `<img src="ht\ttps://${ATT}/p">`, attributeValue: `ht\ttps://${ATT}/p`, note: "literal tab inside the scheme" },
  { id: "fix.literalNewlineInScheme", content: `<img src="ht\ntps://${ATT}/p">`, attributeValue: `ht\ntps://${ATT}/p`, note: "literal LF inside the scheme" },
  { id: "fix.leadingSpace", content: `<img src=" https://${ATT}/p">`, attributeValue: ` https://${ATT}/p`, note: "leading space" },
  { id: "fix.leadingTabEntity", content: `<img src="&#9;https://${ATT}/p">`, attributeValue: `&#9;https://${ATT}/p`, note: "leading tab reference" },
  { id: "fix.doublyEncoded", content: `<img src="https&amp;#58;//${ATT}/p">`, attributeValue: `https&amp;#58;//${ATT}/p`, note: "doubly encoded" },
  { id: "fix.srcsetFirst", content: `<img srcset="https://${ATT}/p 1x">`, attributeValue: `https://${ATT}/p`, note: "srcset single candidate" },
  { id: "fix.srcsetSecond", content: `<img srcset="/local.png 1x, https://${ATT}/p 2x">`, attributeValue: `https://${ATT}/p`, note: "srcset second candidate" },
  { id: "fix.srcsetNoDescriptor", content: `<img srcset="https://${ATT}/p">`, attributeValue: `https://${ATT}/p`, note: "srcset without descriptor" },
  { id: "fix.schemeRelativeSrc", content: `<img src="//${ATT}/p">`, attributeValue: `//${ATT}/p`, note: "protocol-relative //host" },
  { id: "fix.markdownInlineImage", content: `![x](https://${ATT}/p)`, attributeValue: `https://${ATT}/p`, note: "markdown inline image" },
  { id: "fix.markdownRefImage", content: `![x][r]\n\n[r]: https://${ATT}/p`, attributeValue: `https://${ATT}/p`, note: "markdown reference image" },

  // ---- NEW attack axes -------------------------------------------------------
  // (a) named references the HTML5 table has but this decoder's table does not,
  //     whose decoded character the URL parser then REMOVES.
  { id: "new.namedTabInScheme", content: `<img src="ht&Tab;tps://${ATT}/p">`, attributeValue: `ht&Tab;tps://${ATT}/p`, note: "&Tab; = U+0009, stripped by the URL parser" },
  { id: "new.namedNewlineInScheme", content: `<img src="ht&NewLine;tps://${ATT}/p">`, attributeValue: `ht&NewLine;tps://${ATT}/p`, note: "&NewLine; = U+000A, stripped by the URL parser" },
  { id: "new.namedTabAfterScheme", content: `<img src="https&Tab;://${ATT}/p">`, attributeValue: `https&Tab;://${ATT}/p`, note: "&Tab; between scheme and ://" },
  { id: "new.leadingNamedTab", content: `<img src="&Tab;https://${ATT}/p">`, attributeValue: `&Tab;https://${ATT}/p`, note: "leading &Tab;" },

  // (b) backslash spellings of the authority delimiter. WHATWG treats \ as / for
  //     special schemes, so these fetch the attacker host from any base.
  { id: "new.backslashProtocolRelative", content: `<img src="\\\\${ATT}/p">`, attributeValue: `\\\\${ATT}/p`, note: "\\\\host — protocol-relative with backslashes" },
  { id: "new.backslashSchemeBoth", content: `<img src="https:\\\\${ATT}/p">`, attributeValue: `https:\\\\${ATT}/p`, note: "https:\\\\host" },
  { id: "new.backslashSchemeMixed", content: `<img src="https:/\\${ATT}/p">`, attributeValue: `https:/\\${ATT}/p`, note: "https:/\\host" },
  { id: "new.slashBackslashRelative", content: `<img src="/\\${ATT}/p">`, attributeValue: `/\\${ATT}/p`, note: "/\\host" },
  { id: "new.backslashEntity", content: `<img src="&#92;&#92;${ATT}/p">`, attributeValue: `&#92;&#92;${ATT}/p`, note: "backslashes written as references" },
  { id: "new.srcsetBackslash", content: `<img srcset="\\\\${ATT}/p 1x">`, attributeValue: `\\\\${ATT}/p`, note: "srcset candidate with backslashes" },

  // (c) extra slashes after the scheme.
  { id: "new.tripleSlash", content: `<img src="https:///${ATT}/p">`, attributeValue: `https:///${ATT}/p`, note: "https:///host" },
  { id: "new.fourSlash", content: `<img src="https:////${ATT}/p">`, attributeValue: `https:////${ATT}/p`, note: "https:////host" },
  { id: "new.threeSlashRelative", content: `<img src="///${ATT}/p">`, attributeValue: `///${ATT}/p`, note: "///host" },

  // (d) the `<image>` start tag, which the HTML parser rewrites to `img`.
  { id: "new.imageTag", content: `<image src="https://${ATT}/p">`, attributeValue: `https://${ATT}/p`, note: "<image> is parsed as <img> by every HTML parser" },
  { id: "new.imageTagEntity", content: `<image src="https&#58;//${ATT}/p">`, attributeValue: `https&#58;//${ATT}/p`, note: "<image> plus an entity" },

  // (e) markdown pointy-bracket destination, whose grammar permits a literal tab.
  { id: "new.markdownAngleTab", content: `![x](<ht\ttps://${ATT}/p>)`, attributeValue: `ht\ttps://${ATT}/p`, note: "markdown <...> destination with a literal tab" },
  { id: "new.markdownAngleLeadingSpace", content: `![x](< https://${ATT}/p>)`, attributeValue: ` https://${ATT}/p`, note: "markdown <...> destination with a leading space" },

  // (f) unquoted / single-quoted attribute forms.
  { id: "new.unquotedSrc", content: `<img src=https://${ATT}/p>`, attributeValue: `https://${ATT}/p`, note: "unquoted attribute" },
  { id: "new.singleQuotedSrc", content: `<img src='https&#58;//${ATT}/p'>`, attributeValue: `https&#58;//${ATT}/p`, note: "single-quoted attribute + entity" },

  // (g) case and whitespace around the attribute name.
  { id: "new.mixedCaseTag", content: `<IMG SRC="https://${ATT}/p">`, attributeValue: `https://${ATT}/p`, note: "uppercase tag/attribute" },
  { id: "new.newlineBeforeAttr", content: `<img\n  src="https://${ATT}/p">`, attributeValue: `https://${ATT}/p`, note: "newline before the attribute" },

  // (h) triple encoding — beyond the 3-pass bound but also beyond any renderer.
  { id: "new.tripleEncoded", content: `<img src="https&amp;amp;#58;//${ATT}/p">`, attributeValue: `https&amp;amp;#58;//${ATT}/p`, note: "triple-encoded; a renderer decodes ONCE so this should NOT fetch" },

  // (i) userinfo trick: host looks allowlisted but is not.
  { id: "new.userinfoHost", content: `<img src="https://docs.example.org@${ATT}/p">`, attributeValue: `https://docs.example.org@${ATT}/p`, note: "userinfo before the real host" },
];

const results = cases.map((c) => {
  const matches = detectExfil(c.content, []);
  const redacted = applyRedaction(c.content, matches);
  const oracleHost = rendererHost(c.attributeValue);
  const rendererWouldFetchAttacker = oracleHost === ATT;
  return {
    id: c.id,
    note: c.note,
    control: c.control === true,
    rendererHost: oracleHost,
    rendererWouldFetchAttacker,
    flagged: matches.length > 0,
    policyIds: [...new Set(matches.map((m) => m.policyId))],
    changed: redacted !== c.content,
    hostStillPresentAfterRedaction: redacted.includes(ATT),
    // The verdict that matters: a renderer fetches the attacker host but the
    // detector left the host in the output.
    bypass: rendererWouldFetchAttacker && redacted.includes(ATT),
    falsePositive: c.control === true && matches.length > 0,
    redacted,
  };
});

const bypasses = results.filter((r) => r.bypass).map((r) => r.id);
const falsePositives = results.filter((r) => r.falsePositive).map((r) => r.id);

const { writeFileSync } = await import("node:fs");
const out = process.argv[2] ?? "/tmp/T24-recheck2-exfil.json";
writeFileSync(
  out,
  JSON.stringify({ total: results.length, bypasses, falsePositives, results }, null, 2),
);
console.log(`wrote ${out}`);
console.log(`cases=${results.length} bypasses=${bypasses.length} falsePositives=${falsePositives.length}`);
console.log(`BYPASS: ${bypasses.join(", ") || "(none)"}`);
console.log(`FALSEPOS: ${falsePositives.join(", ") || "(none)"}`);
