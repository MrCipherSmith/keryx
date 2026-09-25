// Flow 338 — the routing classifier: which category (`src/harness/routing/
// table.ts`'s `RoutingCategory`) a given `keryx shell` request belongs to,
// when the caller has not already named one. Mirrors the shape
// `docs/requirements/keryx-jev-router/PRD.md` §9.1 drafted, kept minimal:
// one method, two outcomes, never a guessed category.
//
// `src/harness/decision/` is a CLIENT-zone directory (see `jev-client.ts`'s
// own header) — this interface itself has no I/O and no zone dependency, so
// it stays here alongside the concrete classifiers that DO reach a network
// or a provider.

import type { RoutingCategory } from "../routing/table";

/** Which stage of the fallback chain produced a classification (or would have, had it succeeded). */
export type TaskClassifierSource = "deterministic" | "jev" | "main-model";

/**
 * AC9 — cost/usage visibility. Present whenever the classifying stage
 * actually reached a real client (Jev's own `usage`, or the main-model
 * classifier's provider usage) — a deterministic-shortcut result (AC2) or an
 * early refusal before any request went out (no credential, empty
 * vocabulary) carries none.
 */
export interface TaskClassifierUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cost?: number;
  readonly latencyMs?: number;
}

export type TaskClassifierResult =
  | { readonly ok: true; readonly category: RoutingCategory; readonly confidence: number; readonly source: TaskClassifierSource; readonly usage?: TaskClassifierUsage }
  | { readonly ok: false; readonly reason: string; readonly usage?: TaskClassifierUsage };

/**
 * One classifier stage. `classify` must never throw — every failure mode
 * (no credential, timeout, malformed reply, low confidence) resolves to
 * `{ok:false, reason}` so a caller (`classifyTurn`, `classify-turn.ts`) can
 * fall through to the next stage without a try/catch of its own. `categories`
 * is the caller's candidate vocabulary — normally `WIRED_ROUTING_CATEGORIES`
 * from `../routing/table.ts`.
 */
export interface TaskClassifyOptions {
  /** Aborts the underlying request (provider call / Jev call) when the shared per-stage timeout (`classify-turn.ts`) fires. */
  readonly signal?: AbortSignal;
}

export interface TaskClassifier {
  classify(task: string, categories: readonly RoutingCategory[], opts?: TaskClassifyOptions): Promise<TaskClassifierResult>;
}

/** The default when nothing is configured or enabled — never classifies, always `{ok:false}` (PRD §9.4). */
export class NullClassifier implements TaskClassifier {
  async classify(_task?: string, _categories?: readonly RoutingCategory[], _opts?: TaskClassifyOptions): Promise<TaskClassifierResult> {
    return { ok: false, reason: "no classifier configured" };
  }
}
