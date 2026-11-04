import type { Control } from "../remote-control/protocol";
import type { NormalizedUsage } from "../harness/provider/types";
export interface NativeClassifierProvider { candidateId: string; providerId: string; modelId: string; actualProviderId?: string; actualModelId?: string }
export interface NativeClassifierContext {
  signal: AbortSignal;
  beforeIo(provider: NativeClassifierProvider): Promise<void>;
  onRefusal?(code: string): void;
  onUsage(provider: NativeClassifierProvider, usage: NormalizedUsage): void;
}
export interface NativeRoutingSelection { readonly candidateId?: string; readonly selectionReceiptId?: string }
export type NativeRoutingClassifier = (text: string, config: Control["SessionConfig"], context: NativeClassifierContext) => Promise<string | NativeRoutingSelection | undefined>;

import { runRoutingClassifierForTurn } from "../tui/routing-classifier-source";
import type { ProviderPort } from "../harness/provider/types";
import { loadActiveRoutingV2 } from "../harness/routing/active-v2";
import { routingV2Digest, type NormalizedRoutingV2Config } from "../harness/routing/config-v2";
import { classifyDeterministic } from "../harness/decision/deterministic-shortcuts";
import { runRoutingClassifierChain } from "../harness/routing/classifier-chain-v2";
import { buildRoutingClassifierAdapters } from "../harness/routing/classifier-production-v2";
import { applyRoutingClassificationResult } from "../harness/routing/routing-classification-runtime";
import { resolveRoutingForRuntime } from "../harness/routing/routing-runtime";
import { prepareRoutingCandidate } from "../harness/routing/routing-execution-v2";
import type { RoutingRequest } from "../harness/routing/routing-request";
import type { NativeModelBinding } from "./model-identity";
import { nativeRoutingV2Resolution, prepareNativeRoutingV2, type NativeRoutingV2FactsProvider, type NativeRoutingV2Resolution } from "./native-routing-v2";
export interface NativeRoutingClassifierOptions {
  cwd: string; configDir?: string; env: Readonly<Record<string, string | undefined>>;
  availability(config: Control["SessionConfig"]): Control["RoutingAvailability"];
  bindings(): readonly NativeModelBinding[];
  providerFactory(providerId: string, modelId: string): ProviderPort;
  allowed?(providerId: string, modelId: string): boolean;
  modelFacts?: NativeRoutingV2FactsProvider;
  /** Capture one coherent set of local facts for each decision. */
  modelFactsFactory?: () => NativeRoutingV2FactsProvider;
  /** Same output reservation the native agent turn will enforce. */
  outputTokensReserved?: number;
  /** One aggregate native service budget, including cleanup, never above the frozen original work window. */
  timeoutMs?: number;
}
export class NativeClassifierError extends Error {
  constructor(readonly code: string, readonly fatal = false) { super(code); this.name = "NativeClassifierError"; }
}
/** Production composition of the shipped classifier. Only advertised native ProviderPorts are authorized;
 * a global service credential alone never imports a second service-only provider into a remote run. */
