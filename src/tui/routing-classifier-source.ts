// Flow 338 — the routing classifier's shell-side wiring: turns one user
// request line into a routed provider/model, or `undefined` when nothing
// should override the session's own model (routing off, a slash command, every classifier stage came back empty).
//
// `src/tui/` is a CLIENT zone and may import both the decision-layer
// classifiers and the routing table freely — same shape `turn-guard-
// source.ts` already uses for `../review/turn-guard` + `../harness/decision/
// jev-client`.

import {
  CLASSIFY_TURN_TIMEOUT_MS,
  type ClassifyTurnResult,
} from "../harness/decision/classify-turn";
import type { TaskClassifierUsage } from "../harness/decision/classifier";
import {
  connectedPredicateFrom,
  describeAssignment,
  type CategoryAssignment,
  type FlatPickerProvider,
  type RoutingCategory,
  } from "../harness/routing/table";
import { selectClassifierModel } from "../harness/routing/classifier-model";
import { hasCredential, type ProviderFactory } from "../harness/provider/single-turn";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { redactSensitiveText } from "../security/service";
import { resolveExternalSetting } from "../lib/external-switch";
import { externalAllowedConnectedPredicate, loadExternalProvidersConfig } from "../lib/external-providers";
import { loadModelProfiles, profileKey } from "../harness/routing/model-profile";
import { loadRouting } from "../harness/routing/settings";
import type { NormalizedRoutingConfig } from "../harness/routing/config";
import { routingDigest } from "../harness/routing/config";
import { estimateModelCostUsd } from "../harness/routing/snapshot-adapter";
import type { RoutingDecisionReceipt } from "../harness/routing/routing-runtime";
import type { RoutingAssignment } from "../harness/routing/config";
import type { RoutingRequirements } from "../harness/routing/routing-request";
import type { RoutingCapability } from "../harness/routing/routing-request";
import type { RoutingBudgetLedger } from "../harness/routing/routing-budget";
import { routeTurn } from "../harness/routing/routing-turn-service";
import type { RoutingSnapshot } from "../harness/routing/snapshot";
import type { RoutingRequest } from "../harness/routing/routing-request";
import type { NormalizedRequest, NormalizedUsage, ProviderDescription } from "../harness/provider/types";
import { estimateRequestTokens } from "../harness/provider/context-guard";
import { DEFAULT_JEV_ROUTING_TARGET } from "../harness/routing/classifier-adapters";
import { randomUUID } from "node:crypto";

export interface RoutingClassifierTurnOptions {
  readonly enabled: boolean;
  readonly jevEnabled: boolean;
  /** Separate caller authorization for the JEV service; /external is still enforced by its client. */
  readonly jevAllowed?: boolean;
  readonly cwd: string;
  readonly detected: readonly FlatPickerProvider[];
  /** Same live catalog as the picker; detection is for headless callers only. */
  readonly providers?: () => Promise<readonly FlatPickerProvider[]>;
  readonly sessionProvider: string;
  readonly sessionModel: string;
  readonly env?: Record<string, string | undefined>;
  readonly userConfigDir?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly providerFactory?: ProviderFactory;
  /** Trusted static capability description for any catalog target. */
  readonly describeProvider?: (providerId: string, modelId: string) => ProviderDescription;
  /** Stable trusted task identity, shared by classification and execution. */
  readonly requestId?: string;
  /** Frozen trusted task envelope; omitted only by legacy/headless callers. */
  readonly requirements?: RoutingRequirements;
  /** Capabilities proven by the live baseline ProviderPort description. */
  readonly baselineCapabilities?: readonly RoutingCapability[];
  /** Additional caller policy; denial excludes a model. */
  readonly classifierAllowed?: (providerId: string, modelId: string) => boolean;
  /** Executor policy, separate from classifier policy. */
  readonly executorAllowed?: (providerId: string, modelId: string) => boolean;
}

