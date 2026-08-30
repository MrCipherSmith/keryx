// Adaptive model selection for gdskills dispatches (flow 204, T19-T21;
// docs/requirements/keryx-orchestrator-hardening/specification.md §4).
//
// WHY IT LIVES HERE
//
// `src/harness/child/model.ts` already resolves a `{ kind: "tier" }` request
// through an INJECTED `tiers: Record<string, ModelSelection>` map and applies the
// three fail-closed authorization gates. It never says where that map comes from,
// and today nothing builds one — which is why `model.tier` is carried by the
// dispatch contract and applied in exactly one narrow case.
//
// This module is that missing producer, and it sits next to the thing that
// declares tiers (`bundled/skills/**/SKILL.md`) and the thing that carries them
// (`contracts/subagent-dispatch.schema.json`), not next to the thing that gates
// them. Composition, not duplication: `buildTierMap` hands `resolveChildModel`
// the map it already knows how to consume, so the gates stay in one place.
//
// FOUR THINGS, DELIBERATELY SEPARATE
//
//   1. `assignTier`           — signals the orchestrator already holds -> a tier.
//                               Pure, total, and auditable: it returns the ordered
//                               rule ids that produced the answer, so a run can be
//                               explained after the fact. No model is ever asked
//                               to rate its own difficulty (AC16).
//   2. `rankDiscoveredModels` — the models runtime detection actually reported for
//                               the session's provider -> an ordering, or an
//                               explicit refusal to order them.
//   3. `resolveTierModel`     — tier + ordering -> a concrete model.
//   4. `buildTierMap`         — the same resolution, shaped for the existing gated
//                               resolver.
//
// NO TABLE OF MODELS. This module does not know, and must not know, which models
// exist. `src/commands/select.ts` already detects providers at runtime and every
// `DetectedProvider` carries `models: string[]`; that list — passed in, never
// looked up here — is the entire candidate set. A literal table of model ids is
// stale the day a provider ships anything, and the previous version of this file
// proved it: it named a `deep` model that appears nowhere else in this repository.
//
// WHAT COULD NOT BE ELIMINATED, STATED PLAINLY
//
// Capability cannot be derived from a bare string. `MODEL_RANK_HINTS` below is the
// residue: a small, individually-annotated list of SIZE WORDS (`mini`, `haiku`,
// `opus`, `pro`, …) applied to whatever the environment reports. It is knowledge,
// and it is admitted as knowledge — but it is a different kind from a table of
// models. A hint asserts nothing about what exists; it only orders what was found,
// and a candidate set it cannot order produces a fallback rather than a guess.
//
// THE FALLBACK IS THE POINT
//
// When the candidates cannot be ordered — nothing detected, the session's provider
// absent from the catalogue, or the session's own model unrankable — every tier
// takes the SESSION's provider and model. Not a failure, and — the part that
// matters — not a downgrade. Degrading capability because discovery failed is the
// worst of the three outcomes, so an unrankable environment is never resolved to
// "the cheap one by default". `buildTierMap` therefore always returns an entry for
// every tier, which is what keeps `resolveChildModel`'s `unknown model tier`
// denial unreachable (AC15).
//
// Everything is anchored on the session model: `standard` IS the session model,
// `deep` is a discovered model ranked strictly above it, `light` one ranked
// strictly below. That anchoring is what makes "never a downgrade" checkable
// rather than hoped for — a tier can only move away from the session model in the
// direction its own name points.
//
// Pure throughout: no clock, no RNG, no network, no fs. Identical inputs yield
// deep-equal output — the discovered catalogue is an argument, so a test injects
// candidates instead of probing a machine.

/** The three tiers a skill may declare. Ascending capability. */
export const MODEL_TIERS = ["light", "standard", "deep"] as const;

/** A tier a skill declares and a dispatch carries. Never a model name. */
export type ModelTier = (typeof MODEL_TIERS)[number];

