// T84b — destFailWhitespaceTail at all four public boundaries, single call
// each, at a modest size (196608 bytes) chosen for speed while still being
// well under a megabyte. Supplementary to T84-cost.ts's own (slower,
// best-of-3, full-scale) boundary re-run.
import {
  prepareOutputForPersistence,
  validateOutputForTransport,
  type GuardResult,
} from "../../../../src/security/guard";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import { redactToolOutput } from "../../../../src/mcp/redact-seam";

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

function buildWhitespaceTail(bytes: number): string {
  const half = Math.floor(bytes / 2);
  return "[a\n".repeat(Math.floor(half / 3)) + "]:" + " ".repeat(half);
}

const text = buildWhitespaceTail(196608);
const serialized = JSON.stringify({ note: text });
const cwd = process.cwd();
const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }),
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: [
    {
      name: "p.x",
      module: "standard" as const,
      description: "destFailWhitespaceTail",
      inputSchema: { type: "object" },
      mutating: false,
      invoke: async () => ({ note: text }),
    },
  ],
};

let t = performance.now();
await dispatchCallTool(ctx, "p.x", {});
const mcpMs = performance.now() - t;

t = performance.now();
prepareOutputForPersistence(pass, serialized);
const persistMs = performance.now() - t;

t = performance.now();
validateOutputForTransport({ value: { note: text }, format: "json" });
const transportMs = performance.now() - t;

t = performance.now();
await redactToolOutput(cwd, serialized);
const seamMs = performance.now() - t;

console.log(
  JSON.stringify(
    {
      probe: "T84b-destfail-4boundary",
      bytes: text.length,
      boundaries: {
        mcp: Number(mcpMs.toFixed(1)),
        persist: Number(persistMs.toFixed(1)),
        transport: Number(transportMs.toFixed(1)),
        seam: Number(seamMs.toFixed(1)),
      },
      allOverOneSecond: [mcpMs, persistMs, transportMs, seamMs].every((ms) => ms > 1000),
    },
    null,
    2,
  ),
);
