// `keryx routing` — read and edit model routing from the CLI. Every command
// operates on the one routing engine (`src/harness/routing/settings.ts`);
// there is no activation step and no engine switch. `set`/`unset` edit a
// category in the user or project layer, `trust` approves the project layer,
// `settings`/`classes` replace whole layers at an expected revision, and
// `migrate` persists settings written by earlier releases under the current
// keys. Mirrors `keryx providers`'s subcommand dispatch shape.
import { envWithSavedApiKeys, loadShellConfig } from "../lib/shell-config";
import { readConfigFile, readTranscriptFile } from "../lib/config-dir";
import { normalizeRoutingConfig, routingDigest, validateRoutingConfigLayer, type NormalizedRoutingConfig, type RoutingAssignment, type RoutingConfigLayer } from "../harness/routing/config";
import { migrateLegacyRouting, planLegacyRoutingMigration } from "../harness/routing/legacy-migration";
import {
  approveProjectRouting,
  readRoutingSettings,
  ROUTING_NORMALIZATION,
  setRoutingCategory,
  unsetRoutingCategory,
  updateRoutingLayer,
  type RoutingLocation,
  type RoutingScope,
} from "../harness/routing/settings";
import { resolveRoutingDecision } from "../harness/routing/resolver";
import { resolveRoutingForRuntime } from "../harness/routing/routing-runtime";
import { isModelClass, type ModelRef } from "../harness/routing/model-class";
import { buildCatalogRoutingSnapshot } from "../harness/routing/snapshot-adapter";
import { ROUTING_CAPABILITIES, type RoutingCapability, type RoutingRequest } from "../harness/routing/routing-request";
import { hasCredential } from "../harness/provider/single-turn";
import { makeProvider } from "../harness/provider/make-provider";
import { inspectProviderRoutingFacts } from "../harness/routing/provider-facts";
import { externalBlockReason, loadExternalProvidersConfig } from "../lib/external-providers";
import { resolveExternalSetting } from "../lib/external-switch";
import { summarizeRoutingPilot, type RoutingPilotObservation } from "../harness/routing/pilot";
import { resolveProviderDefaultModelId } from "../harness/routing/provider-default";
import { isRoutingCategory, ROUTING_CATEGORIES, type RoutingCategory } from "../harness/routing/table";
import { describeRoutingAssignment } from "../harness/routing/trust";
import {
  formatModelProfileLine,
  loadModelProfiles,
  setModelProfileField,
  type ModelProfile,
  type ModelProfileFieldValue,
} from "../harness/routing/model-profile";
import { allStats, readTaskCostStore, type TaskCostStats } from "../harness/routing/task-cost";

/** Seam for tests: production passes none (the real project cwd, the real per-user config dir). */
export interface RoutingCommandDeps {
  /** Project root. Default: `process.cwd()`. */
  readonly cwd?: string;
  /** Per-user config dir override — the SAME test seam `shell-config.ts` takes. Default: the real global config dir. */
  readonly userConfigDir?: string;
  /** AC10: connected-provider list. Default: the live provider catalog (flow 309, `../harness/provider-catalog.ts`) — same source `/routing`'s picker reads, a fresh cache answered immediately, a stale/missing one refreshed once. */
  providers?: () => Promise<readonly { name: string; models?: readonly string[] }[]>;
  /**
   * The session's own current provider/model — the baseline every `baseline`
   * assignment resolves to. Default: the persisted `ShellConfig.provider`/
   * `.model` (the CLI's best notion of "session" outside a live TUI).
   * `undefined` (nothing persisted yet) means `list` shows assignments only.
   */
  session?: () => { providerId: string; modelId: string } | undefined;
}

