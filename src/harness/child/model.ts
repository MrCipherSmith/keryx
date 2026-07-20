// Fail-closed child model/provider resolution (flow 088, multi-agent engine
// Phase 1). The fourth harness inheritance resolver, a sibling of
// `inheritBudget`/`inheritPolicy` in `./isolation`.
//
// Unlike budget/policy — which are subset/containment checks — a child selecting
// a sibling provider/model is a LATERAL choice, not an escalation, so this is not
// a containment check. The terminal fallback is inherit-the-parent (the common
// case). Provider *authorization* is still fail-closed via three gates applied to
// the resolved candidate:
//   - G1 allowlist        — candidate provider must be in the parent's already-
//                           detected (credentialed) allowlist, else DENY.
//   - G2 trust/network    — a network-class provider is DENIED when the child's
//                           policy forbids network (read-only trust, or a
//                           `defaults.network` other than `allow`).
//   - G3 classifiable     — an unclassifiable provider is DENIED (never construct
//                           a provider the harness cannot reason about).
//
// Resolution order (first match wins): env override -> explicit -> tier ->
// inherit(parent). Pure and deterministic: no clock/RNG/network/fs; identical
// inputs yield deep-equal output. All non-determinism (credential detection, env
// reading, tier config) is injected via `deps`.
import { OPENAI_COMPAT_PROVIDERS, providerByName } from "../../commands/providers";
import type { PolicyProfile } from "../policy/types";

/** A concrete model/provider selection for a child attempt. */
export interface ModelSelection {
  providerId: string;
  modelId: string;
}

/** The parent orchestrator's active selection a child inherits or overrides against. */
export interface ParentModelContext {
  providerId: string;
  modelId: string;
}

/**
 * What the orchestrator asks for on a dispatch. `inherit` (or an omitted request)
 * reuses the parent verbatim; `explicit` names a provider/model directly; `tier`
 * resolves through the configured deterministic tier map.
 */
export type ChildModelRequest =
  | { kind: "inherit" }
  | { kind: "explicit"; providerId: string; modelId: string }
  | { kind: "tier"; tier: string };

/** Provider classes the network gate reasons about. */
export type ProviderClass = "local" | "network" | "unknown";

/** Injected, deterministic inputs for {@link resolveChildModel}. */
export interface ResolveChildModelDeps {
  /**
   * The parent's already-detected, credentialed provider set. A child can never
   * resolve to a provider the parent has no grant for (G1).
   */
  allowedProviders: ReadonlySet<string>;
  /** Deterministic tier -> selection map (e.g. cheap/standard/deep). */
  tiers?: Record<string, ModelSelection>;
  /**
   * Parsed `KERYX_SUBAGENT_MODEL` override, or undefined when unset / `inherit`
   * (see {@link parseEnvModel}). When present it wins over every other rung.
   */
  envOverride?: ModelSelection;
  /** The child's already-resolved policy profile (drives the G2 network gate). */
  policy: PolicyProfile;
  /** Classifier used by the G2/G3 gates. Injected for testability. */
  providerClass: (id: string) => ProviderClass;
}

/** Result of {@link resolveChildModel}: a gated selection or a fail-closed denial. */
export type ResolveChildModelResult =
  | { ok: true; selection: ModelSelection; source: "env" | "explicit" | "tier" | "inherited" }
  | { ok: false; reason: string };

/**
 * Classify a provider id for the model gates. `ollama` is loopback-local;
 * `anthropic` and every registered OpenAI-compatible provider are network-class;
 * anything else is `unknown` (and thus denied on the orchestrated child path).
 * Pure — derived from the static provider registry.
 */
export function providerClass(id: string): ProviderClass {
  if (id === "ollama") return "local";
  if (id === "anthropic") return "network";
  if (providerByName(id) !== undefined) return "network";
  return "unknown";
}

/** The full set of provider ids {@link providerClass} classifies as non-`unknown`. */
export const KNOWN_PROVIDER_IDS: ReadonlySet<string> = new Set<string>([
  "anthropic",
  "ollama",
  ...OPENAI_COMPAT_PROVIDERS.map((p) => p.name),
]);

