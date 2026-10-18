// A read-only snapshot of the project-context feature for the TUI (`/projectctx`,
// the `ProjectCtx` sidebar line): the settings, how many project rules there are,
// and the last recorded resolve. Every read is fail-soft; a file that cannot be
// read is reported in a field, never thrown.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { LAST_RESOLVE_PATH, listRuleRefs, type RecordedResolve } from "./context-resolver";
import {
  PROJECT_CONTEXT_CONFIG_PATH,
  readProjectContextConfig,
  type ProjectContextConfig,
} from "./project-context-config";
import { readProjectRuleRegistry } from "./project-rules";

export type ProjectContextStatus = {
  enforcement: ProjectContextConfig["enforcement"];
  enforcementSource: ProjectContextConfig["enforcementSource"];
  maxBytes: number;
  maxBytesSource: ProjectContextConfig["maxBytesSource"];
  /** Copied plus linked project rules. */
  ruleCount: number;
  linkedCount: number;
  /** Set when `tasks.config.json` exists but is not a JSON object; the settings above are then the defaults. */
  configError?: string;
  last?: RecordedResolve;
  /** Set when `last.json` exists but cannot be used. */
  lastError?: string;
};

async function configProblem(projectRoot: string): Promise<string | undefined> {
  const file = path.join(projectRoot, PROJECT_CONTEXT_CONFIG_PATH);
  if (!(await pathExists(file))) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? undefined : `${PROJECT_CONTEXT_CONFIG_PATH} is not a JSON object`;
  } catch {
    return `${PROJECT_CONTEXT_CONFIG_PATH} is not valid JSON`;
  }
}

async function readLast(projectRoot: string): Promise<{ last?: RecordedResolve; lastError?: string }> {
  const file = path.join(projectRoot, LAST_RESOLVE_PATH);
  if (!(await pathExists(file))) return {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<RecordedResolve> | null;
    const result = parsed?.result;
    if (typeof parsed?.recordedAt !== "string" || typeof result !== "object" || result === null) {
      return { lastError: `${LAST_RESOLVE_PATH} is not a recorded resolve` };
    }
    if ((result as { schema?: unknown }).schema !== 1) {
      return { lastError: `${LAST_RESOLVE_PATH} has an unknown schema` };
    }
    return { last: parsed as RecordedResolve };
  } catch {
    return { lastError: `${LAST_RESOLVE_PATH} is not valid JSON` };
  }
}

export async function loadProjectContextStatus(projectRoot: string): Promise<ProjectContextStatus> {
  const [config, configError, refs, registry, last] = await Promise.all([
    readProjectContextConfig(projectRoot),
    configProblem(projectRoot),
    listRuleRefs(projectRoot),
    readProjectRuleRegistry(projectRoot),
    readLast(projectRoot),
  ]);
  const copied = new Set(refs);
  const linked = registry.filter((entry) => entry.mode === "link" && !copied.has(entry.ref));
  return {
    enforcement: config.enforcement,
    enforcementSource: config.enforcementSource,
    maxBytes: config.maxBytes,
    maxBytesSource: config.maxBytesSource,
    ruleCount: copied.size + linked.length,
    linkedCount: linked.length,
    ...(configError !== undefined ? { configError } : {}),
    ...last,
  };
}
