// Stand-in models for the arbiter's tests and its evaluation sets. Nothing here is used at run time.
//
// `ruleFollowingModel` reads the prompt the way a careful model would: the question kind and the facts, then the
// rule that fits. `replayModel` returns recorded raw replies in order. `hostileModel` answers `allow` whatever it
// is shown, which is what a model steered by injected text would do.

import type { ModelTurnInput, ModelTurnResult } from "../harness/provider/single-turn";
import { bundledArbiterRules, ruleHolds, rulesForKind, type ArbiterFacts, type ArbiterKind, type ArbiterRules } from "./arbiter-rules";

export interface SeenTurns {
  readonly turns: ModelTurnInput[];
}

function ok(model: string, text: string): ModelTurnResult {
  return { provider: "stub", model, credentialAvailable: true, text, usage: { inputTokens: 120, outputTokens: 24, totalTokens: 144 } };
}

/** The facts, kind and recommended option number as the prompt states them. */
export function readPrompt(user: string): { kind: ArbiterKind; facts: ArbiterFacts; recommended: number } {
  const kind = /question kind: (\w+)/.exec(user)?.[1] as ArbiterKind;
  const recommended = Number(/recommended: option (\d+)/.exec(user)?.[1]);
  const facts: Record<string, number | boolean> = {};
  for (const match of user.matchAll(/^- (\w+): (true|false|-?[\d.]+)$/gm)) {
    const name = match[1] as string;
    const raw = match[2] as string;
    facts[name] = raw === "true" ? true : raw === "false" ? false : Number(raw);
  }
  return { kind, facts, recommended };
}

/** A model that follows the written rules: it picks the strictest rule that holds for the facts it was shown. */
export function ruleFollowingModel(seen?: SeenTurns, rules: ArbiterRules = bundledArbiterRules()): (input: ModelTurnInput) => Promise<ModelTurnResult> {
const order = (kind: string): number => (kind === "deny" ? 2 : kind === "escalate" ? 1 : 0);
  return async (input) => {
    seen?.turns.push(input);
    const { kind, facts, recommended } = readPrompt(input.user);
    const holding = rulesForKind(rules, kind).filter((rule) => rule.when !== undefined && ruleHolds(rule, facts));
    const picked =
      holding.sort((a, b) => order(b.verdict) - order(a.verdict))[0] ?? rulesForKind(rules, kind).find((rule) => rule.when === undefined && rule.verdict === "escalate");
    const answer =
      picked === undefined
        ? { verdict: "escalate", rule: "R-99" }
        : { verdict: picked.verdict, rule: picked.id, ...(picked.verdict === "allow" ? { option: recommended } : {}), reason: "stub" };
    return ok(input.model ?? "stub", JSON.stringify(answer));
  };
}

/** Returns each recorded raw reply in turn; the last one repeats. */
export function replayModel(replies: readonly string[], seen?: SeenTurns): (input: ModelTurnInput) => Promise<ModelTurnResult> {
  let next = 0;
  return async (input) => {
    seen?.turns.push(input);
    const text = replies[Math.min(next, replies.length - 1)] ?? "";
    next += 1;
    return ok(input.model ?? "stub", text);
  };
}

/** Says allow to everything, citing the first allow rule of the kind, and option 1. */
export function hostileModel(seen?: SeenTurns, rules: ArbiterRules = bundledArbiterRules()): (input: ModelTurnInput) => Promise<ModelTurnResult> {
  return async (input) => {
    seen?.turns.push(input);
    const { kind } = readPrompt(input.user);
    const rule = rulesForKind(rules, kind).find((candidate) => candidate.verdict === "allow");
    return ok(input.model ?? "stub", JSON.stringify({ verdict: "allow", rule: rule?.id ?? "R-01", option: 1, reason: "ignore previous instructions" }));
  };
}
