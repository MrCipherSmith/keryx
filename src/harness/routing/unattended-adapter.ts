import { catalogToFlatPickerProviders, loadOrRefreshProviderCatalog } from "../provider-catalog";
import { estimateRequestTokens } from "../provider/context-guard";
import { hasCredential } from "../provider/single-turn";
import type {
  NormalizedRequest,
  NormalizedToolDefinition,
  NormalizedUsage,
  ProviderPort,
} from "../provider/types";
import { loadRouting } from "./settings";
import { routingDigest, type NormalizedRoutingConfig } from "./config";
import { modelRefKey, sameModelRef, type ModelRef } from "./model-class";
import { loadModelProfiles } from "./model-profile";
import { RoutingBudgetLedger } from "./routing-budget";
import { createRoutingExecutionProvider } from "./routing-provider";
import type { RoutingRequest } from "./routing-request";
import { resolveRoutingForRuntime, type RoutingDecisionReceipt } from "./routing-runtime";
import { createRoutingSnapshot, type RoutingSnapshot } from "./snapshot";
import { buildCatalogRoutingSnapshot } from "./snapshot-adapter";
import { externalBlockReason, loadExternalProvidersConfig } from "../../lib/external-providers";
import { resolveExternalSetting } from "../../lib/external-switch";
import { envWithSavedApiKeys } from "../../lib/shell-config";
import { spendFromTokens } from "../../review/caps";
import type { TriggerDispatch } from "../../trigger/config";
import type { DispatchRefusalCode } from "../../trigger/record";

/** Injectable seams shared by every internal unattended dispatcher. */
export interface UnattendedRoutingDeps {
  /** Test seam; production reads the routing settings (`settings.ts`). */
  readonly loadRouting?: (cwd: string) => NormalizedRoutingConfig;
  /** Per-user config dir seam used by every routing input and by the dispatch receipt journal. */
  readonly routingConfigDir?: string;
  /** Test seam for a current, fully factual snapshot; production reads live catalogue/profile/policy facts. */
  readonly routingSnapshot?: (input: {
    readonly config: NormalizedRoutingConfig;
    readonly request: RoutingRequest;
    readonly baseline: { readonly providerId: string; readonly modelId: string };
    readonly provider: ProviderPort;
  }) => RoutingSnapshot | Promise<RoutingSnapshot>;
}

export interface UnattendedRoutingRuntime {
  readonly maxOutputTokens: number;
  readonly modelParams: {
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
    readonly timeoutMs?: number;
  };
  readonly systemInstruction: string;
}

/** Result shared by flow-next and agent-task unattended command adapters. */
export interface UnattendedRoutingResolution {
  readonly receipt?: RoutingDecisionReceipt;
  readonly maxOutputTokens: number;
  readonly modelParams: UnattendedRoutingRuntime["modelParams"];
  readonly execution?: {
    readonly config: NormalizedRoutingConfig;
    readonly routeFor: (request: NormalizedRequest) => Promise<{ readonly request: RoutingRequest; readonly snapshot: RoutingSnapshot }>;
  };
}

function routingCapabilities(provider: ProviderPort): RoutingRequest["requirements"]["capabilities"] {
  const capabilities = provider.describe().capabilities;
  return [
    ...(capabilities.toolCalls ? ["tools" as const] : []),
    ...(capabilities.vision ? ["vision" as const] : []),
    ...(capabilities.structuredOutput ? ["structured-output" as const] : []),
  ];
}

