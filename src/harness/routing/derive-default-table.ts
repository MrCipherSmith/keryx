// Flow 327 (Routing A2), AC10 — `deriveDefaultTable`: PRD §6.3's "derived"
// precedence layer. A PURE function: session provider id + its (available)
// model ids + the operator's model-profile catalogue -> a `RoutingTable`
// (`./table.ts`) the SAME shape `routing.config.json`/the per-user layer
// already use, so `resolveCategoryDetailed` treats it as just another layer
// (`RoutingLayers.derived`).
//
// v1 derives from the SESSION's own current provider only — cross-provider
// derivation is explicitly out of scope (PRD §Non-goals, PLAN.md open
// question 8).
import { isProfileComparable, profileKey, type ModelProfile } from "./model-profile";
import { ROUTING_CATEGORIES, type CategoryAssignment, type RoutingCategory, type RoutingTable } from "./table";

const TIER_RANK: Readonly<Record<ModelProfile["strengthTier"]["value"], number>> = { light: 0, standard: 1, deep: 2 };

/**
 * Categories deriving to the LIGHTEST/cheapest comparable model (PRD §6.3):
 * high-volume, low-stakes, mechanical work. `unattended` is grouped here too
 * — the PRD's worked derivation rule names only `quick`/`subagents`/`docs`
 * explicitly and leaves `unattended` unaddressed for the several-models case
 * (a gap in PRD §6.3, not an oversight here); `unattended` (scheduled/
 * `flow-next` background dispatches, PRD §4) is the same "high-volume,
 * cost-sensitive, low-supervision" shape as the other three, so it follows
 * the same rule rather than being left undecided.
 */
const LIGHT_CATEGORIES: ReadonlySet<RoutingCategory> = new Set(["quick", "subagents", "docs", "unattended"]);

/** Categories deriving to the STRONGEST comparable model (PRD §6.3). */
const STRONG_CATEGORIES: ReadonlySet<RoutingCategory> = new Set(["planning", "review"]);

/** Categories that ALWAYS stay the session's own model, unchanged — never set by this function (PRD §6.3: "unchanged" means omitted, letting resolution fall through to the bare `default` category). */
const SESSION_UNCHANGED_CATEGORIES: ReadonlySet<RoutingCategory> = new Set(["default", "coding"]);

// Defensive coverage check: every category in `ROUTING_CATEGORIES` must be
// accounted for by exactly one of the three groups above, so a category
// added later (Flow D) fails loudly here instead of silently deriving
// nothing for it.
{
  const accounted = new Set<RoutingCategory>([...LIGHT_CATEGORIES, ...STRONG_CATEGORIES, ...SESSION_UNCHANGED_CATEGORIES]);
  const missing = ROUTING_CATEGORIES.filter((category) => !accounted.has(category));
  if (missing.length > 0) {
    throw new Error(`derive-default-table.ts: category(ies) ${missing.join(", ")} are not covered by LIGHT_CATEGORIES/STRONG_CATEGORIES/SESSION_UNCHANGED_CATEGORIES`);
  }
}

function priceOrSentinel(profile: ModelProfile, forAscending: boolean): number {
  if (profile.priceInputPerMillion.value !== "unknown") return profile.priceInputPerMillion.value;
  // Unknown price never wins a price-based tie-break in EITHER direction —
  // same "unknown is never good news" posture auto-priority uses (PRD §6.1).
  return forAscending ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

/** Sort candidates so index 0 is the pick: lightest+cheapest first (`ascending`) or strongest+priciest first (`!ascending`), tie-broken by highest `priority.value` either way (PRD §6.3). */
function rankCandidates(candidates: readonly ModelProfile[], ascending: boolean): readonly ModelProfile[] {
  return [...candidates].sort((a, b) => {
    const tierDelta = ascending ? TIER_RANK[a.strengthTier.value] - TIER_RANK[b.strengthTier.value] : TIER_RANK[b.strengthTier.value] - TIER_RANK[a.strengthTier.value];
    if (tierDelta !== 0) return tierDelta;
    const priceDelta = ascending
      ? priceOrSentinel(a, true) - priceOrSentinel(b, true)
      : priceOrSentinel(b, false) - priceOrSentinel(a, false);
    if (priceDelta !== 0) return priceDelta;
    return b.priority.value - a.priority.value;
  });
}

/**
 * Build the `derived` `RoutingTable` for `providerId`'s connected `models`
 * (AC10, PRD §6.3):
 *
 *  - Zero models -> an empty table (nothing to derive; every category falls
 *    through to `default`).
 *  - One model -> that model for every category except `default`/`coding`
 *    (which are always the session's own model, and this IS it).
 *  - Several models -> partitioned by category intent: lightest/cheapest for
 *    `quick`/`subagents`/`docs`/`unattended`, strongest for
 *    `planning`/`review`, `default`/`coding` left unset. A category whose
 *    group has no COMPARABLE candidate (`isProfileComparable`,
 *    `./model-profile.ts`) is also left unset, falling through to `default`.
 *
 * `models` should already be the provider's AVAILABLE models (PRD §6.3 runs
 * this "against available models only") — a caller building `models` from
 * `catalogToFlatPickerProviders`'s live list already gets this for free
 * (flow 309's live catalog only ever reports live-fetched ids).
 */
export function deriveDefaultTable(providerId: string, models: readonly string[], profiles: Readonly<Record<string, ModelProfile>>): RoutingTable {
  if (models.length === 0) return {};
  if (models.length === 1) {
    const assignment: CategoryAssignment = { kind: "model", providerId, modelId: models[0]! };
    const table: RoutingTable = {};
    for (const category of ["review", "subagents", "quick", "coding", "planning", "docs", "unattended"] as const) {
      table[category] = assignment;
    }
    return table;
  }

  const comparable = models
    .map((modelId) => profiles[profileKey(providerId, modelId)])
    .filter((profile): profile is ModelProfile => profile !== undefined && isProfileComparable(profile.modelId, profile));

  const table: RoutingTable = {};
  if (comparable.length > 0) {
    const lightest = rankCandidates(comparable, true)[0]!;
    const strongest = rankCandidates(comparable, false)[0]!;
    for (const category of LIGHT_CATEGORIES) {
      table[category] = { kind: "model", providerId, modelId: lightest.modelId };
    }
    for (const category of STRONG_CATEGORIES) {
      table[category] = { kind: "model", providerId, modelId: strongest.modelId };
    }
  }
  // `default`/`coding` are never set here (SESSION_UNCHANGED_CATEGORIES) —
  // nothing to do for them; resolution falls through to `default`.
  return table;
}