/**
 * Parse a `KERYX_SUBAGENT_MODEL` value into a {@link ModelSelection}. Returns
 * `undefined` for an unset/empty value OR the literal `inherit` (AC4: env
 * `inherit` is treated as unset, so resolution falls through to
 * explicit -> tier -> inherit). The expected form is `"<provider>/<model>"`;
 * the provider is the first `/`-delimited segment and the model is the remainder
 * (so model ids that themselves contain `/`, e.g. `openai/gpt-4o-mini`, survive).
 * A value without a `/`, or with an empty provider/model half, is `undefined`
 * (fail-closed: an unparseable override never silently becomes a partial
 * selection). Pure.
 */
export function parseEnvModel(raw: string | undefined): ModelSelection | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "inherit") return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  const providerId = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (providerId.length === 0 || modelId.length === 0) return undefined;
  return { providerId, modelId };
}

/** The optional `model` block on a canonical `subagent-dispatch` object. */
export interface DispatchModelBlock {
  provider?: string;
  model?: string;
  tier?: string;
  inherit?: boolean;
}

/**
 * Map the declarative `subagent-dispatch` `model` block onto a
 * {@link ChildModelRequest} for {@link resolveChildModel}. An omitted block, an
 * explicit `inherit: true`, or an under-specified block (e.g. `provider` without
 * `model`) all mean inherit — the fail-safe default. A complete `provider`+`model`
 * pair is `explicit`; otherwise a non-empty `tier` is used. Pure.
 */
export function parseDispatchModel(block: DispatchModelBlock | undefined): ChildModelRequest | undefined {
  if (block === undefined) return undefined;
  if (block.inherit === true) return { kind: "inherit" };
  if (
    block.provider !== undefined &&
    block.provider.length > 0 &&
    block.model !== undefined &&
    block.model.length > 0
  ) {
    return { kind: "explicit", providerId: block.provider, modelId: block.model };
  }
  if (block.tier !== undefined && block.tier.length > 0) {
    return { kind: "tier", tier: block.tier };
  }
  return { kind: "inherit" };
}

/**
 * Resolve a child's model/provider, explicitly or by inheriting the parent, then
 * apply the three fail-closed authorization gates. See the module header for the
 * full contract. Pure and deterministic.
 */
export function resolveChildModel(
  parent: ParentModelContext,
  request: ChildModelRequest | undefined,
  deps: ResolveChildModelDeps,
): ResolveChildModelResult {
  // --- Resolution order: env -> explicit -> tier -> inherit. ---------------
  let candidate: ModelSelection;
  let source: "env" | "explicit" | "tier" | "inherited";

  if (deps.envOverride !== undefined) {
    candidate = { providerId: deps.envOverride.providerId, modelId: deps.envOverride.modelId };
    source = "env";
  } else if (request !== undefined && request.kind === "explicit") {
    candidate = { providerId: request.providerId, modelId: request.modelId };
    source = "explicit";
  } else if (request !== undefined && request.kind === "tier") {
    const tier = deps.tiers?.[request.tier];
    if (tier === undefined) {
      return { ok: false, reason: `unknown model tier "${request.tier}"` };
    }
    candidate = { providerId: tier.providerId, modelId: tier.modelId };
    source = "tier";
  } else {
    // Omitted request or `{ kind: "inherit" }`.
    candidate = { providerId: parent.providerId, modelId: parent.modelId };
    source = "inherited";
  }

  // --- Gates (applied to EVERY candidate, including the inherited one). -----
  // G1 — allowlist.
  if (!deps.allowedProviders.has(candidate.providerId)) {
    return {
      ok: false,
      reason: `provider "${candidate.providerId}" is not in the parent allowlist`,
    };
  }

  const cls = deps.providerClass(candidate.providerId);

  // G3 — classifiable (checked before the network gate so `unknown` never
  // reaches it).
  if (cls === "unknown") {
    return { ok: false, reason: `provider "${candidate.providerId}" is not classifiable` };
  }

  // G2 — trust/network. A network-class provider requires a policy that permits
  // network: not a read-only trust posture, and a `defaults.network` of `allow`
  // (an `ask`/`deny` default cannot be satisfied by an unattended child).
  if (cls === "network") {
    const networkForbidden =
      deps.policy.trustMode === "read-only" || deps.policy.defaults.network !== "allow";
    if (networkForbidden) {
      return {
        ok: false,
        reason: `network provider "${candidate.providerId}" is forbidden by child policy (trustMode "${deps.policy.trustMode}", network "${deps.policy.defaults.network}")`,
      };
    }
  }

  return { ok: true, selection: candidate, source };
}
