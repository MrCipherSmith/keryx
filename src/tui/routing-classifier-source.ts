// Flow 338 — the routing classifier's shell-side wiring: turns one user
// request line into a routed provider/model, or `undefined` when nothing
// should override the session's own model (routing off, a slash command, every classifier stage came back empty).
//
// `src/tui/` is a CLIENT zone and may import both the decision-layer
// classifiers and the routing table freely — same shape `turn-guard-
// source.ts` already uses for `../review/turn-guard` + `../harness/decision/
// jev-client`.

import {
  classifyTurn,
  CLASSIFY_TURN_TIMEOUT_MS,
  type ClassifyTurnResult,
} from "../harness/decision/classify-turn";
import type { TaskClassifierUsage } from "../harness/decision/classifier";
import {
  connectedPredicateFrom,
  describeAssignment,
  describeRejectionNotice,
  resolveCategoryDetailed,
  ROUTING_CATEGORIES,
  sessionDerivationModels,
  type CategoryAssignment,
  type FlatPickerProvider,
  type RoutingCategory,
  type RoutingTable,
} from "../harness/routing/table";
import { loadRoutingConfig, type RoutingConfigLocation } from "../harness/routing/config";
import { deriveDefaultTable } from "../harness/routing/derive-default-table";
import { resolveProviderDefaultModelId } from "../harness/routing/provider-default";
import { selectClassifierModel } from "../harness/routing/classifier-model";
import { hasCredential, type ProviderFactory } from "../harness/provider/single-turn";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { redactSensitiveText } from "../security/service";
import { resolveJevClassifierCredential } from "../harness/decision/jev-classifier";
import { resolveExternalSetting } from "../lib/external-switch";
import { externalAllowedConnectedPredicate, loadExternalProvidersConfig } from "../lib/external-providers";
import { availablePredicateFromProfiles, loadModelProfiles, profileKey } from "../harness/routing/model-profile";
import { loadActiveRoutingV2 } from "../harness/routing/active-v2";
import type { NormalizedRoutingV2Config } from "../harness/routing/config-v2";
import { routingV2Digest } from "../harness/routing/config-v2";
import { buildCatalogRoutingSnapshot, estimateModelCostUsd } from "../harness/routing/snapshot-adapter";
import { resolveRoutingForRuntime } from "../harness/routing/routing-runtime";
import type { RoutingDecisionReceipt } from "../harness/routing/routing-runtime";
import type { RoutingAssignmentV2 } from "../harness/routing/config-v2";
import type { RoutingRequirements } from "../harness/routing/routing-request";
import type { RoutingCapability } from "../harness/routing/routing-request";
import { RoutingBudgetLedger } from "../harness/routing/routing-budget";
import { runProductionRoutingClassification } from "../harness/routing/routing-classifier-service";
import type { RoutingSnapshot } from "../harness/routing/snapshot";
import type { RoutingRequest } from "../harness/routing/routing-request";
import type { NormalizedRequest } from "../harness/provider/types";
import { estimateRequestTokens } from "../harness/provider/context-guard";
import { randomUUID } from "node:crypto";

/**
 * The interactive turn's candidate vocabulary: every catalogue category
 * (PRD §4) EXCEPT `"default"` — picking `"default"` would mean "use the
 * session's own model", which is exactly what happens when nothing routes
 * at all, so it is never a useful classifier answer. Deliberately wider
 * than `WIRED_ROUTING_CATEGORIES` (`table.ts`) — that set tracks which
 * categories a call site ALREADY consults the table for (`review`,
 * `subagents`, flow 305); this flow's classifier is the first caller that
 * needs the full catalogue as its own candidate list for an interactive
 * turn, independent of that narrower "wired" bookkeeping.
 */
