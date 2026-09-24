// Pure hook failure-classification table (flow 306, W6, T5).
//
// Implements workstreams/W6-shell-hooks.md's "Failure semantics" table
// exactly: what a timed-out/crashed/malformed hook invocation does to the
// surrounding lifecycle, per hook `class` and (for `gate` malformed output)
// the underlying `decide()` outcome, and per security profile for
// `gate-advisory`. No clock, randomness, network, or filesystem access.
import type { PolicyOutcome, PolicyProfileId } from "../policy/types";
import type { HookAnomalyName, HookClass, HookEventName, HookFailureKind } from "./types";

export interface FailureEffectInput {
  cls: HookClass;
  event: HookEventName;
  failure: HookFailureKind;
  profileId: PolicyProfileId;
  /** The `decide()` outcome this hook was gating, when relevant (gate malformed-output asymmetry). */
  decideOutcome?: PolicyOutcome;
}

export interface FailureEffectResult {
  effect: "deny" | "proceed" | "silent-approve";
  /** Present exactly on the fail-open paths (`proceed`/`silent-approve`) — something happened silently and should be surfaced. */
  warning?: HookAnomalyName;
  reason: HookAnomalyName;
}

/**
 * `sandbox-unavailable`/`refused` classify like a crash (Execution >
 * fail-closed sandbox rule); `hook-sandbox-unavailable` is still the more
 * informative named reason when that is specifically what happened.
 */
function reasonNameFor(failure: HookFailureKind): { normalized: "timeout" | "crash" | "malformed"; name: HookAnomalyName } {
  if (failure === "timeout") return { normalized: "timeout", name: "hook-timeout" };
  if (failure === "malformed") return { normalized: "malformed", name: "hook-malformed-output" };
  if (failure === "sandbox-unavailable") return { normalized: "crash", name: "hook-sandbox-unavailable" };
  return { normalized: "crash", name: "hook-crashed" }; // "crash" | "refused"
}

/**
 * Resolve the effect of one failed hook invocation. `gate` fails closed
 * (except malformed-output-when-not-`ask`, which silent-approves — the
 * asymmetry the spec calls out by name); `gate-advisory` is profile-aware;
 * `observe`/`context` always fail open with a warning. `SessionStart` is an
 * event-level override: ANY class on that event proceeds with a warning,
 * never denies, because nothing on `SessionStart` is gate-capable
 * (`GATE_CAPABLE_EVENTS` excludes it) — a hook registered there cannot change
 * the outcome even when it runs cleanly, so its failure cannot regress
 * enforcement either.
 */
export function failureEffect(input: FailureEffectInput): FailureEffectResult {
  const { normalized, name: reasonName } = reasonNameFor(input.failure);

  let base: FailureEffectResult;
  switch (input.cls) {
    case "gate": {
      if (normalized === "malformed") {
        base =
          input.decideOutcome === "ask"
            ? { effect: "deny", reason: reasonName }
            : { effect: "silent-approve", warning: reasonName, reason: reasonName };
      } else {
        base = { effect: "deny", reason: reasonName };
      }
      break;
    }
    case "gate-advisory": {
      base =
        input.profileId === "unattended-untrusted"
          ? { effect: "deny", reason: "hook-advisory-failed" }
          : { effect: "proceed", warning: "hook-advisory-failed", reason: "hook-advisory-failed" };
      break;
    }
    case "observe": {
      base = { effect: "proceed", warning: "hook-observer-failed", reason: "hook-observer-failed" };
      break;
    }
    case "context": {
      base = { effect: "proceed", warning: "hook-context-failed", reason: "hook-context-failed" };
      break;
    }
  }

  if (input.event === "SessionStart") {
    return { effect: "proceed", warning: base.reason, reason: base.reason };
  }
  return base;
}
