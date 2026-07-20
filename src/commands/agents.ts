import { readFileSync } from "node:fs";
import {
  agentBootstrapRuntimeIds,
  agentBootstrapStatus,
  installAgentBootstrap,
  renderAgentBootstrapBlock,
  resolveAgentBootstrapRuntimes,
  uninstallAgentBootstrap,
} from "../agents/bootstrap";
import { reduceAgents } from "../harness/monitor/reduce";
import type { AgentEvent, AgentsSnapshot } from "../harness/monitor/reduce";
import { optionValue } from "../lib/args";
import { helpOptions, helpTitle, helpUsage, statusLine } from "../lib/ui";

const RUNTIME_USAGE = "<claude|opencode|zcode|codex|antigravity|all>";

export async function agentsCommand(args: string[] = []): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printAgentsHelp();
    return;
  }

  if (subcommand === "monitor") {
    monitorCommand(args.slice(1));
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

/** Parse an agent-event source: a JSON array, or newline-delimited JSON (JSONL). */
function parseAgentEvents(content: string): AgentEvent[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as AgentEvent[];
  }
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AgentEvent);
}

/**
 * `keryx agents monitor [--json] <events-file>` — read-only. Folds a persisted /
 * provided canonical agent-event source via the pure `reduceAgents` accounting
 * layer and renders it: `--json` emits the raw {@link AgentsSnapshot}; text mode
 * renders a run→dispatch tree with status, model, and ↑in/↓out tokens. Writes
 * nothing.
 */
export function monitorCommand(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    helpTitle("keryx agents monitor", "fold a subagent agent-event stream into a fleet snapshot (read-only)");
    helpUsage(["keryx agents monitor <events-file> [--json]"]);
    helpOptions([{ flag: "--json", desc: "Emit the raw AgentsSnapshot as JSON instead of a tree." }]);
    return;
  }

  const json = args.includes("--json");
  const source = args.find((arg) => !arg.startsWith("-"));
  if (source === undefined) {
    console.error("Provide an agent-event source file: keryx agents monitor <events-file> [--json]");
    process.exitCode = 1;
    return;
  }

  let events: AgentEvent[];
  try {
    events = parseAgentEvents(readFileSync(source, "utf8"));
  } catch (error) {
    console.error(`Failed to read/parse agent-event source "${source}": ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const snapshot = reduceAgents(events);
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  renderAgentsTree(snapshot);
}

const STATUS_GLYPH: Record<string, string> = {
  running: "◐",
  done: "●",
  blocked: "◼",
  failed: "✗",
  unknown: "○",
};

/** Render a folded {@link AgentsSnapshot} as a run→dispatch tree with tokens. */
function renderAgentsTree(snapshot: AgentsSnapshot): void {
  console.log("# agents monitor");
  console.log("");
  console.log(`run ${snapshot.runId ?? "(unknown)"} — ${snapshot.agents.length} subagent(s)`);
  for (const agent of snapshot.agents) {
    const tokens = `↑${agent.usage.inputTokens} ↓${agent.usage.outputTokens}${agent.usage.exact ? "" : "~"}`;
    const glyph = STATUS_GLYPH[agent.status] ?? "○";
    console.log(`  ${glyph} ${agent.dispatchId}  ${agent.status}  ${agent.model ?? "-"}  ${tokens}`);
  }
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
  helpTitle("keryx agents", "manage agent bootstrap instructions and monitor a subagent fleet");
  helpUsage([
    `keryx agents bootstrap status --runtime ${RUNTIME_USAGE}`,
    `keryx agents bootstrap install --runtime ${RUNTIME_USAGE} [--dry-run]`,
    `keryx agents bootstrap uninstall --runtime ${RUNTIME_USAGE} [--dry-run]`,
    "keryx agents bootstrap print",
    "keryx agents monitor <events-file> [--json]",
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
