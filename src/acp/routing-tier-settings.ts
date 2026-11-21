import type { ModelClassConfig, RoutingConfigLayer } from "../harness/routing/config";
import { ROUTING_TIERS, modelRefKey, type ModelRef, type RoutingTier, type TierSettingsSnapshot } from "../harness/routing/model-class";
import { readRoutingSettings, updateRoutingLayer, type RoutingLocation, type RoutingSettings } from "../harness/routing/settings";
import type { RoutingCategory } from "../harness/routing/table";
import { DESK_REVIEW_POOLS, parseDeskReviewOptions } from "../review/desk-run-options";

const legacyTiers: Record<RoutingTier, readonly RoutingCategory[]> = {
  strong: ["planning", "review"],
  middle: ["subagents", "coding", "docs", "unattended", "default"],
  light: ["quick"],
};

function legacyModels(layer: RoutingConfigLayer | undefined, tier: RoutingTier): ModelRef[] {
  if (!layer || layer.tierRouting) return [];
  const models = new Map<string, ModelRef>();
  for (const category of legacyTiers[tier]) {
    const assignment = layer.categories?.[category];
    if (assignment?.mode === "model") models.set(modelRefKey(assignment.target), assignment.target);
  }
  return [...models.values()];
}

function models(config: ModelClassConfig): ModelRef[] {
  return config.candidates.filter(candidate => candidate.enabled)
    .sort((a, b) => b.priority - a.priority).map(candidate => candidate.target);
}

export function describeTierSettings(settings: RoutingSettings): TierSettingsSnapshot {
  return {
    revision: settings.revision,
    notices: settings.notices,
    projectOverrides: settings.layers.project !== undefined,
    tiers: DESK_REVIEW_POOLS.map(tier => {
      const modelClass = ROUTING_TIERS[tier];
      const userClass = settings.user.layer?.classes?.[modelClass];
      const projectClass = settings.layers.project?.classes?.[modelClass];
      return {
        tier,
        user: userClass ? models(userClass) : legacyModels(settings.user.layer, tier),
        project: projectClass ? models(projectClass) : null,
      };
    }),
  };
}


export async function saveTierSettings(location: RoutingLocation, revision: string, raw: unknown) {
  const { modelPools } = parseDeskReviewOptions({ mode: "manual", adaptive: true, modelPools: raw });
  const current = readRoutingSettings(location);
  const user = current.user.layer;
  const classes = { ...user?.classes };
  for (const tier of DESK_REVIEW_POOLS) {
    const modelClass = ROUTING_TIERS[tier];
    const existing = classes[modelClass];
    // Preserve policy, explicit disables, and priorities on untouched tiers.
    const selected = modelPools[tier].map(({ provider, model }) => ({ providerId: provider, modelId: model }));
    if (existing && JSON.stringify(models(existing)) === JSON.stringify(selected)) continue;
    const enabled = new Set(selected.map(modelRefKey));
    classes[modelClass] = {
      selection: existing?.selection ?? "priority",
      fallbackClasses: existing?.fallbackClasses ?? [],
      candidates: [
        ...selected.map((target, i) => ({ target, enabled: true, priority: selected.length - i })),
        ...(existing?.candidates.filter(candidate => !candidate.enabled && !enabled.has(modelRefKey(candidate.target))) ?? []),
      ],
    };
  }
  return updateRoutingLayer({
    ...location, scope: "user", expectedRevision: revision,
    next: { ...user, schemaVersion: 2, tierRouting: true, classes },
  });
}
