// Portable Desktop launch contract. Keep this module usable from the webview.
import { REVIEW_WAVE_MAX_CHILDREN } from "./wave-limits";

export { DEFAULT_REVIEW_PARALLEL } from "./wave-limits";
export interface DeskReviewModel { provider: string; model: string }
export type DeskReviewPool = "strong" | "middle" | "light";
export interface DeskReviewOptions {
  mode: "auto" | "manual";
  orchestrator?: boolean;
  autoPublish?: true;
  adaptive: boolean;
  maxWaves?: number;
  maxParallel?: number;
  maxTokens?: number;
  flowId?: string;
  modelPools: Record<DeskReviewPool, DeskReviewModel[]>;
}
export const DESK_MAX_PARALLEL = REVIEW_WAVE_MAX_CHILDREN;
export const DESK_MAX_POOL_MODELS = 32;
export const DESK_REVIEW_POOLS: readonly DeskReviewPool[] = ["strong", "middle", "light"];
export const DESK_OPTIONS_ENV = "KERYX_DESK_REVIEW_OPTIONS";
function invalid(field: string): never {
  throw new Error(`configuration: Invalid Review option ${field}.`);
}
function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid(label);
  return value as Record<string, unknown>;
}
function modelName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z\d][a-z\d_./:@+%-]{0,159}$/i.test(value)) invalid(label);
  return value;
}
export function parseDeskReviewOptions(value: unknown): DeskReviewOptions {
  const input = object(value, ["mode", "orchestrator", "autoPublish", "adaptive", "maxWaves", "maxParallel", "maxTokens", "flowId", "modelPools"], "launch settings");
  if (input.mode !== "auto" && input.mode !== "manual") invalid("mode");
  if (typeof input.adaptive !== "boolean") invalid("adaptive");
  if (input.orchestrator !== undefined && typeof input.orchestrator !== "boolean") invalid("orchestrator");
  const pools = object(input.modelPools, DESK_REVIEW_POOLS, "modelPools");
  const out: DeskReviewOptions = { mode: input.mode, adaptive: input.adaptive, modelPools: { strong: [], middle: [], light: [] } };
  if (input.autoPublish !== undefined && typeof input.autoPublish !== "boolean") invalid("autoPublish");
  if (input.autoPublish === true) out.autoPublish = true;
  if (input.orchestrator === false) {
    out.orchestrator = false;
    out.adaptive = false;
  }
  for (const key of ["maxWaves", "maxParallel", "maxTokens"] as const) {
    const n = input[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || (key === "maxParallel" && n > DESK_MAX_PARALLEL)) invalid(key);
    if (out.orchestrator !== false || key === "maxTokens") out[key] = n;
  }
  if (input.flowId !== undefined) {
    if (typeof input.flowId !== "string" || !/^\d{1,12}$/.test(input.flowId)) invalid("flowId");
    out.flowId = input.flowId.padStart(3, "0");
  }
  for (const key of DESK_REVIEW_POOLS) {
    const rows = pools[key];
    if (!Array.isArray(rows) || rows.length > DESK_MAX_POOL_MODELS) invalid(key);
    const seen = new Set<string>();
    const models = rows.map(raw => {
      const row = object(raw, ["provider", "model"], key);
      const provider = modelName(row.provider, "provider"), model = modelName(row.model, "model");
      const id = JSON.stringify([provider, model]);
      if (seen.has(id)) invalid("duplicate model in " + key);
      seen.add(id);
      return { provider, model };
    });
    if (out.orchestrator !== false) out.modelPools[key] = models;
  }
  return out;
}

export function readDeskOptionsJson(json: string): DeskReviewOptions {
  let input: unknown;
  try { input = JSON.parse(json); } catch { invalid("JSON"); }
  return parseDeskReviewOptions(input);
}

export function deskOptionsKey(options?: DeskReviewOptions): string {
  return options ? JSON.stringify(parseDeskReviewOptions(options)) : "";
}