export interface RoutingClassifierTurnResult {
  readonly classification: ClassifyTurnResult;
  readonly category?: RoutingCategory;
  readonly baseline?: { readonly providerId: string; readonly modelId: string };
  readonly assignment: CategoryAssignment;
  /** First rejected provider-default target and safe failure reason. */
  readonly fallbackReason?: string;
  /** `undefined` when the resolved assignment is `session-default` — nothing to route to, the session's own model applies unchanged. */
  readonly routed?: { readonly providerId: string; readonly modelId: string };
  /** Routing denial is terminal; callers must not silently run the baseline. */
  readonly blockTurn?: boolean;
  /** Frozen routing inputs consumed by the execution ProviderPort wrapper. */
  readonly routingExecution?: {
    readonly config: NormalizedRoutingConfig;
    readonly request: RoutingRequest;
    readonly snapshot: RoutingSnapshot;
    readonly budget: RoutingBudgetLedger;
    readonly target: { readonly providerId: string; readonly modelId: string };
    readonly receipt: RoutingDecisionReceipt;
    readonly beforeIo: (
      target: { readonly providerId: string; readonly modelId: string },
      decisionId: string,
      context: { readonly signal: AbortSignal },
    ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: "cancelled" | "policy-denied" | "credentials-missing" }>;
    readonly estimatedCostUsd: (request: NormalizedRequest, target: { readonly providerId: string; readonly modelId: string }) => number | null;
    readonly actualCostUsd: (
      request: NormalizedRequest,
      target: { readonly providerId: string; readonly modelId: string },
      usage: NormalizedUsage | undefined,
      estimatedCostUsd: number | null,
    ) => number;
    /** Absolute monotonic deadline shared by preparation and provider admission. */
    readonly selectionDeadline: number;
    readonly journal: { readonly cwd: string; readonly configDir?: string };
  };
}

/**
 * AC5/AC6/AC7: run the classifier chain, then resolve the winning category
 * through the SAME `resolveCategoryDetailed` — project + user + `derived`
 * layers, exactly what `keryx routing list` (`../commands/routing.ts`) and
 * `/routing` (`./routing-inspector.ts`) already build via `deriveDefaultTable`
 * (flow 327, PRD §6.3). Unlike those two call sites, this one is ALWAYS
 * inside a live turn — `opts.sessionProvider`/`opts.sessionModel` are
 * required fields here, never `undefined` — so the derived table always
 * builds; there is no "session not known yet" branch to guard for.
 *
 * This intentionally reaches further than `review`/`subagents`
 * (`commands/review.ts`, `spawn-subagent-tool.ts`), which still resolve from
 * project + user only (flow 305's original scope, predating the derived
 * layer). Without `derived` here, an operator who has configured nothing —
 * the common case — would see every category resolve to `session-default`,
 * making `/route on` a no-op: the whole point of this flow is to route an
 * UNCONFIGURED operator to the derived table's per-category pick (the
 * strongest model for planning/review, one step down for
 * subagents/docs/unattended, the smallest for quick), not just to honor
 * explicit configuration. Returns `undefined` when routing is off, the line
 * is a slash command / empty-vocabulary case (`classifyTurn` itself
 * returns `undefined`), or every stage refused.
 */
