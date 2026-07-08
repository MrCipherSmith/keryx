// `gd-metapro mcp` command (specification.md §3, §9; T1, T5; Flow 012).
//
// Thin handler: parses `serve` / `--http` and calls `src/mcp/server.ts`, plus the
// `install` / `uninstall` client-config subcommands (Flow 012) that wire the
// server into an editor/agent's project-local MCP config. It does NOT import the
// MCP SDK — `serveMcp` loads it lazily and `install` only PROBES it.

import path from "node:path";
import { optionValue } from "../lib/args";
import { helpOptions, helpTitle, helpUsage, heading, note, style, symbols } from "../lib/ui";
import { serveMcp } from "../mcp/server";
import {
  installMcpClient,
  mcpRuntimeIds,
  uninstallMcpClient,
} from "../mcp/client-config";

export async function mcpCommand(
  args: string[] = [],
  cwd: string = process.cwd(),
): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h") {
    printMcpHelp();
    return;
  }

  if (subcommand === "install") {
    await handleInstall(cwd, args.slice(1));
    return;
  }

  if (subcommand === "uninstall") {
    await handleUninstall(cwd, args.slice(1));
    return;
  }

  // `mcp` (no subcommand) is an alias for `mcp serve`.
  if (!subcommand || subcommand === "serve") {
    const http = args.includes("--http");
    try {
      await serveMcp({ cwd, http });
    } catch (error) {
      // AC10: the single opt-in command allowed to hard-fail. Print the
      // actionable message and exit non-zero.
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  console.error(`Unknown mcp command: ${subcommand}`);
  printMcpHelp();
  process.exitCode = 1;
}

const RUNTIME_USAGE = `<cursor|claude|generic|all>`;

function parseRequestedRuntimes(args: string[], fallback: string): string[] {
  const runtimeArg = optionValue(args, "--runtime") ?? fallback;
  return runtimeArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// `mcp install [--runtime <cursor|claude|generic|all>] [--dry-run]`. Default
// runtime is `all` (cursor + claude), mirroring `security hooks`. `--dry-run`
// prints the planned change and writes NOTHING.
async function handleInstall(cwd: string, args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const requested = parseRequestedRuntimes(args, "all");
  const report = await installMcpClient(cwd, requested, { dryRun });

  if (report.unknown.length > 0) {
    console.error(`Unknown runtime(s): ${report.unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  heading(`gd-metapro mcp install${dryRun ? " (dry run)" : ""}`);
  for (const outcome of report.outcomes) {
    if (outcome.filePath === null) {
      // generic: print the ready snippet, write no file.
      console.log(`  ${style.cyan(symbols.arrow)} ${outcome.id} — paste this into your MCP client config:`);
      console.log(outcome.snippet ?? "");
      continue;
    }
    const rel = path.relative(cwd, outcome.filePath);
    if (outcome.errors.length > 0) {
      for (const e of outcome.errors) {
        console.log(`  ${style.red(symbols.cross)} ${e}`);
      }
      process.exitCode = 1;
      continue;
    }
    if (dryRun) {
      console.log(`  ${style.cyan(symbols.arrow)} ${outcome.id} → would write ${rel}:`);
      console.log(outcome.snippet ?? "");
    } else {
      console.log(`  ${style.green(symbols.ok)} ${outcome.id} → ${rel}`);
    }
  }

  // Manifest enable.
  if (report.manifest.message) {
    note(report.manifest.message);
  } else if (dryRun && report.manifest.changed) {
    note("would set modules.mcp.enabled=true in .metaproject/metaproject.json");
  } else if (report.manifest.changed) {
    note("set modules.mcp.enabled=true in .metaproject/metaproject.json");
  }

  // SDK hint (never auto-installs, never connects).
  if (!report.sdk.available) {
    note(`Optional MCP SDK not found — install it to run \`gd-metapro mcp serve\`: ${report.sdk.hint}`);
  }
}

// `mcp uninstall [--runtime <cursor|claude|generic|all>]`. Removes ONLY the
// managed gd-metapro entry, leaving other servers + user content intact.
async function handleUninstall(cwd: string, args: string[]): Promise<void> {
  const requested = parseRequestedRuntimes(args, "all");
  const report = await uninstallMcpClient(cwd, requested);

  if (report.unknown.length > 0) {
    console.error(`Unknown runtime(s): ${report.unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  heading("gd-metapro mcp uninstall");
  for (const outcome of report.outcomes) {
    if (outcome.filePath === null) {
      console.log(`  ${style.gray(symbols.off)} ${outcome.id} ${style.dim("no file to change")}`);
      continue;
    }
    const rel = path.relative(cwd, outcome.filePath);
    console.log(
      `  ${outcome.removed ? style.green(symbols.ok) : style.gray(symbols.off)} ${outcome.id} ${style.dim(outcome.removed ? `removed from ${rel}` : "nothing to remove")}`,
    );
  }
}

export function printMcpHelp(): void {
  helpTitle("gd-metapro mcp", "expose Metaproject services over the Model Context Protocol");
  helpUsage([
    "gd-metapro mcp serve            # stdio JSON-RPC MCP server (default)",
    "gd-metapro mcp serve --http     # HTTP/SSE opt-in (requires capabilities.http.enabled)",
    "gd-metapro mcp                  # alias for `mcp serve`",
    `gd-metapro mcp install --runtime ${RUNTIME_USAGE}   # wire this project into an editor/agent`,
    `gd-metapro mcp uninstall --runtime ${RUNTIME_USAGE} # remove the managed gd-metapro server`,
  ]);
  helpOptions([
    { flag: "--http", desc: "Use the isolated HTTP/SSE transport (localhost only) instead of stdio." },
    {
      flag: "--runtime",
      desc: `Target client(s) for install/uninstall: ${mcpRuntimeIds().join(", ")}, or all (=cursor,claude). Comma-separated. Default: all.`,
    },
    { flag: "--dry-run", desc: "install only: print the planned change and write nothing." },
  ]);
  heading("Notes");
  console.log(
    `  ${style.dim("`install` writes a project-local MCP client config (cursor → .cursor/mcp.json, claude → .mcp.json), sets modules.mcp.enabled=true, and prints a snippet for `generic`.")}`,
  );
  console.log(
    `  ${style.dim("Requires the optional @modelcontextprotocol/sdk to serve. Disabled by default (modules.mcp.enabled=false). `install` only probes the SDK — it never installs it or opens a network connection.")}`,
  );
}