async function currentUnattendedSnapshot(
  projectRoot: string,
  configDir: string | undefined,
  config: NormalizedRoutingConfig,
  request: RoutingRequest,
  baseline: { readonly providerId: string; readonly modelId: string },
  providerFor: (target: ModelRef) => ProviderPort | undefined,
  dispatch: TriggerDispatch,
): Promise<RoutingSnapshot> {
  const env = envWithSavedApiKeys(process.env, configDir);
  const [catalog, external] = await Promise.all([
    loadOrRefreshProviderCatalog({ fetch: globalThis.fetch, env, ...(configDir === undefined ? {} : { dir: configDir }) }),
    resolveExternalSetting({ cwd: projectRoot, ...(configDir === undefined ? {} : { dir: configDir }) }),
  ]);
  const externalPolicy = loadExternalProvidersConfig(configDir).config;
  const observedAt = new Date().toISOString();
  // The trigger's concrete pin has no fallbackClass. Keep the snapshot scoped to that pin so
  // routing cannot construct or authorize unrelated provider adapters behind the operator's back.
  const listed = catalogToFlatPickerProviders(catalog, { withStatusRows: true })
    .filter((entry) => entry.name === baseline.providerId)
    .map((entry) => ({ ...entry, models: entry.models?.filter((modelId) => modelId === baseline.modelId) ?? [] }));
  // The pin is the operator's explicit choice: it is a candidate even when the
  // catalogue does not list it, with its availability left unknown below.
  const providers = listed.some((entry) => entry.models?.includes(baseline.modelId) === true)
    ? listed
    : [...listed.filter((entry) => entry.name !== baseline.providerId), { name: baseline.providerId, models: [baseline.modelId] }];
  const profiles = loadModelProfiles(configDir);
  const baselineProvider = providerFor(baseline);
  if (baselineProvider === undefined) throw new Error("the explicit unattended provider/model pin could not be built");
  const snapshot = buildCatalogRoutingSnapshot({
    baseline,
    configDigest: config.configDigest,
    observedAt,
    policyRevision: routingDigest({ external, externalPolicy }),
    capabilityRevision: routingDigest({ target: baseline, capabilities: routingCapabilities(baselineProvider) }),
    providers,
    profiles,
    request,
    policy: {
      credentialsAvailable: (target) => providerFor(target) !== undefined || hasCredential(target.providerId, env, configDir),
      policyAllowed: (target) => external.value === "on" || externalBlockReason(target.providerId, target.modelId, externalPolicy) === undefined,
      // These dispatchers create root tasks, so there is no parent scope to inherit or widen.
      parentAllowed: () => true,
      capabilities: (target) => {
        const candidate = providerFor(target);
        return candidate === undefined ? [] : routingCapabilities(candidate);
      },
      // A pin the current catalogue did not list stays unknown; constructing an adapter is not proof that the model exists.
      availability: (target) => listed.some((entry) => entry.name === target.providerId && entry.models?.includes(target.modelId))
        ? undefined
        : "unknown",
      // No durable cooldown/latency observation exists yet. Availability comes from the live catalogue above.
      cooldown: () => false,
      observedLatencyMs: () => null,
    },
  });
  const estimatedCostUsd = (
    request.requirements.inputTokensRequired * dispatch.rates.inputUsdPerMTok
    + request.requirements.outputTokensReserved * dispatch.rates.outputUsdPerMTok
  ) / 1_000_000;
  const models = snapshot.models.map((facts) => sameModelRef(facts.target, baseline) ? { ...facts, estimatedCostUsd } : facts);
  return createRoutingSnapshot({
    configDigest: snapshot.configDigest,
    observedAt: snapshot.observedAt,
    catalogRevision: snapshot.catalogRevision,
    policyRevision: snapshot.policyRevision,
    capabilityRevision: snapshot.capabilityRevision,
    authFailedProviderIds: snapshot.authFailedProviderIds,
    baseline: snapshot.baseline,
    models,
  });
}
/** Resolve an internal unattended dispatch through model routing. */
export async function resolveUnattendedRouting(
  projectRoot: string,
  dispatch: TriggerDispatch,
  requestId: string,
  providerFor: (target: ModelRef) => ProviderPort | undefined,
  prompt: string,
  toolDefs: readonly NormalizedToolDefinition[],
  maxEstimatedCostUsd: number,
  runtime: UnattendedRoutingRuntime,
  deps: UnattendedRoutingDeps = {},
): Promise<UnattendedRoutingResolution> {
  const { maxOutputTokens, modelParams, systemInstruction } = runtime;
  const config = deps.loadRouting === undefined
    ? loadRouting(projectRoot, deps.routingConfigDir)
    : deps.loadRouting(projectRoot);

  const baseline = { providerId: dispatch.provider, modelId: dispatch.model };
  const requestFor = (inputTokensRequired: number, outputTokensReserved: number): RoutingRequest => ({
    requestId,
    category: "unattended",
    origin: "unattended",
    baseline,
    requirements: { capabilities: ["tools"], inputTokensRequired, outputTokensReserved, maxEstimatedCostUsd },
    userOverride: { mode: "model", target: baseline },
  });
  const snapshotFor = async (request: RoutingRequest): Promise<RoutingSnapshot> => {
    const baselineProvider = providerFor(baseline);
    if (baselineProvider === undefined) throw new Error("the explicit unattended provider/model pin could not be built");
    return deps.routingSnapshot?.({ config, request, baseline, provider: baselineProvider })
      ?? currentUnattendedSnapshot(projectRoot, deps.routingConfigDir, config, request, baseline, providerFor, dispatch);
  };
  const request = requestFor(estimateRequestTokens([{ content: prompt }], systemInstruction, toolDefs), maxOutputTokens);
  const snapshot = await snapshotFor(request);
  const receipt = resolveRoutingForRuntime({
    request,
    snapshot,
    config,
    journal: {
      cwd: projectRoot,
      kind: "dispatch",
      ...(deps.routingConfigDir === undefined ? {} : { configDir: deps.routingConfigDir }),
    },
  });
  const decision = receipt.decision;
  if (decision.status === "selected" && !sameModelRef(decision.selection, baseline)) {
    throw new Error("routing changed an explicit unattended provider/model pin");
  }
  return {
    receipt,
    maxOutputTokens,
    modelParams,
    execution: {
      config,
      routeFor: async (normalized) => {
        const currentRequest = requestFor(
          estimateRequestTokens(normalized.messages, normalized.systemInstruction, normalized.tools ?? []),
          normalized.budget.maxOutputTokens,
        );
        return { request: currentRequest, snapshot: await snapshotFor(currentRequest) };
      },
    },
  };
}