/** Bound live catalog preparation even when the loader ignores cancellation. */
async function loadTurnProviders(
  load: () => Promise<readonly FlatPickerProvider[]>, signal: AbortSignal | undefined, timeoutMs: number,
): Promise<readonly FlatPickerProvider[] | undefined> {
  if (signal?.aborted || timeoutMs <= 0) return undefined;
  let stop!: () => void;
  const stopped = new Promise<undefined>((resolve) => { stop = () => resolve(undefined); });
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    return await Promise.race([Promise.resolve().then(load), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

function categoryAssignmentFor(assignment: RoutingAssignment): CategoryAssignment {
  if (assignment.mode === "model") return { kind: "model", providerId: assignment.target.providerId, modelId: assignment.target.modelId };
  return { kind: "session-default" };
}

function capabilitiesFromDescription(description: ProviderDescription): readonly RoutingCapability[] {
  return [
    ...(description.capabilities.toolCalls ? ["tools" as const] : []),
    ...(description.capabilities.vision ? ["vision" as const] : []),
    ...(description.capabilities.structuredOutput ? ["structured-output" as const] : []),
  ];
}

function catalogCapabilityFacts(
  providers: readonly FlatPickerProvider[],
  baseline: { readonly providerId: string; readonly modelId: string },
  opts: RoutingClassifierTurnOptions,
  config: NormalizedRoutingConfig | undefined,
): ReadonlyMap<string, readonly RoutingCapability[]> {
  const facts = new Map<string, readonly RoutingCapability[]>();
  facts.set(profileKey(baseline.providerId, baseline.modelId), [...(opts.baselineCapabilities ?? [])].sort());
  if (opts.describeProvider === undefined || config === undefined) return facts;
  const candidates = [
    ...Object.values(config.classes).flatMap((modelClass) => modelClass.candidates.map((candidate) => candidate.target)),
    ...Object.values(config.categories).flatMap((assignment) => assignment.mode === "model" ? [assignment.target] : []),
  ];
  for (const target of candidates) {
    const key = profileKey(target.providerId, target.modelId);
    if (facts.has(key)) continue;
    const catalogHasTarget = providers.some((provider) => provider.name === target.providerId
      && provider.models?.includes(target.modelId));
    if (!catalogHasTarget) continue;
    try {
      const description = opts.describeProvider(target.providerId, target.modelId);
      if (description.descriptor.providerId !== target.providerId) throw new Error("provider description identity mismatch");
      facts.set(key, [...capabilitiesFromDescription(description)].sort());
    } catch {
      // Missing or invalid provider metadata proves no capability.
      facts.set(key, []);
    }
  }
  return facts;
}

async function runRoutingForTurn(
  line: string,
  opts: RoutingClassifierTurnOptions,
  config: NormalizedRoutingConfig,
  providers: readonly FlatPickerProvider[],
  profiles: ReturnType<typeof loadModelProfiles>,
  env: Record<string, string | undefined>,
  externalAllowed: (providerId: string, modelId?: string) => boolean,
  fallbackModel: { readonly providerId: string; readonly modelId: string } | undefined,
  snapshotMeta: { readonly observedAt: string; readonly policyRevision: string; readonly capabilityRevision: string },
  capabilityFacts: ReadonlyMap<string, readonly RoutingCapability[]>,
  deadline: number,
): Promise<RoutingClassifierTurnResult | undefined> {
  const baseline = { providerId: opts.sessionProvider, modelId: opts.sessionModel };
  const baseRequest: RoutingRequest = {
    requestId: opts.requestId ?? randomUUID(),
    category: "default",
    origin: "operator" as const,
    baseline,
    requirements: opts.requirements ?? {
      capabilities: [],
      inputTokensRequired: Math.max(1, Math.ceil(line.length / 4)),
      outputTokensReserved: 4_096,
    },
  };
  const targetForClassifier = (adapterId: string): { readonly providerId: string; readonly modelId: string } | undefined => {
    const entry = config.classifier.chain.find((candidate) => candidate.adapterId === adapterId);
    return entry?.target ?? (adapterId === "jev" ? DEFAULT_JEV_ROUTING_TARGET : undefined);
  };
  const classifierCost = (adapterId: string): number | null => {
    const target = targetForClassifier(adapterId);
    return target === undefined ? null : estimateModelCostUsd(
      profiles[profileKey(target.providerId, target.modelId)],
      Math.max(1, Math.ceil(Math.min(line.length, 4_000) / 4)),
      180,
    );
  };
  const classifierActualCost = (adapter: { readonly id: string; lastUsage?: () => NormalizedUsage | undefined }): number | undefined => {
    const target = targetForClassifier(adapter.id);
    if (target === undefined) return undefined;
    const estimated = classifierCost(adapter.id);
    const usage = adapter.lastUsage?.();
    if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return estimated ?? undefined;
    return estimateModelCostUsd(
      profiles[profileKey(target.providerId, target.modelId)],
      usage.inputTokens,
      usage.outputTokens,
    ) ?? estimated ?? undefined;
  };
  const routed = await routeTurn({
    task: line,
    request: baseRequest,
    config,
    providers,
    profiles,
    snapshotMeta,
    snapshotPolicy: {
      credentialsAvailable: (target) => target.providerId === baseline.providerId || hasCredential(target.providerId, env),
      policyAllowed: (target) => externalAllowed(target.providerId, target.modelId) && (opts.executorAllowed?.(target.providerId, target.modelId) ?? true),
      parentAllowed: () => true,
      capabilities: (target) => capabilityFacts.get(profileKey(target.providerId, target.modelId)) ?? [],
      cooldown: () => false,
      observedLatencyMs: () => null,
      availability: (target) => target.providerId === baseline.providerId && target.modelId === baseline.modelId ? "available" : undefined,
    },
    classifier: {
      estimatedCostUsd: (adapter) => classifierCost(adapter.id),
      actualCostUsd: classifierActualCost,
      adapterInput: {
        sessionProvider: opts.sessionProvider,
        ...(fallbackModel === undefined ? {} : { fallbackModel }),
        env,
        jevEnabled: opts.jevEnabled,
        ...(opts.jevAllowed === undefined ? {} : { jevAllowed: opts.jevAllowed }),
        externalAllowed: (providerId, modelId) => externalAllowed(providerId, modelId),
        ...(opts.classifierAllowed === undefined ? {} : { classifierAllowed: opts.classifierAllowed }),
        ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
        ...(opts.providerFactory === undefined ? {} : { providerFactory: opts.providerFactory }),
        ...(opts.userConfigDir === undefined ? {} : { userConfigDir: opts.userConfigDir }),
      },
    },
    journal: { cwd: opts.cwd, ...(opts.userConfigDir === undefined ? {} : { configDir: opts.userConfigDir }), kind: "dispatch" },
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    timeoutMs: Math.max(0, deadline - performance.now()),
  });
  if (routed.status === "cancelled") return undefined;
  const { request, snapshot, budget, receipt } = routed;
  const classified = routed.classification;
  const category = request.category;
  const decision = receipt.decision;
  const source = classified?.status === "classified" && classified.adapterId.toLowerCase() === "jev" ? "jev" as const : "main-model" as const;
  const classification: ClassifyTurnResult = classified?.status === "classified"
    ? { result: { ok: true, category, confidence: classified.classification.confidence, source }, trace: [] }
    : { result: { ok: false, reason: classified === undefined ? "classification not required" : "classifier-failed" }, trace: [] };
  const fallbackReason = decision.status === "blocked" ? decision.reason
    : decision.status === "needs-classification" ? "classification required"
    : classified?.status === "fallback" ? "classifier-failed" : undefined;
  const assignment = decision.status === "selected"
    ? decision.selection.providerId === baseline.providerId && decision.selection.modelId === baseline.modelId
      ? { kind: "session-default" as const }
      : { kind: "model" as const, providerId: decision.selection.providerId, modelId: decision.selection.modelId }
    : categoryAssignmentFor(config.categories[category]);
  const result: RoutingClassifierTurnResult = {
    classification,
    category,
    baseline,
    assignment,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    ...(decision.status === "blocked" || decision.status === "needs-classification" ? { blockTurn: true } : {}),
    ...(decision.status !== "selected" ? {} : { routingExecution: {
      config,
      request,
      snapshot,
      budget,
      target: decision.selection,
      receipt,
      beforeIo: async (target, _decisionId, context) => {
        if (context.signal.aborted) return { ok: false as const, reason: "cancelled" as const };
        const liveExternal = await resolveExternalSetting({
          cwd: opts.cwd,
          ...(opts.userConfigDir === undefined ? {} : { dir: opts.userConfigDir }),
        });
        if (context.signal.aborted) return { ok: false as const, reason: "cancelled" as const };
        const liveAllowed = externalAllowedConnectedPredicate(
          connectedPredicateFrom(providers),
          liveExternal.value === "on",
          loadExternalProvidersConfig(opts.userConfigDir).config,
        );
        if (!liveAllowed(target.providerId, target.modelId)
          || !(opts.executorAllowed?.(target.providerId, target.modelId) ?? true)) {
          return { ok: false as const, reason: "policy-denied" as const };
        }
        const liveEnv = envWithSavedApiKeys(opts.env ?? process.env, opts.userConfigDir);
        if (target.providerId !== baseline.providerId && !hasCredential(target.providerId, liveEnv)) {
          return { ok: false as const, reason: "credentials-missing" as const };
        }
        return { ok: true as const };
      },
      estimatedCostUsd: (normalized, target) => estimateModelCostUsd(
        profiles[profileKey(target.providerId, target.modelId)],
        estimateRequestTokens(normalized.messages, normalized.systemInstruction, normalized.tools ?? []),
        normalized.budget.maxOutputTokens,
      ),
      actualCostUsd: (normalized, target, usage, estimated) => usage?.inputTokens === undefined || usage.outputTokens === undefined
        ? estimated ?? 0
        : estimateModelCostUsd(
          profiles[profileKey(target.providerId, target.modelId)],
          usage.inputTokens,
          usage.outputTokens,
        ) ?? estimated ?? 0,
      selectionDeadline: Math.min(deadline, performance.now() + config.execution.selectionTimeoutMs),
      journal: { cwd: opts.cwd, ...(opts.userConfigDir === undefined ? {} : { configDir: opts.userConfigDir }) },
    } }),
  };
  return decision.status === "selected" && assignment.kind === "model"
    ? { ...result, routed: { providerId: assignment.providerId, modelId: assignment.modelId } }
    : result;
}

export async function runRoutingClassifierForTurn(
  line: string,
  opts: RoutingClassifierTurnOptions,
): Promise<RoutingClassifierTurnResult | undefined> {
  if (opts.signal?.aborted) return undefined;
  if (!opts.enabled) return undefined;
  let routingConfig: NormalizedRoutingConfig;
  try {
    routingConfig = loadRouting(opts.cwd, opts.userConfigDir);
  } catch (error) {
    const baseline = { providerId: opts.sessionProvider, modelId: opts.sessionModel };
    return {
      classification: { result: { ok: false, reason: "invalid routing configuration" }, trace: [] },
      category: "default",
      baseline,
      assignment: { kind: "session-default" },
      fallbackReason: redactSensitiveText(`routing configuration is invalid: ${error instanceof Error ? error.message : String(error)}`),
      blockTurn: true,
    };
  }

  const deadline = performance.now() + Math.max(0, opts.timeoutMs ?? CLASSIFY_TURN_TIMEOUT_MS);
  let profiles!: ReturnType<typeof loadModelProfiles>;
  let providers!: readonly FlatPickerProvider[];
  let env!: Record<string, string | undefined>;
  let external!: Awaited<ReturnType<typeof resolveExternalSetting>>;
  let externalProviders!: ReturnType<typeof loadExternalProvidersConfig>["config"];
  let externalAllowed!: ReturnType<typeof externalAllowedConnectedPredicate>;
  let fallbackModel: { readonly providerId: string; readonly modelId: string } | undefined;
  try {
    profiles = loadModelProfiles(opts.userConfigDir);
    const loadedProviders = opts.providers === undefined ? opts.detected : await loadTurnProviders(opts.providers, opts.signal, Math.max(0, deadline - performance.now()));
    if (loadedProviders === undefined) return undefined;
    providers = loadedProviders;
    if (opts.signal?.aborted) return undefined;
    env = envWithSavedApiKeys(opts.env ?? process.env, opts.userConfigDir);
    // Mandatory privacy gate, refreshed each turn; caller hooks only restrict further.
    external = await resolveExternalSetting({ cwd: opts.cwd, ...(opts.userConfigDir !== undefined ? { dir: opts.userConfigDir } : {}) });
    if (opts.signal?.aborted) return undefined;
    externalProviders = loadExternalProvidersConfig(opts.userConfigDir).config;
    externalAllowed = externalAllowedConnectedPredicate(
      connectedPredicateFrom(providers), external.value === "on",
      externalProviders,
    );
    fallbackModel = selectClassifierModel(providers, profiles, (providerId, modelId) =>
      externalAllowed(providerId, modelId) &&
      (opts.classifierAllowed?.(providerId, modelId) ?? true) &&
      (opts.providerFactory !== undefined || hasCredential(providerId, env)),
    );
  } catch (error) {
    return {
      classification: { result: { ok: false, reason: "routing preparation failed" }, trace: [] },
      category: "default",
      baseline: { providerId: opts.sessionProvider, modelId: opts.sessionModel },
      assignment: { kind: "session-default" },
      fallbackReason: redactSensitiveText(`routing preparation failed: ${error instanceof Error ? error.message : String(error)}`),
      blockTurn: true,
    };
  }
  const baseline = { providerId: opts.sessionProvider, modelId: opts.sessionModel };
  const capabilityFacts = catalogCapabilityFacts(providers, baseline, opts, routingConfig);
  const snapshotMeta = {
    observedAt: new Date().toISOString(),
    policyRevision: routingDigest({
      external: external.value,
      externalProviders,
      classifierCallerPolicy: opts.classifierAllowed === undefined ? "none" : "caller-supplied",
      executorCallerPolicy: opts.executorAllowed === undefined ? "none" : "caller-supplied",
    }),
    capabilityRevision: routingDigest({
      capabilities: [...capabilityFacts.entries()]
        .map(([target, capabilities]) => ({ target, capabilities }))
        .sort((left, right) => left.target.localeCompare(right.target)),
    }),
  };
  try {
    return await runRoutingForTurn(line, opts, routingConfig, providers, profiles, env, externalAllowed, fallbackModel,
      snapshotMeta, capabilityFacts, deadline);
  } catch (error) {
    return {
      classification: { result: { ok: false, reason: "routing resolution failed" }, trace: [] },
      category: "default",
      baseline: { providerId: opts.sessionProvider, modelId: opts.sessionModel },
      assignment: { kind: "session-default" },
      fallbackReason: redactSensitiveText(`routing resolution failed: ${error instanceof Error ? error.message : String(error)}`),
      blockTurn: true,
    };
  }
}

/** Report the deciding stage, not the executor's fallback status. */
function classificationSource(result: RoutingClassifierTurnResult): string {
  if (!result.classification.result.ok) return "none";
  const source = result.classification.result.source;
  return source === "jev" ? "JEV" : source === "main-model" ? "fallback" : source;
}

/** An enabled route must never silently look successful while falling back. */
export function renderRoutingFallbackLine(result: RoutingClassifierTurnResult | undefined): string {
  if (result === undefined) return "[route fallback: no classifier category; using session model]";
  const target = result.baseline === undefined ? "session model" : `${result.baseline.providerId}/${result.baseline.modelId}`;
  return redactSensitiveText(`[route fallback: ${result.category ?? "no classifier category"} -> ${describeAssignment(result.assignment)}; classifier: ${classificationSource(result)}${result.fallbackReason !== undefined ? `; ${result.fallbackReason}` : ""}; using ${target}]`);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** AC8: the per-turn tag line, e.g. `[quick -> claude-haiku-4.5]` — shown only when a turn actually routed to something other than the session's own model. */
export function renderRoutingTagLine(result: RoutingClassifierTurnResult): string | undefined {
  if (result.routed === undefined) return undefined;
  const source = classificationSource(result);
  const confidence = result.classification.result.ok ? ` ${pct(result.classification.result.confidence)}` : "";
  return `[${result.category} -> ${result.routed.providerId}/${result.routed.modelId}] (${source}${confidence}${result.fallbackReason !== undefined ? `; fallback: ${result.fallbackReason}` : ""})`;
}

/** AC9: the per-turn tag's usage detail line, when the classifying stage reached a real client. */
export function renderRoutingUsageLine(usage: TaskClassifierUsage | undefined): string | undefined {
  if (usage === undefined) return undefined;
  const parts = [
    usage.inputTokens !== undefined ? `↑${usage.inputTokens}` : undefined,
    usage.outputTokens !== undefined ? `↓${usage.outputTokens}` : undefined,
    usage.cost !== undefined ? `$${usage.cost.toFixed(4)}` : undefined,
    usage.latencyMs !== undefined ? `${usage.latencyMs}ms` : undefined,
  ].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? `usage: ${parts.join(" ")}` : undefined;
}

/** AC8: the `sb-route` sidebar line — `"on · N routed"` / `"off"`. */
export function renderRoutingSidebarValue(enabled: boolean, routedCount: number, lastCategory?: RoutingCategory): string {
  if (!enabled) return "off";
  return `on · ${routedCount} routed${lastCategory !== undefined ? ` (last: ${lastCategory})` : ""}`;
}

/** Shared with the CLI/other surfaces — kept here rather than duplicated (`describeAssignment` already does the same for `table.ts`'s own callers). */
export { describeAssignment };
