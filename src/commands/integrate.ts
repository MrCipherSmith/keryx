// retired-spellings-ok: file — same: the notice it prints names the retired spelling on purpose
// `keryx integrate [--remove] <editor>` — wire this project's MCP server into an
// editor/agent's project-local MCP client config (Flow 012, renamed by Flow 243
// / D-04).
//
// The editor is a positional argument rather than `--runtime <editor>` because
// the editor is the whole subject of the command, not a modifier on it. The
// retired spellings `keryx mcp install|uninstall --runtime <editor>` still work:
// `./mcp` translates the flag form into this one and calls in here, so there is
// one implementation and nothing to drift.
//
// It does NOT import the MCP SDK — it only PROBES it, never installs it, never
// opens a network connection.

import path from "node:path";
import { helpOptions, helpTitle, helpUsage, heading, note, style, symbols } from "../lib/ui";
import { installMcpClient, mcpRuntimeIds, uninstallMcpClient } from "../mcp/client-config";

export const EDITOR_USAGE = `<cursor|claude|opencode|vscode|generic|all>`;

/** No editor named means every file-backed project-local one, as `--runtime` defaulted to. */
const DEFAULT_EDITORS = ["all"];

export async function integrateCommand(
  args: string[] = [],
  cwd: string = process.cwd(),
  // How the user spelled the invocation, used for the report heading. The
  // deprecated `keryx mcp install|uninstall` aliases pass their own name so
  // their output is unchanged apart from the one added notice line.
  label?: string,
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printIntegrateHelp();
    return;
  }

  const editors = parseEditors(args);

  if (args.includes("--remove")) {
    await removeIntegration(cwd, editors, label ?? "keryx integrate --remove");
    return;
  }
  await addIntegration(cwd, editors, args.includes("--dry-run"), label ?? "keryx integrate");
}

/**
 * The editors named on the command line: every positional, comma-splittable so
 * `integrate cursor,claude` reads the same as the `--runtime cursor,claude` it
 * replaces.
 */
export function parseEditors(args: string[]): string[] {
  const named = args
    .filter((argument) => !argument.startsWith("-"))
    .flatMap((argument) => argument.split(","))
    .map((argument) => argument.trim())
    .filter(Boolean);
  return named.length > 0 ? named : [...DEFAULT_EDITORS];
}

// Writes the client config, sets modules.mcp.enabled=true, and prints a snippet
// for `generic`. `--dry-run` prints the planned change and writes NOTHING.
async function addIntegration(
  cwd: string,
  editors: string[],
  dryRun: boolean,
  label: string,
): Promise<void> {
  const report = await installMcpClient(cwd, editors, { dryRun });

  if (report.unknown.length > 0) {
    console.error(`Unknown runtime(s): ${report.unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  heading(`${label}${dryRun ? " (dry run)" : ""}`);
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
    note(`Optional MCP SDK not found — install it to run \`keryx serve-mcp\`: ${report.sdk.hint}`);
  }
}

// Removes ONLY the managed keryx entry, leaving other servers + user content
// intact.
async function removeIntegration(cwd: string, editors: string[], label: string): Promise<void> {
  const report = await uninstallMcpClient(cwd, editors);

  if (report.unknown.length > 0) {
    console.error(`Unknown runtime(s): ${report.unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  heading(label);
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

export function printIntegrateHelp(): void {
  helpTitle("keryx integrate", "wire this project into an editor or agent as an MCP server");
  helpUsage([
    `keryx integrate ${EDITOR_USAGE}            # write the client config`,
    `keryx integrate --remove ${EDITOR_USAGE}   # remove the managed keryx server`,
    `keryx integrate ${EDITOR_USAGE} --dry-run  # print the planned change, write nothing`,
  ]);
  helpOptions([
    { flag: "--remove", desc: "Remove the managed keryx server instead of writing it." },
    { flag: "--dry-run", desc: "Print the planned change and write nothing." },
  ]);
  heading("Notes");
  console.log(
    `  ${style.dim(`Editors: ${mcpRuntimeIds().join(", ")}, or all (=cursor,claude,opencode). Comma-separated. Default: all.`)}`,
  );
  console.log(
    `  ${style.dim("Writes a project-local MCP client config (cursor → .cursor/mcp.json, claude → .mcp.json, opencode → opencode.json, vscode → .vscode/mcp.json), sets modules.mcp.enabled=true, and prints a snippet for `generic`. `vscode` is opt-in only — not included in `all`.")}`,
  );
  console.log(
    `  ${style.dim("Only probes the optional @modelcontextprotocol/sdk — it never installs it and never opens a network connection.")}`,
  );
}
