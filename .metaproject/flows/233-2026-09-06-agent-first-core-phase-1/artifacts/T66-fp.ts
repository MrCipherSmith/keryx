// T66 — testing the decision line itself, rather than accepting it.
//
// T46's criterion: "a quoted HTML or CSS file trips the DEFERRED surfaces with
// no particular content, while every COVERED surface requires a document that
// deliberately embeds something." This probe writes the realistic carriers a
// Keryx tool output actually returns (`ctx read` of a file, a wiki page, a
// README) and counts, per document, how many findings each side of the line
// produces — including three carriers T46's synthetic corpus does not contain
// and whose existence would weaken the line:
//   - an HTML email template, where the obsolete `background` attribute is not
//     obsolete at all (T46 U16: "benign incidence expected ~0 in modern source");
//   - a documentation redirect stub, which is a `<meta http-equiv=refresh>` and
//     nothing else (T46 U02: "masking it removes a navigation nobody wanted");
//   - a media-heavy docs page, the `<video>`/`<source>`/`<track>` carrier.
//
// Read-only, offline, synthetic hosts only.
// Usage: bun T66-fp.ts [out.json]
import { detectExfil } from "../../../../src/security/detect/exfil";

const CDN = "cdn.example.org";

type Doc = { id: string; side: "covered-side" | "deferred-side" | "control"; text: string; what: string };

const docs: Doc[] = [
  {
    id: "boilerplateHtmlPage",
    side: "deferred-side",
    what: "ctx read of an ordinary index.html — no particular content",
    text: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Docs</title>
<link rel="stylesheet" href="https://${CDN}/style.css">
<link rel="icon" href="https://${CDN}/favicon.ico">
<script src="https://${CDN}/app.js" defer></script>
</head>
<body>
<h1>Docs</h1>
</body>
</html>`,
  },
  {
    id: "ordinaryCssFile",
    side: "deferred-side",
    what: "ctx read of an ordinary site.css",
    text: `@import "https://${CDN}/reset.css";
@font-face { font-family: Inter; src: url(https://${CDN}/inter.woff2) format("woff2"); }
.hero { background-image: url(https://${CDN}/hero.png); }
.icon { background: image-set("https://${CDN}/i@1x.png" 1x); }`,
  },
  {
    id: "htmlEmailTemplate",
    side: "covered-side",
    what: "an HTML email template — where the `background` attribute is still ordinary practice",
    text: `<body background="https://${CDN}/mail/bg.png" bgcolor="#ffffff">
<table width="600" background="https://${CDN}/mail/frame.png" cellpadding="0">
  <tr background="https://${CDN}/mail/row.png">
    <td background="https://${CDN}/mail/cell.png" align="center">
      <img src="https://${CDN}/mail/logo.png" width="120" alt="logo">
    </td>
  </tr>
</table>
</body>`,
  },
  {
    id: "docsRedirectStub",
    side: "covered-side",
    what: "a generated documentation redirect stub — the whole file is one refresh",
    text: `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=https://docs.${CDN}/v3/getting-started/">
<title>Moved</title>
</head><body>This page has moved to <a href="https://docs.${CDN}/v3/getting-started/">the new location</a>.</body></html>`,
  },
  {
    id: "mediaHeavyDocsPage",
    side: "covered-side",
    what: "a docs page with a demo video and captions",
    text: `<h2>Walkthrough</h2>
<video controls poster="https://${CDN}/demo/poster.jpg" width="720">
  <source src="https://${CDN}/demo/walkthrough.webm" type="video/webm">
  <source src="https://${CDN}/demo/walkthrough.mp4" type="video/mp4">
  <track kind="captions" default src="https://${CDN}/demo/captions.vtt" srclang="en">
</video>`,
  },
  {
    id: "docsPageWithPlayer",
    side: "covered-side",
    what: "a docs page embedding a third-party player (T46 §6.1, the row it flags for pushback)",
    text: `# Quickstart

<iframe src="https://player.${CDN}/embed/abc" width="640" height="360" allowfullscreen title="demo"></iframe>

Run \`keryx init\` to begin.`,
  },
  {
    id: "reactMediaComponent",
    side: "covered-side",
    what: "ctx read of a .tsx using capitalised components (T46 §6.4)",
    text: `export function Hero() {
  return (
    <section>
      <Video src="https://${CDN}/hero.mp4" poster="https://${CDN}/hero.jpg" />
      <Source src="https://${CDN}/hero.webm" />
      <Iframe src="https://player.${CDN}/embed/hero" />
    </section>
  );
}`,
  },
  {
    id: "readmeBadges",
    side: "control",
    what: "a README with shields.io badges — the ALREADY accepted baseline cost",
    text: `# keryx

![build](https://img.shields.io/badge/build-passing-green)
![npm](https://img.shields.io/npm/v/keryx)`,
  },
  {
    id: "relativeOnlySite",
    side: "control",
    what: "a same-origin page — must produce nothing",
    text: `<link rel="stylesheet" href="/style.css"><script src="/app.js"></script>
<video src="/media/demo.mp4" poster="/media/poster.jpg"></video>
<iframe src="./embed.html"></iframe><td background="/bg.png">x</td>`,
  },
];

type Row = {
  id: string;
  side: string;
  findings: number;
  byPolicy: Record<string, number>;
  what: string;
};

const rows: Row[] = docs.map((doc) => {
  const findings = detectExfil(doc.text, []);
  const byPolicy: Record<string, number> = {};
  for (const f of findings) byPolicy[f.policyId] = (byPolicy[f.policyId] ?? 0) + 1;
  return { id: doc.id, side: doc.side, findings: findings.length, byPolicy, what: doc.what };
});

for (const r of rows) {
  console.log(
    `${r.id.padEnd(24)} side=${r.side.padEnd(14)} findings=${String(r.findings).padEnd(3)} ${JSON.stringify(r.byPolicy)}`,
  );
  console.log(`${" ".repeat(26)}${r.what}`);
}

const summary = {
  documents: rows.length,
  // the line T46 draws: deferred-side docs should be the ones tripping with no
  // particular content, covered-side docs only when they deliberately embed
  deferredSideFindings: rows.filter((r) => r.side === "deferred-side").map((r) => `${r.id}:${r.findings}`),
  coveredSideFindings: rows.filter((r) => r.side === "covered-side").map((r) => `${r.id}:${r.findings}`),
  controlFindings: rows.filter((r) => r.side === "control").map((r) => `${r.id}:${r.findings}`),
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, rows }, null, 2));
