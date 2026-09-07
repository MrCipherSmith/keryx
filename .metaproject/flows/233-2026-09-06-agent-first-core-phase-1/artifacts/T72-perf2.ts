// T72 — is the 263-second shape a REGRESSION or pre-existing?
//
// `openRunThenUnterminated` = a run of `[`, then `![a](`, then a run of
// non-`)` bytes. Measured on the SHIPPED detector and on a reconstruction of the
// two patterns T71 replaced, at sizes small enough to finish, so the growth of
// each can be compared rather than asserted.
//
// Read-only, offline, no network. Usage: bun T72-perf2.ts [out.json]
import { detectExfil } from "../../../../src/security/detect/exfil";

const OLD_INLINE = /(!?)\[[^\]]*\]\(\s*(?:<([^<>\n]*)>|([^)\s]+))[^)]*\)/g;
const OLD_REFERENCE_USE = /(!?)\[[^\]]*\]\[([^\]]+)\]/g;
function oldPatterns(text: string): number {
  let n = 0;
  OLD_INLINE.lastIndex = 0;
  while (OLD_INLINE.exec(text) !== null) n += 1;
  OLD_REFERENCE_USE.lastIndex = 0;
  while (OLD_REFERENCE_USE.exec(text) !== null) n += 1;
  return n;
}

const build = (half: number) => "[".repeat(half) + "![a](" + "A".repeat(half);

const rows: { bytes: number; shippedMs: number; oldMs: number; ratio: number }[] = [];
for (const half of [500, 1000, 2000, 3000]) {
  const text = build(half);
  let t0 = performance.now();
  detectExfil(text, []);
  const shippedMs = Math.round((performance.now() - t0) * 10) / 10;
  t0 = performance.now();
  oldPatterns(text);
  const oldMs = Math.round((performance.now() - t0) * 10) / 10;
  rows.push({
    bytes: text.length,
    shippedMs,
    oldMs,
    ratio: Math.round((shippedMs / Math.max(oldMs, 0.01)) * 100) / 100,
  });
  console.log(JSON.stringify(rows[rows.length - 1]));
}

// A minimal, realistic-looking payload: one unterminated markdown image in a
// 40 KB tool output, with nothing exotic around it.
const realistic =
  "# Report\n\n" +
  "Here is the chart ![chart](https://cdn.example.org/c.png) and the raw dump:\n\n" +
  "![dump](" +
  "0123456789abcdef".repeat(2500) + // 40 000 bytes, no `)` anywhere
  "\n";
const t0 = performance.now();
detectExfil(realistic, []);
const realisticMs = Math.round((performance.now() - t0) * 10) / 10;

const summary = {
  rows,
  shippedGrowthExponent:
    Math.round(
      (Math.log((rows[rows.length - 1] as { shippedMs: number }).shippedMs / (rows[0] as { shippedMs: number }).shippedMs) /
        Math.log((rows[rows.length - 1] as { bytes: number }).bytes / (rows[0] as { bytes: number }).bytes)) *
        100,
    ) / 100,
  oldGrowthExponent:
    Math.round(
      (Math.log((rows[rows.length - 1] as { oldMs: number }).oldMs / (rows[0] as { oldMs: number }).oldMs) /
        Math.log((rows[rows.length - 1] as { bytes: number }).bytes / (rows[0] as { bytes: number }).bytes)) *
        100,
    ) / 100,
  realisticPayloadBytes: realistic.length,
  realisticPayloadMs: realisticMs,
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify(summary, null, 2));
