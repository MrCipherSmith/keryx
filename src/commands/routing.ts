// `keryx routing` — Flow 305 (Flow A), AC3: read and edit the routing table
// (category -> model, `src/harness/routing/table.ts`) from the CLI. Mirrors
// `keryx providers`'s subcommand dispatch shape (`providers.ts:1065-1090`).
//
// No classifier anywhere in this file (PLAN.md Flow A). `explain` (PRD §8) is
// Flow B — not implemented here. `list`/`set`/`unset`/`trust` are Flow A;
// `profile list`/`profile set` (AC8) and `list`'s `derived`-layer/
// unavailable-fallback reporting (AC10/AC11) are Flow 327 (Routing A2).
import { envWithSavedApiKeys, loadShellConfig } from "../lib/shell-config";
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
  describeCategoryResolution,
  describeRejectionNotice,
  isRoutingCategory,
  parseAssignmentTarget,
  resolveCategoryDetailed,
  ROUTING_CATEGORIES,
  type RoutingCategory,
  type RoutingTable,
} from "../harness/routing/table";
import { approveProjectRouting, describeTableForApproval } from "../harness/routing/trust";
import { deriveDefaultTable } from "../harness/routing/derive-default-table";
import {
  availablePredicateFromProfiles,
  formatModelProfileLine,
  loadModelProfiles,
  setModelProfileField,
  type ModelProfile,
  type ModelProfileFieldValue,
} from "../harness/routing/model-profile";
import { allStats, readTaskCostStore, taskCostLookupFrom, type TaskCostStats } from "../harness/routing/task-cost";

/** Seam for tests: production passes none (the real project cwd, the real per-user config dir). */
export interface RoutingCommandDeps {
  /** Project root. Default: `process.cwd()`. */
  readonly cwd?: string;
  /** Per-user config dir override — the SAME test seam `shell-config.ts` takes. Default: the real global config dir. */
  readonly userConfigDir?: string;
  /** AC10: connected-provider list. Default: the live provider catalog (flow 309, `../harness/provider-catalog.ts`) — same source `/routing`'s picker reads, a fresh cache answered immediately, a stale/missing one refreshed once. */
  providers?: () => Promise<readonly { name: string; models?: readonly string[] }[]>;
  /**
   * Flow 327 (AC10/AC11) — the session's own current provider/model, for the
   * `derived` layer (`deriveDefaultTable`, PRD §6.3 — v1 derives from the
   * session's own provider only). Default: the persisted `ShellConfig.
   * provider`/`.model` (the CLI's best notion of "session" outside a live
   * TUI). `undefined` (nothing persisted yet) means derivation does not run
   * for this call — every category simply falls through to `default`.
   */
  session?: () => { providerId: string; modelId: string } | undefined;
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
      "  keryx routing profile list [--json]",
      "                              Every stored model profile (tier, price, context, priority, sources, availability).",
      "  keryx routing profile set <provider>/<model> --tier|--price-in|--price-out|--context|--priority <value>",
      "                              An operator correction — stored with source \"operator\", never overwritten by a later refresh.",
      "  keryx routing stats [--json]",
      "                              Real measured task cost per (provider, model, category): n, median tokens/task, median cost/task, success rate.",
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

function defaultSession(userConfigDir: string | undefined): { providerId: string; modelId: string } | undefined {
  const cfg = loadShellConfig(userConfigDir);
  if (typeof cfg.provider !== "string" || cfg.provider.length === 0 || typeof cfg.model !== "string" || cfg.model.length === 0) {
    return undefined;
  }
  return { providerId: cfg.provider, modelId: cfg.model };
}

async function runList(args: string[], location: RoutingConfigLocation, deps: RoutingCommandDeps): Promise<void> {
  const loadProviders = deps.providers ?? defaultProviders;
  const loadSession = deps.session ?? (() => defaultSession(location.userConfigDir));
  const [project, user, providers] = await Promise.all([
    loadRoutingConfig("project", location),
    loadRoutingConfig("user", location),
    loadProviders(),
  ]);
  for (const error of [project.error, user.error].filter((e): e is string => e !== undefined)) {
    console.error(`routing: ${error}`);
  }
  const connected = connectedPredicateFrom(providers);
  const profiles = loadModelProfiles(location.userConfigDir);
  const available = availablePredicateFromProfiles(profiles);
  const session = loadSession();
  let derived: RoutingTable = {};
  if (session !== undefined) {
    const sessionProvider = providers.find((p) => p.name === session.providerId);
    const models = sessionProvider?.models ?? [session.modelId];
    const taskCostLookup = taskCostLookupFrom(readTaskCostStore(location.userConfigDir));
    derived = deriveDefaultTable(session.providerId, models, profiles, session.modelId, taskCostLookup);
  }
  const rows = ROUTING_CATEGORIES.map((category) => {
    const resolved = resolveCategoryDetailed(category, { project: project.table, user: user.table, derived }, connected, available);
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
          ...(session !== undefined ? { derivedFrom: session.providerId } : {}),
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
    const suffix = row.rejected !== undefined ? `  (${describeRejectionNotice(row.rejected, row.assignment)})` : "";
    console.log(`${row.category.padEnd(12)} ${describeCategoryResolution(row, session?.providerId)}  [${row.source}]${suffix}`);
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

/** `keryx routing profile list [--json]` (AC8). */
function runProfileList(args: string[], userConfigDir: string | undefined): void {
  const profiles = loadModelProfiles(userConfigDir);
  const sorted = Object.values(profiles).sort((a, b) => (a.providerId === b.providerId ? a.modelId.localeCompare(b.modelId) : a.providerId.localeCompare(b.providerId)));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ profiles: sorted }, null, 2));
    return;
  }
  console.log("# model profiles");
  console.log("");
  if (sorted.length === 0) {
    console.log("(none)");
    return;
  }
  for (const profile of sorted) {
    console.log(formatModelProfileLine(profile));
  }
}

