// Flow 338, AC5 — the routing classifier's fallback chain: deterministic
// shortcut (AC2) -> Jev (AC4, when opted in and credentialed) -> the
// main-model classifier (AC3) -> no classification (`NullClassifier`, AC1).
// The whole chain is bounded by one deadline (JEV reserves half for fallback) and NEVER throws into the
// caller (`tui-shell.ts`'s turn dispatch) — a hung or failing stage degrades
// to the next one, all the way down to "use the session's own model",
// exactly PRD §9.4's fail-closed contract.

import { classifyDeterministic, isSlashCommandLine } from "./deterministic-shortcuts";
import { JevTaskClassifier, resolveJevClassifierCredential } from "./jev-classifier";
import { MainModelTaskClassifier } from "./main-model-classifier";
import { NullClassifier, type TaskClassifierResult, type TaskClassifierSource } from "./classifier";
import type { ProviderFactory } from "../provider/single-turn";
import type { RoutingCategory } from "../routing/table";

/** PRD §12/the task spec's "bounded latency (e.g. 3s)" — never the caller's whole turn budget. */
export const CLASSIFY_TURN_TIMEOUT_MS = 3_000;

export interface ClassifyTurnOptions {
  /** Whether the operator opted into Jev as the classifier (`ShellConfig.routingClassifier`, AC7). Default false — Jev is never tried unless this is explicitly true. */
  readonly jevEnabled?: boolean;
  /** The session's own provider/model, for the main-model classifier fallback (PRD §9.3). */
  readonly sessionProvider?: string;
  readonly sessionModel?: string;
  /** Independent fallback; null forbids reverting to baseline. */
  readonly fallbackModel?: { readonly providerId: string; readonly modelId: string } | null;
  readonly env?: Record<string, string | undefined>;
  readonly dir?: string;
  readonly fetch?: typeof fetch;
  readonly providerFactory?: ProviderFactory;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** One classification attempt's full outcome, including which stage decided it — for the per-turn tag/sidebar (AC8) and the classifier's own usage (AC9). */
export interface ClassifyTurnResult {
  readonly result: TaskClassifierResult;
  /** Every stage that was actually TRIED, in order, with its own outcome — for `/route` detail visibility. */
  readonly trace: ReadonlyArray<{ readonly source: TaskClassifierSource; readonly result: TaskClassifierResult }>;
}

/** Bound a stage, forwarding cancellation and observing late rejections. */
async function withTimeout(
  source: TaskClassifierSource,
  run: (signal: AbortSignal) => Promise<TaskClassifierResult>,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<TaskClassifierResult> {
  const cancelled = (): TaskClassifierResult => ({ ok: false, reason: "classification cancelled" });
  if (external?.aborted) return cancelled();
  if (timeoutMs <= 0) return { ok: false, reason: "classification deadline exceeded" };
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onAbort: () => void = () => {};
  try {
    const aborted = new Promise<TaskClassifierResult>((resolve) => {
      onAbort = () => resolve(external?.aborted ? cancelled() : { ok: false, reason: `${source} classifier timed out after ${timeoutMs}ms` });
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([run(controller.signal), aborted]);
  } catch (error) {
    return { ok: false, reason: `${source} classifier errored: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/**
 * AC5: run the fallback chain for `line` against `categories`. Returns
 * `undefined` immediately (no trace at all) for a slash-command line or an
 * empty vocabulary — routing never applies there (AC2/AC6).
 */
export async function classifyTurn(
  line: string,
  categories: readonly RoutingCategory[],
  opts: ClassifyTurnOptions = {},
): Promise<ClassifyTurnResult | undefined> {
  if (isSlashCommandLine(line) || categories.length === 0) return undefined;

  if (opts.signal?.aborted) return { result: { ok: false, reason: "classification cancelled" }, trace: [] };

  const deterministic = classifyDeterministic(line);
  if (deterministic !== undefined && categories.includes(deterministic)) {
    const result: TaskClassifierResult = { ok: true, category: deterministic, confidence: 1, source: "deterministic" };
    return { result, trace: [{ source: "deterministic", result }] };
  }

  const timeoutMs = opts.timeoutMs ?? CLASSIFY_TURN_TIMEOUT_MS;
  const deadline = performance.now() + Math.max(0, timeoutMs);
  const remaining = () => Math.max(0, deadline - performance.now());
  const fallback = opts.fallbackModel !== undefined ? opts.fallbackModel :
    opts.sessionProvider !== undefined && opts.sessionModel !== undefined
      ? { providerId: opts.sessionProvider, modelId: opts.sessionModel } : undefined;

  const trace: Array<{ readonly source: TaskClassifierSource; readonly result: TaskClassifierResult }> = [];

  const stopped = (): ClassifyTurnResult | undefined => opts.signal?.aborted
    ? { result: { ok: false, reason: "classification cancelled" }, trace }
    : remaining() <= 0 ? { result: { ok: false, reason: "classification deadline exceeded" }, trace } : undefined;
  const initialStop = stopped();
  if (initialStop) return initialStop;

  if (opts.jevEnabled === true) {
    const credential = resolveJevClassifierCredential(opts.env, opts.dir);
    if (credential.key !== undefined) {
      const jev = new JevTaskClassifier({ ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}), ...(opts.env !== undefined ? { env: opts.env } : {}), ...(opts.dir !== undefined ? { dir: opts.dir } : {}), timeoutMs });
      const jevResult = await withTimeout("jev", (signal) => jev.classify(line, categories, { signal }), Math.min(remaining(), fallback != null ? timeoutMs / 2 : timeoutMs), opts.signal);
      trace.push({ source: "jev", result: jevResult });
      const jevStop = stopped();
      if (jevStop) return jevStop;
      if (jevResult.ok) return { result: jevResult, trace };
    }
  }

  if (fallback != null) {
    const mainModel = new MainModelTaskClassifier({
      provider: fallback.providerId,
      model: fallback.modelId,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.providerFactory !== undefined ? { providerFactory: opts.providerFactory } : {}),
    });
    const mainModelResult = await withTimeout("main-model", (signal) => mainModel.classify(line, categories, { signal }), remaining(), opts.signal);
    trace.push({ source: "main-model", result: mainModelResult });
    const mainStop = stopped();
    if (mainStop) return mainStop;
    if (mainModelResult.ok) return { result: mainModelResult, trace };
  }

  const nullResult = await new NullClassifier().classify();
  return { result: nullResult, trace };
}