/** The tier a dispatch gets when nothing raises or lowers it. */
export const DEFAULT_MODEL_TIER: ModelTier = "standard";

/**
 * Accepted spellings that are not the canonical three.
 *
 * `cheap` is not a synonym invented here: it is the vocabulary frozen into
 * `docs/requirements/keryx-multi-agent-engine/schemas/child-model-selection.schema.json`
 * (`"tier": { "enum": ["cheap", "standard", "deep"] }`) and used by the escalation
 * ladder in `src/harness/child/escalation.ts`. That schema is frozen and this
 * package's AC14 names `light`, so both spellings have to resolve. Reading the
 * older one rather than rejecting it costs one map entry; refusing it would fail
 * dispatches that predate this flow.
 */
const TIER_ALIASES: Readonly<Record<string, ModelTier>> = { cheap: "light" };

/** True when `value` is one of the three canonical tiers. */
export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

/**
 * Normalise a declared tier string. Case- and whitespace-insensitive, accepts the
 * aliases above, and returns `undefined` for anything else — including a model
 * name, which is the whole point: a skill that writes `tier: claude-opus-5` gets
 * `undefined` and falls through to session inheritance rather than to a guess.
 */
export function parseModelTier(raw: string | undefined | null): ModelTier | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase();
  if (isModelTier(key)) return key;
  return TIER_ALIASES[key];
}

// ---------------------------------------------------------------------------
// Discovery: the candidate set comes from the environment, never from here.
// ---------------------------------------------------------------------------

/**
 * One provider as runtime detection reported it.
 *
 * A structural subset of `DetectedProvider` (src/commands/select.ts), so the
 * result of `detectProviders()` is passed in verbatim. Declared structurally
 * rather than imported so this module keeps no dependency on the command layer
 * and stays trivially injectable from a test.
 */
export interface DiscoveredProvider {
  readonly name: string;
  readonly models: readonly string[];
}

/** The active session's provider/model, as the orchestrator already knows it. */
export interface SessionModelContext {
  /** Provider id the main agent is running on. */
  readonly providerId: string;
  /** Model id the main agent is running on. */
  readonly modelId: string;
}

// ---------------------------------------------------------------------------
// The irreducible knowledge, kept as small and as removable as it can be made.
// ---------------------------------------------------------------------------

/**
 * One hint that a model id contains a word naming its SIZE.
 *
 * This is the part that could not be derived. `haiku` is smaller than `opus` and
 * no property of the two strings says so; something has to know it. What matters
 * is the shape of the knowledge:
 *
 *   - it names WORDS, never models, so it makes no claim about which models exist
 *     and cannot go stale when a provider ships a new one;
 *   - it is applied to whatever runtime detection reported, so a vendor this list
 *     has never heard of still gets ranked if its names use these words;
 *   - it is a hint, not an authority: a candidate set in which it discriminates
 *     nothing produces a FALLBACK, not a guess;
 *   - and it is one array, overridable per call, so an operator who disagrees
 *     replaces it without touching the algorithm.
 *
 * Weights are ordinal only. Their absolute values mean nothing; only `<` and `>`
 * between two candidates are ever read.
 */
export interface ModelRankHint {
  /** Case-insensitive regex source, tested against the model id. */
  readonly pattern: string;
  /** Higher is more capable. Ordinal; only comparisons are used. */
  readonly weight: number;
  /** Why this word, for whoever edits it next. */
  readonly note: string;
}

/**
 * Size words, and nothing else. Deliberately short — every entry is a thing this
 * module claims to know, so the list is kept to words that vendors use as size
 * markers across product lines rather than to any one vendor's lineup.
 *
 * Words this list does NOT contain are the honest part. Codenames that carry no
 * size (`terra`, `sol`, `luna`, `fable`, …) are unrankable by construction: a
 * codename says nothing about capability, so a session running on one falls back
 * to itself rather than being ordered by folklore. The previous version of this
 * file ordered exactly such codenames from a single conversation, and named one
 * that exists nowhere in this repository.
 */