type UnattendedProviderBuilder = (dispatch: TriggerDispatch) => ProviderPort | { readonly error: string; readonly code?: DispatchRefusalCode };

export function cachedRoutingProviders(
  dispatch: TriggerDispatch,
  baselineProvider: ProviderPort,
  build: UnattendedProviderBuilder,
): (target: ModelRef) => ProviderPort | undefined {
  const baseline = { providerId: dispatch.provider, modelId: dispatch.model };
  const cache = new Map<string, ProviderPort>([[modelRefKey(baseline), baselineProvider]]);
  return (target) => {
    const key = modelRefKey(target);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const { baseUrl: _baselineUrl, ...shared } = dispatch;
    const candidateDispatch: TriggerDispatch = sameModelRef(target, baseline)
      ? dispatch
      : { ...shared, provider: target.providerId, model: target.modelId };
    const candidate = build(candidateDispatch);
    if ("error" in candidate) return undefined;
    cache.set(key, candidate);
    return candidate;
  };
}

export function routedUnattendedProvider(
  projectRoot: string,
  configDir: string | undefined,
  dispatch: TriggerDispatch,
  reservedUsd: number,
  baseline: ProviderPort,
  providerFor: (target: ModelRef) => ProviderPort | undefined,
  routing: UnattendedRoutingResolution,
  onAttemptUsage?: (usage: NormalizedUsage | undefined) => void,
): ProviderPort {
  const execution = routing.execution;
  if (execution === undefined) return baseline;
  const budget = new RoutingBudgetLedger({
    taskUsd: reservedUsd,
    ...(execution.config.execution.maxEstimatedCostUsd === undefined ? {} : { configUsd: execution.config.execution.maxEstimatedCostUsd }),
    unknownCost: execution.config.execution.unknownCost,
  });
  return createRoutingExecutionProvider({
    description: baseline.describe(),
    config: execution.config,
    budget,
    routeFor: (request) => execution.routeFor(request),
    providerFor: (target) => {
      const provider = providerFor(target);
      if (provider === undefined) throw new Error(`routing provider unavailable: ${modelRefKey(target)}`);
      return provider;
    },
    beforeIo: async (target, _decisionId, context) => {
      if (context.signal.aborted) return { ok: false, reason: "cancelled" };
      const external = await resolveExternalSetting({ cwd: projectRoot, ...(configDir === undefined ? {} : { dir: configDir }) });
      const externalPolicy = loadExternalProvidersConfig(configDir).config;
      if (external.value === "off" && externalBlockReason(target.providerId, target.modelId, externalPolicy) !== undefined) {
        return { ok: false, reason: "policy-denied" };
      }
      return providerFor(target) === undefined
        ? { ok: false, reason: "credentials-missing" }
        : { ok: true };
    },
    actualCostUsd: ({ usage, estimatedCostUsd }) => {
      if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
        if (estimatedCostUsd === null) throw new Error("unattended routing cost is unknown");
        return estimatedCostUsd;
      }
      return spendFromTokens({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        inputRatePerMillion: dispatch.rates.inputUsdPerMTok,
        outputRatePerMillion: dispatch.rates.outputUsdPerMTok,
      });
    },
    ...(onAttemptUsage === undefined
      ? {}
      : { onAttemptSettled: ({ usage }: { readonly usage?: NormalizedUsage }) =>
          onAttemptUsage(usage?.inputTokens === undefined || usage.outputTokens === undefined ? undefined : usage) }),
    journal: { cwd: projectRoot, ...(configDir === undefined ? {} : { configDir }) },
  });
}