export function createNativeRoutingClassifier(options: NativeRoutingClassifierOptions): NativeRoutingClassifier {
  return async (text, config, context) => {
    context.signal.throwIfAborted();
    let routingV2: NormalizedRoutingV2Config | undefined;
    try { routingV2 = loadActiveRoutingV2(options.cwd, options.configDir); }
    catch { throw new NativeClassifierError("routing-v2-config-invalid", true); }
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
    const detected = [...new Set(choices.map((choice) => choice.binding.actualProviderId))].map((name) => ({ name, models: choices.filter((choice) => choice.binding.actualProviderId === name).map((choice) => choice.binding.actualModelId) }));
    const budget = Math.max(1, Math.min(2500, options.timeoutMs ?? 2500));
    const deadline = performance.now() + Math.min(3000, budget + 500);
    let authorityRefused = false; let calls = 0;
    const pending = new Set<Promise<void>>();
    const classifierProviderFactory = (providerId: string, modelId: string): ProviderPort => {
        const choice = actual(providerId, modelId); if (choice === undefined) throw new NativeClassifierError("classifier-model-not-permitted");
        const metadata: NativeClassifierProvider = { candidateId: choice.candidate.candidateId, providerId: choice.candidate.providerId, modelId: choice.candidate.modelId, actualProviderId: choice.binding.actualProviderId, actualModelId: choice.binding.actualModelId };
        const provider = options.providerFactory(providerId, modelId);
        return { ...provider, describe: () => provider.describe(), stream: (request, streamOptions) => (async function* () {
          if (++calls > 1) throw new NativeClassifierError("classifier-call-budget-exceeded");
          let finished!: () => void; const completion = new Promise<void>((resolve) => { finished = resolve; }); pending.add(completion);
          const signal = streamOptions.signal === undefined ? context.signal : AbortSignal.any([streamOptions.signal, context.signal]); let bytes = 0;
          try {
            try { await context.beforeIo(metadata); } catch { authorityRefused = true; throw new NativeClassifierError("classifier-authority-refused"); }
            signal.throwIfAborted();
            for await (const event of provider.stream(request, { ...streamOptions, signal })) {
              if (event.kind === "usage_update" && event.usage !== undefined) context.onUsage(metadata, event.usage);
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
    if (routingV2 !== undefined) {
      const category = classifyDeterministic(text) ?? "default";
      const baseRequest: Omit<RoutingRequest, "baseline"> = {
        requestId: routingV2Digest({ origin: "native-session", category, text }),
        category,
        origin: "native-session",
        requirements: {
          capabilities: ["tools"],
          inputTokensRequired: Buffer.byteLength(text),
          outputTokensReserved: options.outputTokensReserved ?? 8192,
        },
      };
      let request = baseRequest;
      const needsClassification = routingV2.categories[category].mode === "auto";
      if (needsClassification) {
        const adapters = buildRoutingClassifierAdapters({ config: routingV2,
          sessionProvider: baseline.binding.actualProviderId,
          fallbackModel: { providerId: baseline.binding.actualProviderId, modelId: baseline.binding.actualModelId },
          env: { ...options.env }, jevEnabled: false, jevAllowed: false,
          externalAllowed: (providerId, modelId) => actual(providerId, modelId) !== undefined,
          classifierAllowed: (providerId, modelId) => actual(providerId, modelId) !== undefined,
          providerFactory: classifierProviderFactory,
          ...(options.configDir === undefined ? {} : { userConfigDir: options.configDir }),
          timeoutMs: Math.min(budget, routingV2.classifier.timeoutMs),
        });
        const classified = await runRoutingClassifierChain(text, {
          adapters,
          deadlineMs: Math.min(budget, routingV2.classifier.timeoutMs),
          minConfidence: routingV2.classifier.minConfidence,
          onFailure: routingV2.classifier.onFailure,
          signal: context.signal,
        });
        const applied = applyRoutingClassificationResult({ ...baseRequest,
          baseline: { providerId: baseline.binding.actualProviderId, modelId: baseline.binding.actualModelId } }, classified);
        if (applied.status === "cancelled") {
          context.signal.throwIfAborted();
          throw new NativeClassifierError("routing-v2-cancelled", true);
        }
        const { baseline: _baseline, ...classifiedRequest } = applied.request;
        request = classifiedRequest;
      }
      await confirmStopped();
      if (authorityRefused) throw new NativeClassifierError("classifier-authority-refused");
      if (pending.size > 0) throw new NativeClassifierError("classifier-stop-unconfirmed");
      context.signal.throwIfAborted();
      let resolution: NativeRoutingV2Resolution;
      let receiptId: string;
      try {
        const modelFacts = options.modelFactsFactory?.() ?? options.modelFacts;
        const prepared = prepareNativeRoutingV2({
          sessionConfig: config,
          availability: frozenAvailability,
          bindings: frozenBindings,
          routingConfig: routingV2,
          ...(options.allowed === undefined ? {} : { allowed: options.allowed }),
          ...(modelFacts === undefined ? {} : { modelFacts }),
          request,
        });
        const journal = { cwd: options.cwd, ...(options.configDir === undefined ? {} : { configDir: options.configDir }) };
        const route = { request: prepared.request, snapshot: prepared.frozen.snapshot, config: routingV2 };
        const receipt = resolveRoutingForRuntime({ ...route, journal: { ...journal, kind: "dispatch" } });
        const candidate = await prepareRoutingCandidate({
          ...route, journal, receipt, signal: context.signal,
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
        if (!candidate.ok) throw new NativeClassifierError(`routing-v2-${candidate.reason}`, true);
        receiptId = candidate.receipt.receiptId;
        resolution = nativeRoutingV2Resolution(prepared.frozen, candidate.receipt.decision);
      } catch (cause) {
        if (cause instanceof NativeClassifierError) throw cause;
        throw new NativeClassifierError("routing-v2-snapshot-invalid", true);
      }
      if (resolution.decision.status === "selected" && resolution.candidateId !== undefined) {
        return { candidateId: resolution.candidateId, selectionReceiptId: receiptId };
      }
      const reason = resolution.decision.status === "blocked" ? resolution.decision.reason : "config-invalid";
      throw new NativeClassifierError(`routing-v2-${reason}`, true);
    }
    const result = await runRoutingClassifierForTurn(text, { enabled: config.routing.enabled, jevEnabled: false, jevAllowed: false,
      cwd: options.cwd, ...(options.configDir === undefined ? {} : { userConfigDir: options.configDir }), env: { ...options.env }, detected,
      sessionProvider: baseline.binding.actualProviderId, sessionModel: baseline.binding.actualModelId, signal: context.signal, timeoutMs: budget,
      classifierAllowed: (providerId, modelId) => actual(providerId, modelId) !== undefined,
      executorAllowed: (providerId, modelId) => actual(providerId, modelId) !== undefined,
      providerFactory: classifierProviderFactory,
    });
    await confirmStopped();
    if (authorityRefused) throw new NativeClassifierError("classifier-authority-refused");
    if (pending.size > 0) throw new NativeClassifierError("classifier-stop-unconfirmed");
    context.signal.throwIfAborted();
    return result?.routed === undefined ? undefined : actual(result.routed.providerId, result.routed.modelId)?.candidate.candidateId;
  };
}