export const MODEL_RANK_HINTS: readonly ModelRankHint[] = [
  { pattern: "\\bnano\\b", weight: -2, note: "vendor-neutral smallest-tier marker" },
  { pattern: "\\btiny\\b", weight: -2, note: "vendor-neutral smallest-tier marker" },
  { pattern: "\\bmini\\b", weight: -1, note: "vendor-neutral small-tier marker" },
  { pattern: "\\blite\\b", weight: -1, note: "vendor-neutral small-tier marker" },
  { pattern: "\\bsmall\\b", weight: -1, note: "vendor-neutral small-tier marker" },
  { pattern: "\\bflash\\b", weight: -1, note: "Gemini's small tier; also used elsewhere for latency-first models" },
  { pattern: "\\bhaiku\\b", weight: -1, note: "Anthropic's small tier" },
  { pattern: "\\binstant\\b", weight: -1, note: "latency-first marker" },
  { pattern: "\\bair\\b", weight: -1, note: "Z.AI GLM's small tier" },
  { pattern: "\\bsonnet\\b", weight: 0, note: "Anthropic's middle tier — ranked, and ranked as middling" },
  { pattern: "\\bmedium\\b", weight: 0, note: "vendor-neutral middle-tier marker" },
  { pattern: "\\bopus\\b", weight: 1, note: "Anthropic's large tier" },
  { pattern: "\\bpro\\b", weight: 1, note: "vendor-neutral large-tier marker" },
  { pattern: "\\blarge\\b", weight: 1, note: "vendor-neutral large-tier marker" },
  { pattern: "\\bmax\\b", weight: 1, note: "vendor-neutral large-tier marker" },
  { pattern: "\\bultra\\b", weight: 2, note: "vendor-neutral largest-tier marker" },
];

/**
 * The ordinal rank of a model id, or `undefined` when no hint applies.
 *
 * `undefined` is load-bearing and is NOT the same as `0`: a model matching no hint
 * is UNRANKED (we cannot place it), while one matching a zero-weight hint is
 * ranked and ranked in the middle. Collapsing the two would let an unknown model
 * be silently ordered against a known one.
 *
 * Weights are summed, so an id carrying two size words in opposite directions
 * (`…-mini-pro`) lands between them — which is the honest reading of an ambiguous
 * name. A malformed pattern is skipped rather than thrown: a bad hint must degrade
 * to "less is known", never to a crashed dispatch.
 */
export function rankModelId(
  modelId: string,
  hints: readonly ModelRankHint[] = MODEL_RANK_HINTS,
): number | undefined {
  const id = modelId.trim();
  if (id.length === 0) return undefined;
  let total = 0;
  let matched = false;
  for (const hint of hints) {
    let re: RegExp;
    try {
      re = new RegExp(hint.pattern, "i");
    } catch {
      continue;
    }
    if (re.test(id)) {
      total += hint.weight;
      matched = true;
    }
  }
  return matched ? total : undefined;
}

// ---------------------------------------------------------------------------
// Ranking: discovered candidates, ordered — or an explicit refusal to order them.
// ---------------------------------------------------------------------------

/** A discovered model that the hints could place. */
export interface RankedModel {
  readonly modelId: string;
  readonly rank: number;
}

/**
 * What discovery and ranking produced for one session. Recorded on the dispatch,
 * because "we assigned a model" and "we could not, so we kept our own" are
 * different facts and a finished run has to be able to tell them apart.
 */
export interface ModelRanking {
  /** The provider whose catalogue was consulted — always the session's. */
  readonly providerId: string;
  /** Every model discovered for that provider, in the order detection reported it. */
  readonly candidates: readonly string[];
  /** The subset the hints could place, best first. Ties keep discovery order. */
  readonly ranked: readonly RankedModel[];
  /** The session model's own rank, or `null` when the hints cannot place it. */
  readonly sessionRank: number | null;
  /** True when tiers may be resolved from `ranked`. */
  readonly usable: boolean;
  /** Why ranking was refused, or `null` when it was not. */
  readonly fallbackReason: string | null;
}

