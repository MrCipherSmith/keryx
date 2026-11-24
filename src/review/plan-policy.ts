import { AUTO_MAX_DISPATCHES, AUTO_MAX_MINUTES, DEFAULT_MAX_DISPATCHES, DEFAULT_MAX_MINUTES } from "./plan-limits";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Apply only local changes from HEAD which tighten the trusted control checkout. */
export function intersectLocalPlanPolicy(trusted: unknown, head: unknown, local: unknown): Record<string, unknown> {
  const config = { ...object(trusted) };
  if (config.reviewPlan !== undefined && (!config.reviewPlan || typeof config.reviewPlan !== "object" || Array.isArray(config.reviewPlan))) return config;
  const base = object(config.reviewPlan), previous = object(object(head).reviewPlan), current = object(object(local).reviewPlan);
  const merged = { ...base };
  const limits = { maxDispatches: DEFAULT_MAX_DISPATCHES, maxMinutes: DEFAULT_MAX_MINUTES,
    autoMaxDispatches: AUTO_MAX_DISPATCHES, autoMaxMinutes: AUTO_MAX_MINUTES };
  for (const [key, fallback] of Object.entries(limits)) {
    const value = current[key];
    if (value === previous[key] || !positive(value)) continue;
    const trustedLimit = positive(base[key]) ? base[key] : fallback;
    if (value < trustedLimit) merged[key] = value;
  }
  if (current.autoApprove === false && previous.autoApprove !== false) merged.autoApprove = false;
  if (Object.keys(merged).length) config.reviewPlan = merged;
  return config;
}
