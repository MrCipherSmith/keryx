// retired-spellings-ok: file — carries the deprecation notice text, which must name the spelling it retires or the notice says nothing
// `keryx serve-mcp` — run keryx itself as an MCP server (specification.md §3, §9;
// T1, T5; Flow 012, renamed by Flow 243 / D-04).
//
// The verb reads `serve-mcp` rather than `mcp serve` so that `mcp` is free to
// mean "the MCP servers keryx connects to" instead of "keryx is an MCP server".
// The retired spelling still works: `./mcp` is a deprecation alias that calls
// straight into this file, so there is one implementation and nothing to drift.
//
// Thin handler: parses `--http` / `--cwd` and calls `src/mcp/server.ts`. It does
// NOT import the MCP SDK — `serveMcp` loads it lazily.

import path from "node:path";
import { optionValue } from "../lib/args";
import { helpOptions, helpTitle, helpUsage, heading, style } from "../lib/ui";
import { serveMcp } from "../mcp/server";
import { resolveServeRoot } from "./mcp-serve-root";

export async function serveMcpCommand(
  args: string[] = [],
  cwd: string = process.cwd(),
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printServeMcpHelp();
    return;
  }

  const http = args.includes("--http");
  const projectRoot = path.resolve(resolveServeRoot(optionValue(args, "--cwd"), cwd, process.env));
  try {
    await serveMcp({ cwd: projectRoot, http });
  } catch (error) {
    // AC10: the single opt-in command allowed to hard-fail. Print the
    // actionable message and exit non-zero.
    //
    // stderr, not stdout: under the default stdio transport stdout carries
    // JSON-RPC frames, and anything else written there is a protocol violation
    // rather than a message.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function printServeMcpHelp(): void {
  helpTitle("keryx serve-mcp", "expose Metaproject services over the Model Context Protocol");
  helpUsage([
    "keryx serve-mcp [--cwd <project-root>]          # stdio JSON-RPC MCP server (default)",
    "keryx serve-mcp --http [--cwd <project-root>]   # HTTP/SSE opt-in (requires capabilities.http.enabled)",
  ]);
  helpOptions([
    { flag: "--http", desc: "Use the isolated HTTP/SSE transport (localhost only) instead of stdio." },
    { flag: "--cwd", desc: "Project root whose .metaproject workspace should be exposed. Defaults to the process cwd." },
  ]);
  heading("Notes");
  console.log(
    `  ${style.dim("Requires the optional @modelcontextprotocol/sdk. Disabled by default (modules.mcp.enabled=false); `keryx integrate <editor>` turns it on and wires a client.")}`,
  );
  console.log(
    `  ${style.dim("`keryx mcp serve` is the retired spelling of this command. It still works and prints one deprecation line on stderr.")}`,
  );
}
