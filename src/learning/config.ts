// Capability gate for the optional model-backed extractor (W3 spec,
// "Optional model-backed extractor (capability-gated)"). Absent file = every
// capability disabled — the deterministic core never depends on this file
// existing.
import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

export interface ProbeConfig {
  defaultTaskSet: string;
  maxUsdPerProbe?: number;
  retainRunsPerPattern: number;
}

export interface LearningConfig {
  schemaVersion: 1;
  probe: ProbeConfig;
  capabilities: {
    modelExtractor: boolean;
  };
}

function defaultProbeConfig(): ProbeConfig {
  return { defaultTaskSet: ".metaproject/data/learning/probes/tasks.json", retainRunsPerPattern: 20 };
}

/** A malformed known field invalidates the entire block; unknown fields are ignored. */
function probeConfig(value: unknown): ProbeConfig {
  const defaults = defaultProbeConfig();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return defaults;
  const block = value as Record<string, unknown>;
  if (block.defaultTaskSet !== undefined && (typeof block.defaultTaskSet !== "string" || block.defaultTaskSet.length === 0)) return defaults;
  if (block.maxUsdPerProbe !== undefined && (typeof block.maxUsdPerProbe !== "number" || !Number.isFinite(block.maxUsdPerProbe) || block.maxUsdPerProbe <= 0)) return defaults;
  if (block.retainRunsPerPattern !== undefined && (typeof block.retainRunsPerPattern !== "number" || !Number.isSafeInteger(block.retainRunsPerPattern) || block.retainRunsPerPattern < 0)) return defaults;
  return {
    defaultTaskSet: block.defaultTaskSet as string | undefined ?? defaults.defaultTaskSet,
    retainRunsPerPattern: block.retainRunsPerPattern as number | undefined ?? defaults.retainRunsPerPattern,
    ...(block.maxUsdPerProbe === undefined ? {} : { maxUsdPerProbe: block.maxUsdPerProbe as number }),
  };
}

export function learningConfigPath(root: string): string {
  return path.join(root, ".metaproject", "learning.config.json");
}

/** Reads `.metaproject/learning.config.json`, defaulting every capability to disabled when the file is absent or malformed. */
export async function loadLearningConfig(root: string): Promise<LearningConfig> {
  const file = learningConfigPath(root);
  const raw: unknown = await pathExists(file) ? await readJsonFileOr<unknown>(file, {}) : {};
  const object = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const capabilities = object.capabilities as { modelExtractor?: unknown } | null | undefined;
  return {
    schemaVersion: 1,
    capabilities: { modelExtractor: capabilities?.modelExtractor === true },
    probe: probeConfig(object.probe),
  };
}