/** Case/whitespace-normalised id, for comparing a session model to a catalogue entry. */
function normaliseModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * Rank the models runtime detection reported for the session's provider.
 *
 * The catalogue is an argument and defaults to EMPTY: a caller that discovers
 * nothing gets a refusal, which resolves to the session model, which is the
 * instruction. Nothing here reads the network, the filesystem or the environment.
 *
 * Ranking is refused — `usable: false`, with the reason recorded — when:
 *
 *   - the session names no model (nothing to anchor on);
 *   - no discovered provider matches the session's provider id (an external CLI
 *     runtime, or detection that has not run);
 *   - the provider reported no usable models;
 *   - the hints cannot place the SESSION's own model. This is the subtle one and
 *     the reason the whole design is anchored: if we do not know where the session
 *     model sits, we cannot say any candidate is above or below it, and `light`
 *     picking something that is in fact larger — or `deep` something smaller — is
 *     exactly the failure the fallback exists to prevent.
 */
export function rankDiscoveredModels(
  session: SessionModelContext,
  catalog: readonly DiscoveredProvider[] = [],
  hints: readonly ModelRankHint[] = MODEL_RANK_HINTS,
): ModelRanking {
  const providerId = session.providerId;
  const refuse = (
    candidates: readonly string[],
    ranked: readonly RankedModel[],
    sessionRank: number | null,
    fallbackReason: string,
  ): ModelRanking => ({ providerId, candidates, ranked, sessionRank, usable: false, fallbackReason });

  const sessionModel = session.modelId.trim();
  if (sessionModel.length === 0) {
    return refuse([], [], null, "the session names no model to anchor the ranking on");
  }

  const wanted = normaliseModelId(providerId);
  const provider =
    wanted.length === 0 ? undefined : catalog.find((p) => normaliseModelId(p.name) === wanted);
  if (provider === undefined) {
    return refuse(
      [],
      [],
      null,
      `no discovered provider matches the session provider "${providerId}"`,
    );
  }

  // De-duplicate while keeping discovery order: the order is not a capability
  // claim, but it IS the only deterministic tiebreak available, so it must be
  // stable.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of provider.models) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (id.length === 0) continue;
    const key = normaliseModelId(id);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(id);
  }
  if (candidates.length === 0) {
    return refuse([], [], null, `provider "${providerId}" reported no models`);
  }

  const ranked: RankedModel[] = [];
  for (const modelId of candidates) {
    const rank = rankModelId(modelId, hints);
    if (rank !== undefined) ranked.push({ modelId, rank });
  }
  // Stable by construction: `candidates` order is preserved inside equal ranks.
  ranked.sort((a, b) => b.rank - a.rank);

  const sessionRank = rankModelId(sessionModel, hints);
  if (sessionRank === undefined) {
    return refuse(
      candidates,
      ranked,
      null,
      `the session model "${sessionModel}" carries no size marker the hints recognise, so no candidate can be called larger or smaller than it`,
    );
  }

  return {
    providerId,
    candidates,
    ranked,
    sessionRank,
    usable: true,
    fallbackReason: null,
  };
}

/**
 * Where a resolved model came from. Recorded on the dispatch — the three values
 * are three genuinely different facts, and flattening them would hide the one
 * that matters.
 *
 *   - `discovered`       — a model reported by runtime detection was assigned.
 *   - `session-ranked`   — ranking WORKED and put this tier at the session's own
 *                          model: `standard` always, and `light`/`deep` when
 *                          nothing discovered sits below/above the session.
 *   - `session-fallback` — ranking was refused; the session model is used because
 *                          nothing could be worked out.
 */
