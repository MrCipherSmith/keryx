// Settings of the project-context resolver, read from the `gdskills.projectContext`
// block of `.metaproject/tasks.config.json`:
//
//   { "gdskills": { "projectContext": { "enforcement": "warn" | "block", "maxBytes": 131072 } } }
//
// Reads are fail-closed and never throw: an absent, unparsable or mistyped value
// reads as the default and, when it was present but wrong, adds a warning. Writes
// keep every other key and refuse to overwrite a file that is not valid JSON.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";

export const PROJECT_CONTEXT_CONFIG_PATH = ".metaproject/tasks.config.json";

/** 128 KiB: the Vantage frontend-relevant rule set measures about 85 KB, plus half again for headroom. */
export const DEFAULT_MAX_BYTES = 131072;
export const MAX_BYTES_FLOOR = 4096;
export const MAX_BYTES_CEILING = 1048576;

export type ProjectContextEnforcement = "warn" | "block";
export type ProjectContextSource = "default" | "config" | "flag";

export type ProjectContextConfig = {
  enforcement: ProjectContextEnforcement;
  enforcementSource: "default" | "config";
  maxBytes: number;
  maxBytesSource: "default" | "config";
  warnings: string[];
};

export function isValidMaxBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MAX_BYTES_FLOOR && value <= MAX_BYTES_CEILING;
}

async function readRoot(projectRoot: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(projectRoot, PROJECT_CONTEXT_CONFIG_PATH), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export async function readProjectContextConfig(projectRoot: string): Promise<ProjectContextConfig> {
  const block = asObject(asObject((await readRoot(projectRoot))?.["gdskills"])?.["projectContext"]);
  const warnings: string[] = [];
  const result: ProjectContextConfig = {
    enforcement: "warn",
    enforcementSource: "default",
    maxBytes: DEFAULT_MAX_BYTES,
    maxBytesSource: "default",
    warnings,
  };
  if (block === undefined) return result;

  if ("enforcement" in block) {
    const raw = block["enforcement"];
    if (raw === "warn" || raw === "block") {
      result.enforcement = raw;
      result.enforcementSource = "config";
    } else {
      warnings.push(`${PROJECT_CONTEXT_CONFIG_PATH}: gdskills.projectContext.enforcement must be "warn" or "block"; reading it as "warn".`);
    }
  }
  if ("maxBytes" in block) {
    const raw = block["maxBytes"];
    if (isValidMaxBytes(raw)) {
      result.maxBytes = raw;
      result.maxBytesSource = "config";
    } else {
      warnings.push(
        `${PROJECT_CONTEXT_CONFIG_PATH}: gdskills.projectContext.maxBytes must be an integer from ${MAX_BYTES_FLOOR} to ${MAX_BYTES_CEILING}; reading it as ${DEFAULT_MAX_BYTES}.`,
      );
    }
  }
  return result;
}

export type ResolvedMaxBytes = { limitBytes: number; limitSource: ProjectContextSource; warnings: string[] };

/** The cap for one call: the `--max-bytes` flag when valid, else the configured value, else the default. */
export async function resolveMaxBytes(projectRoot: string, flag: number | undefined): Promise<ResolvedMaxBytes> {
  const config = await readProjectContextConfig(projectRoot);
  const warnings = [...config.warnings];
  if (flag !== undefined) {
    if (isValidMaxBytes(flag)) return { limitBytes: flag, limitSource: "flag", warnings };
    warnings.push(`--max-bytes must be an integer from ${MAX_BYTES_FLOOR} to ${MAX_BYTES_CEILING}; ignoring ${String(flag)}.`);
  }
  return { limitBytes: config.maxBytes, limitSource: config.maxBytesSource, warnings };
}

async function updateBlock(projectRoot: string, change: (block: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(projectRoot, PROJECT_CONTEXT_CONFIG_PATH);
  let root: Record<string, unknown> = {};
  if (await pathExists(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw new Error(`${PROJECT_CONTEXT_CONFIG_PATH} exists but is not valid JSON — refusing to overwrite it.`);
    }
    const object = asObject(parsed);
    if (object === undefined) throw new Error(`${PROJECT_CONTEXT_CONFIG_PATH} exists but is not a JSON object — refusing to overwrite it.`);
    root = object;
  }
  const gdskills = { ...(asObject(root["gdskills"]) ?? {}) };
  const block = { ...(asObject(gdskills["projectContext"]) ?? {}) };
  change(block);
  gdskills["projectContext"] = block;
  root["gdskills"] = gdskills;
  await writeFileAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
}

export async function writeProjectContextEnforcement(projectRoot: string, enforcement: ProjectContextEnforcement): Promise<void> {
  await updateBlock(projectRoot, (block) => {
    block["enforcement"] = enforcement;
  });
}

export async function writeProjectContextMaxBytes(projectRoot: string, maxBytes: number): Promise<void> {
  if (!isValidMaxBytes(maxBytes)) {
    throw new Error(`maxBytes must be an integer from ${MAX_BYTES_FLOOR} to ${MAX_BYTES_CEILING}; got ${String(maxBytes)}.`);
  }
  await updateBlock(projectRoot, (block) => {
    block["maxBytes"] = maxBytes;
  });
}
