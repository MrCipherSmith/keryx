// Composable metaproject-aware policy escalation (flow 042 / MP-6 deep).
//
// This is a pure primitive that sits OVER the frozen policy engine (`decide()`),
// NOT inside it: it takes a `PolicyDecision` and returns an equal-or-STRICTER one.
// It can only escalate `allow` → `ask` when a metaproject blast radius crosses a
// configured threshold; it NEVER makes any decision more permissive (an `ask` stays
// `ask`, a `deny` stays `deny`) — preserving ADR-0003's "never weaken" invariant.
// The frozen `decide()`, `PolicyContext`, and `PolicyProfile` are untouched; this
// module composes with them.

import type { MetaprojectPort } from "../tool/metaproject-port";
import type { PolicyDecision } from "./types";

/** Metaproject signals available to the escalation primitive. */
export interface MetaprojectPolicyContext {
  /** Number of files transitively affected by the action's target (code graph). */
  blastRadius?: number;
  /** The affected file paths (optional detail). */
  affected?: string[];
}

/**
 * Return `decision` UNCHANGED unless it is `allow` AND the metaproject blast radius
 * meets `threshold` (> 0), in which case return an `ask` decision (allow → ask). It
 * never changes `ask`/`deny` and never makes a decision more permissive. A
 * `threshold <= 0` or an absent `blastRadius` is a no-op. Pure + deterministic.
 */
export function escalateForBlastRadius(
  decision: PolicyDecision,
  ctx: MetaprojectPolicyContext,
  threshold: number,
): PolicyDecision {
  if (
    decision.decision !== "allow" ||
    threshold <= 0 ||
    ctx.blastRadius === undefined ||
    ctx.blastRadius < threshold
  ) {
    return decision;
  }
  return {
    ...decision,
    decision: "ask",
    matchedRules: [...decision.matchedRules, `metaproject:blast-radius>=${threshold}`],
    reason: `Escalated allow→ask: blast radius ${ctx.blastRadius} ≥ ${threshold} (metaproject).`,
  };
}

/**
 * Best-effort blast radius (count of affected files) for `target` via the code
 * graph. Returns 0 when there are no dependents, on a structured port error, or on
 * a thrown error — never throws.
 */
export async function metaprojectBlastRadius(port: MetaprojectPort, target: string): Promise<number> {
  try {
    const result = await port.graphAffected({ target });
    return result.error !== undefined ? 0 : result.affected.length;
  } catch {
    return 0;
  }
}
