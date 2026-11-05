// `keryx routing` — Flow 305 (Flow A), AC3: read and edit the routing table
// (category -> model, `src/harness/routing/table.ts`) from the CLI. Mirrors
// `keryx providers`'s subcommand dispatch shape (`providers.ts:1065-1090`).
//
// No classifier anywhere in this file (PLAN.md Flow A). `explain` (PRD §8) is
// Flow B — not implemented here. `list`/`set`/`unset`/`trust` are Flow A;
// `profile list`/`profile set` (AC8) and `list`'s `derived`-layer/
// unavailable-fallback reporting (AC10/AC11) are Flow 327 (Routing A2).
import { envWithSavedApiKeys, loadShellConfig } from "../lib/shell-config";
import { readConfigFile, readTranscriptFile } from "../lib/config-dir";
import { loadActiveRoutingV2 } from "../harness/routing/active-v2";
import { ROUTING_CLASSIFIER_ADAPTER_REGISTRY } from "../harness/routing/classifier-production-v2";
import { routingV2Digest, validateRoutingV2ConfigLayer, type NormalizedRoutingV2Config, type RoutingV2ConfigLayer } from "../harness/routing/config-v2";
import {
  applyRoutingV2Migration,
  createRoutingV2MigrationPlan,
  deactivateRoutingV2,
  proposeRoutingV2Categories,
  readActiveRoutingV2Settings,
  rollbackRoutingV2Migration,
  updateActiveRoutingV2Layer,
  type RoutingV2MigrationPlan,
} from "../harness/routing/migration-v2";
import { resolveRoutingDecision } from "../harness/routing/resolver";
import { resolveRoutingForRuntime } from "../harness/routing/routing-runtime";
import { isModelClass, type ModelRef } from "../harness/routing/model-class";
import { buildCatalogRoutingSnapshot } from "../harness/routing/snapshot-adapter";
import { ROUTING_CAPABILITIES, type RoutingCapability, type RoutingRequest } from "../harness/routing/routing-request";
import { hasCredential } from "../harness/provider/single-turn";
import { makeProvider } from "../harness/provider/make-provider";
import { inspectProviderRoutingFacts } from "../harness/routing/provider-facts-v2";
import { externalBlockReason, loadExternalProvidersConfig } from "../lib/external-providers";
import { resolveExternalSetting } from "../lib/external-switch";
import { summarizeRoutingPilot, type RoutingPilotObservation } from "../harness/routing/pilot-v2";
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

