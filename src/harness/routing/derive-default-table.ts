// Flow 327 (Routing A2), AC10 (rewritten 2026-09-25 — review of PR #718's
// NaN tie-break, which let `opus-4.7` beat the session's own `opus-5.5`, and
// the operator's model-choice policy) — `deriveDefaultTable`: PRD §6.3's
// "derived" precedence layer. A PURE function: session provider id + session
// model id + its (available) model ids + the operator's model-profile
// catalogue -> a `RoutingTable` (`./table.ts`) the SAME shape
// `routing.config.json`/the per-user layer already use, so
// `resolveCategoryDetailed` treats it as just another layer
// (`RoutingLayers.derived`).
//
// v1 derives from the SESSION's own current provider only — cross-provider
// derivation is explicitly out of scope (PRD §Non-goals, PLAN.md open
// question 8).
//
// THE RANKING (rewritten AC10): a candidate is ranked by FAMILY SIZE CLASS
// first — `rankModelId`/`MODEL_RANK_HINTS` (`../../gdskills/model-tier.ts`),
// reused exactly as AC5 reuses it: opus > sonnet > haiku, flagship >
// mini/flash/lite. That module's own tier ladder (`light`/`standard`/`deep`)
// deliberately stops at size words and never parses a version number — see
// its header comment. WITHIN the same family and vendor (same size word(s)
// stripped of any version token — `familyKey`, below), a newer VERSION
// ranks higher (`claude-opus-5.5` > `claude-opus-4.7`, `gpt-6` > `gpt-5`,
// `gemini-3.8-flash` > `gemini-3.1-flash`) — the operator's decision,
// 2026-09-25: the family word already carries size, so version is free to
// order generations within it. `parseModelVersion` is conservative: an id
// with zero or more than one numeric-only token yields no version rather
// than a guess, and a family/version mismatch never crashes the ranking —
// it just does not distinguish the tie.
import { isNonChatModelId, isFreeVariantModelId, isProfileComparable, profileKey, type ModelProfile } from "./model-profile";
import { MODEL_RANK_HINTS, rankModelId } from "../../gdskills/model-tier";
import { ROUTING_CATEGORIES, type CategoryAssignment, type RoutingCategory, type RoutingTable } from "./table";

/** Categories anchored on "the strongest model not weaker than the session model" (PRD §6.3, rewritten). */
const STRONG_CATEGORIES: ReadonlySet<RoutingCategory> = new Set(["planning", "review"]);

/**
 * Categories anchored on "the next size step down from the session's
 * family" — never the smallest class, the session model itself when there
 * is no middle step (rewritten AC10). `unattended` (scheduled/`flow-next`
 * background dispatches, PRD §4) is grouped here for the same reason the
 * previous ranking grouped it with the other unattended/low-supervision
 * categories: the PRD's worked example names only `subagents`/`docs`
 * explicitly and leaves `unattended` unaddressed, and it is the same
 * "someone is not reading every token" shape as the other two.
 */
const STEP_DOWN_CATEGORIES: ReadonlySet<RoutingCategory> = new Set(["subagents", "docs", "unattended"]);

/** The smallest class, globally (rewritten AC10). */
const QUICK_CATEGORIES: ReadonlySet<RoutingCategory> = new Set(["quick"]);

/** Categories that ALWAYS stay the session's own model, unchanged — never set by this function (omitted, letting resolution fall through to the bare `default` category). */
const SESSION_UNCHANGED_CATEGORIES: ReadonlySet<RoutingCategory> = new Set(["default", "coding"]);

// Defensive coverage check: every category in `ROUTING_CATEGORIES` must be
// accounted for by exactly one of the four groups above, so a category
// added later (Flow D) fails loudly here instead of silently deriving
// nothing for it.
{
  const accounted = new Set<RoutingCategory>([...STRONG_CATEGORIES, ...STEP_DOWN_CATEGORIES, ...QUICK_CATEGORIES, ...SESSION_UNCHANGED_CATEGORIES]);
  const missing = ROUTING_CATEGORIES.filter((category) => !accounted.has(category));
  if (missing.length > 0) {
    throw new Error(`derive-default-table.ts: category(ies) ${missing.join(", ")} are not covered by STRONG_CATEGORIES/STEP_DOWN_CATEGORIES/QUICK_CATEGORIES/SESSION_UNCHANGED_CATEGORIES`);
  }
}

// ---------------------------------------------------------------------------
// Family / version parsing — conservative by construction (item 2).
// ---------------------------------------------------------------------------

/** A token that is PURELY a (possibly dotted) number — `5`, `5.5`, never `5.5.2`-with-letters or `4o`. */
const VERSION_TOKEN = /^\d+(?:\.\d+)*$/;

/** Split a model id into lower-cased tokens on any run of characters that are not `[a-z0-9.]` — a dotted version stays ONE token (`5.5`), a hyphen/slash/underscore/colon is a boundary. */
function tokenize(modelId: string): string[] {
  return modelId
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length > 0);
}

