import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildGraph } from "../gdgraph/build";
import { getAffected, getCycles, getOrphans, loadGraph } from "../gdgraph/query";

export async function gdgraphCommand(args: string[]): Promise<void> {
  if (process.env.GD_METAPRO_GDGRAPH_LOCAL !== "1") {
    const delegated = await delegateToLocalRunner(args);
    if (delegated) {
      return;
    }
  }

  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "build") {
    const result = await buildGraph(process.cwd());
    console.log(`gdgraph build complete: ${result.nodes} nodes, ${result.edges} edges`);
    console.log(`summary: ${result.summaryPath}`);
    return;
  }

  if (command === "query") {
    const query = args.slice(1).join(" ").trim();
    const graph = await loadGraph(process.cwd());

    if (query === "cycles") {
      const cycles = getCycles(graph);
      if (cycles.length === 0) {
        console.log("No cycles found.");
        return;
      }
      for (const cycle of cycles) {
        console.log(cycle.join(" -> "));
      }
      return;
    }

    if (query === "orphans") {
      const orphans = getOrphans(graph);
      if (orphans.length === 0) {
        console.log("No orphan modules found.");
        return;
      }
      for (const orphan of orphans) {
        console.log(orphan);
      }
      return;
    }

    console.error(`Unsupported gdgraph query: ${query || "<empty>"}`);
    console.error("Supported queries: cycles, orphans");
    process.exitCode = 1;
    return;
  }

  if (command === "affected") {
    const target = args[1];
    if (!target) {
      console.error("Usage: gd-metapro gdgraph affected <file>");
      process.exitCode = 1;
      return;
    }

    const graph = await loadGraph(process.cwd());
    const affected = getAffected(graph, target);

    console.log(`# Affected context for ${affected.target}`);
    console.log("");
    console.log("## Dependencies");
    printList(affected.dependencies);
    console.log("");
    console.log("## Dependents");
    printList(affected.dependents);
    return;
  }

  console.error(`Unknown gdgraph command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function delegateToLocalRunner(args: string[]): Promise<boolean> {
  const localRunner = path.join(
    process.cwd(),
    ".metaproject",
    "core",
    "gdgraph",
    "cli.ts",
  );

  if (!existsSync(localRunner)) {
    return false;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [localRunner, ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        GD_METAPRO_GDGRAPH_LOCAL: "1",
      },
    });

    child.on("error", reject);
    child.on("close", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });

  return true;
}

function printHelp(): void {
  console.log(`gd-metapro gdgraph

Usage:
  gd-metapro gdgraph build
  gd-metapro gdgraph query cycles
  gd-metapro gdgraph query orphans
  gd-metapro gdgraph affected <file>
`);
}

function printList(items: string[]): void {
  if (items.length === 0) {
    console.log("- none");
    return;
  }

  for (const item of items) {
    console.log(`- ${item}`);
  }
}
