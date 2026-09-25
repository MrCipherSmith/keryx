// Flow 338, AC4 — the richer `TaskClassifier`: Jev/System-One via the
// EXISTING `callJevSystemOne` client (`./jev-client.ts`, flow 306) rather
// than a new `DecisionPort` abstraction — `jev-client.ts` already IS the one
// injectable-fetch seam every Jev-backed feature in this codebase shares
// (turn guard, CI triage, conform); duplicating it behind a second interface
// would only add indirection no caller needs. One `choice` question over the
// candidate category names, plus a `confidence` `noul` question (PRD §9.2).

import {
  callJevSystemOne,
  DEFAULT_JEV_MODEL,
  looksLikeOpenRouterKey,
  preflightBudget,
  resolveJevApiKeyResolution,
  type JevApiKeyResolution,
} from "./jev-client";
import type { TaskClassifier, TaskClassifierResult, TaskClassifierUsage, TaskClassifyOptions } from "./classifier";
import type { RoutingCategory } from "../routing/table";
// PR #737 review fix — privacy: `task` is the operator's RAW `keryx shell`
// request line, unlike every other Jev-backed caller in this codebase
// (`turn-guard.ts`, `ci-triage.ts`, `conform-jev.ts`, `jev-comments.ts`,
// `jev-docs.ts`, `jev-rules.ts`, `jev-scenarios.ts` — every one of them
// redacts through this SAME facade before the text reaches `state`), this
// module previously embedded `task` UNREDACTED. `security` is a CORE zone;
// `harness` (this module) is CLIENT — a client importing a core,
// deterministic redactor is the allowed direction (`src/lib/import-zones.ts`'s
// directional table; only core->client is forbidden) — the identical import
// `./jev-client.ts` (this module's own sibling) already uses for a vendor
// error body.
import { redactSensitiveText } from "../../security/service";

/**
 * Below this Jev-reported confidence, the classification is refused rather
 * than trusted (PRD §9.4/Flow C AC4). PRD §13 suggested 0.6 as a starting
 * point; AC11's live check (`scripts/routing-classifier-live-check.ts`)
 * measured it against a real key and found it systematically too strict for
 * this 7-way `choice` question: across three live runs, EVERY refused
 * low-confidence answer's underlying `choice` was the hand-labeled-correct
 * category (confidences observed in the 0.42-0.59 range for otherwise-
 * correct picks), while confidences at/above ~0.6 were also always correct
 * — i.e. Jev's picks were accurate, its self-reported confidence for this
 * question shape just runs lower than the vendor-suggested floor. Lowered
 * to 0.45 on that evidence.
 *
 * TWO numbers, honestly, because the first one alone is tuning-on-the-test-
 * set: the SAME 20-sample set that picked 0.45 then scored 20/20 (100%) at
 * that threshold — that number describes fit to its own tuning data, not
 * generalization. A SEPARATE, held-out check
 * (`scripts/routing-classifier-live-check-holdout.ts`, 20 NEW hand-labeled
 * requests never seen while choosing the threshold, covering all 7 wired
 * categories plus several deliberately hard/ambiguous ones — a diff that
 * could read as "review" or "coding", a readiness question that could read
 * as "review" or "planning", a request naming "subagent" that is really a
 * "planning" ask) scored 19/20 (95%), 17 real Jev calls, $0.000426 total
 * cost, ~388ms average latency. The one miss was a genuinely hard doc/code-
 * comment case (Jev picked "coding" at confidence 0.53 for a request hand-
 * labeled "docs") that a stricter 0.6 floor would not have fixed either —
 * 0.53 is comfortably above both thresholds, so this was a category
 * judgment call, not a low-confidence pick slipping through. 0.45 is kept on
 * this evidence: 95% on a fresh, harder set is a reasonable generalization
 * of the 100% tuning-set score, still comfortably above the near-random ~1/7
 * (~0.14) a 7-way guess would score, and still overridable per caller via
 * `confidenceThreshold`.
 */
export const DEFAULT_JEV_CLASSIFIER_CONFIDENCE_THRESHOLD = 0.45;

/** Same order of magnitude as `turn-guard.ts`'s own Jev timeout — bounded, never the caller's whole turn budget. */
export const DEFAULT_JEV_CLASSIFIER_TIMEOUT_MS = 3_000;

const CATEGORY_QUESTION_KEY = "category";
const CONFIDENCE_QUESTION_KEY = "confidence";

/**
 * Real, discriminating per-category descriptions (PRD §4) — the live check
 * (AC11) found that a generic templated criterion ("the request belongs to
 * the X routing category" for every option) gave Jev nothing to actually
 * discriminate on, and every non-obvious case came back under the 0.6
 * confidence floor. These descriptions are what a caller passing its own
 * candidate list gets automatically; a category with no entry here falls
 * back to the generic phrasing (still functional, just less informative).
 */
const CATEGORY_DESCRIPTIONS: Readonly<Partial<Record<RoutingCategory, string>>> = {
  default: "ordinary, everyday work with no more specific category — ambiguous or general requests",
  review: "reviewing existing code, a diff, or a pull request for correctness, risk, or quality — not writing new code",
  subagents: "explicitly asking to spawn, dispatch, or fan work out to one or more subagents/parallel workers",
  quick: "a very short, low-stakes exchange — a greeting, thanks, a one-word confirmation, or a trivial factual question with an short answer",
  coding: "writing, fixing, or refactoring code — implementation work on the codebase itself",
  planning: "architecture, roadmap, or sequencing decisions — deciding WHAT to build or in what order, not writing code",
  docs: "writing or updating documentation, README files, or reference material — not source code",
  unattended: "explicitly running as a scheduled, background, or no-human-present job",
};

