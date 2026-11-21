import type { ModelClassConfig, RoutingConfigLayer } from "../harness/routing/config";
import { ROUTING_TIERS, modelRefKey, type ModelRef, type RoutingTier, type TierSettingsSnapshot } from "../harness/routing/model-class";
import { readRoutingSettings, updateRoutingLayer, type RoutingLocation, type RoutingSettings } from "../harness/routing/settings";
import type { RoutingCategory } from "../harness/routing/table";


const tiers = ["strong", "middle", "light"] as const satisfies readonly RoutingTier[];
const MAX_TIER_MODELS = 32;
const modelId = /^[a-z\d][a-z\d_./:@+%-]{0,159}$/i;

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
    personalOverrides: Object.keys(settings.user.layer?.categories ?? {}).length > 0,
    projectOverrides: settings.layers.project !== undefined,
    tiers: tiers.map(tier => {
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof Reflect.get(raw, "replaceOverrides") !== "boolean") {
    throw new Error("Invalid routing tiers request.");
  }
  const modelPools: unknown = Reflect.get(raw, "modelPools");
  if (!modelPools || typeof modelPools !== "object" || Object.keys(modelPools).some(tier => !tiers.some(value => value === tier))) {
    throw new Error("Invalid routing model pools.");
  }
  const replaceOverrides = Reflect.get(raw, "replaceOverrides") === true;
  const current = readRoutingSettings(location);
  const user = current.user.layer;
  const classes = { ...user?.classes };
  for (const tier of tiers) {
    const modelClass = ROUTING_TIERS[tier];
    const existing = classes[modelClass];
    // Preserve policy, explicit disables, and priorities on untouched tiers.
    const entries: unknown = Reflect.get(modelPools, tier);
    if (!Array.isArray(entries) || entries.length > MAX_TIER_MODELS) throw new Error(`Invalid ${tier} routing pool.`);
    const selected = entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid model in ${tier} routing pool.`);
      const providerId: unknown = Reflect.get(entry, "provider");
      const targetModelId: unknown = Reflect.get(entry, "model");
      if (typeof providerId !== "string" || !modelId.test(providerId) || typeof targetModelId !== "string" || !modelId.test(targetModelId)) {
        throw new Error(`Invalid model in ${tier} routing pool.`);
      }
      return { providerId, modelId: targetModelId };
    });
    if (current.layers.project?.classes?.[modelClass] && !replaceOverrides) continue;
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
    next: { ...user, schemaVersion: 2, tierRouting: true, classes, ...(replaceOverrides ? { categories: {} } : {}) },
  });
}
