// Adaptive model selection for gdskills dispatches (flow 204, T19-T21;
// docs/requirements/keryx-orchestrator-hardening/specification.md §4).
//
// WHY IT LIVES HERE
//
// `src/harness/child/model.ts` already resolves a `{ kind: "tier" }` request
// through an INJECTED `tiers: Record<string, ModelSelection>` map and applies the
// three fail-closed authorization gates. It never says where that map comes from.
//
// This module is that producer, and it sits next to the thing that declares tiers
// (`bundled/skills/**/SKILL.md`) and the thing that carries them
// (`contracts/subagent-dispatch.schema.json`), not next to the thing that gates
// them. Composition, not duplication: `buildTierMap` hands `resolveChildModel`
// the map it already knows how to consume, so the gates stay in one place.
//
// THE ONE WIRE, NAMED
//
// `createSpawnSubagentTool` (src/harness/tool/builtin/spawn-subagent-tool.ts) is
// the seam that closes the loop for every interactive dispatch: it calls
// `buildTierMap` with the session's provider/model and its host's detection
// result, puts the map on `SubagentConfig.tiers`, and turns the tool's optional
// `model_tier` input into the `{ kind: "tier" }` request. From there
// `spawnSubagent` -> `spawnChild` -> `resolveChildModel` applies the gates and
// the child runs on the resolved model. A tier is asked for only when that input
// is present; an omitted one inherits the parent, unchanged.
//
// That wire is what makes the rest of this file load-bearing rather than
// decorative, so it is pinned by a test that drives the REAL path
// (spawn-subagent-model-tier.test.ts) and asserts on the provider the tool
// actually constructed. A test over a hand-built `tiers` map cannot see a missing
// producer — it passes just as happily when nothing calls `buildTierMap` at all.
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
// denial unreachable for any dispatch that goes through the wire named above
// (AC15) — a caller that requests a tier while supplying no map is still denied,
// and should be.
//
// Everything is anchored on the session model: `standard` IS the session model,
// `deep` is a discovered model ranked strictly above it, `light` the NEXT size step
// below it. That anchoring is what makes "never a downgrade" checkable rather than
// hoped for — a tier can only move away from the session model in the direction its
// own name points.
//
// GENERATION (flow 358). Size words order size CLASSES; a version number orders
// GENERATIONS, and only within one family and vendor (`familyKey`, `./model-version`):
// a newer `sonnet` outranks an older `sonnet`, so `deep` for a session on the older
// one is the newer sibling, and an older sibling is never `light` or `deep`. A
// version is NEVER compared across families — `sonnet-5` is not "above" `opus-4-8`
// because 5 > 4.8. A larger class of an OLDER generation than the session is
// therefore AMBIGUOUS, not "above": with no agent the tier keeps the session model
// (`session-fallback`, reason id `kept-older-generation[-pricier]`), and with one
// the agent below is asked.
//
// `light` is the next size step down — an Opus session takes Sonnet, not Haiku;
// Haiku only when nothing sits between. There is no "smallest class" tier: that is
// what the routing table's `quick` category is for.
//
// THE AGENT FALLBACK (flow 358), an injected port. When the ranking is refused but
// the provider did report other models, or a tier is ambiguous as above, a
// `TierRankAgent` may be asked to ORDER THE CANDIDATE MODELS. It sees only the
// discovered ids and profile prices and answers JSON; ids outside the discovered set
// are dropped; an error, a timeout or a malformed answer resolves to the session
// model; `deep` is only ever taken from above the session in its order; the result
// is cached by a hash of the catalogue; and it runs on the light tier of the
// session's own provider. It compares MODELS. It never rates a task's own
// difficulty — `assignTier` above owns the tier, from signals the orchestrator holds.
//
// Pure throughout: no RNG, no network, no fs. Identical inputs yield deep-equal
// output — the discovered catalogue is an argument, so a test injects candidates
// instead of probing a machine. The one wall-clock touch is the bounded wait on the
// INJECTED agent (`RANK_AGENT_TIMEOUT_MS`), and it only exists when an agent does.

import { createHash } from "node:crypto";
import { familyKey, parseModelVersion } from "./model-version";

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
 *
 * A `Map`, not an object literal, and that is not a style choice. A bare object
 * inherits `Object.prototype`, so `aliases["constructor"]` returns a FUNCTION and
 * `aliases["toString"]` a method — neither is `undefined`, which is the only value
 * `parseModelTier` treats as "not a tier". Read through an object literal, a skill
 * declaring `model_tier: constructor` passed the AC14 build guard, and
 * `resolveTierFromRanking` — seeing a value that is neither `undefined`, nor
 * `standard`, nor `deep` — took the `light` branch and SILENTLY DOWNGRADED the
 * dispatch. A `Map` has no prototype chain to inherit from, so an unknown key is
 * `undefined` and nothing else.
 */
