export const MODEL_CLASSES = ["light", "standard", "expert", "frontier"] as const;

export type ModelClass = (typeof MODEL_CLASSES)[number];

export interface ModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

const MODEL_CLASS_RANK: Readonly<Record<ModelClass, number>> = {
  light: 0,
  standard: 1,
  expert: 2,
  frontier: 3,
};

export function isModelClass(value: unknown): value is ModelClass {
  return typeof value === "string" && (MODEL_CLASSES as readonly string[]).includes(value);
}

export function compareModelClasses(left: ModelClass, right: ModelClass): number {
  return MODEL_CLASS_RANK[left] - MODEL_CLASS_RANK[right];
}

export function sameModelRef(left: ModelRef, right: ModelRef): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

export function modelRefKey(ref: ModelRef): string {
  return `${ref.providerId}\u0000${ref.modelId}`;
}

/** The three operator-facing tiers, mapped to the resolver's model classes. */
export const ROUTING_TIER_IDS = ["strong", "middle", "light"] as const;
export type RoutingTier = (typeof ROUTING_TIER_IDS)[number];
export const ROUTING_TIERS = {
  strong: "expert",
  middle: "standard",
  light: "light",
} as const satisfies Readonly<Record<RoutingTier, ModelClass>>;

export interface TierSettingsSnapshot {
  readonly revision: string;
  readonly notices: readonly string[];
  readonly projectOverrides: boolean;
  readonly projectTrustRequired: boolean;
  readonly personalOverrides: boolean;
  readonly tiers: readonly {
    readonly tier: RoutingTier;
    readonly user: readonly ModelRef[];
    readonly project: readonly ModelRef[] | null;
  }[];
}