export type TierResolutionSource = "discovered" | "session-ranked" | "session-fallback";

/** A tier resolved against a session: a concrete model plus its provenance. */
export interface TierResolution {
  readonly tier: ModelTier;
  readonly providerId: string;
  readonly modelId: string;
  readonly source: TierResolutionSource;
  /** One sentence, for the dispatch record. */
  readonly reason: string;
  /** What discovery and ranking produced, so the sentence above can be checked. */
  readonly ranking: ModelRanking;
}

/**
 * Resolve a tier against an ALREADY-COMPUTED ranking.
 *
 * Split out so `buildTierMap` ranks once for all three tiers and so the tier ->
 * model step is testable without a catalogue. Total: every input returns a usable
 * selection, and the provider is ALWAYS the session's — candidates come from the
 * session provider's own catalogue, so a resolved selection is one
 * `resolveChildModel` gate G1 already admits.
 */
export function resolveTierFromRanking(
  session: SessionModelContext,
  tier: ModelTier | string | undefined,
  ranking: ModelRanking,
): TierResolution {
  const parsed = parseModelTier(typeof tier === "string" ? tier : undefined);
  const session_ = (
    resolvedTier: ModelTier,
    source: TierResolutionSource,
    reason: string,
  ): TierResolution => ({
    tier: resolvedTier,
    providerId: session.providerId,
    modelId: session.modelId,
    source,
    reason,
    ranking,
  });

  if (parsed === undefined) {
    return session_(
      DEFAULT_MODEL_TIER,
      "session-fallback",
      `tier ${JSON.stringify(tier ?? null)} is not one of ${MODEL_TIERS.join("/")}; keeping the session model`,
    );
  }

  if (!ranking.usable) {
    return session_(
      parsed,
      "session-fallback",
      `discovered models could not be ranked (${ranking.fallbackReason ?? "no reason recorded"}); keeping the session model for tier ${parsed}`,
    );
  }

  if (parsed === "standard") {
    return session_(
      parsed,
      "session-ranked",
      `standard is the session's own model "${session.modelId}" (rank ${ranking.sessionRank})`,
    );
  }

  const anchor = ranking.sessionRank ?? 0;
  // `ranked` is best-first, so the first strictly-above entry is the most capable
  // and the last strictly-below entry is the least. Strictly: a candidate at the
  // session's own rank is a lateral move, never a tier.
  const pick =
    parsed === "deep"
      ? ranking.ranked.find((m) => m.rank > anchor)
      : [...ranking.ranked].reverse().find((m) => m.rank < anchor);

  if (pick === undefined) {
    const direction = parsed === "deep" ? "above" : "below";
    return session_(
      parsed,
      "session-ranked",
      `no discovered model ranks ${direction} the session model "${session.modelId}" (rank ${anchor}); tier ${parsed} keeps it`,
    );
  }

  return {
    tier: parsed,
    providerId: session.providerId,
    modelId: pick.modelId,
    source: "discovered",
    reason: `tier ${parsed} took discovered model "${pick.modelId}" (rank ${pick.rank}) against the session model "${session.modelId}" (rank ${anchor})`,
    ranking,
  };
}

/**
 * Discover, rank and resolve one tier. The convenience form; prefer
 * {@link buildTierMap} when all three tiers are wanted.
 */
export function resolveTierModel(
  session: SessionModelContext,
  tier: ModelTier | string | undefined,
  catalog: readonly DiscoveredProvider[] = [],
  hints: readonly ModelRankHint[] = MODEL_RANK_HINTS,
): TierResolution {
  return resolveTierFromRanking(session, tier, rankDiscoveredModels(session, catalog, hints));
}

