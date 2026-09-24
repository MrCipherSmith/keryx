// Pure composition of the policy engine's decision with hook decisions (flow
// 306, W6, T5).
//
// This is the security-sensitive surface workstreams/W6-shell-hooks.md's
// "Composition with the policy engine" section pins: hooks can only TIGHTEN
// `decide()`'s outcome, never loosen it, and a `decide()` deny (hard or not)
// is untouchable by any hook of any class or precedence. Never mutates its
// inputs — every branch returns a new object.
import type { PolicyDecision, PolicyOutcome } from "../policy/types";

export interface HookDecisionEntry {
  hookId: string;
  decision?: PolicyOutcome;
}

export interface ComposeOptions {
  interactive: boolean;
}

/**
 * Compose a `decide()` result with the ordered set of gate-hook decisions
 * that ran for one tool call. `policy.decision === "deny"` (hard or a
 * baseline/flow-file deny) is returned unchanged — no hook decision is even
 * consulted once `decide()` has already denied. Otherwise: any hook `deny`
 * wins; else any hook `ask` tightens `allow` to `ask` (a no-op if `decide()`
 * already said `ask`); the headless fail-closed rule (`engine.ts:234-241`)
 * applies AFTER hook composition, so a hook-tightened `ask` under
 * `interactive: false` still fails closed to `deny`. A hook `allow` never
 * loosens anything and is never itself a reason to change the record.
 */
export function composeDecision(
  policy: PolicyDecision,
  hooks: readonly HookDecisionEntry[],
  opts: ComposeOptions,
): PolicyDecision {
  if (policy.decision === "deny") {
    return { ...policy };
  }

  const denyHook = hooks.find((h) => h.decision === "deny");
  if (denyHook !== undefined) {
    return {
      ...policy,
      decision: "deny",
      matchedRules: [...policy.matchedRules, `hook:${denyHook.hookId}:deny`],
      reason: `Denied by hook ${denyHook.hookId}.`,
    };
  }

  const askHook = hooks.find((h) => h.decision === "ask");
  if (askHook !== undefined) {
    if (opts.interactive === false) {
      return {
        ...policy,
        decision: "deny",
        matchedRules: [...policy.matchedRules, `hook:${askHook.hookId}:ask`, "headless-fail-closed"],
        reason: `Hook ${askHook.hookId} asked but the session is non-interactive; failing closed.`,
      };
    }
    if (policy.decision === "allow") {
      return {
        ...policy,
        decision: "ask",
        matchedRules: [...policy.matchedRules, `hook:${askHook.hookId}:ask`],
        reason: `Tightened to ask by hook ${askHook.hookId}.`,
      };
    }
    // policy.decision is already "ask" — the hook agreed, nothing changed.
    return { ...policy };
  }

  return { ...policy };
}

export interface TightenResult {
  outcome: PolicyOutcome;
  /** `hook:<id>:<decision>` entries, only when a hook actually changed `outcome`. */
  matchedRules: string[];
}

/**
 * The same tighten-only rule for the non-tool gate-capable events
 * (`UserPromptSubmit`/`Stop`/`SubagentStart`), which have no `PolicyDecision`
 * of their own — only an implicit `"allow"` baseline a hook may tighten.
 */
export function tightenOutcome(
  base: PolicyOutcome,
  hooks: readonly HookDecisionEntry[],
  interactive: boolean,
): TightenResult {
  if (base === "deny") {
    return { outcome: "deny", matchedRules: [] };
  }

  const denyHook = hooks.find((h) => h.decision === "deny");
  if (denyHook !== undefined) {
    return { outcome: "deny", matchedRules: [`hook:${denyHook.hookId}:deny`] };
  }

  const askHook = hooks.find((h) => h.decision === "ask");
  if (askHook !== undefined) {
    if (interactive === false) {
      return { outcome: "deny", matchedRules: [`hook:${askHook.hookId}:ask`, "headless-fail-closed"] };
    }
    if (base === "allow") {
      return { outcome: "ask", matchedRules: [`hook:${askHook.hookId}:ask`] };
    }
    return { outcome: base, matchedRules: [] };
  }

  return { outcome: base, matchedRules: [] };
}