const NUMERIC_FIELD_FLAGS: Readonly<Record<string, "priceInputPerMillion" | "priceOutputPerMillion" | "contextLength" | "priority">> = {
  "--price-in": "priceInputPerMillion",
  "--price-out": "priceOutputPerMillion",
  "--context": "contextLength",
  "--priority": "priority",
};

/** `keryx routing profile set <provider>/<model> --tier|--price-in|--price-out|--context|--priority <value>` (AC8). */
async function runProfileSet(args: string[], userConfigDir: string | undefined): Promise<void> {
  const target = args[0];
  if (target === undefined || target.startsWith("--") || !target.includes("/")) {
    console.error("Usage: keryx routing profile set <provider>/<model> --tier|--price-in|--price-out|--context|--priority <value>");
    process.exitCode = 1;
    return;
  }
  const slash = target.indexOf("/");
  const providerId = target.slice(0, slash);
  const modelId = target.slice(slash + 1);
  if (providerId.length === 0 || modelId.length === 0) {
    console.error(`Could not parse "${target}" as <provider>/<model>.`);
    process.exitCode = 1;
    return;
  }
  let update: ModelProfileFieldValue | undefined;
  const tierIndex = args.indexOf("--tier");
  if (tierIndex !== -1) {
    const raw = args[tierIndex + 1];
    if (raw !== "light" && raw !== "standard" && raw !== "deep") {
      console.error(`--tier must be one of light, standard, deep (got ${JSON.stringify(raw)}).`);
      process.exitCode = 1;
      return;
    }
    update = { field: "tier", value: raw };
  } else {
    for (const [flag, field] of Object.entries(NUMERIC_FIELD_FLAGS)) {
      const idx = args.indexOf(flag);
      if (idx === -1) continue;
      const raw = args[idx + 1];
      const num = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(num)) {
        console.error(`${flag} must be a number (got ${JSON.stringify(raw)}).`);
        process.exitCode = 1;
        return;
      }
      update = { field, value: num } as ModelProfileFieldValue;
      break;
    }
  }
  if (update === undefined) {
    console.error("Usage: keryx routing profile set <provider>/<model> --tier|--price-in|--price-out|--context|--priority <value>");
    process.exitCode = 1;
    return;
  }
  const profile: ModelProfile = await setModelProfileField(providerId, modelId, update, userConfigDir);
  console.log(`${providerId}/${modelId}: ${formatModelProfileLine(profile)}`);
}

/** `$1.23`/`$0.0041` style — enough precision to distinguish two cheap models, never scientific notation. */
function formatUsd(value: number): string {
  const digits = value < 0.01 ? 4 : 2;
  return `$${value.toFixed(digits)}`;
}

function formatStatsLine(row: TaskCostStats): string {
  const cost = row.medianCostUsd !== undefined ? formatUsd(row.medianCostUsd) : "unknown";
  const success = `${Math.round(row.successRate * 100)}%`;
  return `${row.providerId}/${row.modelId}  [${row.category}]  n=${row.n}  median ${Math.round(row.medianTokens)} tok/task  ${cost}/task  ${success} success`;
}

/** `keryx routing stats [--json]` (flow 341) — real measured task cost per (provider, model, category), from `task-cost.ts`'s rolling on-disk store. Never prints a credential/key: the store holds only ids, token counts, a derived cost, and a boolean. */
function runStats(args: string[], userConfigDir: string | undefined): void {
  const store = readTaskCostStore(userConfigDir);
  const rows = allStats(store);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ stats: rows }, null, 2));
    return;
  }
  console.log("# routing task cost");
  console.log("");
  if (rows.length === 0) {
    console.log("(no measured tasks recorded yet)");
    return;
  }
  for (const row of rows) {
    console.log(formatStatsLine(row));
  }
}

async function runProfile(args: string[], userConfigDir: string | undefined): Promise<void> {
  const sub = args[0];
  if (sub === "list") {
    runProfileList(args.slice(1), userConfigDir);
    return;
  }
  if (sub === "set") {
    await runProfileSet(args.slice(1), userConfigDir);
    return;
  }
  console.error(`Unknown routing profile command: ${sub}`);
  console.error("Usage: keryx routing profile list [--json] | keryx routing profile set <provider>/<model> --tier|--price-in|--price-out|--context|--priority <value>");
  process.exitCode = 1;
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
  if (command === "profile") {
    await runProfile(args.slice(1), location.userConfigDir);
    return;
  }
  if (command === "stats") {
    runStats(args.slice(1), location.userConfigDir);
    return;
  }
  console.error(`Unknown routing command: ${command}`);
  printRoutingHelp();
  process.exitCode = 1;
}