/** The shape `resolveChildModel` consumes for `{ kind: "tier" }` requests. */
export interface TierModelSelection {
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * Build the `tiers` map for `resolveChildModel`.
 *
 * Every canonical tier AND every alias gets an entry, unconditionally. That is the
 * mechanical form of AC15: `resolveChildModel` denies a tier it cannot find in
 * this map, so a map that is total for the known vocabulary cannot produce a
 * "provider we could not classify" dispatch failure.
 */
export function buildTierMap(
  session: SessionModelContext,
  catalog: readonly DiscoveredProvider[] = [],
  hints: readonly ModelRankHint[] = MODEL_RANK_HINTS,
): Record<string, TierModelSelection> {
  const ranking = rankDiscoveredModels(session, catalog, hints);
  const map: Record<string, TierModelSelection> = {};
  for (const tier of MODEL_TIERS) {
    const resolved = resolveTierFromRanking(session, tier, ranking);
    map[tier] = { providerId: resolved.providerId, modelId: resolved.modelId };
  }
  for (const [alias, tier] of Object.entries(TIER_ALIASES)) {
    const canonical = map[tier];
    if (canonical !== undefined) map[alias] = canonical;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tier assignment: deterministic, from signals the orchestrator already holds.
// ---------------------------------------------------------------------------

/**
 * The signals specification §4.4 names. Every one of them is something the
 * orchestrator has before it dispatches — the round's scope, its own attempt
 * counter, the diff it computed, the findings it is holding, the verification
 * method it is about to ask for. None of them is a model's self-report.
 *
 * All optional: a caller that knows nothing gets `standard`, which is the
 * documented default rather than a guess.
 */
export interface TierSignals {
  /** Round scope. `blast-radius` floors the tier at `deep`. */
  readonly scope?: string | undefined;
  /** 1-based attempt at the SAME finding. `>= 2` raises one tier. */
  readonly fixAttempt?: number | undefined;
  /** A strategy change forced by hitting the loop cap. */
  readonly forcedStrategyChange?: boolean | undefined;
  /** Findings in scope for this dispatch. */
  readonly findingCount?: number | undefined;
  /** Changed lines in the diff under review. */
  readonly diffLines?: number | undefined;
  /** `review-finding.schema.json` verification method for this dispatch. */
  readonly verifierMethod?: "execution" | "site-check" | "reasoning" | string | undefined;
  /**
   * Whether any finding in scope is a security finding. A boolean rather than a
   * severity, because `review-finding.schema.json` has no security severity —
   * `severity` is blocker/major/minor/info and the security dimension lives in the
   * reviewer (`review-security-code`). The caller derives it; this stays pure.
   */
  readonly hasSecurityFinding?: boolean | undefined;
}

/** A tier plus the ordered rule ids that produced it. */
export interface TierAssignment {
  readonly tier: ModelTier;
  /**
   * Ordered, stable rule ids — the audit trail recorded on the dispatch
   * (`model.tier_reasons`). Ids, not prose: they are compared in tests and read
   * back from old runs, so they must not drift with wording.
   */
  readonly reasons: readonly string[];
}

/** Findings at or below this count may take `light`, given a small enough diff. */
export const LIGHT_MAX_FINDINGS = 3;
/** Diff size at or below which `light` is allowed, given few enough findings. */
export const LIGHT_MAX_DIFF_LINES = 50;

const TIER_RANK: Readonly<Record<ModelTier, number>> = { light: 0, standard: 1, deep: 2 };

function atLeast(tier: ModelTier, floor: ModelTier): ModelTier {
  return TIER_RANK[tier] >= TIER_RANK[floor] ? tier : floor;
}

function raiseOne(tier: ModelTier): ModelTier {
  const next = MODEL_TIERS[TIER_RANK[tier] + 1];
  return next ?? tier;
}

/**
 * Assign a tier from the signals. Pure, total and deterministic — the same
 * signals always produce the same tier and the same reason list.
 *
 * Rules run in a fixed order, and the order is the substance:
 *
 *   1. base `standard`
 *   2. downgrades to `light`, which are PERMISSIONS ("allow light"), not commands
 *   3. floors — `blast-radius` and a forced strategy change raise to `deep` and
 *      therefore beat any downgrade above them
 *   4. a repeated fix attempt raises one tier
 *   5. the security floor, applied last, so nothing below it can slip through
 *
 * Floors after downgrades is what makes "at least `deep`" mean at least: a
 * blast-radius round over a 12-line diff is still a blast-radius round.
 */
export function assignTier(signals: TierSignals): TierAssignment {
  const reasons: string[] = ["base:standard"];
  let tier: ModelTier = DEFAULT_MODEL_TIER;

  // 2 - allow light. Execution and site-check verification both take their answer
  // from something that ran, not from reasoning about the code.
  const method = signals.verifierMethod;
  if (method === "execution" || method === "site-check") {
    tier = "light";
    reasons.push(`light:verifier-${method}`);
  } else if (
    typeof signals.findingCount === "number" &&
    signals.findingCount <= LIGHT_MAX_FINDINGS &&
    typeof signals.diffLines === "number" &&
    signals.diffLines <= LIGHT_MAX_DIFF_LINES
  ) {
    tier = "light";
    reasons.push("light:small-scope");
  }

  // 3 - floors.
  if (signals.scope === "blast-radius") {
    tier = atLeast(tier, "deep");
    reasons.push("floor:blast-radius");
  }
  if (signals.forcedStrategyChange === true) {
    tier = atLeast(tier, "deep");
    reasons.push("floor:forced-strategy-change");
  }

  // 4 - repeated attempt at the same finding.
  if (typeof signals.fixAttempt === "number" && signals.fixAttempt >= 2) {
    const raised = raiseOne(tier);
    if (raised !== tier) {
      tier = raised;
      reasons.push("raise:fix-attempt");
    } else {
      reasons.push("raise:fix-attempt-capped");
    }
  }

  // 5 - security never runs below standard.
  if (signals.hasSecurityFinding === true) {
    tier = atLeast(tier, "standard");
    reasons.push("floor:security");
  }

  return { tier, reasons };
}

/**
 * The `model` block a dispatch carries once a tier has been assigned and
 * resolved: the tier, the audit trail that produced it, and the resolution that
 * followed. Matches the `model` object in
 * `contracts/subagent-dispatch.schema.json`.
 */
export interface DispatchModelDecision {
  readonly tier: ModelTier;
  readonly tier_reasons: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly tier_resolution: TierResolutionSource;
  /**
   * What was discovered and how it was ordered. Without this, `tier_resolution`
   * says a fallback happened and never says what was on the table when it did —
   * which is the difference between a run that can be explained and one that can
   * only be re-guessed.
   */
  readonly model_discovery: {
    readonly provider: string;
    readonly candidates: readonly string[];
    readonly ranked: readonly { readonly model: string; readonly rank: number }[];
    readonly session_rank: number | null;
    readonly fallback_reason: string | null;
  };
}

/**
 * Assign, resolve, and produce the schema-shaped record in one call — the seam an
 * orchestrator uses. Separate from `assignTier`/`resolveTierModel` so both halves
 * stay independently testable, and so the recorded shape has exactly one writer.
 */
export function decideDispatchModel(
  session: SessionModelContext,
  signals: TierSignals,
  catalog: readonly DiscoveredProvider[] = [],
  hints: readonly ModelRankHint[] = MODEL_RANK_HINTS,
): DispatchModelDecision {
  const assignment = assignTier(signals);
  const resolved = resolveTierModel(session, assignment.tier, catalog, hints);
  const { ranking } = resolved;
  return {
    tier: assignment.tier,
    tier_reasons: assignment.reasons,
    provider: resolved.providerId,
    model: resolved.modelId,
    tier_resolution: resolved.source,
    model_discovery: {
      provider: ranking.providerId,
      candidates: ranking.candidates,
      ranked: ranking.ranked.map((m) => ({ model: m.modelId, rank: m.rank })),
      session_rank: ranking.sessionRank,
      fallback_reason: ranking.fallbackReason,
    },
  };
}

// ---------------------------------------------------------------------------
// Skill declarations.
// ---------------------------------------------------------------------------

/** Frontmatter key a SKILL.md uses to declare its tier. */
export const SKILL_TIER_KEY = "model_tier";

/** Extract the YAML frontmatter block of a SKILL.md, or `undefined`. */
function frontmatterOf(markdown: string): string | undefined {
  if (!markdown.startsWith("---")) return undefined;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return undefined;
  return markdown.slice(3, end);
}

/**
 * Read a skill's declared tier from its frontmatter. `undefined` when absent or
 * unrecognised — an undeclared skill runs on the session model, which is the same
 * safe default as an unknown provider.
 */
export function parseSkillModelTier(markdown: string): ModelTier | undefined {
  const block = frontmatterOf(markdown);
  if (block === undefined) return undefined;
  const match = new RegExp(`^${SKILL_TIER_KEY}:\\s*(.+)$`, "m").exec(block);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  return parseModelTier(raw.trim().replace(/^["']|["'],?$/g, ""));
}

/**
 * Values that name nothing concrete, and so are not a model name: a tier, a
 * placeholder, an explicit inherit, an interpolation.
 */
const NON_CONCRETE_MODEL_VALUE = /^(?:null|~|inherit|session|default|auto|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\})$/i;

/**
 * A key that DECLARES a model, anywhere in a skill file — frontmatter, a dispatch
 * JSON block, an example. Deliberately narrow: it matches an assignment, not a
 * mention. Prose that names a model while explaining something ("… so
 * `review-logic (sonnet)` parses") is not a declaration, and a guard that could
 * not tell the two apart would be routed around on its first false positive.
 */
const MODEL_DECLARATION = /^\s*(?:[-*]\s*)?"?(model|model_id|model-id|model_name|modelId)"?\s*[:=]\s*(.+?)\s*,?\s*$/i;

/** A `model_tier` assignment, checked for a tier rather than a model name. */
const TIER_DECLARATION = new RegExp(`^\\s*(?:[-*]\\s*)?"?(?:${SKILL_TIER_KEY}|model-tier|modelTier)"?\\s*[:=]\\s*(.+?)\\s*,?\\s*$`, "i");

function unquote(value: string): string {
  return value.trim().replace(/^["'`]|["'`]$/g, "").trim();
}

/**
 * Every place `markdown` declares a concrete model instead of a tier, as
 * `<line-number>: <line>` strings. Empty means the file is compliant.
 *
 * This is the executable half of AC14. It is exported rather than inlined into
 * the guard test so the rule has ONE definition: the same predicate that fails the
 * build is available to anything that wants to check a skill before shipping it.
 */
export function concreteModelDeclarations(markdown: string): string[] {
  const offenders: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    const tierMatch = TIER_DECLARATION.exec(line);
    if (tierMatch?.[1] !== undefined) {
      const value = unquote(tierMatch[1]);
      if (parseModelTier(value) === undefined) {
        offenders.push(`${i + 1}: ${line.trim()} (not one of ${MODEL_TIERS.join("/")})`);
      }
      continue;
    }

    const modelMatch = MODEL_DECLARATION.exec(line);
    if (modelMatch?.[2] === undefined) continue;
    const value = unquote(modelMatch[2]);
    if (value.length === 0) continue;
    // A model id is a single token. A sentence after `Model:` is guidance, not a
    // declaration — `- Model: prefer a cheaper model if one is available` names
    // nothing and would make this guard a nuisance rather than a rule.
    if (/\s/.test(value)) continue;
    if (NON_CONCRETE_MODEL_VALUE.test(value)) continue;
    if (isModelTier(value.toLowerCase())) continue;
    offenders.push(`${i + 1}: ${line.trim()} (declares a model; declare ${SKILL_TIER_KEY} instead)`);
  }
  return offenders;
}
