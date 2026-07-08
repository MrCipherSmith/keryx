import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { optionValue } from "../lib/args";
import { runAssetsSubcommand } from "../assets/command";
import { buildGraph } from "../gdgraph/build";
import { getCycles, getOrphans, loadGraph } from "../gdgraph/query";
import { computeAffected, type AffectedResult } from "../gdgraph/affected";
import { loadGdgraphConfig } from "../gdgraph/config";
import { writeRepomap } from "../gdgraph/repomap";

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
    await runAffected(args.slice(1));
    return;
  }

  if (command === "repomap") {
    await runRepomap(args.slice(1));
    return;
  }

  if (command === "assets") {
    const result = await runAssetsSubcommand(process.cwd(), "gdgraph", args.slice(1));
    for (const line of result.lines) {
      if (result.exitCode === 0) {
        console.log(line);
      } else {
        console.error(line);
      }
    }
    process.exitCode = result.exitCode;
    return;
  }

  console.error(`Unknown gdgraph command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runAffected(rest: string[]): Promise<void> {
  const target = positionals(rest)[0];
  if (!target) {
    console.error("Usage: gd-metapro gdgraph affected <file> [--depth N] [--ranked] [--json]");
    process.exitCode = 1;
    return;
  }

  const ranked = rest.includes("--ranked");
  const asJson = rest.includes("--json");
  const config = await loadGdgraphConfig(process.cwd());
  const depthArg = optionValue(rest, "--depth");
  const depth = depthArg !== undefined ? Number.parseInt(depthArg, 10) : config.affected.defaultDepth;

  const graph = await loadGraph(process.cwd());
  const affected = computeAffected(graph, target, {
    depth: Number.isFinite(depth) ? depth : config.affected.defaultDepth,
    ranked: ranked || asJson,
  });

  if (asJson) {
    console.log(JSON.stringify(affected, null, 2));
    return;
  }

  // Default / --depth 1 output is byte-for-byte identical to the pre-block
  // renderer (Dependencies + Dependents sections, sorted). `--ranked` is
  // strictly additive below.
  console.log(`# Affected context for ${affected.target}`);
  console.log("");
  console.log("## Dependencies");
  printList(affected.dependencies);
  console.log("");
  console.log("## Dependents");
  printList(affected.dependents);

  if (ranked) {
    console.log("");
    console.log("## Blast Radius (ranked)");
    if (affected.ranked.length === 0) {
      console.log("- none");
    } else {
      for (const entry of affected.ranked) {
        console.log(`- ${entry.path} (hop ${entry.hop}, fanIn ${entry.fanIn})`);
      }
    }
  }
}

async function runRepomap(rest: string[]): Promise<void> {
  const budgetArg = optionValue(rest, "--budget");
  const budget = budgetArg !== undefined ? Number.parseInt(budgetArg, 10) : undefined;
  const seed = collectSeeds(rest);
  if (rest.includes("--changed")) {
    seed.push(...(await changedFiles()));
  }

  const config = await loadGdgraphConfig(process.cwd());
  const graph = await loadGraph(process.cwd());
  const result = await writeRepomap(process.cwd(), graph, config, {
    ...(budget !== undefined && Number.isFinite(budget) ? { budget } : {}),
    ...(seed.length > 0 ? { seed } : {}),
  });

  console.log(`gdgraph repomap complete: ${result.entries.length} entries, ~${result.tokens} tokens`);
  if (result.omitted > 0) {
    console.log(`omitted (over budget): ${result.omitted}`);
  }
  console.log(`repomap: ${result.path}`);
}

// Collect free positional arguments, skipping flags + their consumed values.
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--depth" || arg === "--budget") {
      i += 1;
      continue;
    }
    if (arg === "--seed") {
      while (i + 1 < args.length && !args[i + 1]?.startsWith("--")) {
        i += 1;
      }
      continue;
    }
    if (arg?.startsWith("--")) {
      continue;
    }
    if (arg) {
      out.push(arg);
    }
  }
  return out;
}

function collectSeeds(args: string[]): string[] {
  const seeds: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--seed") {
      while (i + 1 < args.length && !args[i + 1]?.startsWith("--")) {
        i += 1;
        const value = args[i];
        if (value) {
          seeds.push(value);
        }
      }
    }
  }
  return seeds;
}

// Best-effort changed-file discovery for `--changed` personalization. Local git
// only; failure ⇒ no seeds (never blocks, never networks).
async function changedFiles(): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      const child = spawn("git", ["diff", "--name-only", "HEAD"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => resolve([]));
      child.on("close", () => {
        resolve(out.split("\n").map((line) => line.trim()).filter(Boolean));
      });
    } catch {
      resolve([]);
    }
  });
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

  // New surfaces (repomap/assets) + affected flags are only implemented in this
  // package runner, not the copied core cli.ts. Delegate legacy commands only.
  const command = args[0];
  const delegatable = command === "build" || command === "query"
    || (command === "affected" && !args.some((arg) => arg.startsWith("--")));
  if (!delegatable) {
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
  gd-metapro gdgraph affected <file> [--depth N] [--ranked] [--json]
  gd-metapro gdgraph repomap [--budget N] [--seed <path>...] [--changed]
  gd-metapro gdgraph assets list | verify [<id>] | pull <id>
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

export type { AffectedResult };
