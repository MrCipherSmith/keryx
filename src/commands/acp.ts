// `keryx acp` — Agent Client Protocol agent server over stdio (flow 285, T7).
//
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (`../acp/framing.ts`)
// and answers `initialize`, `session/new` and `session/prompt`
// (`../acp/server.ts`). Nothing but protocol frames may ever reach stdout —
// every diagnostic below goes to stderr, matching the transport's own MUST
// NOT ("a stray console.log corrupts the stream", `context.md` §0).

import { randomUUID } from "node:crypto";
import { runAcpServer } from "../acp/server";
import { loadAcpFixtureProvider } from "../acp/fixture-provider";
import { makeProvider } from "../harness/provider/make-provider";
import packageJson from "../../package.json" with { type: "json" };

interface ParsedAcpArgs {
  provider: string;
  model: string;
  baseUrl?: string;
  /** Test-only: a deterministic scripted provider (`../acp/fixture-provider.ts`), never used in production. */
  fixture?: string;
  dataDir?: string;
}

function parseArgs(args: string[]): ParsedAcpArgs {
  let provider = "fake";
  let model = "fake-model";
  let baseUrl: string | undefined;
  let fixture: string | undefined;
  let dataDir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--provider") {
      provider = args[(i += 1)] ?? provider;
    } else if (arg === "--model") {
      model = args[(i += 1)] ?? model;
    } else if (arg === "--base-url") {
      baseUrl = args[(i += 1)];
    } else if (arg === "--fixture") {
      fixture = args[(i += 1)];
    } else if (arg === "--data-dir") {
      dataDir = args[(i += 1)];
    }
  }
  return {
    provider,
    model,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(fixture !== undefined ? { fixture } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
  };
}

export async function acpCommand(args: string[]): Promise<void> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const parsed = parseArgs(args);
  const provider =
    parsed.fixture !== undefined
      ? loadAcpFixtureProvider(parsed.fixture)
      : makeProvider(parsed.provider, parsed.model, {
          fetch,
          env: process.env,
          ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
        });

  await runAcpServer({
    input: process.stdin,
    write: (chunk) => {
      process.stdout.write(chunk);
    },
    logError: (line) => {
      process.stderr.write(`${line}\n`);
    },
    provider,
    providerId: parsed.provider,
    modelId: parsed.model,
    agentInfo: { name: "keryx", version: packageJson.version },
    ...(parsed.dataDir !== undefined ? { dataDir: parsed.dataDir } : {}),
    idSeq: () => randomUUID(),
  });
}

function printHelp(): void {
  console.log(`keryx acp

Speak the Agent Client Protocol (ACP) v1 over stdio: newline-delimited
JSON-RPC 2.0 on stdin, the same framing on stdout. Launch this as a
subprocess from an ACP client (an editor, e.g.) — it answers initialize,
session/new and session/prompt, streaming session/update notifications as a
turn runs rather than only at the end. Nothing but protocol frames is ever
written to stdout; every diagnostic goes to stderr.

Usage:
  keryx acp [--provider <p>] [--model <m>] [--base-url <url>] [--data-dir <dir>]
`);
}