/**
 * The id with its version token(s) removed, joined back — "same family and
 * vendor" for the version tie-break. `claude-opus-5.5` and `claude-opus-4.7`
 * both key to `claude-opus`; `gemini-3.8-flash` and `gemini-3.1-flash` both
 * key to `gemini-flash`. Two numeric tokens (`claude-opus-4-8`, a
 * hyphenated curated id) still strip to the same family even though the
 * VERSION itself is then ambiguous (see `parseModelVersion`) — family
 * grouping only needs "is this a number", not "which number is the version".
 */
export function familyKey(modelId: string): string {
  return tokenize(modelId)
    .filter((t) => !VERSION_TOKEN.test(t))
    .join("-");
}

/**
 * The id's version number, or `undefined` when none is parseable — zero
 * numeric-only tokens (no version present) or MORE than one (ambiguous,
 * e.g. a hyphenated `4-8` id) both yield `undefined` rather than a guess
 * (item 2: "parse numeric version segments conservatively; if an id has no
 * parseable version, do not guess").
 */
export function parseModelVersion(modelId: string): number | undefined {
  const versionTokens = tokenize(modelId).filter((t) => VERSION_TOKEN.test(t));
  if (versionTokens.length !== 1) return undefined;
  const value = Number(versionTokens[0]);
  return Number.isFinite(value) ? value : undefined;
}

/** Family size class (rewritten AC10): `rankModelId`'s raw ordinal, `undefined` (no hint matched) treated as `0` — the same "unranked -> standard/middle" convention `guessStrengthTier` (AC5) already uses. */
function sizeRank(modelId: string): number {
  return rankModelId(modelId, MODEL_RANK_HINTS) ?? 0;
}

/**
 * Strength ordering by id alone (no profile needed — the session model may
 * not even have a stored profile): size class first, then, ONLY within the
 * same family+vendor, version. Negative means `aId` is STRONGER than `bId`;
 * `0` means the two cannot be distinguished (different families at the same
 * size class, or either side's version is unparseable) — never `NaN`, since
 * every operand is an ordinary finite number (`rankModelId` ordinals and
 * `parseModelVersion` floats), unlike the previous `Infinity - Infinity`
 * price comparator this rewrite replaces.
 */
function compareStrengthById(aId: string, bId: string): number {
  const sizeDelta = sizeRank(bId) - sizeRank(aId);
  if (sizeDelta !== 0) return sizeDelta;
  if (familyKey(aId) === familyKey(bId)) {
    const va = parseModelVersion(aId);
    const vb = parseModelVersion(bId);
    if (va !== undefined && vb !== undefined && va !== vb) return vb - va;
  }
  return 0;
}

/**
 * Full selection ordering, for picking one candidate out of a tied-strength
 * group: strength first, then the session model itself (tie-break rule,
 * rewritten AC10: "the session model first"), then `priority.value`
 * descending (higher wins — `priority.value` is always a finite number,
 * `computeAutoPriority`'s own contract, so this never produces `NaN` either),
 * then the model id itself for full determinism regardless of input order
 * (the BLOCKER this rewrite fixes: the same candidate set, in either input
 * order, must always resolve to the same pick).
 */
function compareForSelection(a: ModelProfile, b: ModelProfile, sessionModelId: string): number {
  const strength = compareStrengthById(a.modelId, b.modelId);
  if (strength !== 0) return strength;
  const aIsSession = a.modelId === sessionModelId;
  const bIsSession = b.modelId === sessionModelId;
  if (aIsSession !== bIsSession) return aIsSession ? -1 : 1;
  const priorityDelta = b.priority.value - a.priority.value;
  if (priorityDelta !== 0) return priorityDelta;
  return a.modelId.localeCompare(b.modelId);
}

function modelAssignment(providerId: string, modelId: string): CategoryAssignment {
  return { kind: "model", providerId, modelId };
}

/** planning/review: the strongest candidate not weaker than the session model; the session model itself when nothing is strictly stronger. */
function pickPlanningReview(comparable: readonly ModelProfile[], sessionModelId: string, providerId: string): CategoryAssignment {
  const notWeaker = comparable.filter((c) => compareStrengthById(c.modelId, sessionModelId) <= 0);
  if (notWeaker.length === 0) return modelAssignment(providerId, sessionModelId);
  const strongest = [...notWeaker].sort((a, b) => compareForSelection(a, b, sessionModelId))[0]!;
  const strictlyStronger = compareStrengthById(strongest.modelId, sessionModelId) < 0;
  return strictlyStronger ? modelAssignment(providerId, strongest.modelId) : modelAssignment(providerId, sessionModelId);
}