const TIER_ALIASES: ReadonlyMap<string, ModelTier> = new Map<string, ModelTier>([["cheap", "light"]]);

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
  return TIER_ALIASES.get(key);
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
 *
 * VERSION IS NOT A SIZE HINT. `rankModelId` never parses a version number out of
 * an id: `claude-opus-5.5` and `claude-opus-4.7` get the SAME size rank from it.
 * Generation is a separate axis, added by flow 358 on top of these hints in
 * `orderRanked`/`relate` (below) using `parseModelVersion`/`familyKey`
 * (`./model-version`): within one family and vendor a newer version outranks an
 * older one — `claude-opus-5.5` > `claude-opus-4.7`, hyphenated `claude-opus-4-8`
 * read as `4.8`, `gemini-3.8-flash` > `gemini-3.1-flash` — and across families a
 * version is never compared (the operator's 2026-09-25 decision for the routing
 * table, `deriveDefaultTable`, which reuses these hints and the same parser).
 * This file used to stop at size words; the tier resolution now uses both.
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
  /** The subset the hints could place, best first: size class, then (within one family) newer version, then discovery order. */
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
 * The size-word-placeable candidates as a deterministic TOTAL order, best first:
 *
 *   1. size class (`rankModelId`), larger first;
 *   2. inside a class, families in the order discovery first reported them —
 *      different families are never compared by version;
 *   3. inside a family (`familyKey`: same vendor, same size words), a parseable
 *      version first and NEWER first — `claude-sonnet-5-5` before
 *      `claude-sonnet-5`; an id with no parseable version follows the versioned
 *      ones, in discovery order;
 *   4. discovery order.
 *
 * The version step is what makes "a newer generation outranks an older one of its
 * own family" hold; it deliberately never crosses a family (a version number is
 * not comparable between `opus` and `sonnet`). The key is lexicographic, so the
 * order is transitive whatever the input order.
 */
