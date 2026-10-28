import type { Control } from "../remote-control/protocol";
import type { NormalizedUsage } from "../harness/provider/types";
export interface NativeClassifierProvider { candidateId: string; providerId: string; modelId: string; actualProviderId?: string; actualModelId?: string }
export interface NativeClassifierContext {
  signal: AbortSignal;
  beforeIo(provider: NativeClassifierProvider): Promise<void>;
  onRefusal?(code: string): void;
  onUsage(provider: NativeClassifierProvider, usage: NormalizedUsage): void;
}
export type NativeRoutingClassifier = (text: string, config: Control["SessionConfig"], context: NativeClassifierContext) => Promise<string | undefined>;

import { runRoutingClassifierForTurn } from "../tui/routing-classifier-source";
import type { ProviderPort } from "../harness/provider/types";
import type { NativeModelBinding } from "./model-identity";
export interface NativeRoutingClassifierOptions {
  cwd: string; configDir?: string; env: Readonly<Record<string, string | undefined>>;
  availability(config: Control["SessionConfig"]): Control["RoutingAvailability"];
  bindings(): readonly NativeModelBinding[];
  providerFactory(providerId: string, modelId: string): ProviderPort;
  allowed?(providerId: string, modelId: string): boolean;
  /** One aggregate native service budget, including cleanup, never above the frozen original work window. */
  timeoutMs?: number;
}
export class NativeClassifierError extends Error { constructor(readonly code: string) { super(code); this.name = "NativeClassifierError"; } }
/** Production composition of the shipped classifier. Only advertised native ProviderPorts are authorized;
 * a global service credential alone never imports a second service-only provider into a remote run. */
export function createNativeRoutingClassifier(options: NativeRoutingClassifierOptions): NativeRoutingClassifier {
  return async (text, config, context) => {
    context.signal.throwIfAborted();
    const available = options.availability(config).candidates.filter((candidate) => candidate.available && candidate.reason === "none"
      && [config.baselineCandidateId, ...config.routing.candidateIds].includes(candidate.candidateId));
    const choices = available.flatMap((candidate) => {
      const binding = options.bindings().find((binding) => binding.providerId === candidate.providerId && binding.modelId === candidate.modelId);
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
    const result = await runRoutingClassifierForTurn(text, { enabled: config.routing.enabled, jevEnabled: false, jevAllowed: false,
      cwd: options.cwd, ...(options.configDir === undefined ? {} : { userConfigDir: options.configDir }), env: { ...options.env }, detected,
      sessionProvider: baseline.binding.actualProviderId, sessionModel: baseline.binding.actualModelId, signal: context.signal, timeoutMs: budget,
      classifierAllowed: (providerId, modelId) => actual(providerId, modelId) !== undefined,
      executorAllowed: (providerId, modelId) => actual(providerId, modelId) !== undefined,
      providerFactory: (providerId, modelId) => {
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
      },
    });
    if (pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...pending]), new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - performance.now())); })]);
      if (timer !== undefined) clearTimeout(timer);
    }
    if (authorityRefused) throw new NativeClassifierError("classifier-authority-refused");
    if (pending.size > 0) throw new NativeClassifierError("classifier-stop-unconfirmed");
    context.signal.throwIfAborted();
    return result?.routed === undefined ? undefined : actual(result.routed.providerId, result.routed.modelId)?.candidate.candidateId;
  };
}
