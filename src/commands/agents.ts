import {
  agentBootstrapRuntimeIds,
  agentBootstrapStatus,
  installAgentBootstrap,
  renderAgentBootstrapBlock,
  resolveAgentBootstrapRuntimes,
  uninstallAgentBootstrap,
} from "../agents/bootstrap";
import { optionValue } from "../lib/args";
import { helpOptions, helpTitle, helpUsage, statusLine } from "../lib/ui";

const RUNTIME_USAGE = "<claude|opencode|zcode|codex|antigravity|all>";

export async function agentsCommand(args: string[] = []): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printAgentsHelp();
    return;
  }

  if (subcommand !== "bootstrap") {
    console.error(`Unknown agents command: ${subcommand}`);
    printAgentsHelp();
    process.exitCode = 1;
    return;
  }

  await bootstrapCommand(args.slice(1));
}

async function bootstrapCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printBootstrapHelp();
    return;
  }

  const action = args[0] && !args[0].startsWith("-") ? args[0] : "status";
  const rest = action === "status" ? args.filter((arg) => arg !== "status") : args.slice(1);

  if (action === "print") {
    console.log(renderAgentBootstrapBlock("AGENTS.md"));
    return;
  }

  if (action !== "status" && action !== "install" && action !== "uninstall") {
    console.error(`Unknown agents bootstrap command: ${action}`);
    printBootstrapHelp();
    process.exitCode = 1;
    return;
  }

  const runtimeArg = optionValue(rest, "--runtime") ?? "all";
  const dryRun = rest.includes("--dry-run");
  const { runtimes, unknown } = resolveAgentBootstrapRuntimes([runtimeArg]);

  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (runtimes.length === 0) {
    console.error("No runtimes selected.");
    process.exitCode = 1;
    return;
  }

  if (action === "status") {
    console.log("# agents bootstrap status");
    console.log("");
    for (const runtime of runtimes) {
      const status = await agentBootstrapStatus(runtime);
      const ok = status.installed && status.current;
      const detail = status.installed
        ? status.current ? status.filePath : `${status.filePath} (outdated)`
        : `${status.filePath} (missing)`;
      statusLine(`${status.label} (${status.runtime})`, ok, detail);
    }
    console.log("");
    console.log(`To update: keryx agents bootstrap install --runtime ${runtimeArg}`);
    return;
  }

  if (action === "install") {
    console.log(`# agents bootstrap install${dryRun ? " (dry-run)" : ""}`);
    console.log("");
    for (const runtime of runtimes) {
      const result = await installAgentBootstrap(runtime, { dryRun });
      statusLine(`${result.label} (${result.runtime})`, result.current, result.filePath);
      if (dryRun && result.wrote) {
        console.log(`  would write: ${result.filePath}`);
      }
    }
    return;
  }

  console.log(`# agents bootstrap uninstall${dryRun ? " (dry-run)" : ""}`);
  console.log("");
  for (const runtime of runtimes) {
    const result = await uninstallAgentBootstrap(runtime, { dryRun });
    statusLine(`${result.label} (${result.runtime})`, !result.installed, result.filePath);
    if (dryRun && result.removed) {
      console.log(`  would remove managed block: ${result.filePath}`);
    }
  }
}

function printAgentsHelp(): void {
  helpTitle("keryx agents", "manage global agent bootstrap instructions");
  helpUsage([
    `keryx agents bootstrap status --runtime ${RUNTIME_USAGE}`,
    `keryx agents bootstrap install --runtime ${RUNTIME_USAGE} [--dry-run]`,
    `keryx agents bootstrap uninstall --runtime ${RUNTIME_USAGE} [--dry-run]`,
    "keryx agents bootstrap print",
  ]);
}

function printBootstrapHelp(): void {
  helpTitle("keryx agents bootstrap", "install optional Metaproject routing into global agent entrypoints");
  helpUsage([
    `keryx agents bootstrap status --runtime ${RUNTIME_USAGE}`,
    `keryx agents bootstrap install --runtime ${RUNTIME_USAGE} [--dry-run]`,
    `keryx agents bootstrap uninstall --runtime ${RUNTIME_USAGE} [--dry-run]`,
    "keryx agents bootstrap print",
  ]);
  helpOptions([
    {
      flag: "--runtime",
      desc: `Target runtime(s): ${agentBootstrapRuntimeIds().join(", ")}, all. Comma-separated. Alias: antigravuty.`,
    },
    { flag: "--dry-run", desc: "Print planned writes/removals without changing files." },
  ]);
}
