import type { ModelRankHint } from "./model-tier";

/**
 * Built-in tier pins for model ids that carry no size word. `model-tier.ts`
 * itself holds no model ids; these are the operator-stated exceptions
 * (2026-10-10): Codex GPT-6 sol is the deep model, luna the cheap one for simple
 * operations. Scoped to the gpt-6 family so other vendors' codenames stay
 * unrankable, and overridable per model with `keryx routing profile set --tier`.
 */
export const CODEX_TIER_PINS: readonly ModelRankHint[] = [
  { pattern: "^gpt-6(\\.\\d+)*-sol$", weight: 1, override: true, note: "Codex GPT-6 sol: deep tier (operator pin)" },
  { pattern: "^gpt-6(\\.\\d+)*-luna$", weight: -1, override: true, note: "Codex GPT-6 luna: light tier (operator pin)" },
];
