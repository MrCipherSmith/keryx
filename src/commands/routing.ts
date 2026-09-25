// `keryx routing` — Flow 305 (Flow A), AC3: read and edit the routing table
// (category -> model, `src/harness/routing/table.ts`) from the CLI. Mirrors
// `keryx providers`'s subcommand dispatch shape (`providers.ts:1065-1090`).
//
// No classifier anywhere in this file (PLAN.md Flow A). `explain`/`profile`
// (PRD §8) are Flow A2/B — not implemented here; `list`/`set`/`unset` are.
import {
  loadRoutingConfig,
  saveRoutingConfig,
  type RoutingConfigLayer,
  type RoutingConfigLocation,
} from "../harness/routing/config";
import {
  describeAssignment,
  isRoutingCategory,
  parseAssignmentTarget,
  ROUTING_CATEGORIES,
  type RoutingCategory,
} from "../harness/routing/table";

/** Seam for tests: production passes none (the real project cwd, the real per-user config dir). */
export interface RoutingCommandDeps {
  /** Project root. Default: `process.cwd()`. */
  readonly cwd?: string;
  /** Per-user config dir override — the SAME test seam `shell-config.ts` takes. Default: the real global config dir. */
  readonly userConfigDir?: string;
}

function printRoutingHelp(): void {
  console.log(
    [
      "Usage: keryx routing <subcommand>",
      "",
      "  keryx routing list [--json]",
      "                              Every category, its resolved model, and which layer answered.",
      "  keryx routing set <category> <provider>/<model> [--user|--project]",
      "                              Pin an exact model for a category (default layer: --user).",
      "  keryx routing set <category> <provider> [--user|--project]",
      "                              Pin a provider's own default model for a category.",
      "  keryx routing unset <category> [--user|--project]",
      "                              Clear a category back to session default (default layer: --user).",
      "",
      `Categories: ${ROUTING_CATEGORIES.join(", ")}`,
    ].join("\n"),
  );
}

/** `--user` (default) or `--project` — which layer a write subcommand targets. */
function layerFromArgs(args: readonly string[]): RoutingConfigLayer {
  if (args.includes("--project")) return "project";
  return "user";
}

function parseCategory(raw: string | undefined): RoutingCategory | undefined {
  if (raw === undefined || !isRoutingCategory(raw)) return undefined;
  return raw;
}

async function runList(args: string[], location: RoutingConfigLocation): Promise<void> {
  const [project, user] = await Promise.all([loadRoutingConfig("project", location), loadRoutingConfig("user", location)]);
  for (const error of [project.error, user.error].filter((e): e is string => e !== undefined)) {
    console.error(`routing: ${error}`);
  }
  const rows = ROUTING_CATEGORIES.map((category) => {
    const projectAssignment = project.table[category];
    const userAssignment = user.table[category];
    const assignment = projectAssignment ?? userAssignment;
    const source: "project" | "user" | "default" =
      projectAssignment !== undefined ? "project" : userAssignment !== undefined ? "user" : "default";
    return {
      category,
      assignment: assignment ?? { kind: "session-default" as const },
      source,
    };
  });
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          categories: Object.fromEntries(
            rows.map((r) => [r.category, { assignment: r.assignment, source: r.source }]),
          ),
          ...(project.error !== undefined ? { projectError: project.error } : {}),
          ...(user.error !== undefined ? { userError: user.error } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("# routing table");
  console.log("");
  for (const row of rows) {
    console.log(`${row.category.padEnd(12)} ${describeAssignment(row.assignment)}  [${row.source}]`);
  }
}

async function runSet(args: string[], location: RoutingConfigLocation): Promise<void> {
  const category = parseCategory(args[0]);
  if (category === undefined) {
    console.error(`Unknown or missing category. Expected one of ${ROUTING_CATEGORIES.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  const target = args[1];
  if (target === undefined || target.startsWith("--")) {
    console.error("Usage: keryx routing set <category> <provider>/<model> [--user|--project]");
    process.exitCode = 1;
    return;
  }
  const assignment = parseAssignmentTarget(target);
  if (assignment === undefined) {
    console.error(`Could not parse "${target}" as <provider>/<model> or <provider>.`);
    process.exitCode = 1;
    return;
  }
  const layer = layerFromArgs(args.slice(2));
  const current = await loadRoutingConfig(layer, location);
  await saveRoutingConfig(layer, location, { ...current.table, [category]: assignment });
  console.log(`${category} -> ${describeAssignment(assignment)}  [${layer}]`);
}

async function runUnset(args: string[], location: RoutingConfigLocation): Promise<void> {
  const category = parseCategory(args[0]);
  if (category === undefined) {
    console.error(`Unknown or missing category. Expected one of ${ROUTING_CATEGORIES.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  const layer = layerFromArgs(args.slice(1));
  const current = await loadRoutingConfig(layer, location);
  const { [category]: _removed, ...rest } = current.table;
  await saveRoutingConfig(layer, location, rest);
  console.log(`${category} -> session default  [${layer}]`);
}

export async function routingCommand(args: string[], deps: RoutingCommandDeps = {}): Promise<void> {
  const location: RoutingConfigLocation = {
    cwd: deps.cwd ?? process.cwd(),
    ...(deps.userConfigDir !== undefined ? { userConfigDir: deps.userConfigDir } : {}),
  };
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printRoutingHelp();
    return;
  }
  if (command === "list") {
    await runList(args.slice(1), location);
    return;
  }
  if (command === "set") {
    await runSet(args.slice(1), location);
    return;
  }
  if (command === "unset") {
    await runUnset(args.slice(1), location);
    return;
  }
  console.error(`Unknown routing command: ${command}`);
  printRoutingHelp();
  process.exitCode = 1;
}
