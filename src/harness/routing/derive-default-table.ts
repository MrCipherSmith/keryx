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
// Flow 341: the step-down pick (below) can be overridden by REAL measured
// task cost, once there is enough of it — see `preferByMeasuredCost`'s own
// doc for the exact rule and evidence bar. Everything else in this file is
// unchanged by that addition.
//
// THE RANKING (rewritten AC10): a candidate is ranked by FAMILY SIZE CLASS
// first — `rankModelId`/`MODEL_RANK_HINTS` (`../../gdskills/model-tier.ts`),
// reused exactly as AC5 reuses it: opus > sonnet > haiku, flagship >
// mini/flash/lite. That module's own tier ladder (`light`/`standard`/`deep`)
// deliberately stops at size words and never parses a version number — see
// its header comment. WITHIN the same family and vendor (same size word(s)
// stripped of any version token — `familyKey`, below), a newer VERSION
// ranks higher (`claude-opus-5.5` > `claude-opus-4.7`, `claude-opus-4-8`
// hyphenated -> `4.8` same as dotted, `gpt-6` > `gpt-5`, `gemini-3.8-flash` >
// `gemini-3.1-flash`) — the operator's decision, 2026-09-25: the family word
// already carries size, so version is free to order generations within it.
// `parseModelVersion` is conservative (rewritten round 2 — real Anthropic
// ids are hyphenated, not dotted, and the original parser refused every one
// of them): a run of 2-3 adjacent SHORT (1-2 digit) hyphen-separated tokens
// merges into one dotted version (`4-8` -> `4.8`); a lone date/snapshot
// stamp (6-8 bare digits) and more than one such run in the same id both
// still yield no version rather than a guess — see `findVersionGroups`/
// `parseVersionGroup`, below. A family/version mismatch never crashes the
// ranking — it just does not distinguish the tie.
import { isNonChatModelId, isFreeVariantModelId, isProfileComparable, profileKey, type ModelProfile } from "./model-profile";
import { MODEL_RANK_HINTS, rankModelId } from "../../gdskills/model-tier";
import { familyKey, parseModelVersion } from "../../gdskills/model-version";
import { MIN_MEASURED_TASKS, type TaskCostLookup } from "./task-cost";
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

// `familyKey`/`parseModelVersion` (the conservative family/version parse) live in
// `../../gdskills/model-version.ts` since flow 358, so `gdskills/model-tier.ts` can use them
// without an import cycle; they are re-exported here for existing callers.
export { familyKey, parseModelVersion };

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

/**
 * Flow 341 — real task cost overrides the structural step-down pick, but
 * only past an evidence bar. `pickStepDown`'s rule ASSUMES a lighter model
 * is cheaper per task; the operator's point motivating this override is that
 * the assumption is not always true — a lighter model can burn MORE tokens
 * finishing the same task than a stronger one, so a per-token price alone
 * (which this module never even had — `pickStepDown` uses SIZE CLASS, not
 * price) is not evidence about task cost either. Only a real measured median
 * cost per task is.
 *
 * The rule (AC4/AC5, flow 341): the structural `lighter` pick stands
 * UNCHANGED unless ALL of the following hold —
 *
 *   1. `lookup` is supplied (a caller with no stats simply gets the old
 *      behavior — byte-identical when omitted, same posture every optional
 *      parameter in this module keeps).
 *   2. `lighter` and `stronger` are both concrete `"model"` assignments on
 *      the SAME provider and actually differ (nothing to compare otherwise —
 *      `pickStepDown` returning the session model itself when there is no
 *      middle step is exactly this case, and is left alone).
 *   3. BOTH candidates have `n >= MIN_MEASURED_TASKS` (20) recorded tasks in
 *      THIS category — below that, a single unlucky run could flip the
 *      choice; the structural, size-based rule is the more trustworthy
 *      default until there is real volume.
 *   4. BOTH candidates have a KNOWN median cost per task (`medianCostUsd`) —
 *      a model whose price is unrecorded contributes no evidence either way,
 *      never a guess from token counts alone.
 *
 * Only when every one of those holds is the comparison made at all, and even
 * then the lighter model keeps its structural win when its own median cost
 * per task IS strictly lower — this override only fires to correct the
 * assumption, never to add a second, redundant reason to agree with it.
 * `stronger` is the same candidate `STRONG_CATEGORIES` would route to —
 * `pickPlanningReview`'s result — reused here as "the stronger one" the AC
 * refers to, rather than inventing a second notion of strength.
 */
function preferByMeasuredCost(
  lighter: CategoryAssignment,
  stronger: CategoryAssignment,
  category: RoutingCategory,
  lookup: TaskCostLookup | undefined,
): CategoryAssignment {
  if (lookup === undefined) return lighter;
  if (lighter.kind !== "model" || stronger.kind !== "model") return lighter;
  if (lighter.providerId !== stronger.providerId || lighter.modelId === stronger.modelId) return lighter;
  const lighterStats = lookup(lighter.providerId, lighter.modelId, category);
  const strongerStats = lookup(stronger.providerId, stronger.modelId, category);
  if (lighterStats === undefined || strongerStats === undefined) return lighter;
  if (lighterStats.n < MIN_MEASURED_TASKS || strongerStats.n < MIN_MEASURED_TASKS) return lighter;
  if (lighterStats.medianCostUsd === undefined || strongerStats.medianCostUsd === undefined) return lighter;
  const lighterIsCheaper = lighterStats.medianCostUsd < strongerStats.medianCostUsd;
  return lighterIsCheaper ? lighter : stronger;
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
 *
 * `taskCostLookup` (flow 341, optional and additive — omitted, every
 * category's pick is byte-identical to before this parameter existed) is
 * consulted ONLY for `STEP_DOWN_CATEGORIES`, and only past
 * `preferByMeasuredCost`'s evidence bar — see that function's doc for the
 * exact rule. Stats are passed in, already loaded by the caller
 * (`taskCostLookupFrom`, `./task-cost.ts`); this function itself never
 * touches disk, keeping it pure.
 */
export function deriveDefaultTable(
  providerId: string,
  models: readonly string[],
  profiles: Readonly<Record<string, ModelProfile>>,
  sessionModelId: string,
  taskCostLookup?: TaskCostLookup,
): RoutingTable {
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
  for (const category of STEP_DOWN_CATEGORIES) {
    table[category] = preferByMeasuredCost(stepDown, planningReview, category, taskCostLookup);
  }

  const quick = pickQuick(comparable, sessionModelId, providerId);
  for (const category of QUICK_CATEGORIES) table[category] = quick;

  // `default`/`coding` are never set here (SESSION_UNCHANGED_CATEGORIES) —
  // nothing to do for them; resolution falls through to `default`.
  return table;
}