export function printRoutingHelp(): void {
  console.log(
    [
      "Usage: keryx routing <subcommand>",
      "",
      "  keryx routing list [--json]",
      "                              Every category, the model it resolves to, and which layer assigned it.",
      "  keryx routing set <category> <provider>/<model>|<class>|baseline|auto [--user|--project]",
      "                              Assign a category (default layer: --user). Classes: light, standard, expert, frontier.",
      "  keryx routing set <category> <provider> [--user|--project]",
      "                              Pin a provider's own default model for a category.",
      "  keryx routing unset <category> [--user|--project]",
      "                              Clear a category; it falls through to the next layer, then the session model.",
      "  keryx routing trust",
      "                              Review and approve the project's routing.config.json (required before it applies).",
      "  keryx routing classes list",
      "  keryx routing classes set <class> <file.json> --revision <revision>",
      "                              Show, or replace at the expected revision, a user model class pool.",
      "  keryx routing settings list",
      "  keryx routing settings set <user|project> <file.json> --revision <revision>",
      "                              Read or atomically replace a whole routing settings layer.",
      "  keryx routing explain --request <file.json> --json",
      "                              Resolve explicit task requirements and show decision evidence.",
      "  keryx routing pilot <observations.json|journal.jsonl>",
      "                              Report preview parity and fallback trace completeness.",
      "  keryx routing migrate [--dry-run] [--include-activated-user]",
      "                              Write routing settings from earlier releases under the current keys (idempotent).",
      "                              User settings an earlier release activated for one project stay scoped to it",
      "                              unless --include-activated-user adopts them for every project.",
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
function scopeFromArgs(args: readonly string[]): RoutingScope {
  return args.includes("--project") ? "project" : "user";
}

/** Refuse a flag the subcommand does not define instead of silently ignoring it. */
function rejectUnknownFlags(args: readonly string[], allowed: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !allowed.includes(arg));
  if (unknown.length > 0) throw new Error(`Unknown flag ${unknown.join(", ")} for keryx routing. See keryx routing --help.`);
}

function parseCategory(raw: string | undefined): RoutingCategory | undefined {
  if (raw === undefined || !isRoutingCategory(raw)) return undefined;
  return raw;
}

/** `<provider>/<model>`, a model class, `baseline`, `auto`, or a bare provider (its default model). */
export function parseRoutingTarget(raw: string): RoutingAssignment | { readonly error: string } {
  const value = raw.trim();
  if (value === "baseline") return { mode: "baseline" };
  if (value === "auto") return { mode: "auto" };
  if (isModelClass(value)) return { mode: "class", modelClass: value };
  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) {
    return { mode: "model", target: { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) } };
  }
  if (slash === -1 && value.length > 0) {
    const modelId = resolveProviderDefaultModelId(value);
    if (modelId === undefined) return { error: `Provider "${value}" has no known default model; name one: ${value}/<model>.` };
    return { mode: "model", target: { providerId: value, modelId } };
  }
  return { error: `Could not parse "${raw}" as <provider>/<model>, a model class, baseline or auto.` };
}