const TURN_CLASSIFIER_CATEGORIES: readonly RoutingCategory[] = ROUTING_CATEGORIES.filter((c) => c !== "default");

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
  /** v2 resolver denial is terminal; callers must not silently run the baseline. */
  readonly blockTurn?: boolean;
  /** Frozen v2 inputs consumed by the execution ProviderPort wrapper. */
  readonly routingV2?: {
    readonly config: NormalizedRoutingV2Config;
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

function legacyAssignment(assignment: RoutingAssignmentV2): CategoryAssignment {
  if (assignment.mode === "model") return { kind: "model", providerId: assignment.target.providerId, modelId: assignment.target.modelId };
  return { kind: "session-default" };
}

async function runRoutingClassifierForTurnV2(
  line: string,
  opts: RoutingClassifierTurnOptions,
  config: NormalizedRoutingV2Config,
  providers: readonly FlatPickerProvider[],
  profiles: ReturnType<typeof loadModelProfiles>,
  env: Record<string, string | undefined>,
  externalAllowed: (providerId: string, modelId?: string) => boolean,
  fallbackModel: { readonly providerId: string; readonly modelId: string } | undefined,
  snapshotMeta: { readonly observedAt: string; readonly policyRevision: string; readonly capabilityRevision: string },
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
  const budget = new RoutingBudgetLedger({
    ...(baseRequest.requirements.maxEstimatedCostUsd === undefined ? {} : { taskUsd: baseRequest.requirements.maxEstimatedCostUsd }),
    configUsd: config.execution.maxEstimatedCostUsd,
    unknownCost: config.execution.unknownCost,
  });
  let request = baseRequest;
  let classified: Awaited<ReturnType<typeof runProductionRoutingClassification>>["classification"] | undefined;
  if (config.categories.default.mode === "auto") {
    const classification = await runProductionRoutingClassification({
      task: line,
      request: baseRequest,
      config,
      budget,
      estimatedCostUsd: () => null,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
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
    });
    if (classification.status === "cancelled" || opts.signal?.aborted) return undefined;
    classified = classification.classification;
    request = classification.request;
  }
  const category = request.category;
  const snapshot = buildCatalogRoutingSnapshot({
    configDigest: config.configDigest,
    ...snapshotMeta,
    baseline,
    providers,
    profiles,
    request,
    policy: {
      credentialsAvailable: (target) => target.providerId === baseline.providerId || hasCredential(target.providerId, env),
      policyAllowed: (target) => externalAllowed(target.providerId, target.modelId) && (opts.executorAllowed?.(target.providerId, target.modelId) ?? true),
      parentAllowed: () => true,
      capabilities: (target) => target.providerId === baseline.providerId && target.modelId === baseline.modelId
        ? opts.baselineCapabilities ?? [] : [],
      cooldown: () => false,
      observedLatencyMs: () => null,
      availability: (target) => target.providerId === baseline.providerId && target.modelId === baseline.modelId ? "available" : undefined,
    },
  });
  const receipt = resolveRoutingForRuntime({
    request,
    snapshot,
    config,
    ...(classified?.status === "fallback" ? { fallbackReason: "classifier-failed" as const } : {}),
    journal: { cwd: opts.cwd, ...(opts.userConfigDir === undefined ? {} : { configDir: opts.userConfigDir }), kind: "dispatch" },
  });
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
    : legacyAssignment(config.categories[category]);
  const result: RoutingClassifierTurnResult = {
    classification,
    category,
    baseline,
    assignment,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    ...(decision.status === "blocked" || decision.status === "needs-classification" ? { blockTurn: true } : {}),
    ...(decision.status !== "selected" ? {} : { routingV2: {
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
  let activeV2: NormalizedRoutingV2Config | undefined;
  try {
    activeV2 = loadActiveRoutingV2(opts.cwd, opts.userConfigDir);
  } catch (error) {
    const baseline = { providerId: opts.sessionProvider, modelId: opts.sessionModel };
    return {
      classification: { result: { ok: false, reason: "invalid active routing v2 configuration" }, trace: [] },
      category: "default",
      baseline,
      assignment: { kind: "session-default" },
      fallbackReason: redactSensitiveText(`active routing v2 configuration is invalid: ${error instanceof Error ? error.message : String(error)}`),
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
    if (activeV2 === undefined) throw error;
    return {
      classification: { result: { ok: false, reason: "routing v2 preparation failed" }, trace: [] },
      category: "default",
      baseline: { providerId: opts.sessionProvider, modelId: opts.sessionModel },
      assignment: { kind: "session-default" },
      fallbackReason: redactSensitiveText(`routing v2 preparation failed: ${error instanceof Error ? error.message : String(error)}`),
      blockTurn: true,
    };
  }
  const snapshotMeta = {
    observedAt: new Date().toISOString(),
    policyRevision: routingV2Digest({
      external: external.value,
      externalProviders,
      classifierCallerPolicy: opts.classifierAllowed === undefined ? "none" : "caller-supplied",
      executorCallerPolicy: opts.executorAllowed === undefined ? "none" : "caller-supplied",
    }),
    capabilityRevision: routingV2Digest({
      baseline: { providerId: opts.sessionProvider, modelId: opts.sessionModel },
      baselineCapabilities: [...(opts.baselineCapabilities ?? [])].sort(),
      catalogCapabilities: "unproven",
    }),
  };
  const shadowV2 = env.KERYX_ROUTING_V2_SHADOW === "1";
  if (activeV2 !== undefined && shadowV2) {
    try {
      const baseline = { providerId: opts.sessionProvider, modelId: opts.sessionModel };
      const request: RoutingRequest = {
        requestId: opts.requestId ?? randomUUID(),
        category: "default",
        origin: "operator",
        baseline,
        requirements: opts.requirements ?? { capabilities: [], inputTokensRequired: Math.max(1, Math.ceil(line.length / 4)), outputTokensReserved: 4_096 },
      };
      const snapshot = buildCatalogRoutingSnapshot({
        configDigest: activeV2.configDigest,
        ...snapshotMeta,
        baseline,
        providers,
        profiles,
        request,
        policy: {
          credentialsAvailable: (target) => target.providerId === baseline.providerId || hasCredential(target.providerId, env),
          policyAllowed: (target) => externalAllowed(target.providerId, target.modelId) && (opts.executorAllowed?.(target.providerId, target.modelId) ?? true),
          parentAllowed: () => true,
          capabilities: (target) => target.providerId === baseline.providerId && target.modelId === baseline.modelId ? opts.baselineCapabilities ?? [] : [],
          cooldown: () => false,
          observedLatencyMs: () => null,
          availability: (target) => target.providerId === baseline.providerId && target.modelId === baseline.modelId ? "available" : undefined,
        },
      });
      resolveRoutingForRuntime({
        request,
        snapshot,
        config: activeV2,
        journal: { cwd: opts.cwd, ...(opts.userConfigDir === undefined ? {} : { configDir: opts.userConfigDir }), kind: "preview" },
      });
    } catch {
      // Shadow observation must never change or block legacy execution.
    }
  }
  if (activeV2 !== undefined && !shadowV2) {
    try {
      return await runRoutingClassifierForTurnV2(line, opts, activeV2, providers, profiles, env, externalAllowed, fallbackModel,
        snapshotMeta);
    } catch (error) {
      return {
        classification: { result: { ok: false, reason: "routing v2 resolution failed" }, trace: [] },
        category: "default",
        baseline: { providerId: opts.sessionProvider, modelId: opts.sessionModel },
        assignment: { kind: "session-default" },
        fallbackReason: redactSensitiveText(`routing v2 resolution failed: ${error instanceof Error ? error.message : String(error)}`),
        blockTurn: true,
      };
    }
  }
  const classification = await classifyTurn(line, TURN_CLASSIFIER_CATEGORIES, {
    jevEnabled: opts.jevEnabled && opts.jevAllowed !== false && external.value === "on",
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    fallbackModel: fallbackModel ?? null,
    ...(opts.providerFactory !== undefined ? { providerFactory: opts.providerFactory } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    timeoutMs: Math.max(0, deadline - performance.now()),
  });
  if (opts.signal?.aborted) return undefined;
  if (classification === undefined) return undefined;
  const baseline = { providerId: opts.sessionProvider, modelId: opts.sessionModel };
  const skippedJev = opts.jevEnabled && opts.jevAllowed === false ? "jev: caller policy denied"
    : opts.jevEnabled && external.value !== "on" ? "jev: external policy denied"
    : opts.jevEnabled && resolveJevClassifierCredential(opts.env).key === undefined ? "jev: credentials unavailable" : undefined;
  if (!classification.result.ok) {
    const failures = classification.trace.flatMap(stage => stage.result.ok ? [] : [`${stage.source}: ${stage.result.reason}`]);
    return { classification, baseline, assignment: { kind: "session-default" },
      fallbackReason: redactSensitiveText([skippedJev, ...failures,
        fallbackModel === undefined ? "no available authorized sufficient classifier" : undefined,
        classification.result.reason].filter(Boolean).join("; ")) };
  }

  const category = classification.result.category;
  const location: RoutingConfigLocation = { cwd: opts.cwd, ...(opts.userConfigDir !== undefined ? { userConfigDir: opts.userConfigDir } : {}) };
  const [project, user] = await Promise.all([loadRoutingConfig("project", location), loadRoutingConfig("user", location)]);
  if (opts.signal?.aborted) return undefined;
  const connected = connectedPredicateFrom(providers);
  const available = availablePredicateFromProfiles(profiles);
  let fallbackReason: string | undefined;
  // Check the concrete default BEFORE accepting a layer, preserving the
  // project > user > derived > session fallback order of the leaf resolver.
  const connectedForTurn = (providerId: string, modelId?: string): boolean => {
    if (modelId !== undefined) {
      const reason = !connected(providerId, modelId) ? "model not connected"
        : !externalAllowed(providerId, modelId) ? "external policy denied"
        : !available(providerId, modelId) ? "model unavailable"
        : !(opts.executorAllowed?.(providerId, modelId) ?? true) ? "executor policy denied"
        : opts.providerFactory === undefined && !hasCredential(providerId, env) ? "credentials unavailable"
        : undefined;
      if (reason !== undefined) {
        fallbackReason ??= `${providerId}/${modelId}: ${reason}`;
        return false;
      }
      return true;
    }
    const defaultId = resolveProviderDefaultModelId(providerId);
    const reason = !connected(providerId) ? "provider not connected"
      : defaultId === undefined ? "no documented provider default"
      : !connected(providerId, defaultId) ? "default model not connected"
      : !externalAllowed(providerId, defaultId) ? "external policy denied"
      : !available(providerId, defaultId) ? "default model unavailable"
      : !(opts.executorAllowed?.(providerId, defaultId) ?? true) ? "executor policy denied"
      : opts.providerFactory === undefined && !hasCredential(providerId, env) ? "credentials unavailable"
      : undefined;
    if (reason !== undefined) {
      fallbackReason ??= `${providerId} (provider default): ${reason}`;
      return false;
    }
    return true;
  };
  // Flow 327's `derived` layer, built from the SAME provider list already on
  // hand (`providers`, shared with the picker) against the session's own
  // provider/model — the same shape `keryx routing list` and `/routing` use.
  const models = sessionDerivationModels(providers, { providerId: opts.sessionProvider, modelId: opts.sessionModel });
  const derived: RoutingTable = deriveDefaultTable(opts.sessionProvider, models, profiles, opts.sessionModel);
  const resolved = resolveCategoryDetailed(category, { project: project.table, user: user.table, derived }, connectedForTurn, available);
  fallbackReason ??= resolved.rejected === undefined ? skippedJev : describeRejectionNotice(resolved.rejected, resolved.assignment);
  const stageFailures = classification.trace.flatMap(stage => stage.result.ok ? [] : [`${stage.source}: ${stage.result.reason}`]);
  const reasons = [...new Set([skippedJev, ...stageFailures, fallbackReason].filter((reason): reason is string => reason !== undefined))];
  fallbackReason = reasons.length === 0 ? undefined : redactSensitiveText(reasons.join("; "));
  const result = { classification, category, baseline, assignment: resolved.assignment,
    ...(fallbackReason !== undefined ? { fallbackReason: redactSensitiveText(fallbackReason) } : {}) };
  if (resolved.assignment.kind === "session-default") return result;
  if (resolved.assignment.kind === "model") {
    return { ...result, routed: { providerId: resolved.assignment.providerId, modelId: resolved.assignment.modelId } };
  }
  // Same documented default as the CLI/child requests, never the baseline
  // or an arbitrary live catalogue entry. Already checked above.
  const modelId = resolveProviderDefaultModelId(resolved.assignment.providerId);
  return modelId === undefined ? result : { ...result, routed: { providerId: resolved.assignment.providerId, modelId } };
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
