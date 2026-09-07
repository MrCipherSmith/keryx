// T78 — the benign-corpus +2, checked rather than accepted.
//
// T77 says the two extra findings are the SAME vector (`ex09-image-1x1-tracker`)
// in the two worktree copies of the repository's own attack fixture, released
// before because "a surrounding bracket pair in the JSON made it an image inside
// a link's description" — i.e. T72#F-001 firing on the repo's own fixture.
//
// The check: the ONLY markdown span the T77 change newly scans is a LINK's
// DESCRIPTION. So the explanation holds iff there is an opening `[` with no `!`
// whose resolved inline construct has `open < ex09.start < descriptionEnd`.
// This replicates `descriptionEnds` + `readInlineDestination` on the fixture's
// own bytes rather than trusting the narrative.
// Read-only, offline. No network.
import { detectExfil } from "../../../../src/security/detect/exfil";

const INLINE_DESTINATION = /\(\s*(?:<([^<>\n]*)>|([^)\s]+))[^)]*\)/y;

function index(content: string) {
  const balanced = new Map<number, number>();
  const closes: number[] = [];
  const open: number[] = [];
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    if (c === "[") open.push(i);
    else if (c === "]") {
      closes.push(i);
      const s = open.pop();
      if (s !== undefined) balanced.set(s, i + 1);
    }
  }
  return { balanced, closes };
}
function firstAtOrAfter(values: number[], from: number): number {
  for (const v of values) if (v >= from) return v;
  return -1;
}

const paths = [
  ".claude/worktrees/keryx-harness-phase-1-109f34/fixtures/exfil/cases.json",
  ".claude/worktrees/wizardly-chatelet-a166c6/fixtures/exfil/cases.json",
];

const report: Array<Record<string, unknown>> = [];
for (const path of paths) {
  const content = await Bun.file(path).text();
  const idx = index(content);
  const f = detectExfil(content, []);
  const ex09 = f.find((m) => String(m.value).includes("c2.example-attacker.com"));
  const enclosing: Array<Record<string, unknown>> = [];
  if (ex09) {
    let target = ex09.start as number;
    while (target > 0 && content[target - 1] !== "[") target -= 1;
    target -= 1; // the image's own `[`, which is what had to be reachable
    for (let open = 0; open < target; open += 1) {
      if (content[open] !== "[") continue;
      const isImage = open > 0 && content[open - 1] === "!";
      const b = idx.balanced.get(open) ?? -1;
      const fc = firstAtOrAfter(idx.closes, open);
      for (const end of [b, fc === -1 ? -1 : fc + 1]) {
        if (end === -1) continue;
        if (content[end] !== "(") continue;
        INLINE_DESTINATION.lastIndex = end;
        const m = INLINE_DESTINATION.exec(content);
        if (!m) continue;
        if (INLINE_DESTINATION.lastIndex <= target) continue;
        enclosing.push({
          open,
          isImage,
          targetInDescription: target < end,
          targetInDestination: target >= end,
          descriptionEnd: end,
          constructEnd: INLINE_DESTINATION.lastIndex,
          destination: (m[1] ?? m[2] ?? "").slice(0, 60),
          openContext: content.slice(Math.max(0, open - 40), open + 20).replace(/\n/g, "\\n"),
        });
      }
    }
  }
  report.push({
    path,
    findings: f.length,
    ex09Start: ex09 ? ex09.start : null,
    enclosingInlineConstructsContainingEx09: enclosing.length,
    enclosingLinks: enclosing.filter((e) => e.isImage === false).length,
    detail: enclosing.slice(0, 4),
    explanationHolds: enclosing.some((e) => e.isImage === false && e.targetInDescription === true),
  });
}

console.log(JSON.stringify({ probe: "T78-corpus", report }, null, 2));
