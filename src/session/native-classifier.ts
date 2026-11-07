import type { Control } from "../remote-control/protocol";
import type { NormalizedRequest, NormalizedUsage } from "../harness/provider/types";
export interface NativeClassifierProvider { candidateId: string; providerId: string; modelId: string; actualProviderId?: string; actualModelId?: string }
export interface NativeClassifierContext {
  signal: AbortSignal;
  beforeIo(provider: NativeClassifierProvider): Promise<void>;
  onRefusal?(code: string): void;
  onUsage(provider: NativeClassifierProvider, usage: NormalizedUsage): void;
}
export interface NativeRoutingSelection {
  readonly candidateId?: string;
  readonly selectionReceiptId?: string;
  /** Local test/diagnostic seam; createSessionRouting deliberately does not serialize it. */
  readonly classifierReceiptId?: string;
  /** The classifier failed and routing applied its configured `onFailure` assignment. */
  readonly classifierFallback?: true;
}
export type NativeRoutingClassifier = (text: string, config: Control["SessionConfig"], context: NativeClassifierContext) => Promise<string | NativeRoutingSelection | undefined>;

import { runModelTurn } from "../harness/provider/single-turn";
import type { ProviderPort } from "../harness/provider/types";
import { loadRouting } from "../harness/routing/settings";
import { routingDigest, type NormalizedRoutingConfig } from "../harness/routing/config";
import { classifyDeterministic } from "../harness/decision/deterministic-shortcuts";
import type { RoutingClassifierAdapter } from "../harness/routing/classifier-chain";
import { buildRoutingClassifierAdapters } from "../harness/routing/classifier-production";
import { runRoutingClassification } from "../harness/routing/routing-classifier-service";
import { RoutingBudgetLedger } from "../harness/routing/routing-budget";
import { resolveRoutingForRuntime } from "../harness/routing/routing-runtime";
import { prepareRoutingCandidate } from "../harness/routing/routing-execution";
import { ROUTING_CAPABILITIES, type RoutingRequest, type RoutingRequirements } from "../harness/routing/routing-request";
import type { NativeModelBinding } from "./model-identity";
import { nativeRoutingResolution, prepareNativeRouting, type NativeRoutingFactsProvider, type NativeRoutingResolution } from "./native-routing";
import type { NativeRoutingBudgetStore } from "./native-routing-budget";
import { ROUTING_CATEGORIES } from "../harness/routing/table";
import { MODEL_CLASSES } from "../harness/routing/model-class";
import { redactSensitiveText } from "../security/service";
export interface NativeRoutingClassifierOptions {
  cwd: string; configDir?: string; env: Readonly<Record<string, string | undefined>>;
  availability(config: Control["SessionConfig"]): Control["RoutingAvailability"];
  bindings(): readonly NativeModelBinding[];
  providerFactory(providerId: string, modelId: string): ProviderPort;
  allowed?(providerId: string, modelId: string): boolean;
  modelFacts?: NativeRoutingFactsProvider;
  /** Capture one coherent set of local facts for each decision. */
  modelFactsFactory?: () => NativeRoutingFactsProvider;
  /** Same output reservation the native agent turn will enforce. */
  outputTokensReserved?: number;
  /** One aggregate native service budget, including cleanup, never above the frozen original work window. */
  timeoutMs?: number;
  /** Local-only handoff of the task ledger to the admitted native runtime. */
  routingBudgetStore?: NativeRoutingBudgetStore;
}
export class NativeClassifierError extends Error {
  constructor(readonly code: string, readonly fatal = false) { super(code); this.name = "NativeClassifierError"; }
}
const NATIVE_CLASSIFIER_OUTPUT_TOKENS = 16;

function normalizedInputTokenEstimate(request: NormalizedRequest): number {
  const bytes = Buffer.byteLength(JSON.stringify({
    systemInstruction: request.systemInstruction,
    messages: request.messages,
    tools: request.tools ?? [],
  }));
  return Math.max(1, Math.ceil(bytes / 4));
}

