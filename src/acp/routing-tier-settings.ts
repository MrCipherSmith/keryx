import type { ModelClassConfig, RoutingConfigLayer } from "../harness/routing/config";
import { ROUTING_MAX_TIER_MODELS, ROUTING_TIER_IDS, ROUTING_TIERS, modelRefKey, type ModelRef, type RoutingTier, type TierSettingsSnapshot } from "../harness/routing/model-class";
import { readRoutingSettings, updateRoutingLayer, type RoutingLocation, type RoutingSettings } from "../harness/routing/settings";
import { PROJECT_SCOPED_USER_NOTICE } from "../harness/routing/legacy-migration";
import { ROUTING_CATEGORIES, ROUTING_CATEGORY_TIERS } from "../harness/routing/table";

const modelId = /^[a-z\d][a-z\d_./:@+%-]{0,159}$/i;

function legacyModels(layer: RoutingConfigLayer | undefined, tier: RoutingTier): ModelRef[] {
  if (!layer || layer.tierRouting) return [];
  const models = new Map<string, ModelRef>();
  for (const category of ROUTING_CATEGORIES) {
    if (ROUTING_CATEGORY_TIERS[category] !== tier) continue;
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
  const saveBlocked = settings.user.source === "opt-in";
  return {
    revision: settings.revision,
    saveBlocked,
    enabled: settings.user.layer?.tierRouting ?? false,
    projectEnabled: settings.layers.project?.tierRouting ?? null,
    notices: saveBlocked ? [...settings.notices, PROJECT_SCOPED_USER_NOTICE] : settings.notices,
    personalOverrides: Object.keys(settings.user.layer?.categories ?? {}).length > 0,
    projectOverrides: settings.layers.project !== undefined,
    projectTrustRequired: !settings.project.trusted,
    tiers: ROUTING_TIER_IDS.map(tier => {
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid routing tiers request.");
  const enabled: unknown = Reflect.get(raw, "enabled");
  const replaceOverrides: unknown = Reflect.get(raw, "replaceOverrides");
  if (typeof enabled !== "boolean" || typeof replaceOverrides !== "boolean" || (replaceOverrides && !enabled)) {
    throw new Error("Invalid routing tiers request.");
  }
  const modelPools: unknown = Reflect.get(raw, "modelPools");
  if (!modelPools || typeof modelPools !== "object" || Object.keys(modelPools).some(tier => !ROUTING_TIER_IDS.some(value => value === tier))) {
    throw new Error("Invalid routing model pools.");
  }
  const current = readRoutingSettings(location);
  if (current.user.source === "opt-in") throw new Error(PROJECT_SCOPED_USER_NOTICE);
  const user = current.user.layer;
  const classes = { ...user?.classes };
  for (const tier of ROUTING_TIER_IDS) {
    const modelClass = ROUTING_TIERS[tier];
    if (current.layers.project?.classes?.[modelClass]) continue;
    const existing = classes[modelClass];
    const enabledModels = existing ? models(existing) : [];
    // Preserve policy, explicit disables, and priorities on untouched tiers.
    const entries: unknown = Reflect.get(modelPools, tier);
    if (!Array.isArray(entries) || entries.length > Math.max(ROUTING_MAX_TIER_MODELS, enabledModels.length)) throw new Error(`Invalid ${tier} routing pool.`);
    const selected = entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid model in ${tier} routing pool.`);
      const providerId: unknown = Reflect.get(entry, "provider");
      const targetModelId: unknown = Reflect.get(entry, "model");
      if (typeof providerId !== "string" || !providerId || typeof targetModelId !== "string" || !targetModelId) {
        throw new Error(`Invalid model in ${tier} routing pool.`);
      }
      return { providerId, modelId: targetModelId };
    });
    if (existing && JSON.stringify(enabledModels) === JSON.stringify(selected)) continue;
    const known = new Set((existing?.candidates.map(candidate => candidate.target) ?? legacyModels(user, tier)).map(modelRefKey));
    if (selected.some(target => !known.has(modelRefKey(target)) && (!modelId.test(target.providerId) || !modelId.test(target.modelId)))) {
      throw new Error(`Invalid model in ${tier} routing pool.`);
    }
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
    ...location, scope: "user", expectedRevision: revision, preserveLegacyScope: true,
    next: { ...user, schemaVersion: 2, tierRouting: enabled, classes, ...(replaceOverrides ? { categories: {} } : {}) },
  });
}
