// Capability gate for the optional model-backed extractor (W3 spec,
// "Optional model-backed extractor (capability-gated)"). Absent file = every
// capability disabled — the deterministic core never depends on this file
// existing.
import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

export interface LearningConfig {
  schemaVersion: 1;
  capabilities: {
    modelExtractor: boolean;
  };
}

const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  schemaVersion: 1,
  capabilities: { modelExtractor: false },
};

export function learningConfigPath(root: string): string {
  return path.join(root, ".metaproject", "learning.config.json");
}

/** Reads `.metaproject/learning.config.json`, defaulting every capability to disabled when the file is absent or malformed. */
export async function loadLearningConfig(root: string): Promise<LearningConfig> {
  const file = learningConfigPath(root);
  if (!(await pathExists(file))) return DEFAULT_LEARNING_CONFIG;
  const raw = await readJsonFileOr<Partial<LearningConfig> & { capabilities?: { modelExtractor?: unknown } }>(file, {});
  return {
    schemaVersion: 1,
    capabilities: {
      modelExtractor: raw.capabilities?.modelExtractor === true,
    },
  };
}
