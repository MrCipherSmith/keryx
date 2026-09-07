// T83 — differential fuzz. The reference-definition table stopped being a regex
// (`/^[ \t]*\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|(\S+))/gm`) and became a hand-written
// linear scan. The load-bearing claim is that the scan's FIRST reading
// reproduces that pattern exactly, and that its second reading is purely
// ADDITIVE — so no document may lose a finding.
//
// This probe does not read the table (it is not exported, and it does not need
// to be). It drives whole documents through the shipped detector and records
// every finding's offset and value, over a deterministic corpus built from the
// characters the pattern is sensitive to: `[`, `]`, `\`, `:`, `!`, spaces, tabs,
// newlines, angle brackets and a URL. Run it on the pre-change tree and on the
// post-change tree and diff the two logs:
//
//   a finding present BEFORE and absent AFTER is a RELEASE — there must be none;
//   a finding present AFTER only is the repair, and every one of them must come
//   from a document containing `\]`.
//
// Read-only, offline, synthetic and reserved hosts only.
// Usage: bun T83-parity.ts
import { detectExfil } from "../../../../src/security/detect/exfil";

const U = "https://attacker.invalid/p";
const OK = "https://ok.example.org/x";

// xorshift32, so the corpus is identical on both trees.
let seed = 0x5eed1234;
function next(): number {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed;
}
function pick<T>(values: T[]): T {
  return values[next() % values.length] as T;
}

const ATOMS = [
  "[", "]", "\\", "\\]", "\\[", "\\\\", ":", "!", "![", " ", "\t", "\n", "\r",
  "a", "bc", "def", "<", ">", U, OK, "]:", "]: ", "\n[", "\n  [", "&#93;", "İ", "ΟΣ",
];

const documents: string[] = [];
// 1) purely random atom strings
for (let i = 0; i < 12000; i += 1) {
  const length = 2 + (next() % 12);
  let text = "";
  for (let j = 0; j < length; j += 1) text += pick(ATOMS);
  documents.push(text);
}
// 2) definition-shaped documents with a random label and a random use
const LABEL_ATOMS = ["a", "b", "\\]", "\\[", "\\\\", "\\", "]", "[", " ", "\n", ":"];
for (let i = 0; i < 12000; i += 1) {
  const length = 1 + (next() % 5);
  let label = "";
  for (let j = 0; j < length; j += 1) label += pick(LABEL_ATOMS);
  const indent = pick(["", " ", "  ", "\t", "x "]);
  const destination = pick([U, OK, `<${U}>`, `<${OK}>`, ""]);
  const gap = pick([" ", "", "\n  ", "  \n"]);
  const use = pick([`![${label}]`, `![alt][${label}]`, `![${label}][]`, `[${label}]`, ""]);
  documents.push(`${use}\n\n${indent}[${label}]:${gap}${destination}\n`);
}

const rows = documents.map((text, at) => ({
  at,
  findings: detectExfil(text, []).map((m) => `${m.start}:${m.length}:${m.value}`),
}));

console.log(
  JSON.stringify(
    {
      probe: "T83-parity",
      documents: documents.length,
      documentsWithFindings: rows.filter((r) => r.findings.length > 0).length,
      totalFindings: rows.reduce((sum, r) => sum + r.findings.length, 0),
      rows: rows.filter((r) => r.findings.length > 0),
    },
    null,
    2,
  ),
);
