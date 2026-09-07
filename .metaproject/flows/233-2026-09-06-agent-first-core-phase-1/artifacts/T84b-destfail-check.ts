// T84b — independent follow-up on T84-cost.ts: `destFailWhitespaceTail` /
// `destFailNewlineTail` read >=1s well under a megabyte in the ladder run
// (12.6s at 262144 bytes, 198.3s at 1048576, exponent ~2.0). This checks:
//   (a) is it pre-existing (same shape driven through the reconstructed
//       pre-T83 copy) or specific to the new scanner;
//   (b) does it reach a public boundary (redactToolOutput, one call, no
//       repeated trials, at a modest size for speed).
// Single trial per point (not best-of-3) — this is a scoping check, not the
// authoritative measurement; T84-cost.ts's own re-run (already launched) is
// the measurement of record.
// Usage: T84_TMP=<dir> bun T84b-destfail-check.ts
import { redactToolOutput } from "../../../../src/mcp/redact-seam";
import { detectExfil as shipped } from "../../../../src/security/detect/exfil";

const TMP = process.env.T84_TMP as string;
const { detectExfil: pre } = (await import(`${TMP}/exfil-prechange.ts`)) as {
  detectExfil: typeof shipped;
};

function buildWhitespaceTail(bytes: number): string {
  const half = Math.floor(bytes / 2);
  return "[a\n".repeat(Math.floor(half / 3)) + "]:" + " ".repeat(half);
}
function buildNewlineTail(bytes: number): string {
  const half = Math.floor(bytes / 2);
  return "[a\n".repeat(Math.floor(half / 3)) + "]:" + "\n".repeat(half);
}

const sizes = [50000, 100000, 200000];
const rows: Array<Record<string, unknown>> = [];
for (const [id, build] of Object.entries({
  destFailWhitespaceTail: buildWhitespaceTail,
  destFailNewlineTail: buildNewlineTail,
})) {
  for (const bytes of sizes) {
    const text = build(bytes);
    let t = performance.now();
    const preFindings = pre(text, []).length;
    const preMs = performance.now() - t;
    t = performance.now();
    const postFindings = shipped(text, []).length;
    const postMs = performance.now() - t;
    rows.push({
      shape: id,
      bytes: text.length,
      preMs: Number(preMs.toFixed(1)),
      postMs: Number(postMs.toFixed(1)),
      preFindings,
      postFindings,
    });
  }
}

// boundary reproduction check, single call, at a size already shown costly
// in the ladder run (262144-byte-class)
const cwd = process.cwd();
const boundaryText = buildWhitespaceTail(262144);
const t0 = performance.now();
const seamText = await redactToolOutput(cwd, JSON.stringify({ note: boundaryText }));
const seamMs = performance.now() - t0;

console.log(
  JSON.stringify(
    {
      probe: "T84b-destfail-check",
      rows,
      boundaryCheck: {
        shape: "destFailWhitespaceTail",
        bytes: boundaryText.length,
        seamMs: Number(seamMs.toFixed(1)),
        seamRanToCompletion: typeof seamText === "string",
      },
    },
    null,
    2,
  ),
);