/**
 * subagents/docs/unattended: the next size step DOWN from the session's own
 * size class — never the smallest class, the session model itself when
 * there is no middle step.
 *
 * "The smallest class" is the NEGATIVE-weight tier `MODEL_RANK_HINTS`
 * itself defines (`nano`/`tiny`/`mini`/`lite`/`flash`/`haiku`/`instant`/
 * `air`, weight `< 0`) — a FIXED floor, not "whatever happens to be the
 * lowest bucket present". That is the difference between the worked
 * example (Opus session, opus/opus/sonnet/haiku present: sonnet, weight
 * `0`, is the eligible middle step) and a 2-model provider (Opus + Sonnet
 * only, nothing negative-weight present at all): in BOTH cases sonnet
 * (weight `0`) is a valid, non-smallest step down. Only when the ONLY
 * bucket below the session is itself negative-weight (Opus + Haiku, no
 * Sonnet) is there truly "no middle step", and the session model is kept.
 */
function pickStepDown(comparable: readonly ModelProfile[], sessionModelId: string, providerId: string): CategoryAssignment {
  const buckets = [...new Set(comparable.map((c) => sizeRank(c.modelId)))];
  const sessionSize = sizeRank(sessionModelId);
  const eligible = buckets.filter((b) => b < sessionSize && b >= 0);
  if (eligible.length === 0) return modelAssignment(providerId, sessionModelId);
  const target = Math.max(...eligible);
  const inBucket = comparable.filter((c) => sizeRank(c.modelId) === target);
  const pick = [...inBucket].sort((a, b) => compareForSelection(a, b, sessionModelId))[0]!;
  return modelAssignment(providerId, pick.modelId);
}

/** quick: the globally smallest class present among comparable candidates. */
function pickQuick(comparable: readonly ModelProfile[], sessionModelId: string, providerId: string): CategoryAssignment {
  const smallest = Math.min(...comparable.map((c) => sizeRank(c.modelId)));
  const inBucket = comparable.filter((c) => sizeRank(c.modelId) === smallest);
  const pick = [...inBucket].sort((a, b) => compareForSelection(a, b, sessionModelId))[0]!;
  return modelAssignment(providerId, pick.modelId);
}

/**
 * Build the `derived` `RoutingTable` for `providerId`'s connected `models`,
 * anchored on the session's own model id (rewritten AC10, PRD §6.3):
 *
 *  - Zero models -> an empty table (nothing to derive; every category falls
 *    through to `default`).
 *  - One available CHAT model (item 3: a non-chat/`:free` sole model derives
 *    nothing) -> that model for every category except `default`/`coding`.
 *  - Several models -> filtered to COMPARABLE (`isProfileComparable`) chat
 *    models (item 3: non-chat and `:free` ids are never candidates), then
 *    partitioned by category intent: `planning`/`review` get the strongest
 *    candidate not weaker than the session model (PRD §6.3);
 *    `subagents`/`docs`/`unattended` get the next size step down from the
 *    session's own class, never the smallest; `quick` gets the smallest
 *    class present; `default`/`coding` are left unset (session-anchored,
 *    unconditionally). Zero comparable candidates -> an empty table.
 *
 * `models` should already be the provider's AVAILABLE models (PRD §6.3 runs
 * this "against available models only") — a caller building `models` from
 * `catalogToFlatPickerProviders`'s live list already gets this for free
 * (flow 309's live catalog only ever reports live-fetched ids).
 */
export function deriveDefaultTable(providerId: string, models: readonly string[], profiles: Readonly<Record<string, ModelProfile>>, sessionModelId: string): RoutingTable {
  if (models.length === 0) return {};
  if (models.length === 1) {
    const only = models[0]!;
    if (isNonChatModelId(only) || isFreeVariantModelId(only)) return {};
    const assignment = modelAssignment(providerId, only);
    const table: RoutingTable = {};
    for (const category of ["review", "subagents", "quick", "planning", "docs", "unattended"] as const) {
      table[category] = assignment;
    }
    return table;
  }

  const comparable = models
    .map((modelId) => profiles[profileKey(providerId, modelId)])
    .filter(
      (profile): profile is ModelProfile =>
        profile !== undefined && isProfileComparable(profile.modelId, profile) && profile.chatCapable && !isFreeVariantModelId(profile.modelId),
    );

  if (comparable.length === 0) return {};

  const table: RoutingTable = {};
  const planningReview = pickPlanningReview(comparable, sessionModelId, providerId);
  for (const category of STRONG_CATEGORIES) table[category] = planningReview;

  const stepDown = pickStepDown(comparable, sessionModelId, providerId);
  for (const category of STEP_DOWN_CATEGORIES) table[category] = stepDown;

  const quick = pickQuick(comparable, sessionModelId, providerId);
  for (const category of QUICK_CATEGORIES) table[category] = quick;

  // `default`/`coding` are never set here (SESSION_UNCHANGED_CATEGORIES) —
  // nothing to do for them; resolution falls through to `default`.
  return table;
}
