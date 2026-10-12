// The model-round limit of one interactive agent turn, and the one place that
// says what it is per permission mode. Kept free of imports from `agent.ts` so
// the help text, the readline `/mode` output and the TUI can render the same
// numbers the turn loop enforces.

import type { PermissionMode } from "./permission-mode";

/**
 * Default model-round-trip budget per user turn for interactive agent
 * (`keryx shell` / TUI) in `ask`. A round is one `provider.stream()`
 * request/response cycle and may carry a batch of several tool calls, so this
 * bounds runaway ROUNDS rather than the number of distinct legitimate tool calls
 * a big task needs (see ADR-0010's "shape problem" — counting unique tool-call
 * signatures conflated task volume with actual repetition; this replaces
 * that axis rather than re-tuning its numbers, matching how grok-build,
 * Codex, and opencode all gate on rounds/tokens instead of call-signature
 * count). Real repetition is still caught independently by
 * `MAX_ATTEMPTS_PER_HASH`. Still a finite loop-safety guard — not
 * unlimited.
 */
export const DEFAULT_MAX_ROUNDS = 40;

/** The limit a `trust`-mode turn gets when the env is unset. */
export const TRUST_MAX_ROUNDS = 120;

/** Env override for {@link DEFAULT_MAX_ROUNDS} (positive integer). */
export const ENV_AGENT_MAX_ROUNDS = "KERYX_AGENT_MAX_ROUNDS";

/**
 * Hard ceiling when env/CLI requests an extreme value (runaway guard), and the
 * limit an `auto`-mode turn gets when the env is unset.
 */
export const MAX_AGENT_MAX_ROUNDS = 200;

/**
 * True when a turn at this limit class extends itself instead of asking: the
 * `auto` permission mode, or a turn that belongs to an automatic review (an
 * orthogonal run mode — see ./automatic-review.ts — that leaves the permission
 * mode, and so every approval, as it was).
 */
export function extendsWithoutAsking(mode: PermissionMode | undefined, automaticReview = false): boolean {
  return automaticReview || mode === "auto";
}

/**
 * Resolve model-round-trip budget for an interactive agent turn.
 * - valid env integer ≥ 1 → that value, clamped to {@link MAX_AGENT_MAX_ROUNDS}, in every mode
 * - unset / empty / invalid env, `mode === "auto"` or an automatic review → {@link MAX_AGENT_MAX_ROUNDS}
 * - unset / empty / invalid env, `mode === "trust"` → {@link TRUST_MAX_ROUNDS}
 * - unset / empty / invalid env, any other mode → {@link DEFAULT_MAX_ROUNDS}
 *
 * Callers pass `process.env` in production; tests inject a stub map.
 */
export function resolveAgentMaxRounds(
  env: Record<string, string | undefined> = process.env,
  mode?: PermissionMode,
  automaticReview = false,
): number {
  const fallback = extendsWithoutAsking(mode, automaticReview)
    ? MAX_AGENT_MAX_ROUNDS
    : mode === "trust"
      ? TRUST_MAX_ROUNDS
      : DEFAULT_MAX_ROUNDS;
  const raw = env[ENV_AGENT_MAX_ROUNDS];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(n, MAX_AGENT_MAX_ROUNDS);
}

/** The split for `/help`: the limit in `ask`, then the ones in `trust` and `auto`. */
export function describeRoundLimitSplit(env: Record<string, string | undefined> = process.env): string {
  return (
    `${resolveAgentMaxRounds(env, "ask")} rounds per turn, ` +
    `${resolveAgentMaxRounds(env, "trust")} in trust, ${resolveAgentMaxRounds(env, "auto")} in auto and in automatic review`
  );
}

/** One-line description of the limit a turn gets while it belongs to an automatic review. */
export function describeAutomaticReviewLimit(env: Record<string, string | undefined> = process.env): string {
  return `${resolveAgentMaxRounds(env, undefined, true)} rounds per turn, extends without asking`;
}

/**
 * One-line description of the round limit a turn gets in `mode`. Every surface
 * that shows the permission mode renders this string, so they cannot disagree.
 */
export function describeRoundLimit(
  mode: PermissionMode,
  env: Record<string, string | undefined> = process.env,
): string {
  const limit = resolveAgentMaxRounds(env, mode);
  return mode === "auto"
    ? `${limit} rounds per turn, extends without asking`
    : `${limit} rounds per turn, asks before extending`;
}
