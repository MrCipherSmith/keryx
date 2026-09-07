// T78 — the new pathological shape, driven through all four public boundaries.
//
// T77 removed MAX_REFERENCE_LABEL and replaced it with a budget derived from the
// document's OWN reference definitions. The budget is therefore an
// ATTACKER-CHOSEN constant: one long `[ref]: URL` line raises it arbitrarily, and
// `readBracketConstructs` then slices + normalises an O(n) label span at EVERY
// opening bracket. Every perf shape T72 and T77 measured with a bracket run
// carried no definition at all, so `budget.maxLength === 0` short-circuited the
// path before it sliced.
//
// This probe asks the question the acceptance criterion asks: does the cost land
// at the MANDATORY floor's public boundaries, not only in the pure function?
// Advisory redaction is OFF, so what is measured is the mandatory floor.
// Read-only, offline, synthetic hosts only.
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

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

// definition length L, bracket run n; L >= 2n keeps every span inside the budget
function payload(n: number): string {
  const L = 2 * n;
  return `[${"a".repeat(L)}]: https://ok.example.org/x\n` + "[".repeat(n) + "]".repeat(n);
}

// A payload that looks like ordinary documentation: a real reference definition
// whose label is long because it is a sentence, plus a table-of-contents-shaped
// bracket run. Included to show the shape does not require a bizarre document.
function prosePayload(n: number): string {
  const label = "see the section on ".repeat(Math.ceil((2 * n) / 19)).slice(0, 2 * n);
  return `[${label}]: https://docs.example.org/guide\n\n` + "[".repeat(n) + "]".repeat(n);
}

const ladder: Array<Record<string, unknown>> = [];
for (const n of [2000, 4000, 8000, 16000, 32000, 64000]) {
  const content = payload(n);
  const t0 = performance.now();
  detectExfil(content);
  const ms = performance.now() - t0;
  ladder.push({ n, bytes: content.length, detectorMs: Number(ms.toFixed(1)) });
  if (ms > 60000) break;
}

// --- the four public boundaries, on one tuned payload ----------------------
const N = 32000;
const text = payload(N);
const serialized = JSON.stringify({ note: text });

const cwd = process.cwd();
const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }), // advisory OFF
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: [
    {
      name: "p.dos",
      module: "standard" as const,
      description: "dos",
      inputSchema: { type: "object" },
      mutating: false,
      invoke: async () => ({ note: text }),
    },
  ],
};

async function time<T>(label: string, fn: () => T | Promise<T>) {
  const t0 = performance.now();
  await fn();
  return { boundary: label, ms: Number((performance.now() - t0).toFixed(1)) };
}

const boundaries = [
  await time("dispatchCallTool", () => dispatchCallTool(ctx, "p.dos", {})),
  await time("prepareOutputForPersistence", () =>
    prepareOutputForPersistence(pass, serialized),
  ),
  await time("validateOutputForTransport", () =>
    validateOutputForTransport({ value: { note: text }, format: "json" }),
  ),
  await time("redactToolOutput", () => redactToolOutput(cwd, serialized)),
];

// --- the prose-shaped variant ---------------------------------------------
const prose = prosePayload(16000);
const t0 = performance.now();
detectExfil(prose);
const proseMs = Number((performance.now() - t0).toFixed(1));

console.log(
  JSON.stringify(
    {
      probe: "T78-boundary",
      ladder,
      tunedPayload: { n: N, bytes: text.length },
      boundaries,
      boundariesOverOneSecond: boundaries
        .filter((b) => b.ms > 1000)
        .map((b) => b.boundary),
      prose: { n: 16000, bytes: prose.length, detectorMs: proseMs },
    },
    null,
    2,
  ),
);
