import type { ReviewAgentConfig, ReviewAgentConfigOverrides, ReviewAgentRoleCeiling, ReviewAgentRunCeilings } from "./types";

export const REVIEW_AGENTS_ENTITIES = ["review-scout", "review-coordinator", "review-worker", "review-validator"] as const;

const runCeilings: ReviewAgentRunCeilings = {
  maxActiveDescendants: 32,
  initialConcurrency: 12,
  maxIncompleteGenerals: 6,
  maxActiveChildrenPerGeneral: 8,
  maxLaunches: 512,
  maxLaunchesPerWave: 128,
  maxLaunchesOutsideWaves: 128,
  maxWaves: 50,
  maxAgentTimeMs: 960 * 60_000,
  elapsedDeadlineMs: 120 * 60_000,
  reserveFraction: 0.2,
  maxReviewRounds: 8,
  maxDepth: 2,
};

const leaf: ReviewAgentRoleCeiling = { elapsedMs: 15 * 60_000, modelRoundsDefault: 80, modelRoundsMax: 400, toolCallsMax: 400, maxChildLaunches: 0 };
const roleCeilings: ReviewAgentConfig["roleCeilings"] = {
  root: { elapsedMs: 120 * 60_000, modelRoundsDefault: 200, modelRoundsMax: 800, toolCallsMax: 2_000, maxChildLaunches: 512 },
  coordinator: { elapsedMs: 45 * 60_000, modelRoundsDefault: 120, modelRoundsMax: 600, toolCallsMax: 800, maxChildLaunches: 48 },
  worker: leaf,
  scout: leaf,
  validator: leaf,
};

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name}.${key} is not supported`);
  for (const key of expected) if (!(key in value)) throw new Error(`${name}.${key} is required`);
}

function stringList(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0) || new Set(value).size !== value.length) throw new Error(`${name} must be an array of unique non-empty strings`);
}

export function validateReviewAgentConfig(config: ReviewAgentConfig): ReviewAgentConfig {
  const raw = record(config, "config");
  const optional = config.spendingCeiling === undefined ? [] : ["spendingCeiling"];
  exactFields(raw, ["configVersion", "profile", "runCeilings", "roleCeilings", "allowedAdapters", "allowedEntities", "allowedSkills", "fallbackPolicy", "costMode", ...optional], "config");
  if (config.configVersion !== 1) throw new Error(`Unsupported review agents config version: ${String(config.configVersion)}`);
  if (typeof config.profile !== "string" || config.profile.trim().length === 0) throw new Error("profile must be a non-empty string");
  const runs = record(config.runCeilings, "runCeilings");
  exactFields(runs, ["maxActiveDescendants", "initialConcurrency", "maxIncompleteGenerals", "maxActiveChildrenPerGeneral", "maxLaunches", "maxLaunchesPerWave", "maxLaunchesOutsideWaves", "maxWaves", "maxAgentTimeMs", "elapsedDeadlineMs", "reserveFraction", "maxReviewRounds", "maxDepth"], "runCeilings");
  for (const [name, value] of Object.entries(runs)) {
    if (name === "reserveFraction") continue;
    positiveInteger(value as number, `runCeilings.${name}`);
  }
  if (typeof config.runCeilings.reserveFraction !== "number" || !Number.isFinite(config.runCeilings.reserveFraction) || config.runCeilings.reserveFraction < 0 || config.runCeilings.reserveFraction >= 1) throw new Error("runCeilings.reserveFraction must be in [0, 1)");
  if (config.runCeilings.initialConcurrency > config.runCeilings.maxActiveDescendants) throw new Error("initialConcurrency cannot exceed maxActiveDescendants");
  const roles = record(config.roleCeilings, "roleCeilings");
  exactFields(roles, ["root", "coordinator", "worker", "scout", "validator"], "roleCeilings");
  for (const role of ["root", "coordinator", "worker", "scout", "validator"] as const) {
    const limits = record(roles[role], `roleCeilings.${role}`);
    exactFields(limits, ["elapsedMs", "modelRoundsDefault", "modelRoundsMax", "toolCallsMax", "maxChildLaunches"], `roleCeilings.${role}`);
    positiveInteger(limits.elapsedMs as number, `roleCeilings.${role}.elapsedMs`);
    positiveInteger(limits.modelRoundsDefault as number, `roleCeilings.${role}.modelRoundsDefault`);
    positiveInteger(limits.modelRoundsMax as number, `roleCeilings.${role}.modelRoundsMax`);
    positiveInteger(limits.toolCallsMax as number, `roleCeilings.${role}.toolCallsMax`);
    if (!Number.isSafeInteger(limits.maxChildLaunches) || (limits.maxChildLaunches as number) < 0) throw new Error(`roleCeilings.${role}.maxChildLaunches must be a non-negative safe integer`);
    if ((limits.modelRoundsDefault as number) > (limits.modelRoundsMax as number)) throw new Error(`roleCeilings.${role}.modelRoundsDefault cannot exceed modelRoundsMax`);
  }
  stringList(config.allowedAdapters, "allowedAdapters");
  stringList(config.allowedEntities, "allowedEntities");
  stringList(config.allowedSkills, "allowedSkills");
  if (config.fallbackPolicy !== "refuse" && config.fallbackPolicy !== "ask" && config.fallbackPolicy !== "preapproved") throw new Error("fallbackPolicy is invalid");
  if (config.costMode !== "measured-cost" && config.costMode !== "cost-unknown") throw new Error("costMode is invalid");
  if (config.costMode === "measured-cost" && config.spendingCeiling === undefined) throw new Error("measured-cost requires spendingCeiling");
  if (config.spendingCeiling !== undefined) {
    const ceiling = record(config.spendingCeiling, "spendingCeiling"); exactFields(ceiling, ["amount", "currency"], "spendingCeiling");
    if (typeof ceiling.amount !== "number" || !Number.isFinite(ceiling.amount) || ceiling.amount <= 0) throw new Error("spendingCeiling.amount must be positive");
    if (typeof ceiling.currency !== "string" || !/^[A-Z]{3}$/.test(ceiling.currency)) throw new Error("spendingCeiling.currency must be a three-letter uppercase code");
  }
  return config;
}

export function createLargeReviewConfig(overrides: ReviewAgentConfigOverrides = {}): ReviewAgentConfig {
  const mergedRoles = Object.fromEntries(Object.entries(roleCeilings).map(([role, limits]) => [role, { ...limits, ...overrides.roleCeilings?.[role as keyof typeof roleCeilings] }])) as unknown as ReviewAgentConfig["roleCeilings"];
  return validateReviewAgentConfig({
    configVersion: 1,
    profile: overrides.profile ?? "large-review",
    runCeilings: { ...runCeilings, ...overrides.runCeilings },
    roleCeilings: mergedRoles,
    allowedAdapters: overrides.allowedAdapters ?? [],
    allowedEntities: overrides.allowedEntities ?? REVIEW_AGENTS_ENTITIES,
    allowedSkills: overrides.allowedSkills ?? [],
    fallbackPolicy: overrides.fallbackPolicy ?? "refuse",
    costMode: overrides.costMode ?? "cost-unknown",
    ...(overrides.spendingCeiling === undefined ? {} : { spendingCeiling: overrides.spendingCeiling }),
  });
}
