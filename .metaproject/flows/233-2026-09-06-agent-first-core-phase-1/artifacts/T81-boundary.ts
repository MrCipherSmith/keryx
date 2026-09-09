// T81 — the four public boundaries on the worst shapes this round found, at a
// megabyte, which is far past anything the nine prior rounds measured. Advisory
// redaction OFF, so what is timed is the mandatory floor.
//
// One shape per process (see T81-boundary.sh) so heap pressure from an earlier
// shape cannot be read as a cliff. Synthetic hosts only, no network.
import {
  prepareOutputForPersistence,
  validateOutputForTransport,
  type GuardResult,
} from "../../../../src/security/guard";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import { redactToolOutput } from "../../../../src/mcp/redact-seam";

const OK = "https://ok.example.org/x";
const ATT = "attacker.invalid";
const DEF = (length: number) => `[${"a".repeat(length)}]: ${OK}\n`;

// Each builder fills `total` bytes, so the same size can be compared across
// shapes. `bytes` is the payload the boundary actually carries.
const builders: Record<string, (total: number) => string> = {
  // The worst per-byte shape found: a balanced bracket nest with a
  // 200 000-character definition raising every filter a document can raise.
  balancedNest_withLongDef: (total) => {
    const def = DEF(Math.floor(total / 4));
    const run = Math.max(1, Math.floor((total - def.length) / 2));
    return def + "[".repeat(run) + "]".repeat(run);
  },
  // Image opens, each one a candidate label.
  bangRunManyCloses_withLongDef: (total) => {
    const def = DEF(Math.floor(total / 4));
    return def + "![a]".repeat(Math.max(1, Math.floor((total - def.length) / 4)));
  },
  // The same body with NO definition, so the label path never runs at all: the
  // control that says how much of the cost is this round's and how much is the
  // floor's pre-existing per-byte cost.
  bangRunManyCloses_noDef: (total) => {
    const pad = Math.floor(total / 4);
    return "x".repeat(pad) + "![a]".repeat(Math.max(1, Math.floor((total - pad) / 4)));
  },
  // A definition label carrying 60 000 `[`, the only threshold a payload can
  // raise, so this is the shape that exhausts the total-work budget.
  budgetExhausting: (total) => {
    const def = `[${"[".repeat(60000)}x]: https://${ATT}/p?ctx=CTX\n`;
    // the trailing `]` is load-bearing: without a close there is no construct
    // to read as a label, so the budget is never spent and the definition is
    // released — correctly, because nothing in such a document resolves it.
    return def + "![".repeat(Math.max(1, Math.floor((total - def.length - 1) / 2))) + "]";
  },
};

const shape = process.argv[2] ?? "";
const total = Number(process.argv[3] ?? "1048576");
const build = builders[shape];
if (!build || !total) {
  console.log(
    JSON.stringify({ error: `usage: T81-boundary.ts <${Object.keys(builders).join("|")}> <bytes>` }),
  );
  process.exit(2);
}
const text = build(total);
const serialized = JSON.stringify({ note: text });

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};
const cwd = process.cwd();
const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }),
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: [
    {
      name: "p.worst",
      module: "standard" as const,
      description: "worst",
      inputSchema: { type: "object" },
      mutating: false,
      invoke: async () => ({ note: text }),
    },
  ],
};

// Best of three: this machine showed 5x run-to-run variance under load, and a
// GC pause is not a cost bound.
async function time<T>(label: string, fn: () => T | Promise<T>) {
  let best = Infinity;
  for (let run = 0; run < 3; run += 1) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { boundary: label, ms: Number(best.toFixed(1)) };
}

const call = await dispatchCallTool(ctx, "p.worst", {});
const boundaries = [
  await time("dispatchCallTool", () => dispatchCallTool(ctx, "p.worst", {})),
  await time("prepareOutputForPersistence", () => prepareOutputForPersistence(pass, serialized)),
  await time("validateOutputForTransport", () =>
    validateOutputForTransport({ value: { note: text }, format: "json" }),
  ),
  await time("redactToolOutput", () => redactToolOutput(cwd, serialized)),
];

console.log(
  JSON.stringify({
    probe: "T81-boundary",
    shape,
    bytes: text.length,
    boundaries,
    boundariesOverOneSecond: boundaries.filter((b) => b.ms > 1000).map((b) => b.boundary),
    // the budget-exhausting shape must still be REPORTED, with its attacker
    // definition masked rather than released
    mcpState: (call as { redaction?: { state?: string } }).redaction?.state ?? "?",
    mcpLeaksAttacker: JSON.stringify(call).includes(ATT),
  }),
);
