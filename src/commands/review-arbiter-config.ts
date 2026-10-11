// `review.arbiter` in `.metaproject/tasks.config.json`, and the model the arbiter runs on.
//
// The model is declared as a TIER, never a model id by default: the arbiter is a unit of unattended work, so it
// runs one step below the session's flagship (the `light` tier). An explicit `model` pin is accepted for an
// operator who wants one, and the GPT-6 Astra model is refused by name wherever it would come from: a pin, a tier
// resolution that lands on it, or a session that is already running on it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { ANTHROPIC_MODELS, GEMINI_MODELS, OPENAI_MODELS } from "./curated-model-lists";
import { providerByName } from "./providers";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/service";
import { isDeniedModel } from "../gdskills/model-denylist";
import {
  buildTierMap,
  TIER_RANK_HINTS,
  type DiscoveredProvider,
  type ModelRankHint,
  type SessionModelContext,
} from "../gdskills/model-tier";
import { loadRankHints } from "../harness/routing/model-profile";

/** The tiers the arbiter may run on: the one below the flagship, or the session's own. `deep` is the flagship side and is refused. */
export const ARBITER_TIERS = ["light", "standard"] as const;
export type ArbiterTier = (typeof ARBITER_TIERS)[number];

export const DEFAULT_ARBITER_TIER: ArbiterTier = "light";
export const DEFAULT_CALL_CAP = 20;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_CALL_CAP = 200;
export const MAX_TIMEOUT_MS = 120_000;

export interface ArbiterConfig {
  readonly enabled: boolean;
  readonly tier: ArbiterTier;
  /** An explicit `provider/model` pin; wins over the tier. */
  readonly model?: { readonly providerId: string; readonly modelId: string };
  readonly callCap: number;
  readonly timeoutMs: number;
  /** Problems found in the block. A non-empty list means the arbiter escalates every question, since its own settings cannot be trusted. */
  readonly errors: readonly string[];
}

function reviewArbiterBlock(cwd: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const review = (parsed as Record<string, unknown>)["review"];
    if (typeof review !== "object" || review === null) return undefined;
    return (review as Record<string, unknown>)["arbiter"];
  } catch {
    // no config file, or one that is not JSON: the defaults apply, as for every other review.* block
    return undefined;
  }
}

function splitModel(value: string): { providerId: string; modelId: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function parseArbiterConfig(raw: unknown): ArbiterConfig {
  const errors: string[] = [];
  const defaults: ArbiterConfig = { enabled: true, tier: DEFAULT_ARBITER_TIER, callCap: DEFAULT_CALL_CAP, timeoutMs: DEFAULT_TIMEOUT_MS, errors };
  if (raw === undefined) return defaults;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push("review.arbiter must be an object");
    return defaults;
  }
  const block = raw as Record<string, unknown>;
  let enabled = true;
  if (block["enabled"] !== undefined) {
    if (typeof block["enabled"] === "boolean") enabled = block["enabled"];
    else errors.push("review.arbiter.enabled must be true or false");
  }
  let tier: ArbiterTier = DEFAULT_ARBITER_TIER;
  if (block["tier"] !== undefined) {
    if (typeof block["tier"] === "string" && (ARBITER_TIERS as readonly string[]).includes(block["tier"])) tier = block["tier"] as ArbiterTier;
    else errors.push(`review.arbiter.tier must be one of ${ARBITER_TIERS.join(", ")}: a tier name, never a model id, and never the flagship tier`);
  }
  let model: ArbiterConfig["model"];
  if (block["model"] !== undefined) {
    const split = typeof block["model"] === "string" ? splitModel(block["model"]) : undefined;
    if (split === undefined) errors.push("review.arbiter.model must look like provider/model");
    else model = split;
  }
  let callCap = DEFAULT_CALL_CAP;
  if (block["callCap"] !== undefined) {
    const value = block["callCap"];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CALL_CAP) callCap = value;
    else errors.push(`review.arbiter.callCap must be a whole number from 1 to ${MAX_CALL_CAP}`);
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (block["timeoutMs"] !== undefined) {
    const value = block["timeoutMs"];
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= MAX_TIMEOUT_MS) timeoutMs = value;
    else errors.push(`review.arbiter.timeoutMs must be a whole number from 100 to ${MAX_TIMEOUT_MS}`);
  }
  return { enabled, tier, ...(model === undefined ? {} : { model }), callCap, timeoutMs, errors };
}

/** Reads the block; an absent file or block means the defaults, a malformed block means defaults plus `errors`. */
export function readArbiterConfig(cwd: string): ArbiterConfig {
  return parseArbiterConfig(reviewArbiterBlock(cwd));
}

export type ResolvedModel =
  | { readonly ok: true; readonly providerId: string; readonly modelId: string; readonly source: "pinned" | "tier" | "session-fallback" }
  | { readonly ok: false; readonly error: string };

export interface ResolveModelDeps {
  readonly catalog?: readonly DiscoveredProvider[];
  readonly hints?: readonly ModelRankHint[];
}

/** The models a provider is known to offer without asking it: the curated lists, a compat provider's own list, and the session model. */
export function offlineCatalog(session: SessionModelContext): readonly DiscoveredProvider[] {
  const curated: Record<string, readonly string[]> = {
    anthropic: ANTHROPIC_MODELS,
    openai: OPENAI_MODELS,
    gemini: GEMINI_MODELS,
  };
  const known = curated[session.providerId] ?? providerByName(session.providerId)?.models ?? [];
  const models = known.includes(session.modelId) ? [...known] : [...known, session.modelId];
  return [{ name: session.providerId, models }];
}

export function refuseDenied(modelId: string): string | undefined {
  return isDeniedModel(modelId)
    ? `the arbiter model "${modelId}" is refused by name: GPT-6 Astra is too expensive to run on the operator's behalf`
    : undefined;
}

/**
 * The model the arbiter calls. A pin wins; otherwise the configured tier is resolved against the session's own
 * provider. A tier that finds nothing smaller than the session model keeps the session model, and the log says so
 * (`session-fallback`). Astra is refused whichever way the model was reached.
 */
export function resolveArbiterModel(config: ArbiterConfig, session: SessionModelContext | undefined, deps: ResolveModelDeps = {}): ResolvedModel {
  if (config.model !== undefined) {
    const refused = refuseDenied(config.model.modelId);
    if (refused !== undefined) return { ok: false, error: refused };
    return { ok: true, providerId: config.model.providerId, modelId: config.model.modelId, source: "pinned" };
  }
  if (session === undefined) return { ok: false, error: "the session model is not known, so the arbiter tier cannot be resolved" };
  const sessionRefused = refuseDenied(session.modelId);
  const catalog = deps.catalog ?? offlineCatalog(session);
  const hints = deps.hints ?? safeHints(session.providerId);
  const picked = buildTierMap(session, catalog, hints)[config.tier];
  if (picked === undefined) return { ok: false, error: `the tier "${config.tier}" resolved to no model` };
  const refused = refuseDenied(picked.modelId) ?? (picked.modelId === session.modelId ? sessionRefused : undefined);
  if (refused !== undefined) return { ok: false, error: refused };
  return {
    ok: true,
    providerId: picked.providerId,
    modelId: picked.modelId,
    source: picked.modelId === session.modelId && config.tier !== "standard" ? "session-fallback" : "tier",
  };
}

function safeHints(providerId: string): readonly ModelRankHint[] {
  try {
    return loadRankHints(providerId);
  } catch {
    return TIER_RANK_HINTS;
  }
}
