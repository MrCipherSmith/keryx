// `keryx routing` — Flow 305 (Flow A), AC3: read and edit the routing table
// (category -> model, `src/harness/routing/table.ts`) from the CLI. Mirrors
// `keryx providers`'s subcommand dispatch shape (`providers.ts:1065-1090`).
//
// No classifier anywhere in this file (PLAN.md Flow A). `explain`/`profile`
// (PRD §8) are Flow A2/B — not implemented here; `list`/`set`/`unset`/`trust`
// (the last two flow 305 review findings, AC10/AC11) are.
import { envWithSavedApiKeys } from "../lib/shell-config";
import {
  loadRoutingConfig,
  loadRoutingConfigRaw,
  setRoutingCategory,
  unsetRoutingCategory,
  type RoutingConfigLayer,
  type RoutingConfigLocation,
} from "../harness/routing/config";
import {
  connectedPredicateFrom,
  describeAssignment,
  describeFallbackNotice,
  isRoutingCategory,
  parseAssignmentTarget,
  resolveCategoryDetailed,
  ROUTING_CATEGORIES,
  type RoutingCategory,
} from "../harness/routing/table";
import { approveProjectRouting, describeTableForApproval } from "../harness/routing/trust";

/** Seam for tests: production passes none (the real project cwd, the real per-user config dir). */
export interface RoutingCommandDeps {
  /** Project root. Default: `process.cwd()`. */
  readonly cwd?: string;
  /** Per-user config dir override — the SAME test seam `shell-config.ts` takes. Default: the real global config dir. */
  readonly userConfigDir?: string;
  /** AC10: connected-provider list. Default: the live provider catalog (flow 309, `../harness/provider-catalog.ts`) — same source `/routing`'s picker reads, a fresh cache answered immediately, a stale/missing one refreshed once. */
  providers?: () => Promise<readonly { name: string; models?: readonly string[] }[]>;
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
      "  keryx routing trust",
      "                              Review and approve the project's routing.config.json (required before it applies).",
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

async function defaultProviders(): Promise<readonly { name: string; models?: readonly string[] }[]> {
  // Dynamic import: `../harness/provider-catalog.ts` imports `./providers`
  // (this module's sibling, for the live `/models`/balance fetch), so a
  // static import here — `./routing.ts` -> `../harness/provider-catalog.ts`
  // — is fine directionally but is deferred anyway to match the same
  // lazy-load idiom `/routing`'s own `defaultProviders` uses.
  const { loadOrRefreshProviderCatalog, catalogToFlatPickerProviders } = await import("../harness/provider-catalog");
  const catalog = await loadOrRefreshProviderCatalog({ fetch, env: envWithSavedApiKeys() });
  return catalogToFlatPickerProviders(catalog);
}

async function runList(args: string[], location: RoutingConfigLocation, deps: RoutingCommandDeps): Promise<void> {
  const loadProviders = deps.providers ?? defaultProviders;
  const [project, user, providers] = await Promise.all([
    loadRoutingConfig("project", location),
    loadRoutingConfig("user", location),
    loadProviders(),
  ]);
  for (const error of [project.error, user.error].filter((e): e is string => e !== undefined)) {
    console.error(`routing: ${error}`);
  }
  const connected = connectedPredicateFrom(providers);
  const rows = ROUTING_CATEGORIES.map((category) => {
    const resolved = resolveCategoryDetailed(category, { project: project.table, user: user.table }, connected);
    return { category, ...resolved };
  });
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          categories: Object.fromEntries(
            rows.map((r) => [
              r.category,
              { assignment: r.assignment, source: r.source, ...(r.rejected !== undefined ? { rejected: r.rejected } : {}) },
            ]),
          ),
          ...(project.error !== undefined ? { projectError: project.error } : {}),
          ...(project.untrusted === true ? { projectUntrusted: true } : {}),
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
    const suffix = row.rejected !== undefined ? `  (${describeFallbackNotice(row.rejected.assignment, row.assignment)})` : "";
    console.log(`${row.category.padEnd(12)} ${describeAssignment(row.assignment)}  [${row.source}]${suffix}`);
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
  await setRoutingCategory(layer, location, category, assignment);
  console.log(`${category} -> ${describeAssignment(assignment)}  [${layer}]`);
  if (layer === "project") {
    console.log(`Note: routing.config.json changes take effect only after \`keryx routing trust\` approves the file's current content.`);
  }
}

async function runUnset(args: string[], location: RoutingConfigLocation): Promise<void> {
  const category = parseCategory(args[0]);
  if (category === undefined) {
    console.error(`Unknown or missing category. Expected one of ${ROUTING_CATEGORIES.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  const layer = layerFromArgs(args.slice(1));
  await unsetRoutingCategory(layer, location, category);
  console.log(`${category} -> session default  [${layer}]`);
}

/**
 * AC11(c) — review the project's routing.config.json and approve it. Prints
 * what will apply BEFORE recording anything (same discipline `keryx mcp
 * trust` already uses, `mcp-servers.ts:trustCommand`).
 */
async function runTrust(_args: string[], location: RoutingConfigLocation): Promise<void> {
  const raw = await loadRoutingConfigRaw("project", location);
  if (raw.error !== undefined) {
    console.error(`routing: ${raw.error}`);
    process.exitCode = 1;
    return;
  }
  if (Object.keys(raw.table).length === 0) {
    console.log("routing.config.json declares no categories — nothing to approve.");
    return;
  }
  console.log("Approving routing.config.json:");
  for (const line of describeTableForApproval(raw.table)) {
    console.log(`  ${line}`);
  }
  const result = await approveProjectRouting(location.cwd, raw.table, location.userConfigDir);
  if (!result.ok) {
    console.error(`routing: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Approved (${result.file}).`);
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
    await runList(args.slice(1), location, deps);
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
  if (command === "trust") {
    await runTrust(args.slice(1), location);
    return;
  }
  console.error(`Unknown routing command: ${command}`);
  printRoutingHelp();
  process.exitCode = 1;
}
