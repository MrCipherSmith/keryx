// retired-spellings-ok: file — this file IS the retired spelling. It exists only to translate the old verbs to the new ones and announce the rename, so naming them is its whole job
// `keryx mcp` — the RETIRED spelling of the MCP publisher surface (Flow 243 /
// D-04). It is an alias and nothing else:
//
//   keryx mcp [serve]                     → keryx serve-mcp
//   keryx mcp install   --runtime <ed>    → keryx integrate <ed>
//   keryx mcp uninstall --runtime <ed>    → keryx integrate --remove <ed>
//
// The verb is being freed to mean "the MCP servers keryx CONNECTS TO" rather
// than "keryx IS an MCP server". Nothing here re-implements anything: the real
// commands live in `./serve-mcp` and `./integrate`, and this file only
// translates the old argument shape and prints one deprecation line. An alias
// that carried its own copy of the behaviour would be two implementations free
// to drift, which is the failure the rename exists to end.

import { optionValue } from "../lib/args";
import { helpOptions, helpTitle, helpUsage, heading, style } from "../lib/ui";
import { mcpRuntimeIds } from "../mcp/client-config";
import { EDITOR_USAGE, integrateCommand } from "./integrate";
import { isMcpConsumerSubcommand, runMcpConsumerCommand } from "./mcp-servers";
import { serveMcpCommand } from "./serve-mcp";

export async function mcpCommand(
  args: string[] = [],
  cwd: string = process.cwd(),
): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h") {
    printMcpHelp();
    return;
  }

  // The CONSUMER surface, and the reason the verb was freed. These are new
  // subcommands, not renamed ones, so they print no deprecation line — `keryx
  // mcp list` is the current spelling, not a retired one.
  if (isMcpConsumerSubcommand(subcommand)) {
    const code = await runMcpConsumerCommand(subcommand, args.slice(1), {
      cwd,
      log: (line) => console.log(line),
      // stderr, because a bare `keryx mcp` is the stdio MCP server and this
      // module shares its process: a diagnostic on stdout would sit in the
      // same stream as JSON-RPC frames.
      err: (line) => console.error(line),
    });
    if (code !== 0) process.exitCode = code;
    return;
  }

  if (subcommand === "install") {
    announceRename("`keryx mcp install --runtime <editor>`", "`keryx integrate <editor>`");
    await integrateCommand(toIntegrateArgs(args.slice(1)), cwd, "keryx mcp install");
    return;
  }

  if (subcommand === "uninstall") {
    announceRename(
      "`keryx mcp uninstall --runtime <editor>`",
      "`keryx integrate --remove <editor>`",
    );
    await integrateCommand(["--remove", ...toIntegrateArgs(args.slice(1))], cwd, "keryx mcp uninstall");
    return;
  }

  // `mcp` (no subcommand) is an alias for `mcp serve`, which is now an alias in
  // turn — so a bare `keryx mcp` in a client config keeps serving.
  if (!subcommand || subcommand === "serve") {
    announceRename("`keryx mcp serve`", "`keryx serve-mcp`");
    await serveMcpCommand(args.slice(1), cwd);
    return;
  }

  console.error(`Unknown mcp command: ${subcommand}`);
  printMcpHelp();
  process.exitCode = 1;
}

/**
 * One line, on stderr, once per invocation.
 *
 * stderr because a bare `keryx mcp` IS the stdio MCP server: stdout carries
 * JSON-RPC frames there, and a notice written to it corrupts every client
 * session rather than informing anyone.
 *
 * Once per invocation because `--runtime all` performs three writes. A line a
 * reader sees three times in one command is a line they learn to skip, which is
 * how deprecation notices stop working at all — so it is printed here, beside
 * the routing decision, and never inside the per-editor loop.
 */
function announceRename(retired: string, replacement: string): void {
  console.error(`${retired} is deprecated — use ${replacement} instead.`);
}

/**
 * Translate the retired flag form into the positional form `integrate` takes.
 *
 * `--runtime a,b` becomes the editors; every other flag rides along unchanged so
 * `--dry-run` and `--help` keep meaning what they meant. Bare positionals are
 * dropped because `mcp install` never had any.
 */
function toIntegrateArgs(rest: string[]): string[] {
  const runtimeArg = optionValue(rest, "--runtime");
  const editors = runtimeArg === undefined ? ["all"] : [runtimeArg];
  const flags = rest.filter(
    (argument) =>
      argument.startsWith("-") && argument !== "--runtime" && !argument.startsWith("--runtime="),
  );
  return [...editors, ...flags];
}

export function printMcpHelp(): void {
  helpTitle("keryx mcp", "retired spelling of the MCP publisher surface — see the replacements below");
  helpUsage([
    "keryx serve-mcp [--http] [--cwd <project-root>]   # replaces `keryx mcp serve`",
    `keryx integrate ${EDITOR_USAGE}          # replaces \`keryx mcp install --runtime\``,
    `keryx integrate --remove ${EDITOR_USAGE} # replaces \`keryx mcp uninstall --runtime\``,
  ]);
  helpOptions([
    { flag: "--http", desc: "serve only: use the isolated HTTP/SSE transport (localhost only) instead of stdio." },
    { flag: "--cwd", desc: "serve only: project root whose .metaproject workspace should be exposed. Defaults to the process cwd." },
    {
      flag: "--runtime",
      desc: `install/uninstall only: target client(s) — ${mcpRuntimeIds().join(", ")}, or all (=cursor,claude,opencode). Comma-separated. Default: all.`,
    },
    { flag: "--dry-run", desc: "install only: print the planned change and write nothing." },
  ]);
  heading("Notes");
  console.log(
    `  ${style.dim("Every `keryx mcp …` invocation still works and still behaves identically; each prints one deprecation line on stderr naming its replacement.")}`,
  );
  console.log(
    `  ${style.dim("Run `keryx serve-mcp --help` or `keryx integrate --help` for the current surface.")}`,
  );
}