async function defaultProviders(): Promise<readonly { name: string; models?: readonly string[] }[]> {
  // Deferred like `/routing`'s own `defaultProviders`: the catalog pulls in
  // the provider stack, which a `routing set` never needs.
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

async function runSet(args: string[], location: RoutingLocation): Promise<void> {
  rejectUnknownFlags(args, ["--user", "--project"]);
  const category = parseCategory(args[0]);
  if (category === undefined) {
    console.error(`Unknown or missing category. Expected one of ${ROUTING_CATEGORIES.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  const target = args[1];
  if (target === undefined || target.startsWith("--")) {
    console.error("Usage: keryx routing set <category> <provider>/<model>|<class>|baseline|auto [--user|--project]");
    process.exitCode = 1;
    return;
  }
  const assignment = parseRoutingTarget(target);
  if ("error" in assignment) {
    console.error(assignment.error);
    process.exitCode = 1;
    return;
  }
  const scope = scopeFromArgs(args.slice(2));
  await setRoutingCategory(scope, location, category, assignment);
  console.log(`${category} -> ${describeRoutingAssignment(assignment)}  [${scope}]`);
  if (scope === "project") {
    console.log("Note: routing.config.json changes take effect only after `keryx routing trust` approves the file's current content.");
  }
}

async function runUnset(args: string[], location: RoutingLocation): Promise<void> {
  rejectUnknownFlags(args, ["--user", "--project"]);
  const category = parseCategory(args[0]);
  if (category === undefined) {
    console.error(`Unknown or missing category. Expected one of ${ROUTING_CATEGORIES.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  const scope = scopeFromArgs(args.slice(1));
  await unsetRoutingCategory(scope, location, category);
  console.log(`${category} -> unset  [${scope}]`);
}

/**
 * Review the project's routing settings and approve them. Prints what will
 * apply BEFORE recording anything (same discipline `keryx mcp trust` uses).
 */
function runTrust(location: RoutingLocation): void {
  const settings = readRoutingSettings(location);
  const layer = settings.project.layer;
  if (layer === undefined || Object.keys(layer).every((key) => key === "schemaVersion")) {
    console.log("routing.config.json declares no routing settings — nothing to approve.");
    return;
  }
  const result = approveProjectRouting(location);
  if (!result.ok) {
    console.error(`routing: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log("Approved routing.config.json:");
  for (const line of result.approved) console.log(`  ${line}`);
  console.log(`(${result.file})`);
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

async function listRouting(
  config: NormalizedRoutingConfig,
  location: RoutingLocation,
  deps: RoutingCommandDeps,
  json: boolean,
  explain?: Pick<RoutingRequest, "requestId" | "category" | "requirements">,
  notices: readonly string[] = [],
): Promise<void> {
  for (const notice of notices) console.error(`routing: ${notice}`);
  const baseline = deps.session?.() ?? defaultSession(location.configDir);
  if (baseline === undefined) {
    if (explain !== undefined) throw new Error("Select a session provider and model before explaining a routing request.");
    // Without a session there is no baseline to resolve against: show what is assigned, where.
    const assignments = ROUTING_CATEGORIES.map((category) => ({
      category, assignment: config.categories[category], source: config.categorySources[category],
    }));
    if (json) {
      console.log(JSON.stringify({ baseline: null, assignments, ...(notices.length > 0 ? { notices } : {}) }, null, 2));
      return;
    }
    console.log("Routing assignments (no session model selected, so nothing is resolved):");
    for (const row of assignments) console.log(`${row.category.padEnd(12)} ${describeRoutingAssignment(row.assignment)}  [${row.source}]`);
    return;
  }
  const [providers, external] = await Promise.all([
    (deps.providers ?? defaultProviders)(),
    resolveExternalSetting({ cwd: location.cwd, ...(location.configDir === undefined ? {} : { dir: location.configDir }) }),
  ]);
  const providerPolicy = loadExternalProvidersConfig(location.configDir).config;
  const profiles = loadModelProfiles(location.configDir);
  const env = envWithSavedApiKeys(process.env, location.configDir);
  const observedAt = new Date().toISOString();
  const targets = [baseline, ...providers.flatMap((provider) =>
    (provider.models ?? []).map((modelId) => ({ providerId: provider.name, modelId })))];
  const policyAllowed = ({ providerId, modelId }: ModelRef) =>
    external.value === "on" || externalBlockReason(providerId, modelId, providerPolicy) === undefined;
  const credentialsAvailable = ({ providerId }: ModelRef) => hasCredential(providerId, env, location.configDir);
  const facts = inspectProviderRoutingFacts(targets, (target) =>
    policyAllowed(target) && credentialsAvailable(target)
      ? makeProvider(target.providerId, target.modelId, {
          fetch, env, ...(location.configDir === undefined ? {} : { configDir: location.configDir }),
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
      catalogRevision: routingDigest({ providers, profiles }),
      policyRevision: routingDigest({ external: external.value, providerPolicy }),
      capabilityRevision: facts.capabilityRevision,
      policy: {
        credentialsAvailable,
        policyAllowed,
        parentAllowed: () => true,
        // The session model is the one already running; with a credential it is available.
        availability: (target) => target.providerId === baseline.providerId && target.modelId === baseline.modelId && credentialsAvailable(target)
          ? "available"
          : undefined,
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
            ...(location.configDir === undefined ? {} : { configDir: location.configDir }),
          },
        }).decision;
    return { category, decision };
  });
  if (json) {
    console.log(JSON.stringify({ baseline, decisions, ...(notices.length > 0 ? { notices } : {}) }, null, 2));
    return;
  }
  console.log(`Routing preview (no task requirements). Baseline: ${baseline.providerId}/${baseline.modelId}`);
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

function validateProposedLayer(value: unknown): RoutingConfigLayer {
  const result = validateRoutingConfigLayer(value, ROUTING_NORMALIZATION);
  if (!result.ok) throw new Error(`Invalid routing layer: ${result.errors.join(", ")}`);
  return value as RoutingConfigLayer;
}

function printSettings(location: RoutingLocation): void {
  const settings = readRoutingSettings(location);
  console.log(JSON.stringify({
    revision: settings.revision,
    user: settings.user,
    project: settings.project,
    effective: settings.layers,
    ...(settings.notices.length > 0 ? { notices: settings.notices } : {}),
  }, null, 2));
}

async function editRoutingSettings(args: readonly string[], location: RoutingLocation): Promise<void> {
  const [group, action, target, file, revisionFlag, expectedRevision] = args;
  if (group === "settings" && action === "list" && args.length === 2) {
    printSettings(location);
    return;
  }
  if (action !== "set" || file === undefined || revisionFlag !== "--revision" || !expectedRevision || args.length !== 6) {
    throw new Error("Supply a settings layer or model class, a JSON file, and --revision.");
  }
  let scope: RoutingScope;
  let next: RoutingConfigLayer;
  if (group === "settings" && (target === "project" || target === "user")) {
    scope = target;
    next = validateProposedLayer(readRoutingJson(file));
  } else if (group === "classes" && isModelClass(target)) {
    scope = "user";
    const user = readRoutingSettings(location).user.layer;
    next = validateProposedLayer({
      ...user,
      schemaVersion: 2,
      classes: { ...user?.classes, [target]: readRoutingJson(file) },
    });
  } else {
    throw new Error("Invalid settings layer or model class.");
  }
  const result = await updateRoutingLayer({ ...location, scope, expectedRevision, next });
  console.log(JSON.stringify(result, null, 2));
  if (scope === "project") console.log("Note: project routing settings take effect only after `keryx routing trust` approves them.");
}

async function migrateRouting(args: readonly string[], location: RoutingLocation): Promise<void> {
  const allowed = ["--dry-run", "--include-activated-user"];
  if (args.some((arg) => !allowed.includes(arg)) || new Set(args).size !== args.length) {
    throw new Error("Usage: keryx routing migrate [--dry-run] [--include-activated-user]");
  }
  const options = { includeActivatedUser: args.includes("--include-activated-user") };
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify(planLegacyRoutingMigration(location, ROUTING_NORMALIZATION, options), null, 2));
    return;
  }
  console.log(JSON.stringify(await migrateLegacyRouting(location, ROUTING_NORMALIZATION, options), null, 2));
}

function loadEffectiveRouting(location: RoutingLocation): { config: NormalizedRoutingConfig; notices: readonly string[] } {
  const settings = readRoutingSettings(location);
  return { config: normalizeRoutingConfig(settings.layers, ROUTING_NORMALIZATION), notices: settings.notices };
}

export async function routingCommand(args: string[], deps: RoutingCommandDeps = {}): Promise<void> {
  const location: RoutingLocation = {
    cwd: deps.cwd ?? process.cwd(),
    ...(deps.userConfigDir !== undefined ? { configDir: deps.userConfigDir } : {}),
  };
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printRoutingHelp();
    return;
  }
  if (command === "classes" && args[1] === "list" && args.length === 2) {
    console.log(JSON.stringify(loadEffectiveRouting(location).config.classes, null, 2));
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
    const { config, notices } = loadEffectiveRouting(location);
    await listRouting(config, location, deps, true, explainRequest(readRoutingJson(file)), notices);
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
    rejectUnknownFlags(args.slice(1), ["--json"]);
    const { config, notices } = loadEffectiveRouting(location);
    await listRouting(config, location, deps, args.includes("--json"), undefined, notices);
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
    runTrust(location);
    return;
  }
  if (command === "profile") {
    await runProfile(args.slice(1), location.configDir);
    return;
  }
  if (command === "stats") {
    runStats(args.slice(1), location.configDir);
    return;
  }
  console.error(`Unknown routing command: ${command}`);
  printRoutingHelp();
  process.exitCode = 1;
}