function orderRanked(candidates: readonly string[], hints: readonly ModelRankHint[]): RankedModel[] {
  const firstSeenFamily = new Map<string, number>();
  const rows: {
    model: RankedModel;
    family: string;
    version: number | undefined;
    index: number;
  }[] = [];
  candidates.forEach((modelId, index) => {
    const rank = rankModelId(modelId, hints);
    if (rank === undefined) return;
    const family = `${rank}|${familyKey(modelId)}`;
    if (!firstSeenFamily.has(family)) firstSeenFamily.set(family, index);
    rows.push({ model: { modelId, rank }, family, version: parseModelVersion(modelId), index });
  });
  rows.sort((a, b) => {
    if (a.model.rank !== b.model.rank) return b.model.rank - a.model.rank;
    if (a.family !== b.family) return firstSeenFamily.get(a.family)! - firstSeenFamily.get(b.family)!;
    const aHas = a.version !== undefined;
    const bHas = b.version !== undefined;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas && a.version !== b.version) return b.version! - a.version!;
    return a.index - b.index;
  });
  return rows.map((r) => r.model);
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

  const ranked = orderRanked(candidates, hints);

  const sessionRank = rankModelId(sessionModel, hints);
  if (sessionRank === undefined) {
    return refuse(
      candidates,
      ranked,
      null,
      `the session model "${sessionModel}" carries no size marker the hints recognise, so no candidate can be called larger or smaller than it`,
    );
  }

  // The session model was placed, and NOTHING ELSE was. Observed on a real
  // provider: the session ran `…-v4-flash` (`flash` is a size word, rank -1)
  // while the two candidates carried no size word at all, so `ranked` came back
  // empty. Every tier then resolved through the "no discovered model ranks above
  // / below" branch and recorded `session-ranked` — which claims the ranking
  // worked and this is where it landed. It did not work: there was nothing to
  // rank, and an operator reading `session-ranked` next to `ranked: []` cannot
  // tell that from a provider whose models were all ranked and all lateral.
  //
  // Refusing here costs nothing — with no ranked candidate every tier keeps the
  // session model on either path — and buys a record that says which of the two
  // happened.
  if (ranked.length === 0) {
    return refuse(
      candidates,
      ranked,
      sessionRank,
      `none of the ${candidates.length} model(s) provider "${providerId}" reported carries a size marker the hints recognise, so no candidate can be called larger or smaller than the session model "${sessionModel}"`,
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
 * Where a resolved model came from. Recorded on the dispatch — the values are
 * genuinely different facts, and flattening them would hide the one that matters.
 *
 *   - `discovered`       — a model reported by runtime detection was assigned.
 *   - `session-ranked`   — ranking WORKED and put this tier at the session's own
 *                          model: `standard` always, and `light`/`deep` when
 *                          nothing discovered sits below/above the session.
 *   - `session-fallback` — ranking was refused or was AMBIGUOUS (a larger size
 *                          class that is an older generation); the session model
 *                          is used because nothing could be worked out.
 *   - `agent-ranked`     — the deterministic ranking was refused or ambiguous and
 *                          an injected agent ordered the discovered candidates
 *                          instead (flow 358). The agent compares MODELS; it never
 *                          rates the task.
 */
export type TierResolutionSource = "discovered" | "session-ranked" | "session-fallback" | "agent-ranked";

/**
 * A price for one model, per million tokens, as the operator's profile holds it.
 * Both fields optional: an unpriced model contributes no evidence either way
 * (never `0`, never a guess).
 */
export interface ModelPrice {
  readonly inputPerMillion?: number | undefined;
  readonly outputPerMillion?: number | undefined;
}

/** Prices keyed by model id (the session provider's catalogue only). */
export type ModelPrices = Readonly<Record<string, ModelPrice>>;

/** Why the deterministic path asked for the agent, when it did. */
export type TierAgentTrigger = "refused" | "ambiguous";

/** What the agent fallback did for one resolution, so the run can be explained. */
export interface TierAgentTrace {
  readonly trigger: TierAgentTrigger;
  /** The light-tier selection of the session's own provider the agent ran on. */
  readonly runOn: { readonly providerId: string; readonly modelId: string };
  /** True when the order came from the cache and the agent was not called. */
  readonly cacheHit: boolean;
  /** The validated order, best first; empty when the agent failed. */
  readonly order: readonly string[];
  /** Ids the agent returned that are not in the discovered set (dropped). */
  readonly dropped: readonly string[];
  /** Hash of the candidate catalogue the cache is keyed by. */
  readonly catalogueHash: string;
  /** Why the agent's answer was not used, or `null` when it was. */
  readonly failure: string | null;
}

/** A tier resolved against a session: a concrete model plus its provenance. */
export interface TierResolution {
  readonly tier: ModelTier;
  readonly providerId: string;
  readonly modelId: string;
  readonly source: TierResolutionSource;
  /** One sentence, for the dispatch record. */
  readonly reason: string;
  /**
   * A stable id for the sentence above (`picked-below`, `kept-older-generation-pricier`,
   * `agent-picked-above`, …). Recorded as `resolve:<reasonId>` in `tier_reasons`;
   * ids, not prose, so they can be compared in tests and read back from old runs.
   */
  readonly reasonId: string;
  /** What discovery and ranking produced, so the sentence above can be checked. */
  readonly ranking: ModelRanking;
  /** Present only when the agent fallback was asked. */
  readonly agent?: TierAgentTrace | undefined;
}

// --- generation-aware placement ---------------------------------------------

/** Session-relative placement of one ranked candidate. */
type Relation =
  /** A larger class, or a newer generation of the session's own family. */
  | "above"
  /** A larger class whose version is OLDER than the session's: ambiguous. */
  | "above-older-generation"
  /** A smaller size class. */
  | "below"
  /** Same class and not comparable, or an older sibling of the session's family: never a tier. */
  | "lateral";

function relate(sessionId: string, sessionRank: number, candidate: RankedModel): Relation {
  if (candidate.rank < sessionRank) return "below";
  const sessionVersion = parseModelVersion(sessionId);
  const candidateVersion = parseModelVersion(candidate.modelId);
  const bothVersions = sessionVersion !== undefined && candidateVersion !== undefined;
  if (candidate.rank > sessionRank) {
    return bothVersions && candidateVersion < sessionVersion ? "above-older-generation" : "above";
  }
  // Same size class. Only the SAME family and vendor is ever ordered by version.
  if (bothVersions && familyKey(candidate.modelId) === familyKey(sessionId) && candidateVersion > sessionVersion) {
    return "above";
  }
  return "lateral";
}

function priceOf(prices: ModelPrices | undefined, modelId: string): ModelPrice | undefined {
  if (prices === undefined) return undefined;
  const exact = prices[modelId];
  if (exact !== undefined) return exact;
  const wanted = normaliseModelId(modelId);
  for (const [id, price] of Object.entries(prices)) {
    if (normaliseModelId(id) === wanted) return price;
  }
  return undefined;
}

/** `true`/`false` when both prices are known on at least one axis, `undefined` when they cannot be compared. */
function costsMoreThan(candidate: ModelPrice | undefined, session: ModelPrice | undefined): boolean | undefined {
  if (candidate === undefined || session === undefined) return undefined;
  let known = false;
  let higher = false;
  for (const [c, s] of [
    [candidate.inputPerMillion, session.inputPerMillion],
    [candidate.outputPerMillion, session.outputPerMillion],
  ] as const) {
    if (typeof c === "number" && typeof s === "number") {
      known = true;
      if (c > s) higher = true;
    }
  }
  return known ? higher : undefined;
}

function formatPrice(price: ModelPrice | undefined): string {
  if (price === undefined) return "price unknown";
  const parts: string[] = [];
  if (typeof price.inputPerMillion === "number") parts.push(`$${price.inputPerMillion}/M in`);
  if (typeof price.outputPerMillion === "number") parts.push(`$${price.outputPerMillion}/M out`);
  return parts.length === 0 ? "price unknown" : parts.join(", ");
}

/** The discovered candidates other than the session's own model. */
function otherCandidates(session: SessionModelContext, ranking: ModelRanking): string[] {
  const own = normaliseModelId(session.modelId);
  return ranking.candidates.filter((id) => normaliseModelId(id) !== own);
}

interface Evaluation {
  readonly resolution: TierResolution;
  /** Set when the agent fallback may be asked; `null` when the deterministic answer stands. */
  readonly trigger: TierAgentTrigger | null;
}

/**
 * The deterministic half of a resolution, plus whether the agent is worth asking.
 * Every rung returns a usable selection on the session's provider.
 */
function evaluateTier(
  session: SessionModelContext,
  tier: ModelTier | string | undefined,
  ranking: ModelRanking,
  prices: ModelPrices | undefined,
): Evaluation {
  const parsed = parseModelTier(typeof tier === "string" ? tier : undefined);
  const keep = (
    resolvedTier: ModelTier,
    source: TierResolutionSource,
    reasonId: string,
    reason: string,
    trigger: TierAgentTrigger | null = null,
  ): Evaluation => ({
    resolution: {
      tier: resolvedTier,
      providerId: session.providerId,
      modelId: session.modelId,
      source,
      reason,
      reasonId,
      ranking,
    },
    trigger,
  });

  if (parsed === undefined) {
    return keep(
      DEFAULT_MODEL_TIER,
      "session-fallback",
      "tier-unrecognised",
      `tier ${JSON.stringify(tier ?? null)} is not one of ${MODEL_TIERS.join("/")}; keeping the session model`,
    );
  }

  // The agent is only ever worth asking for a tier that moves off the session
  // model, and only when there is something else to choose from.
  const askable = parsed !== "standard" && otherCandidates(session, ranking).length > 0;

  if (!ranking.usable) {
    return keep(
      parsed,
      "session-fallback",
      "ranking-refused",
      `discovered models could not be ranked (${ranking.fallbackReason ?? "no reason recorded"}); keeping the session model for tier ${parsed}`,
      askable ? "refused" : null,
    );
  }

  // A ranking with no session rank has no anchor, whatever it claims about being
  // usable. `rankDiscoveredModels` never produces that pair, but this function is
  // EXPORTED and takes an arbitrary `ModelRanking`, and the previous
  // `sessionRank ?? 0` silently invented rank 0 for such an input — which places
  // `light` below zero and `deep` above it rather than below and above the session,
  // so `light` could pick a model LARGER than the session's. Refusing is the same
  // answer the "unrankable session model" branch of `rankDiscoveredModels` gives
  // for the same missing fact.
  if (ranking.sessionRank === null) {
    return keep(
      parsed,
      "session-fallback",
      "no-session-rank",
      `the ranking carries no rank for the session model "${session.modelId}", so no candidate can be called above or below it; keeping the session model for tier ${parsed}`,
      askable ? "refused" : null,
    );
  }

  if (parsed === "standard") {
    return keep(
      parsed,
      "session-ranked",
      "session-is-standard",
      `standard is the session's own model "${session.modelId}" (rank ${ranking.sessionRank})`,
    );
  }

  const anchor = ranking.sessionRank;
  const own = normaliseModelId(session.modelId);
  const others = ranking.ranked.filter((m) => normaliseModelId(m.modelId) !== own);
  const related = others.map((m) => ({ model: m, relation: relate(session.modelId, anchor, m) }));

  if (parsed === "deep") {
    // `ranked` is best-first, so the first entry is the most capable one above.
    const above = related.find((r) => r.relation === "above");
    if (above !== undefined) {
      const sameClass = above.model.rank === anchor;
      return {
        resolution: {
          tier: parsed,
          providerId: session.providerId,
          modelId: above.model.modelId,
          source: "discovered",
          reason: sameClass
            ? `tier deep took "${above.model.modelId}", a newer generation of the session model's own family "${session.modelId}" (rank ${anchor})`
            : `tier deep took discovered model "${above.model.modelId}" (rank ${above.model.rank}) against the session model "${session.modelId}" (rank ${anchor})`,
          reasonId: sameClass ? "picked-newer-generation" : "picked-above",
          ranking,
        },
        trigger: null,
      };
    }
    const older = related.filter((r) => r.relation === "above-older-generation");
    if (older.length > 0) {
      const first = older[0]!.model.modelId;
      const sessionPrice = priceOf(prices, session.modelId);
      const pricier = older.some((r) => costsMoreThan(priceOf(prices, r.model.modelId), sessionPrice) === true);
      const ids = older.map((r) => `"${r.model.modelId}" (${formatPrice(priceOf(prices, r.model.modelId))})`).join(", ");
      return keep(
        parsed,
        "session-fallback",
        pricier ? "kept-older-generation-pricier" : "kept-older-generation",
        `the only discovered model(s) above the session model "${session.modelId}" (${formatPrice(sessionPrice)}) by size class are an OLDER generation${pricier ? " and cost more" : ""}: ${ids}; a larger class of an older generation is not a stronger model, so tier deep keeps the session model (first candidate "${first}")`,
        "ambiguous",
      );
    }
    return keep(
      parsed,
      "session-ranked",
      "no-model-above",
      `no discovered model ranks above the session model "${session.modelId}" (rank ${anchor}); tier deep keeps it`,
    );
  }

  // light: the NEXT size step below, never the smallest class. `ranked` is
  // best-first, so the first `below` entry sits in the nearest smaller bucket, and
  // inside it the newest generation of its family. A same-class older sibling is
  // `lateral`, never `below`.
  const below = related.find((r) => r.relation === "below");
  if (below === undefined) {
    return keep(
      parsed,
      "session-ranked",
      "no-model-below",
      `no discovered model ranks below the session model "${session.modelId}" (rank ${anchor}); tier light keeps it`,
    );
  }
  return {
    resolution: {
      tier: parsed,
      providerId: session.providerId,
      modelId: below.model.modelId,
      source: "discovered",
      reason: `tier light took discovered model "${below.model.modelId}" (rank ${below.model.rank}), the next size step below the session model "${session.modelId}" (rank ${anchor})`,
      reasonId: "picked-below",
      ranking,
    },
    trigger: null,
  };
}

/**
 * Resolve a tier against an ALREADY-COMPUTED ranking, deterministically.
 *
 * Split out so `buildTierMap` ranks once for all three tiers and so the tier ->
 * model step is testable without a catalogue. Total: every input returns a usable
 * selection, and the provider is ALWAYS the session's — candidates come from the
 * session provider's own catalogue, so a resolved selection is one
 * `resolveChildModel` gate G1 already admits.
 *
 * `prices` (optional) only feeds the reason recorded when an older-generation
 * candidate is refused; it never changes which model is picked.
 */
export function resolveTierFromRanking(
  session: SessionModelContext,
  tier: ModelTier | string | undefined,
  ranking: ModelRanking,
  prices?: ModelPrices,
): TierResolution {
  return evaluateTier(session, tier, ranking, prices).resolution;
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
  prices?: ModelPrices,
): TierResolution {
  return resolveTierFromRanking(session, tier, rankDiscoveredModels(session, catalog, hints), prices);
}

// ---------------------------------------------------------------------------
// The agent fallback (flow 358): an INJECTED port, so this module still holds
// no network and no filesystem.
//
// It exists for exactly two situations the deterministic ranking cannot settle:
//
//   - the ranking was REFUSED (the session model or the catalogue carries no size
//     word) but the provider did report other models; and
//   - a tier is AMBIGUOUS — the only candidates above the session are a larger
//     class of an OLDER generation, which size words alone cannot call stronger.
//
// What the agent does is compare CANDIDATE MODELS with each other, given nothing
// but their discovered ids and profile prices. It is never shown a task, never
// asked how hard anything is, and never chooses a tier: `assignTier` still owns
// that. Its answer is strict JSON, checked against the discovered set (a foreign
// id is dropped), and any failure — an error, a timeout, a malformed or
// session-less answer — resolves exactly as the deterministic path already did:
// the session model. A tier of `standard`/`deep` is only ever taken from ABOVE the
// session in the agent's order, so it can never place either below it.
// ---------------------------------------------------------------------------

/** One candidate as the agent sees it: the discovered id and profile prices, nothing else. */
export interface TierRankCandidate {
  readonly modelId: string;
  readonly inputPerMillion?: number | undefined;
  readonly outputPerMillion?: number | undefined;
}

/** What the agent port is handed. */
export interface TierRankRequest {
  readonly providerId: string;
  /** The session's own model — always one of `candidates`. */
  readonly sessionModel: string;
  readonly trigger: TierAgentTrigger;
  /** The discovered ids plus the session model, sorted by id, with profile prices. */
  readonly candidates: readonly TierRankCandidate[];
  /** The light tier of the session's own provider: where the agent must run. */
  readonly runOn: { readonly providerId: string; readonly modelId: string };
  /** The full prompt, built by {@link buildRankPrompt}; a host may send it as is. */
  readonly prompt: string;
  /** Aborted when the call times out, so a host stops the paid turn instead of only waiting less. */
  readonly signal?: AbortSignal | undefined;
  /** The session provider's base URL when it has one; the agent runs on the same provider. */
  readonly baseUrl?: string | undefined;
}

/** The agent port: raw answer text in, raw text out. Validation is this module's job. */
export type TierRankAgent = (request: TierRankRequest) => Promise<string>;

/** An async key/value cache for validated orders, keyed by the catalogue hash. */
export interface TierRankCache {
  get(key: string): Promise<readonly string[] | undefined>;
  set(key: string, order: readonly string[]): Promise<void>;
}

/** Options for the agent-assisted resolvers; all optional, none is required. */
export interface TierAgentOptions {
  readonly agent?: TierRankAgent | undefined;
  readonly cache?: TierRankCache | undefined;
  readonly prices?: ModelPrices | undefined;
  /** Upper bound on one agent call. Default {@link RANK_AGENT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** The session provider's base URL, handed to the agent so its turn goes to the same endpoint. */
  readonly baseUrl?: string | undefined;
}

/** The bound on one agent call: a dispatch must never hang on a ranking helper. */
export const RANK_AGENT_TIMEOUT_MS = 20_000;

/** The most candidates one ranking call shows the agent; its answer is capped at a few hundred tokens, so a bigger list could never be answered in full. */
export const RANK_MAX_CANDIDATES = 24;

/** Bumped when the prompt or answer contract changes, so an old cached order is never reused. */
const RANK_CONTRACT_VERSION = 1;

/** At most {@link RANK_MAX_CANDIDATES} ids: the session model, then the deterministic ranking's best (size class, then version), then unranked ids by name. */
function capCandidates(ids: readonly string[], sessionModelId: string, ranking: ModelRanking): string[] {
  if (ids.length <= RANK_MAX_CANDIDATES) return [...ids];
  const byKey = new Map(ids.map((id) => [normaliseModelId(id), id] as const));
  const sessionKey = normaliseModelId(sessionModelId);
  const priority = [
    sessionKey,
    ...ranking.ranked.map((r) => normaliseModelId(r.modelId)),
    ...[...byKey.keys()].sort(),
  ];
  const picked: string[] = [];
  const taken = new Set<string>();
  for (const key of priority) {
    if (picked.length >= RANK_MAX_CANDIDATES) break;
    const id = byKey.get(key);
    if (id === undefined || taken.has(key)) continue;
    taken.add(key);
    picked.push(id);
  }
  return picked;
}

/** The candidate list the agent sees: discovered ids plus the session model, sorted, with prices. */
function agentCandidates(
  session: SessionModelContext,
  ranking: ModelRanking,
  prices: ModelPrices | undefined,
): TierRankCandidate[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [...ranking.candidates, session.modelId.trim()]) {
    const key = normaliseModelId(id);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  const kept = capCandidates(ids, session.modelId, ranking);
  kept.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return kept.map((modelId) => {
    const price = priceOf(prices, modelId);
    return { modelId, inputPerMillion: price?.inputPerMillion, outputPerMillion: price?.outputPerMillion };
  });
}

/**
 * The hash a validated order is cached under: the provider plus the sorted
 * catalogue with prices. Independent of the session model and of the tier, so one
 * agent call serves `deep` and `light` alike, and an identical catalogue asks once.
 */
export function rankCatalogueHash(providerId: string, candidates: readonly TierRankCandidate[]): string {
  const canonical = JSON.stringify({
    v: RANK_CONTRACT_VERSION,
    provider: normaliseModelId(providerId),
    models: candidates.map((c) => [c.modelId, c.inputPerMillion ?? null, c.outputPerMillion ?? null]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The prompt for the agent. It carries the candidate ids and profile prices and a
 * JSON answer contract — and states, in as many words, that it compares MODELS.
 * Deliberately no task, no diff, no user text.
 */
export function buildRankPrompt(candidates: readonly TierRankCandidate[]): string {
  const rows = candidates.map((c) => ({
    id: c.modelId,
    input_usd_per_million_tokens: c.inputPerMillion ?? null,
    output_usd_per_million_tokens: c.outputPerMillion ?? null,
  }));
  return [
    "You compare AI language models with each other. You are not given a task and must not judge how hard any task is.",
    "Order the model ids below from most capable to least capable, using the id text (family, size and version words) and the prices.",
    "A newer generation of a family is stronger than an older one; a larger size class is stronger than a smaller one of a comparable generation; a higher price is a weak hint of capability only.",
    "Rules: use ONLY the ids listed, exactly as written; list every id once; do not invent ids.",
    'Answer with JSON only, no prose: {"order": ["<most capable id>", "...", "<least capable id>"]}',
    "",
    `Models: ${JSON.stringify(rows)}`,
  ].join("\n");
}

/** The outcome of checking an agent's answer against the discovered set. */
export type RankAnswer =
  | { readonly ok: true; readonly order: readonly string[]; readonly dropped: readonly string[] }
  | { readonly ok: false; readonly error: string };

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(body);
  } catch {
    // Some models put a sentence around the object; the object itself must still be JSON.
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/**
 * Validate an agent's raw answer. Strict on shape, tolerant of order: a string
 * array under `order` (or a bare array); every id is matched case-insensitively
 * against `allowed` and mapped back to the DISCOVERED spelling; an id outside the
 * set is dropped, duplicates keep their first position; and the answer must place
 * the session model, or it is malformed — an order that leaves out the anchor
 * cannot say what is above or below it.
 */
export function parseRankAnswer(raw: unknown, allowed: readonly string[], sessionModel: string): RankAnswer {
  if (typeof raw !== "string") return { ok: false, error: "the agent returned no text" };
  const json = extractJson(raw);
  const list: unknown = Array.isArray(json)
    ? json
    : typeof json === "object" && json !== null
      ? (json as { order?: unknown }).order
      : undefined;
  if (!Array.isArray(list)) return { ok: false, error: 'the answer is not JSON of the shape {"order": [...]}' };

  const canonical = new Map(allowed.map((id) => [normaliseModelId(id), id] as const));
  const order: string[] = [];
  const dropped: string[] = [];
  const placed = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "string") return { ok: false, error: "the order holds a non-string entry" };
    const id = canonical.get(normaliseModelId(entry));
    if (id === undefined) {
      dropped.push(entry);
      continue;
    }
    if (placed.has(id)) continue;
    placed.add(id);
    order.push(id);
  }
  const sessionId = canonical.get(normaliseModelId(sessionModel));
  if (sessionId === undefined || !placed.has(sessionId)) {
    return { ok: false, error: "the answer does not place the session model" };
  }
  return { ok: true, order, dropped };
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * {@link resolveTierFromRanking} plus the agent fallback. Identical to the
 * deterministic form unless the ranking was refused or the tier is ambiguous AND
 * an agent was supplied — and even then any failure returns the deterministic
 * answer, with the failure appended to its reason.
 */
export async function resolveTierWithAgent(
  session: SessionModelContext,
  tier: ModelTier | string | undefined,
  ranking: ModelRanking,
  options: TierAgentOptions = {},
): Promise<TierResolution> {
  const { prices, agent, cache } = options;
  const deterministic = evaluateTier(session, tier, ranking, prices);
  const trigger = deterministic.trigger;
  if (trigger === null || agent === undefined) return deterministic.resolution;

  const base = deterministic.resolution;
  const requested = base.tier;
  const candidates = agentCandidates(session, ranking, prices);
  const allowed = candidates.map((c) => c.modelId);
  const catalogueHash = rankCatalogueHash(session.providerId, candidates);
  // The agent runs on the LIGHT tier of the session's own provider: the cheap
  // deterministic step below the session, or the session itself when none exists.
  const light = evaluateTier(session, "light", ranking, prices).resolution;
  const runOn = { providerId: light.providerId, modelId: light.modelId };

  const failed = (failure: string, dropped: readonly string[] = []): TierResolution => ({
    ...base,
    reason: `${base.reason}; the agent fallback could not rank the candidates (${failure}), so the session model stays`,
    reasonId: "agent-failed",
    agent: { trigger, runOn, cacheHit: false, order: [], dropped, catalogueHash, failure },
  });

  let order: readonly string[] | undefined;
  let dropped: readonly string[] = [];
  let cacheHit = false;

  if (cache !== undefined) {
    try {
      const stored = await cache.get(catalogueHash);
      if (stored !== undefined) {
        // A cached order is re-checked like a fresh answer: the file is not trusted.
        const checked = parseRankAnswer(JSON.stringify({ order: stored }), allowed, session.modelId);
        if (checked.ok) {
          order = checked.order;
          cacheHit = true;
        }
      }
    } catch {
      // A broken cache is a miss, never a failed dispatch.
    }
  }

  if (order === undefined) {
    const controller = new AbortController();
    const request: TierRankRequest = {
      providerId: session.providerId,
      sessionModel: session.modelId,
      trigger,
      candidates,
      runOn,
      prompt: buildRankPrompt(candidates),
      signal: controller.signal,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    };
    let answer: string;
    try {
      answer = await withTimeout(
        (async () => agent(request))(),
        options.timeoutMs ?? RANK_AGENT_TIMEOUT_MS,
        () => controller.abort(),
      );
    } catch (error) {
      return failed(errorText(error));
    }
    const checked = parseRankAnswer(answer, allowed, session.modelId);
    if (!checked.ok) return failed(checked.error);
    order = checked.order;
    dropped = checked.dropped;
    if (cache !== undefined) {
      try {
        await cache.set(catalogueHash, order);
      } catch {
        // Not caching costs one more agent call next time; it changes no answer.
      }
    }
  }

  const trace: TierAgentTrace = { trigger, runOn, cacheHit, order, dropped, catalogueHash, failure: null };
  const sessionIndex = order.findIndex((id) => normaliseModelId(id) === normaliseModelId(session.modelId));
  const orderText = order.join(" > ");

  const settle = (modelId: string, reasonId: string, reason: string): TierResolution => ({
    tier: requested,
    providerId: session.providerId,
    modelId,
    source: "agent-ranked",
    reason,
    reasonId,
    ranking,
    agent: trace,
  });

  // The deterministic size knowledge is not the agent's to overrule when it EXISTS:
  // with a usable ranking, an entry the size words place below the session is never
  // `deep`, and one they place above it is never `light`. When the ranking was
  // refused (no anchor) the agent's own order is all there is.
  const rankedById = new Map(ranking.ranked.map((m) => [normaliseModelId(m.modelId), m] as const));
  const relationOf = (id: string): Relation | undefined => {
    const known = rankedById.get(normaliseModelId(id));
    return known !== undefined && ranking.usable && ranking.sessionRank !== null
      ? relate(session.modelId, ranking.sessionRank, known)
      : undefined;
  };

  if (requested === "deep") {
    // Only entries the agent put ABOVE the session can be `deep`: never below it.
    const sessionPrice = priceOf(prices, session.modelId);
    let vetoed: string | undefined;
    for (const id of order.slice(0, sessionIndex)) {
      const relation = relationOf(id);
      if (relation === "below" || relation === "lateral") continue;
      // The one price veto: a larger class of an OLDER generation that also costs
      // more is never `deep`, whatever an agent says (AC2).
      if (relation === "above-older-generation" && costsMoreThan(priceOf(prices, id), sessionPrice) === true) {
        vetoed ??= id;
        continue;
      }
      return settle(
        id,
        "agent-picked-above",
        `the deterministic ranking could not settle this tier (${base.reasonId}); the agent fallback ordered the candidates (${orderText}) and tier deep took "${id}", above the session model "${session.modelId}"`,
      );
    }
    if (vetoed !== undefined) {
      return settle(
        session.modelId,
        "agent-veto-older-generation",
        `the agent fallback ordered the candidates (${orderText}) but "${vetoed}" is an older generation that costs more than the session model "${session.modelId}", so tier deep keeps the session model`,
      );
    }
    return settle(
      session.modelId,
      "agent-kept-session",
      `the agent fallback ordered the candidates (${orderText}) and placed nothing usable above the session model "${session.modelId}"; tier deep keeps it`,
    );
  }

  // light: the entry right after the session in the agent's order.
  const next = order[sessionIndex + 1];
  const nextRelation = next === undefined ? undefined : relationOf(next);
  if (next === undefined || nextRelation === "above" || nextRelation === "above-older-generation") {
    return settle(
      session.modelId,
      "agent-kept-session",
      `the agent fallback ordered the candidates (${orderText}) and placed nothing usable below the session model "${session.modelId}"; tier light keeps it`,
    );
  }
  return settle(
    next,
    "agent-picked-below",
    `the deterministic ranking could not settle this tier (${base.reasonId}); the agent fallback ordered the candidates (${orderText}) and tier light took "${next}", the next step below the session model "${session.modelId}"`,
  );
}

/** Discover, rank, resolve one tier, and ask the agent when the ranking cannot settle it. */
export async function resolveTierModelWithAgent(
  session: SessionModelContext,
  tier: ModelTier | string | undefined,
  catalog: readonly DiscoveredProvider[] = [],
  options: TierAgentOptions & { readonly hints?: readonly ModelRankHint[] | undefined } = {},
): Promise<TierResolution> {
  const ranking = rankDiscoveredModels(session, catalog, options.hints ?? MODEL_RANK_HINTS);
  return resolveTierWithAgent(session, tier, ranking, options);
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
  for (const [alias, tier] of TIER_ALIASES) {
    const canonical = map[tier];
    if (canonical !== undefined) map[alias] = canonical;
  }
  return map;
}

/**
 * A copy of `map` with one resolved tier written over its entry (and over every
 * alias of that tier), so a tier the agent fallback settled is the one
 * `resolveChildModel` applies. The map stays total: nothing is removed.
 */
export function applyTierResolution(
  map: Readonly<Record<string, TierModelSelection>>,
  resolution: Pick<TierResolution, "tier" | "providerId" | "modelId">,
): Record<string, TierModelSelection> {
  const next: Record<string, TierModelSelection> = { ...map };
  const selection = { providerId: resolution.providerId, modelId: resolution.modelId };
  next[resolution.tier] = selection;
  for (const [alias, tier] of TIER_ALIASES) {
    if (tier === resolution.tier) next[alias] = selection;
  }
  return next;
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
  prices?: ModelPrices,
): DispatchModelDecision {
  const assignment = assignTier(signals);
  return toDispatchDecision(assignment, resolveTierModel(session, assignment.tier, catalog, hints, prices));
}

/**
 * {@link decideDispatchModel} with the agent fallback: the same record, but a tier
 * the deterministic ranking could not settle may come back `agent-ranked`.
 */
export async function decideDispatchModelWithAgent(
  session: SessionModelContext,
  signals: TierSignals,
  catalog: readonly DiscoveredProvider[] = [],
  options: TierAgentOptions & { readonly hints?: readonly ModelRankHint[] | undefined } = {},
): Promise<DispatchModelDecision> {
  const assignment = assignTier(signals);
  return toDispatchDecision(assignment, await resolveTierModelWithAgent(session, assignment.tier, catalog, options));
}

function toDispatchDecision(assignment: TierAssignment, resolved: TierResolution): DispatchModelDecision {
  const { ranking } = resolved;
  return {
    tier: assignment.tier,
    // The rule ids that ASSIGNED the tier, then the one that RESOLVED it to a model.
    tier_reasons: [...assignment.reasons, `resolve:${resolved.reasonId}`],
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