function parseCompactNativeClassification(value: string): unknown {
  const [category, modelClass, confidenceRaw, capabilitiesRaw, ...extra] = value.trim().split("|").map((part) => part.trim());
  if (extra.length > 0 || category === undefined || modelClass === undefined || confidenceRaw === undefined || capabilitiesRaw === undefined) return undefined;
  const confidence = Number(confidenceRaw);
  const requiredCapabilities = capabilitiesRaw === "-" || capabilitiesRaw === ""
    ? [] : capabilitiesRaw.split(",").map((capability) => capability.trim());
  if (!(ROUTING_CATEGORIES as readonly string[]).includes(category)
    || !(MODEL_CLASSES as readonly string[]).includes(modelClass)
    || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
    || requiredCapabilities.some((capability) => !(ROUTING_CAPABILITIES as readonly string[]).includes(capability))) return undefined;
  return { category, modelClass, confidence, reasonCode: "native-compact-classifier", requiredCapabilities };
}
/** Production composition of the shipped classifier. Only advertised native ProviderPorts are authorized;
 * a global service credential alone never imports a second service-only provider into a remote run. */
export function createNativeRoutingClassifier(options: NativeRoutingClassifierOptions): NativeRoutingClassifier {
  return async (text, config, context) => {
    context.signal.throwIfAborted();
    let routingConfig: NormalizedRoutingConfig;
    try { routingConfig = loadRouting(options.cwd, options.configDir); }
    catch { throw new NativeClassifierError("routing-config-invalid", true); }
    const frozenAvailability = options.availability(config);
    const frozenBindings = options.bindings();
    const available = frozenAvailability.candidates.filter((candidate) => candidate.available && candidate.reason === "none"
      && candidate.reasoningEfforts.includes(config.reasoningEffort)
      && [config.baselineCandidateId, ...config.routing.candidateIds].includes(candidate.candidateId));
    const choices = available.flatMap((candidate) => {
      const binding = frozenBindings.find((binding) => binding.providerId === candidate.providerId && binding.modelId === candidate.modelId);
      return binding === undefined || options.allowed?.(binding.actualProviderId, binding.actualModelId) === false ? [] : [{ candidate, binding }];
    });
    const actual = (providerId: string, modelId: string) => choices.find((choice) => choice.binding.actualProviderId === providerId && choice.binding.actualModelId === modelId);
    const baseline = choices.find((choice) => choice.candidate.candidateId === config.baselineCandidateId);
    if (baseline === undefined) throw new NativeClassifierError("classifier-baseline-not-permitted");
    const budget = Math.max(1, Math.min(2500, options.timeoutMs ?? 2500));
    const deadline = performance.now() + Math.min(3000, budget + 500);
    const aggregateSignal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())))]);
    const modelFacts = options.modelFactsFactory?.() ?? options.modelFacts;
    const routingBudget = new RoutingBudgetLedger({
      configUsd: routingConfig.execution.maxEstimatedCostUsd,
      unknownCost: routingConfig.execution.unknownCost,
    });
    let authorityRefused = false; let calls = 0;
    const classifierUsage = new Map<string, NormalizedUsage>();
    const pending = new Set<Promise<void>>();
    const classifierProviderFactory = (providerId: string, modelId: string): ProviderPort => {
        const choice = actual(providerId, modelId); if (choice === undefined) throw new NativeClassifierError("classifier-model-not-permitted");
        const metadata: NativeClassifierProvider = { candidateId: choice.candidate.candidateId, providerId: choice.candidate.providerId, modelId: choice.candidate.modelId, actualProviderId: choice.binding.actualProviderId, actualModelId: choice.binding.actualModelId };
        const provider = options.providerFactory(providerId, modelId);
        return { ...provider, describe: () => provider.describe(), stream: (request, streamOptions) => (async function* () {
          if (++calls > 1) throw new NativeClassifierError("classifier-call-budget-exceeded");
          let finished!: () => void; const completion = new Promise<void>((resolve) => { finished = resolve; }); pending.add(completion);
          const signal = streamOptions.signal === undefined ? aggregateSignal : AbortSignal.any([streamOptions.signal, aggregateSignal]); let bytes = 0;
          try {
            try { await context.beforeIo(metadata); } catch { authorityRefused = true; throw new NativeClassifierError("classifier-authority-refused"); }
            signal.throwIfAborted();
            const maxOutputTokens = Math.min(request.budget.maxOutputTokens, NATIVE_CLASSIFIER_OUTPUT_TOKENS);
            const boundedRequest = { ...request, budget: { maxOutputTokens, runReservation: Math.min(request.budget.runReservation, maxOutputTokens) } };
            for await (const event of provider.stream(boundedRequest, { ...streamOptions, signal })) {
              if (event.kind === "usage_update" && event.usage !== undefined) {
                classifierUsage.set(JSON.stringify([providerId, modelId]), event.usage);
                context.onUsage(metadata, event.usage);
              }
              signal.throwIfAborted(); bytes += Buffer.byteLength(event.text ?? "");
              if (bytes > 32768) throw new NativeClassifierError("classifier-output-limit");
              yield event;
            }
          } finally { pending.delete(completion); finished(); }
        })() };
    };
    const confirmStopped = async () => { if (pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...pending]), new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - performance.now())); })]);
      if (timer !== undefined) clearTimeout(timer);
    } };
    {
      const taskBudget = routingBudget;
      const estimateCost = (providerId: string, modelId: string, requirements: RoutingRequirements): number | null => {
        const choice = actual(providerId, modelId);
        if (choice === undefined || modelFacts === undefined) return null;
        try {
          const value = modelFacts({ providerId, modelId }, choice.candidate, requirements).estimatedCostUsd;
          return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
        } catch { return null; }
      };
      const category = classifyDeterministic(text) ?? "default";
      const baseRequest: Omit<RoutingRequest, "baseline"> = {
        requestId: routingDigest({ origin: "native-session", category, text }),
        category,
        origin: "native-session",
        requirements: {
          capabilities: ["tools"],
          inputTokensRequired: Buffer.byteLength(text),
          outputTokensReserved: options.outputTokensReserved ?? 8192,
        },
      };
      let request = baseRequest;
      let classifierReceiptId: string | undefined;
      const needsClassification = routingConfig.categories[category].mode === "auto";
      if (needsClassification) {
        const configuredAdapters = buildRoutingClassifierAdapters({ config: routingConfig,
          sessionProvider: baseline.binding.actualProviderId,
          fallbackModel: { providerId: baseline.binding.actualProviderId, modelId: baseline.binding.actualModelId },
          env: { ...options.env }, jevEnabled: false, jevAllowed: false,
          externalAllowed: (providerId, modelId) => actual(providerId, modelId) !== undefined,
          classifierAllowed: (providerId, modelId) => actual(providerId, modelId) !== undefined,
          providerFactory: classifierProviderFactory,
          ...(options.configDir === undefined ? {} : { userConfigDir: options.configDir }),
          timeoutMs: Math.min(budget, routingConfig.classifier.timeoutMs),
        });
        const adapters: RoutingClassifierAdapter<string>[] = configuredAdapters.map((adapter, index) => {
          const entry = routingConfig.classifier.chain[index];
          const target = entry?.target;
          const providerInScope = target !== undefined && (routingConfig.providers.scope === "all-connected"
            || routingConfig.providers.scope === "session-only" && target.providerId === baseline.binding.actualProviderId
            || routingConfig.providers.scope === "allowlist" && routingConfig.providers.allowlist.includes(target.providerId));
          if (entry?.adapterId !== "model" || target === undefined || !providerInScope || actual(target.providerId, target.modelId) === undefined) return adapter;
          return { id: adapter.id, async classify(task, classifierContext) {
            const result = await runModelTurn({
              provider: target.providerId,
              model: target.modelId,
              system: `Classify the request. Reply with one compact line only: category|modelClass|confidence|requiredCapabilities. category=${ROUTING_CATEGORIES.join(",")}; modelClass=${MODEL_CLASSES.join(",")}; confidence=0..1; requiredCapabilities is comma-separated from ${ROUTING_CAPABILITIES.join(",")} or - for none.`,
              user: redactSensitiveText(task.slice(0, 2_000)),
              maxOutputTokens: NATIVE_CLASSIFIER_OUTPUT_TOKENS,
              requestId: "keryx-native-routing-classifier",
              env: { ...options.env },
              providerFactory: classifierProviderFactory,
              signal: classifierContext.signal,
            });
            if (result.error !== undefined || result.text.trim().length === 0) throw new Error("native model classifier did not return a usable response");
            const parsed = parseCompactNativeClassification(result.text);
            if (parsed === undefined) throw new Error("native model classifier response is invalid");
            return parsed;
          } };
        });
        const classifierRequirements: RoutingRequirements = {
          capabilities: [],
          inputTokensRequired: Math.max(1, Math.ceil(Buffer.byteLength(text) / 4)),
          outputTokensReserved: NATIVE_CLASSIFIER_OUTPUT_TOKENS,
        };
        const classifierTarget = (adapterId: string) => routingConfig.classifier.chain.find((entry) => entry.adapterId === adapterId)?.target;
        const classified = await runRoutingClassification({
          task: text,
          request: { ...baseRequest, baseline: { providerId: baseline.binding.actualProviderId, modelId: baseline.binding.actualModelId } },
          config: routingConfig,
          adapters,
          budget: taskBudget,
          estimatedCostUsd: (adapter) => {
            const target = classifierTarget(adapter.id);
            return target === undefined ? null : estimateCost(target.providerId, target.modelId, classifierRequirements);
          },
          actualCostUsd: (adapter) => {
            const target = classifierTarget(adapter.id);
            if (target === undefined) return undefined;
            const usage = classifierUsage.get(JSON.stringify([target.providerId, target.modelId]));
            if (usage === undefined || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
            const actualRequirements: RoutingRequirements = {
              capabilities: [],
              inputTokensRequired: usage.inputTokens ?? classifierRequirements.inputTokensRequired,
              outputTokensReserved: usage.outputTokens ?? classifierRequirements.outputTokensReserved,
            };
            return estimateCost(target.providerId, target.modelId, actualRequirements) ?? undefined;
          },
          signal: aggregateSignal,
        });
        if (classified.status === "cancelled" || classified.classification.status === "cancelled") {
          context.signal.throwIfAborted();
          throw new NativeClassifierError("routing-cancelled", true);
        }
        classifierReceiptId = classified.classification.receiptId;
        const { baseline: _baseline, ...classifiedRequest } = classified.request;
        request = classifiedRequest;
      }
      await confirmStopped();
      if (authorityRefused) throw new NativeClassifierError("classifier-authority-refused");
      if (pending.size > 0) throw new NativeClassifierError("classifier-stop-unconfirmed");
      context.signal.throwIfAborted();
      if (aggregateSignal.aborted) throw new NativeClassifierError("routing-uncertain-outcome", true);
      let resolution: NativeRoutingResolution;
      let receiptId: string;
      try {
        const remainingEstimatedCostUsd = taskBudget.snapshot().remainingUsd;
        if (remainingEstimatedCostUsd !== null) request = { ...request, requirements: {
          ...request.requirements,
          maxEstimatedCostUsd: Math.min(request.requirements.maxEstimatedCostUsd ?? remainingEstimatedCostUsd, remainingEstimatedCostUsd),
        } };
        const prepared = prepareNativeRouting({
          sessionConfig: config,
          availability: frozenAvailability,
          bindings: frozenBindings,
          routingConfig: routingConfig,
          ...(options.allowed === undefined ? {} : { allowed: options.allowed }),
          ...(modelFacts === undefined ? {} : { modelFacts }),
          request,
        });
        const journal = { cwd: options.cwd, ...(options.configDir === undefined ? {} : { configDir: options.configDir }) };
        const route = { request: prepared.request, snapshot: prepared.frozen.snapshot, config: routingConfig };
        const receipt = resolveRoutingForRuntime({ ...route, journal: { ...journal, kind: "dispatch" } });
        const remainingSelectionMs = Math.max(0, Math.floor(deadline - performance.now()));
        if (remainingSelectionMs <= 0) throw new NativeClassifierError("routing-uncertain-outcome", true);
        const candidate = await prepareRoutingCandidate({
          ...route, journal, receipt, signal: aggregateSignal, selectionTimeoutMs: remainingSelectionMs,
          prepare: async (target) => {
            const choice = actual(target.providerId, target.modelId);
            if (choice === undefined || options.allowed?.(target.providerId, target.modelId) === false) {
              return { ok: false, reason: "policy-denied" };
            }
            const current = options.availability(config).candidates.find((item) => item.candidateId === choice.candidate.candidateId);
            if (current === undefined || !current.available || current.reason !== "none"
              || !current.reasoningEfforts.includes(config.reasoningEffort)) {
              return { ok: false, reason: "model-unavailable" };
            }
            try {
              // Construction only. The host must still admit the final candidate
              // before the native runtime may open its provider stream.
              options.providerFactory(target.providerId, target.modelId);
            } catch {
              return { ok: false, reason: "model-unavailable" };
            }
            return { ok: true, value: undefined };
          },
        });
        if (!candidate.ok) throw new NativeClassifierError(`routing-${candidate.reason}`, true);
        receiptId = candidate.receipt.receiptId;
        resolution = nativeRoutingResolution(prepared.frozen, candidate.receipt.decision);
        if (resolution.decision.status === "selected" && options.routingBudgetStore !== undefined) {
          const selectedTarget = resolution.decision.selection;
          const selectedChoice = actual(selectedTarget.providerId, selectedTarget.modelId);
          if (selectedChoice === undefined) throw new NativeClassifierError("routing-policy-denied", true);
          options.routingBudgetStore.publish(receiptId, {
            target: selectedTarget,
            receipt: candidate.receipt,
            config: routingConfig,
            budget: taskBudget,
            journal,
            estimatedCostUsd: (normalizedRequest) => estimateCost(
              selectedTarget.providerId,
              selectedTarget.modelId,
              {
                capabilities: normalizedRequest.tools?.length ? ["tools"] : [],
                inputTokensRequired: normalizedInputTokenEstimate(normalizedRequest),
                outputTokensReserved: normalizedRequest.budget.maxOutputTokens,
              },
            ),
            actualCostUsd: ({ request: normalizedRequest, usage, estimatedCostUsd }) => {
              if (usage === undefined || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return estimatedCostUsd ?? 0;
              return estimateCost(
                selectedTarget.providerId,
                selectedTarget.modelId,
                {
                  capabilities: normalizedRequest.tools?.length ? ["tools"] : [],
                  inputTokensRequired: usage.inputTokens ?? normalizedInputTokenEstimate(normalizedRequest),
                  outputTokensReserved: usage.outputTokens ?? normalizedRequest.budget.maxOutputTokens,
                },
              ) ?? estimatedCostUsd ?? 0;
            },
          });
        }
      } catch (cause) {
        if (cause instanceof NativeClassifierError) throw cause;
        throw new NativeClassifierError("routing-snapshot-invalid", true);
      }
      if (resolution.decision.status === "selected" && resolution.candidateId !== undefined) {
        return { candidateId: resolution.candidateId, selectionReceiptId: receiptId,
          ...(classifierReceiptId === undefined ? {} : { classifierReceiptId }),
          ...(resolution.decision.recommendationSource === "classifier-fallback" ? { classifierFallback: true as const } : {}) };
      }
      const reason = resolution.decision.status === "blocked" ? resolution.decision.reason : "config-invalid";
      throw new NativeClassifierError(`routing-${reason}`, true);
    }
  };
}