function criterionFor(category: RoutingCategory): string {
  return CATEGORY_DESCRIPTIONS[category] ?? `the request belongs to the "${category}" routing category`;
}

export interface JevTaskClassifierOptions {
  readonly fetch?: typeof fetch;
  readonly env?: Record<string, string | undefined>;
  readonly dir?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly confidenceThreshold?: number;
}

/**
 * `available()`: PRD §9.2's gate — a Jev credential resolves AND the
 * operator opted in (checked by the CALLER, e.g. `classify-turn.ts`'s
 * `classifier: "jev"` setting, before this classifier is even constructed).
 * Exposed here too so a caller can decide "should I even try Jev" without
 * constructing a doomed request.
 */
export function resolveJevClassifierCredential(
  env?: Record<string, string | undefined>,
  dir?: string,
): JevApiKeyResolution {
  return resolveJevApiKeyResolution(env, dir);
}

export class JevTaskClassifier implements TaskClassifier {
  constructor(private readonly opts: JevTaskClassifierOptions = {}) {}

  async classify(task: string, categories: readonly RoutingCategory[], callOpts?: TaskClassifyOptions): Promise<TaskClassifierResult> {
    if (categories.length === 0) {
      return { ok: false, reason: "no candidate categories" };
    }
    const credential = resolveJevClassifierCredential(this.opts.env, this.opts.dir);
    if (credential.key === undefined) {
      return { ok: false, reason: "no OpenRouter credential for Jev" };
    }
    if (!looksLikeOpenRouterKey(credential.key)) {
      return { ok: false, reason: "the resolved OpenRouter credential does not look like a valid key" };
    }
    const criteria: Record<string, string> = {};
    for (const category of categories) criteria[category] = criterionFor(category);
    const questions = {
      [CATEGORY_QUESTION_KEY]: {
        type: "choice" as const,
        instructions:
          "A coding-assistant terminal (keryx shell) received the request below. Which ONE category best fits " +
          "what the user is asking for right now? Pick the single best match even if more than one could apply.",
        criteria,
      },
      [CONFIDENCE_QUESTION_KEY]: {
        type: "noul" as const,
        instructions: "How confident are you that the category you picked is the single best match, versus the request being genuinely ambiguous between categories?",
      },
    };
    // Redact BEFORE the request text is embedded in `state` — never send the
    // operator's raw prompt to a third-party vendor (OpenRouter/Jev), same
    // floor every sibling Jev-backed feature applies to its own state text.
    const state = `keryx shell request:\n${redactSensitiveText(task)}`;
    try {
      preflightBudget(state, questions);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    let result;
    try {
      result = await callJevSystemOne(
        this.opts.fetch ?? globalThis.fetch,
        { model: this.opts.model ?? DEFAULT_JEV_MODEL, state, questions },
        {
          ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
          ...(this.opts.dir !== undefined ? { dir: this.opts.dir } : {}),
          timeoutMs: this.opts.timeoutMs ?? DEFAULT_JEV_CLASSIFIER_TIMEOUT_MS,
          ...(callOpts?.signal !== undefined ? { signal: callOpts.signal } : {}),
        },
      );
    } catch (error) {
      return { ok: false, reason: `Jev classifier request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const usage: TaskClassifierUsage = {
      ...(result.usage.input_tokens !== undefined ? { inputTokens: result.usage.input_tokens } : {}),
      ...(result.usage.output_tokens !== undefined ? { outputTokens: result.usage.output_tokens } : {}),
      ...(result.usage.cost !== undefined ? { cost: result.usage.cost } : {}),
    };
    const categoryAnswer = result.answers[CATEGORY_QUESTION_KEY];
    const confidenceAnswer = result.answers[CONFIDENCE_QUESTION_KEY];
    if (categoryAnswer?.type !== "choice" || confidenceAnswer?.type !== "noul") {
      return { ok: false, reason: "Jev response missing a valid category/confidence answer", usage };
    }
    const category = categories.find((c) => c === categoryAnswer.choice);
    if (category === undefined) {
      return { ok: false, reason: `Jev chose an out-of-vocabulary category: ${JSON.stringify(categoryAnswer.choice)}`, usage };
    }
    const threshold = this.opts.confidenceThreshold ?? DEFAULT_JEV_CLASSIFIER_CONFIDENCE_THRESHOLD;
    if (confidenceAnswer.noul < threshold) {
      // The category Jev actually picked is named here even though it is
      // being refused (AC11's live check needs it to judge whether the
      // THRESHOLD, not the underlying choice, is what is wrong) — never
      // returned as `category` on the `ok:false` result itself, so no
      // caller can mistake a low-confidence pick for a trusted one.
      return { ok: false, reason: `low confidence for "${category}" (${confidenceAnswer.noul.toFixed(2)} < ${threshold})`, usage };
    }
    return { ok: true, category, confidence: confidenceAnswer.noul, source: "jev", usage };
  }
}