export function printRoutingHelp(): void {
  console.log(
    [
      "Usage: keryx routing <subcommand>",
      "",
      "  keryx routing list [--json]",
      "                              Every category, its resolved model, and which layer answered.",
      "  keryx routing classes list",
      "                              Show the active v2 model class pools.",
      "  keryx routing classes set <class> <file.json> --revision <revision>",
      "                              Replace a user model class pool at the expected revision.",
      "  keryx routing settings list",
      "  keryx routing settings set <user|project> <file.json> --revision <revision>",
      "                              Read or atomically replace an active v2 settings layer.",
      "  keryx routing explain --request <file.json> --json",
      "                              Resolve explicit task requirements and show decision evidence.",
      "  keryx routing pilot <observations.json|journal.jsonl>",
      "                              Report preview parity and fallback trace completeness.",
      "  keryx routing migrate --dry-run [proposed-layers.json]",
      "                              Print a reviewable v2 migration plan as JSON.",
      "  keryx routing migrate --apply|--rollback <plan.json> --confirm",
      "                              Apply or roll back a reviewed migration plan.",
      "  keryx routing migrate --deactivate --confirm",
      "                              Return future turns to legacy without restoring backups.",
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
  const session = loadSession();
  const connected = connectedPredicateFrom(providers, session);
  const profiles = loadModelProfiles(location.userConfigDir);
  const available = availablePredicateFromProfiles(profiles);
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

async function listRoutingV2(
  config: NormalizedRoutingV2Config,
  location: RoutingConfigLocation,
  deps: RoutingCommandDeps,
  json: boolean,
  explain?: Pick<RoutingRequest, "requestId" | "category" | "requirements">,
): Promise<void> {
  const baseline = deps.session?.() ?? defaultSession(location.userConfigDir);
  if (baseline === undefined) throw new Error("Select a session provider and model before previewing routing.");
  const [providers, external] = await Promise.all([
    (deps.providers ?? defaultProviders)(),
    resolveExternalSetting({ cwd: location.cwd, ...(location.userConfigDir === undefined ? {} : { dir: location.userConfigDir }) }),
  ]);
  const providerPolicy = loadExternalProvidersConfig(location.userConfigDir).config;
  const profiles = loadModelProfiles(location.userConfigDir);
  const env = envWithSavedApiKeys(process.env, location.userConfigDir);
  const observedAt = new Date().toISOString();
  const targets = [baseline, ...providers.flatMap((provider) =>
    (provider.models ?? []).map((modelId) => ({ providerId: provider.name, modelId })))];
  const policyAllowed = ({ providerId, modelId }: ModelRef) =>
    external.value === "on" || externalBlockReason(providerId, modelId, providerPolicy) === undefined;
  const credentialsAvailable = ({ providerId }: ModelRef) => hasCredential(providerId, env, location.userConfigDir);
  const facts = inspectProviderRoutingFacts(targets, (target) =>
    policyAllowed(target) && credentialsAvailable(target)
      ? makeProvider(target.providerId, target.modelId, {
          fetch, env, ...(location.userConfigDir === undefined ? {} : { configDir: location.userConfigDir }),
        }).describe()
      : undefined);
  const decisions = (explain === undefined ? ROUTING_CATEGORIES : [explain.category]).map((category) => {
    const request: RoutingRequest = {
      requestId: explain?.requestId ?? `preview:${category}`,
      category,
      origin: "operator",
      baseline,
      requirements: explain?.requirements ?? { capabilities: [], inputTokensRequired: 0, outputTokensReserved: 0 },
    };
    const snapshot = buildCatalogRoutingSnapshot({
      baseline, configDigest: config.configDigest, providers, profiles, request,
      observedAt,
      catalogRevision: routingV2Digest({ providers, profiles }),
      policyRevision: routingV2Digest({ external: external.value, providerPolicy }),
      capabilityRevision: facts.capabilityRevision,
      policy: {
        credentialsAvailable,
        policyAllowed,
        parentAllowed: () => true,
        capabilities: facts.capabilities,
        cooldown: () => false,
        observedLatencyMs: () => null,
      },
    });
    const decision = explain === undefined
      ? resolveRoutingDecision(request, snapshot, config)
      : resolveRoutingForRuntime({
          request, snapshot, config,
          journal: {
            kind: "preview", cwd: location.cwd,
            ...(location.userConfigDir === undefined ? {} : { configDir: location.userConfigDir }),
          },
        }).decision;
    return { category, decision };
  });
  if (json) {
    console.log(JSON.stringify({ engineVersion: 2, baseline, decisions }, null, 2));
    return;
  }
  console.log(`Routing v2 preview (no task requirements). Baseline: ${baseline.providerId}/${baseline.modelId}`);
  for (const { category, decision } of decisions) {
    const result = decision.status === "selected" ? `${decision.selection.providerId}/${decision.selection.modelId}`
      : decision.status === "blocked" ? decision.reason : decision.status;
    console.log(`${category}: ${result} [${decision.assignmentSource}]`);
  }
}

function pilotObservations(raw: unknown): RoutingPilotObservation[] {
  if (!Array.isArray(raw)) throw new Error("Routing pilot evidence must be an array of observations.");
  return raw.map((value: unknown, index) => {
    if (value === null || typeof value !== "object") throw new Error(`Invalid routing observation at index ${index}.`);
    const { kind, requestId, snapshotDigest, classifierReceiptId, selection, fallback } = value as Record<string, unknown>;
    if ((kind !== "preview" && kind !== "dispatch") || typeof requestId !== "string" || requestId.length === 0
      || typeof snapshotDigest !== "string" || snapshotDigest.length === 0
      || (classifierReceiptId !== undefined && typeof classifierReceiptId !== "string")) {
      throw new Error(`Invalid routing observation at index ${index}.`);
    }
    const base = { requestId, snapshotDigest, ...(classifierReceiptId === undefined ? {} : { classifierReceiptId }) };
    let target: RoutingPilotObservation["selection"];
    if (selection !== undefined) {
      if (selection === null || typeof selection !== "object") throw new Error(`Invalid routing selection at index ${index}.`);
      const { providerId, modelId } = selection as Record<string, unknown>;
      if (typeof providerId !== "string" || !providerId || typeof modelId !== "string" || !modelId) {
        throw new Error(`Invalid routing selection at index ${index}.`);
      }
      target = { providerId, modelId };
    }
    const observed = { ...base, ...(target === undefined ? {} : { selection: target }) };
    if (kind === "preview") return { ...observed, kind };
    if (fallback === undefined) return { ...observed, kind };
    if (fallback === null || typeof fallback !== "object") throw new Error(`Invalid routing fallback at index ${index}.`);
    const { parentDecisionId, reason } = fallback as Record<string, unknown>;
    return {
      ...observed,
      kind,
      fallback: {
        ...(typeof parentDecisionId === "string" ? { parentDecisionId } : {}),
        ...(typeof reason === "string" ? { reason } : {}),
      },
    };
  });
}

function pilotJournal(file: string): RoutingPilotObservation[] {
  const read = readTranscriptFile(file);
  if (!read.ok) throw new Error(`Could not read routing journal: ${read.reason}.`);
  const rows: unknown[] = read.text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  return pilotObservations(rows.flatMap((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid routing journal record.");
    const record = row as Record<string, unknown>;
    if (record.kind === "attempt") return [];
    return [{
      ...record,
      ...((record.parentDecisionId !== undefined || record.fallbackReason !== undefined)
        ? { fallback: { parentDecisionId: record.parentDecisionId, reason: record.fallbackReason } }
        : {}),
    }];
  }));
}

function readRoutingJson(file: string): unknown {
  const read = readConfigFile(file);
  if (!read.ok) throw new Error(`Could not read routing input: ${read.reason}.`);
  return JSON.parse(read.text);
}

function explainRequest(raw: unknown): Pick<RoutingRequest, "requestId" | "category" | "requirements"> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a routing request object.");
  const { requestId, category, requirements } = raw as Record<string, unknown>;
  if (typeof requestId !== "string" || !requestId || typeof category !== "string" || !isRoutingCategory(category)
    || requirements === null || typeof requirements !== "object" || Array.isArray(requirements)) {
    throw new Error("Expected requestId, category and requirements.");
  }
  const { capabilities, inputTokensRequired, outputTokensReserved, minimumClass, maxEstimatedCostUsd } = requirements as Record<string, unknown>;
  if (!Array.isArray(capabilities) || !capabilities.every((value: unknown): value is RoutingCapability =>
    ROUTING_CAPABILITIES.some((capability) => capability === value))
    || typeof inputTokensRequired !== "number" || !Number.isSafeInteger(inputTokensRequired) || inputTokensRequired < 0
    || typeof outputTokensReserved !== "number" || !Number.isSafeInteger(outputTokensReserved) || outputTokensReserved < 0
    || (minimumClass !== undefined && !isModelClass(minimumClass))
    || (maxEstimatedCostUsd !== undefined && (typeof maxEstimatedCostUsd !== "number" || !Number.isFinite(maxEstimatedCostUsd) || maxEstimatedCostUsd < 0))) {
    throw new Error("Invalid routing task requirements.");
  }
  return {
    requestId, category,
    requirements: {
      capabilities, inputTokensRequired, outputTokensReserved,
      ...(minimumClass === undefined ? {} : { minimumClass }),
      ...(maxEstimatedCostUsd === undefined ? {} : { maxEstimatedCostUsd }),
    },
  };
}

function validateProposedLayer(value: unknown): RoutingV2ConfigLayer | undefined {
  if (value === undefined) return undefined;
  const result = validateRoutingV2ConfigLayer(value, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  if (!result.ok) throw new Error(`Invalid routing layer: ${result.errors.join(", ")}`);
  return value as RoutingV2ConfigLayer;
}

async function editRoutingSettings(args: readonly string[], location: RoutingConfigLocation): Promise<void> {
  const [group, action, target, file, revisionFlag, expectedRevision] = args;
  const normalization = { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY };
  const settings = readActiveRoutingV2Settings(location.cwd, location.userConfigDir, normalization);
  if (settings === undefined) throw new Error("Activate routing v2 with a reviewed migration plan first.");
  if (group === "settings" && action === "list" && args.length === 2) {
    console.log(JSON.stringify(settings, null, 2));
    return;
  }
  if (action !== "set" || file === undefined || revisionFlag !== "--revision" || !expectedRevision || args.length !== 6) {
    throw new Error("Supply a settings layer or model class, a JSON file, and --revision.");
  }
  let layer: "project" | "user";
  let next: RoutingV2ConfigLayer | undefined;
  if (group === "settings" && (target === "project" || target === "user")) {
    layer = target;
    next = validateProposedLayer(readRoutingJson(file));
  } else if (group === "classes" && isModelClass(target)) {
    layer = "user";
    const user = settings.layers.user;
    next = validateProposedLayer({
      ...user,
      schemaVersion: 2,
      classes: { ...user?.classes, [target]: readRoutingJson(file) },
    });
  } else {
    throw new Error("Invalid settings layer or model class.");
  }
  if (next === undefined) throw new Error("Expected a routing settings layer.");
  const result = await updateActiveRoutingV2Layer({
    cwd: location.cwd,
    ...(location.userConfigDir === undefined ? {} : { configDir: location.userConfigDir }),
    layer,
    expectedRevision,
    next,
    normalization,
  });
  console.log(JSON.stringify(result, null, 2));
}

function routingMigrationContext(location: RoutingConfigLocation) {
  return {
    cwd: location.cwd,
    ...(location.userConfigDir === undefined ? {} : { configDir: location.userConfigDir }),
    normalization: { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY },
  };
}

async function buildDefaultRoutingV2Plan(location: RoutingConfigLocation): Promise<RoutingV2MigrationPlan> {
  const context = routingMigrationContext(location);
    const [project, user] = await Promise.all([loadRoutingConfigRaw("project", location), loadRoutingConfigRaw("user", location)]);
    if (project.error || user.error) throw new Error("Resolve invalid legacy routing entries before migration.");
    const projectProposal = proposeRoutingV2Categories(project.table);
    const userProposal = proposeRoutingV2Categories(user.table, {
      ...(process.env.KERYX_SUBAGENT_MODEL === undefined ? {} : { subagentModelOverride: process.env.KERYX_SUBAGENT_MODEL }),
    });
    const projectCategories = Object.fromEntries(ROUTING_CATEGORIES.filter((category) => project.table[category] !== undefined)
      .map((category) => [category, projectProposal.categories[category]]));
    const userCategories = Object.fromEntries(ROUTING_CATEGORIES.filter((category) => user.table[category] !== undefined)
      .map((category) => [category, userProposal.categories[category]]));
    return createRoutingV2MigrationPlan({
      ...context,
      project: { schemaVersion: 2, categories: projectCategories },
      user: { schemaVersion: 2, categories: userCategories },
      unresolved: [...projectProposal.unresolved, ...userProposal.unresolved],
    });
}

export type RoutingV2Mode = "v2" | "legacy";

/** Current routing mode for the project/user config at `location`. Never throws. */
export function routingV2Mode(location: RoutingConfigLocation): RoutingV2Mode {
  try {
    return loadActiveRoutingV2(location.cwd, location.userConfigDir) === undefined ? "legacy" : "v2";
  } catch {
    return "legacy";
  }
}

/**
 * `/route-v2 on|off` from the TUI: the same steps as `routing migrate
 * --dry-run` + `--apply <plan> --confirm` (on) or `--deactivate --confirm`
 * (off), without a plan file. Returns a one-line status; throws with the
 * migration's own message when it cannot proceed.
 */
export async function setRoutingV2Active(on: boolean, location: RoutingConfigLocation): Promise<string> {
  const context = routingMigrationContext(location);
  if (!on) {
    const result = await deactivateRoutingV2({ ...context, confirmed: true });
    return result.status === "already-deactivated" ? "Routing v2 is already off (legacy mode)." : "Routing v2 off — legacy routing is active.";
  }
  const override = process.env.KERYX_SUBAGENT_MODEL?.trim();
  if (override && override !== "inherit") {
    throw new Error("Resolve and clear KERYX_SUBAGENT_MODEL before activating routing v2.");
  }
  const plan = await buildDefaultRoutingV2Plan(location);
  const result = await applyRoutingV2Migration(plan, { ...context, confirmed: true });
  return result.status === "already-applied" ? "Routing v2 is already on." : "Routing v2 on — model classes are active.";
}

async function migrateRouting(args: readonly string[], location: RoutingConfigLocation): Promise<void> {
  const context = {
    cwd: location.cwd,
    ...(location.userConfigDir === undefined ? {} : { configDir: location.userConfigDir }),
    normalization: { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY },
  };
  const [mode, file, confirmation] = args;
  if (mode === "--deactivate" && file === "--confirm" && args.length === 2) {
    console.log(JSON.stringify(await deactivateRoutingV2({ ...context, confirmed: true }), null, 2));
    return;
  }
  if (mode === "--dry-run" && args.length <= 2) {
    if (file !== undefined) {
      const raw = readRoutingJson(file);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected an object with project and user routing layers.");
      const record = raw as Record<string, unknown>;
      if (Object.keys(record).some((key) => key !== "project" && key !== "user")) throw new Error("Only project and user layers are accepted.");
      const project = validateProposedLayer(record.project);
      const user = validateProposedLayer(record.user);
      if (project === undefined && user === undefined) throw new Error("Supply at least one proposed layer.");
      const override = process.env.KERYX_SUBAGENT_MODEL?.trim();
      const unresolved = override && override !== "inherit"
        ? [{ code: "subagent-model-override", message: "Clear KERYX_SUBAGENT_MODEL after resolving its v2 assignment." }]
        : [];
      console.log(JSON.stringify(await createRoutingV2MigrationPlan({
        ...context, unresolved,
        ...(project === undefined ? {} : { project }), ...(user === undefined ? {} : { user }),
      }), null, 2));
      return;
    }
    console.log(JSON.stringify(await buildDefaultRoutingV2Plan(location), null, 2));
    return;
  }
  if ((mode === "--apply" || mode === "--rollback") && file !== undefined && confirmation === "--confirm" && args.length === 3) {
    const override = process.env.KERYX_SUBAGENT_MODEL?.trim();
    if (mode === "--apply" && override && override !== "inherit") {
      throw new Error("Resolve and clear KERYX_SUBAGENT_MODEL before activating routing v2.");
    }
    const plan = readRoutingJson(file) as RoutingV2MigrationPlan;
    const operation = mode === "--apply" ? applyRoutingV2Migration : rollbackRoutingV2Migration;
    console.log(JSON.stringify(await operation(plan, { ...context, confirmed: true }), null, 2));
    return;
  }
  throw new Error("Usage: keryx routing migrate --dry-run [proposed-layers.json], --apply|--rollback <plan.json> --confirm, or --deactivate --confirm.");
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
  if (command === "classes" && args[1] === "list" && args.length === 2) {
    const config = loadActiveRoutingV2(location.cwd, location.userConfigDir);
    if (config === undefined) {
      console.log("Routing is in legacy mode. No v2 model class pools are active.");
      return;
    }
    console.log(JSON.stringify(config.classes, null, 2));
    return;
  }
  if (command === "settings" || command === "classes") {
    await editRoutingSettings(args, location);
    return;
  }
  if (command === "explain") {
    const file = args[2];
    if (args[1] !== "--request" || file === undefined || args[3] !== "--json" || args.length !== 4) {
      throw new Error("Usage: keryx routing explain --request <file.json> --json.");
    }
    const config = loadActiveRoutingV2(location.cwd, location.userConfigDir);
    if (config === undefined) throw new Error("Routing v2 must be active to explain a request.");
    await listRoutingV2(config, location, deps, true, explainRequest(readRoutingJson(file)));
    return;
  }
  if (command === "pilot" && args[1] !== undefined && args.length === 2) {
    const result = summarizeRoutingPilot(args[1].endsWith(".jsonl")
      ? pilotJournal(args[1])
      : pilotObservations(readRoutingJson(args[1])));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "migrate") {
    await migrateRouting(args.slice(1), location);
    return;
  }
  if (command === "list") {
    const config = args.includes("--legacy") ? undefined : loadActiveRoutingV2(location.cwd, location.userConfigDir);
    if (config !== undefined) {
      await listRoutingV2(config, location, deps, args.includes("--json"));
      return;
    }
    await runList(args.slice(1), location, deps);
    return;
  }
  if (command === "set") {
    if (!args.includes("--legacy") && loadActiveRoutingV2(location.cwd, location.userConfigDir) !== undefined) {
      throw new Error("Routing v2 is active. Use the v2 migration plan to change assignments, or pass --legacy to edit legacy settings.");
    }
    await runSet(args.slice(1), location);
    return;
  }
  if (command === "unset") {
    if (!args.includes("--legacy") && loadActiveRoutingV2(location.cwd, location.userConfigDir) !== undefined) {
      throw new Error("Routing v2 is active. Use the v2 migration plan to change assignments, or pass --legacy to edit legacy settings.");
    }
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
