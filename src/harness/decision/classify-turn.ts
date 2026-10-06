// Flow 338, AC5 — the routing classifier's fallback chain: deterministic
// shortcut (AC2) -> Jev (AC4, when opted in and credentialed) -> the
// main-model classifier (AC3) -> no classification (`NullClassifier`, AC1).
// Every stage is bounded by a shared timeout and NEVER throws into the
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
  readonly env?: Record<string, string | undefined>;
  readonly dir?: string;
  readonly fetch?: typeof fetch;
  readonly providerFactory?: ProviderFactory;
  readonly timeoutMs?: number;
}

/** One classification attempt's full outcome, including which stage decided it — for the per-turn tag/sidebar (AC8) and the classifier's own usage (AC9). */
export interface ClassifyTurnResult {
  readonly result: TaskClassifierResult;
  /** Every stage that was actually TRIED, in order, with its own outcome — for `/route` detail visibility. */
  readonly trace: ReadonlyArray<{ readonly source: TaskClassifierSource; readonly result: TaskClassifierResult }>;
}

/** Race one stage against the shared timeout — a stage that never settles degrades to a timeout refusal rather than hanging the chain. */
async function withTimeout(
  source: TaskClassifierSource,
  run: (signal: AbortSignal) => Promise<TaskClassifierResult>,
  timeoutMs: number,
): Promise<TaskClassifierResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<TaskClassifierResult>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve({ ok: false, reason: `${source} classifier timed out after ${timeoutMs}ms` }));
      }),
    ]);
  } catch (error) {
    return { ok: false, reason: `${source} classifier errored: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
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

  const deterministic = classifyDeterministic(line);
  if (deterministic !== undefined && categories.includes(deterministic)) {
    const result: TaskClassifierResult = { ok: true, category: deterministic, confidence: 1, source: "deterministic" };
    return { result, trace: [{ source: "deterministic", result }] };
  }

  const timeoutMs = opts.timeoutMs ?? CLASSIFY_TURN_TIMEOUT_MS;
  const trace: Array<{ readonly source: TaskClassifierSource; readonly result: TaskClassifierResult }> = [];

  if (opts.jevEnabled === true) {
    const credential = resolveJevClassifierCredential(opts.env, opts.dir);
    if (credential.key !== undefined) {
      const jev = new JevTaskClassifier({ ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}), ...(opts.env !== undefined ? { env: opts.env } : {}), ...(opts.dir !== undefined ? { dir: opts.dir } : {}), timeoutMs });
      const jevResult = await withTimeout("jev", (signal) => jev.classify(line, categories, { signal }), timeoutMs);
      trace.push({ source: "jev", result: jevResult });
      if (jevResult.ok) return { result: jevResult, trace };
    }
  }

  if (opts.sessionProvider !== undefined && opts.sessionModel !== undefined) {
    const mainModel = new MainModelTaskClassifier({
      provider: opts.sessionProvider,
      model: opts.sessionModel,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.providerFactory !== undefined ? { providerFactory: opts.providerFactory } : {}),
    });
    const mainModelResult = await withTimeout("main-model", (signal) => mainModel.classify(line, categories, { signal }), timeoutMs);
    trace.push({ source: "main-model", result: mainModelResult });
    if (mainModelResult.ok) return { result: mainModelResult, trace };
  }

  const nullResult = await new NullClassifier().classify();
  return { result: nullResult, trace };
}
