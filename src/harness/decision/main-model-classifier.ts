// Flow 338, AC3 — the cheapest real `TaskClassifier`: a short, non-streaming,
// tool-free request to the SESSION'S OWN current provider/model (PRD §9.3),
// used when Jev is not connected/enabled but classification is still wanted.
// Built on `runModelTurn` (`../provider/single-turn.ts`), the same
// credential-detection + fail-closed single-completion helper every other
// model-backed keryx command already shares (wiki enrich, health explain
// --narrate, …) — no new provider plumbing.

import { runModelTurn, type ProviderFactory } from "../provider/single-turn";
import type { TaskClassifier, TaskClassifierResult, TaskClassifyOptions } from "./classifier";
import type { RoutingCategory } from "../routing/table";

/** Task text longer than this is truncated before being sent (flagged in the resulting reason on truncation is NOT surfaced — same "best-effort, never blocking" contract as the rest of this classifier). */
export const MAIN_MODEL_CLASSIFIER_TASK_CHARS = 2000;

/**
 * A one-token reply carries no real probability — this classifier's fixed,
 * conservative confidence (below Jev's own 0.6+ measured answers, but above
 * `classify-turn.ts`'s low-confidence rejection floor) rather than a
 * fabricated number. Documented here so `classify-turn.ts`'s threshold logic
 * and any caller inspecting `confidence` reads the same explanation.
 */
export const MAIN_MODEL_CLASSIFIER_CONFIDENCE = 0.7;

function buildSystemPrompt(categories: readonly RoutingCategory[]): string {
  return (
    `You are a strict routing classifier for a coding-assistant terminal. Given the user's next request, ` +
    `answer with EXACTLY ONE of these category names and nothing else — no punctuation, no explanation, ` +
    `no quotes: ${categories.join(", ")}.`
  );
}

/** The reply's first line, lower-cased and stripped of surrounding punctuation/whitespace — the strict single-token parse. */
function parseLabel(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine
    .trim()
    .toLowerCase()
    .replace(/^[^a-z]+|[^a-z]+$/gi, "");
}

export interface MainModelTaskClassifierOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
  readonly providerFactory?: ProviderFactory;
  readonly requestId?: string;
}

/**
 * PRD §9.3: single-token/short reply, no streaming, no tools, a size cap on
 * the task text, invoked only when a caller actually asks for a
 * classification (`classify-turn.ts`'s gating, never speculative).
 */
export class MainModelTaskClassifier implements TaskClassifier {
  constructor(private readonly opts: MainModelTaskClassifierOptions = {}) {}

  async classify(task: string, categories: readonly RoutingCategory[], callOpts?: TaskClassifyOptions): Promise<TaskClassifierResult> {
    if (categories.length === 0) {
      return { ok: false, reason: "no candidate categories" };
    }
    const truncated = task.slice(0, MAIN_MODEL_CLASSIFIER_TASK_CHARS);
    let result;
    try {
      result = await runModelTurn({
        ...(this.opts.provider !== undefined ? { provider: this.opts.provider } : {}),
        ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
        system: buildSystemPrompt(categories),
        user: truncated,
        maxOutputTokens: 16,
        requestId: this.opts.requestId ?? "keryx-routing-classifier",
        ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
        ...(this.opts.fetch !== undefined ? { fetch: this.opts.fetch } : {}),
        ...(this.opts.providerFactory !== undefined ? { providerFactory: this.opts.providerFactory } : {}),
        ...(callOpts?.signal !== undefined ? { signal: callOpts.signal } : {}),
      });
    } catch (error) {
      return { ok: false, reason: `main-model classifier request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (result.error !== undefined) {
      return { ok: false, reason: `main-model classifier provider error: ${result.error.message ?? "unknown"}` };
    }
    // `credentialAvailable` is only trustworthy for the "nothing ran at all"
    // case (`runModelTurn` returns empty text without ever constructing a
    // provider) — an injected `providerFactory` (production's own detected
    // session provider, or a test stub) can produce real text even when
    // `hasCredential`'s env-var probe reads `false`, so the credential gate
    // is keyed off "no text came back" rather than that flag alone.
    if (result.text.length === 0) {
      return {
        ok: false,
        reason: result.credentialAvailable ? "empty classifier response" : "no credential available for the session's provider",
      };
    }
    const usage = {
      ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
      ...(result.usage?.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {}),
      ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
    };
    const label = parseLabel(result.text);
    const match = categories.find((c) => c === label);
    if (match === undefined) {
      return { ok: false, reason: `unparseable classifier response: ${JSON.stringify(result.text.slice(0, 80))}`, usage };
    }
    return { ok: true, category: match, confidence: MAIN_MODEL_CLASSIFIER_CONFIDENCE, source: "main-model", usage };
  }
}
