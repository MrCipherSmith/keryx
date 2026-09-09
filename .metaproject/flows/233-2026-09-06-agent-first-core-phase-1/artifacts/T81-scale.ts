// T81 — where the LINEAR cost crosses one second, measured one shape per
// process so heap pressure from an earlier shape cannot be read as a cliff.
//
// Usage: bun T81-scale.ts <shape> <n>. The caller (T81-scale.sh) sweeps both.
// Synthetic hosts only, no network.
import { detectExfil } from "../../../../src/security/detect/exfil";

const OK = "https://ok.example.org/x";
const DEF = (length: number) => `[${"a".repeat(length)}]: ${OK}\n`;

const builders: Record<string, (n: number) => string> = {
  // The label path at its most expensive: every open is an image, every span is
  // a candidate label, and the definition raises every filter it can raise.
  bangRunManyCloses_withLongDef: (n) => DEF(200000) + "![a]".repeat(n),
  // The same body with NO definition: the label path never runs, so this is the
  // cost of the two markdown walks alone, unchanged by this round.
  bangRunManyCloses_noDef: (n) => "![a]".repeat(n),
  // Link opens with a definition present: no label work at all (the `!` gate),
  // but BOTH walks run, which is the pre-existing dominant term at this scale.
  linkRunManyCloses_withDef: (n) => DEF(200000) + "[a]".repeat(n),
  // T78's own worst shape.
  balancedNest_withLongDef: (n) => DEF(200000) + "[".repeat(n) + "]".repeat(n),
};

const shape = process.argv[2] ?? "";
const n = Number(process.argv[3] ?? "0");
const build = builders[shape];
if (!build || !n) {
  console.log(JSON.stringify({ error: "usage: T81-scale.ts <shape> <n>" }));
  process.exit(2);
}
const content = build(n);
let best = Infinity;
for (let run = 0; run < 3; run += 1) {
  const started = performance.now();
  detectExfil(content);
  best = Math.min(best, performance.now() - started);
}
console.log(
  JSON.stringify({
    shape,
    n,
    bytes: content.length,
    ms: Number(best.toFixed(1)),
    msPerMegabyte: Number(((best / content.length) * 1048576).toFixed(1)),
  }),
);
